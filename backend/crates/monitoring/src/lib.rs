use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, TimeDelta, Utc};
use domain::{FetchedPage, Monitor, NormalizedOffer, OfferSource, OfferSourceError};
use product_intelligence::ProductInterpreter;
use spider::configuration::{SpiderCloudConfig, SpiderCloudMode, SpiderCloudReturnFormat};
use spider::website::Website;
use tokio::{
    net::lookup_host,
    sync::{Mutex, Semaphore},
};
use url::{Host, Url};

pub const DEFAULT_CHECK_INTERVAL_SECONDS: i64 = 60;

#[derive(Debug, Clone)]
pub struct FetchConfig {
    pub request_timeout: Duration,
    pub crawl_timeout: Duration,
    pub max_response_bytes: usize,
    pub user_agent: String,
    pub global_concurrency: usize,
    pub per_domain_concurrency: usize,
    pub spider_cloud_api_key: Option<String>,
}

impl Default for FetchConfig {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(15),
            crawl_timeout: Duration::from_secs(20),
            max_response_bytes: 2 * 1024 * 1024,
            user_agent: "CompraloMonitor/0.1".into(),
            global_concurrency: 16,
            per_domain_concurrency: 2,
            spider_cloud_api_key: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MonitoringError {
    #[error("unsafe URL: {0}")]
    UnsafeUrl(String),
    #[error("DNS resolution failed: {0}")]
    Dns(String),
    #[error("Spider did not return the requested page")]
    MissingPage,
    #[error("page exceeded the {limit} byte limit ({actual} bytes)")]
    ResponseTooLarge { limit: usize, actual: usize },
    #[error("fetch timed out")]
    Timeout,
    #[error("product page returned HTTP {0}")]
    HttpStatus(u16),
    #[error("extraction failed: {0}")]
    Extraction(String),
}

/// Validate the parts of a URL that do not require DNS resolution.
pub fn validate_url_syntax(url: &Url) -> Result<(), MonitoringError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(MonitoringError::UnsafeUrl(
            "only http and https are allowed".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(MonitoringError::UnsafeUrl(
            "embedded credentials are forbidden".into(),
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| MonitoringError::UnsafeUrl("URL has no host".into()))?;
    match host {
        Host::Domain(name) => {
            let lower = name.trim_end_matches('.').to_ascii_lowercase();
            if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
                return Err(MonitoringError::UnsafeUrl(
                    "local hostnames are forbidden".into(),
                ));
            }
        }
        Host::Ipv4(ip) => ensure_public_ip(IpAddr::V4(ip))?,
        Host::Ipv6(ip) => ensure_public_ip(IpAddr::V6(ip))?,
    }
    Ok(())
}

/// Resolve the target before giving it to Spider. Redirects are disabled in Spider so
/// every network destination has passed this check.
pub async fn validate_public_url(url: &Url) -> Result<(), MonitoringError> {
    validate_url_syntax(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| MonitoringError::UnsafeUrl("URL has no host".into()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| MonitoringError::UnsafeUrl("unknown port".into()))?;
    let addresses: Vec<_> = lookup_host((host, port))
        .await
        .map_err(|e| MonitoringError::Dns(e.to_string()))?
        .collect();
    if addresses.is_empty() {
        return Err(MonitoringError::Dns("host returned no addresses".into()));
    }
    for address in addresses {
        ensure_public_ip(address.ip())?;
    }
    Ok(())
}

fn ensure_public_ip(ip: IpAddr) -> Result<(), MonitoringError> {
    let unsafe_address = match ip {
        IpAddr::V4(ip) => ipv4_is_non_public(ip),
        IpAddr::V6(ip) => ipv6_is_non_public(ip),
    };
    if unsafe_address {
        Err(MonitoringError::UnsafeUrl(format!(
            "non-public address {ip} is forbidden"
        )))
    } else {
        Ok(())
    }
}

fn ipv4_is_non_public(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_documentation()
        || octets[0] == 0
        || octets[0] == 100 && (64..=127).contains(&octets[1])
        || octets[0] == 198 && (octets[1] == 18 || octets[1] == 19)
        || octets[0] >= 240
}

fn ipv6_is_non_public(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    ip.is_loopback() || ip.is_unspecified() || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (segments[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (segments[0] & 0xffc0) == 0xfec0 // deprecated site-local fec0::/10
        || (segments[0] == 0x2001 && segments[1] == 0x0db8) // documentation
        || ip.to_ipv4().is_some_and(ipv4_is_non_public)
}

#[derive(Clone)]
pub struct SpiderFetcher {
    config: FetchConfig,
    global: Arc<Semaphore>,
    per_domain: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
}

impl SpiderFetcher {
    pub fn new(config: FetchConfig) -> Self {
        assert!(config.global_concurrency > 0);
        assert!(config.per_domain_concurrency > 0);
        Self {
            global: Arc::new(Semaphore::new(config.global_concurrency)),
            per_domain: Arc::new(Mutex::new(HashMap::new())),
            config,
        }
    }

    pub async fn fetch(&self, url: &Url) -> Result<FetchedPage, MonitoringError> {
        validate_public_url(url).await?;
        let host = url.host_str().expect("validated host").to_ascii_lowercase();
        let domain_semaphore = {
            let mut semaphores = self.per_domain.lock().await;
            semaphores
                .entry(host)
                .or_insert_with(|| Arc::new(Semaphore::new(self.config.per_domain_concurrency)))
                .clone()
        };
        let _global = self
            .global
            .acquire()
            .await
            .expect("semaphore is never closed");
        let _domain = domain_semaphore
            .acquire()
            .await
            .expect("semaphore is never closed");
        // Fetch locally first. Configuring Spider Cloud on the initial request can
        // return a provider response rather than the retailer's HTML.
        let direct = self.fetch_with_spider(url, false).await;
        if direct.is_ok() || self.config.spider_cloud_api_key.is_none() {
            return direct;
        }
        self.fetch_with_spider(url, true).await
    }

    async fn fetch_with_spider(
        &self,
        url: &Url,
        cloud_fallback: bool,
    ) -> Result<FetchedPage, MonitoringError> {
        let mut website = Website::new_with_firewall(url.as_str(), true);
        website
            .with_limit(1)
            .with_depth(1)
            .with_concurrency_limit(Some(1))
            .with_respect_robots_txt(true)
            .with_redirect_limit(0)
            .with_retry(0)
            .with_request_timeout(Some(self.config.request_timeout))
            .with_crawl_timeout(Some(self.config.crawl_timeout))
            .with_user_agent(Some(&self.config.user_agent));
        if let Some(api_key) = self
            .config
            .spider_cloud_api_key
            .as_deref()
            .filter(|_| cloud_fallback)
        {
            website.with_spider_cloud_config(
                SpiderCloudConfig::new(api_key)
                    .with_mode(SpiderCloudMode::Fallback)
                    .with_return_format(SpiderCloudReturnFormat::Raw),
            );
        }
        let mut receiver = website.subscribe(2);
        tokio::time::timeout(self.config.crawl_timeout, website.scrape())
            .await
            .map_err(|_| MonitoringError::Timeout)?;
        let page = receiver
            .try_recv()
            .map_err(|_| MonitoringError::MissingPage)?;
        let html = String::from_utf8_lossy(page.get_html_bytes_u8()).into_owned();
        if !page.status_code.is_success() {
            return Err(MonitoringError::HttpStatus(page.status_code.as_u16()));
        }
        if html.trim().is_empty() {
            return Err(MonitoringError::MissingPage);
        }
        if html.len() > self.config.max_response_bytes {
            return Err(MonitoringError::ResponseTooLarge {
                limit: self.config.max_response_bytes,
                actual: html.len(),
            });
        }
        let final_url =
            Url::parse(page.get_url()).map_err(|e| MonitoringError::UnsafeUrl(e.to_string()))?;
        // Redirects are disabled, but retain a strict same-URL assertion as defense in depth.
        if canonical_request_url(&final_url) != canonical_request_url(url) {
            return Err(MonitoringError::UnsafeUrl(
                "redirected away from the validated URL".into(),
            ));
        }
        Ok(FetchedPage {
            requested_url: url.clone(),
            final_url,
            status: page.status_code.as_u16(),
            html,
            fetched_at: Utc::now(),
        })
    }
}

fn canonical_request_url(url: &Url) -> String {
    let mut url = url.clone();
    url.set_fragment(None);
    url.to_string().trim_end_matches('/').to_string()
}

#[derive(Clone)]
pub struct SpiderOfferSource {
    fetcher: SpiderFetcher,
    interpreter: Arc<ProductInterpreter>,
}

impl SpiderOfferSource {
    pub fn new(fetcher: SpiderFetcher, interpreter: Arc<ProductInterpreter>) -> Self {
        Self {
            fetcher,
            interpreter,
        }
    }

    async fn offer_for_url(&self, url: &Url) -> Result<NormalizedOffer, OfferSourceError> {
        let page = self
            .fetcher
            .fetch(url)
            .await
            .map_err(map_monitoring_error)?;
        self.interpreter
            .extract(&page)
            .await
            .map_err(|e| OfferSourceError::Extraction(e.to_string()))
    }
}

#[async_trait]
impl OfferSource for SpiderOfferSource {
    async fn check(&self, monitor: &Monitor) -> Result<NormalizedOffer, OfferSourceError> {
        self.offer_for_url(&monitor.url).await
    }

    async fn revalidate(
        &self,
        offer: &NormalizedOffer,
    ) -> Result<NormalizedOffer, OfferSourceError> {
        self.offer_for_url(&offer.source_url).await
    }
}

fn map_monitoring_error(error: MonitoringError) -> OfferSourceError {
    match error {
        MonitoringError::UnsafeUrl(message) | MonitoringError::Dns(message) => {
            OfferSourceError::UnsafeUrl(message)
        }
        other => OfferSourceError::Fetch(other.to_string()),
    }
}

#[derive(Debug, Clone)]
pub struct SchedulePolicy {
    pub normal_interval: TimeDelta,
    pub maximum_backoff: TimeDelta,
}

impl Default for SchedulePolicy {
    fn default() -> Self {
        Self {
            normal_interval: TimeDelta::seconds(DEFAULT_CHECK_INTERVAL_SECONDS),
            maximum_backoff: TimeDelta::minutes(30),
        }
    }
}

impl SchedulePolicy {
    pub fn next_after_success(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        now + self.normal_interval
    }

    pub fn next_after_failure(
        &self,
        now: DateTime<Utc>,
        consecutive_failures: u32,
    ) -> DateTime<Utc> {
        let exponent = consecutive_failures.saturating_sub(1).min(20);
        let multiplier = 1_i64.checked_shl(exponent).unwrap_or(i64::MAX);
        let seconds = self
            .normal_interval
            .num_seconds()
            .saturating_mul(multiplier)
            .min(self.maximum_backoff.num_seconds());
        now + TimeDelta::seconds(seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn rejects_non_http_credentials_and_local_destinations() {
        for raw in [
            "file:///etc/passwd",
            "http://user:secret@example.com/product",
            "http://localhost/product",
            "http://127.0.0.1/product",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.1/product",
            "http://[::1]/product",
        ] {
            assert!(
                validate_url_syntax(&Url::parse(raw).unwrap()).is_err(),
                "{raw} must be rejected"
            );
        }
    }

    #[test]
    fn accepts_public_http_urls_without_resolving_them() {
        assert!(
            validate_url_syntax(&Url::parse("https://example.com/product?id=1").unwrap()).is_ok()
        );
        assert!(validate_url_syntax(&Url::parse("https://93.184.216.34/product").unwrap()).is_ok());
    }

    #[test]
    fn scheduler_defaults_to_sixty_seconds_and_backs_off() {
        let policy = SchedulePolicy::default();
        let now = Utc.timestamp_opt(1_700_000_000, 0).unwrap();
        assert_eq!(policy.next_after_success(now), now + TimeDelta::seconds(60));
        assert_eq!(
            policy.next_after_failure(now, 1),
            now + TimeDelta::seconds(60)
        );
        assert_eq!(
            policy.next_after_failure(now, 3),
            now + TimeDelta::seconds(240)
        );
        assert_eq!(
            policy.next_after_failure(now, 20),
            now + TimeDelta::minutes(30)
        );
    }

    #[test]
    fn canonical_comparison_tolerates_fragment_and_trailing_slash_only() {
        let a = Url::parse("https://example.com/product/#details").unwrap();
        let b = Url::parse("https://example.com/product").unwrap();
        assert_eq!(canonical_request_url(&a), canonical_request_url(&b));
    }
}
