//! P4 money service, spoken over HTTP.
//!
//! P4 owns the Stripe mandate hold and the aggregator that places the order. This crate is the
//! Rust side of that contract:
//!
//! ```text
//!   supports()   -> GET  /coverage                 where P4 can actually buy
//!   checkout()   -> POST /checkout                 capture the hold, then order
//!   find_order() -> GET  /purchases/{key}          did a previous attempt already buy?
//!   commit()     -> POST /funds/commit             the mandate hold, at arm time
//!   release()    -> POST /funds/release            every terminal state lands here
//! ```
//!
//! Two rules survive from `CONTRACTS.md` and must not be optimised away:
//!
//! 1. **The ceiling is not enforced here.** `checkout` never compares the offer total to the
//!    mandate before calling P4. Stripe refuses an over-mandate capture with `amount_too_large`,
//!    and that refusal is the evidence the ceiling lives outside our process.
//! 2. **An ambiguous checkout is [`CheckoutResult::Unknown`], never a failure.** A timeout or an
//!    undecodable body may still have bought something; the engine resolves it through
//!    `find_order` rather than retrying blind. A double purchase is the one unacceptable bug.

use std::{
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use domain::{Monitor, NormalizedOffer};
use execution::{CheckoutResult, ConfirmedOrder, Merchant, MerchantError};
use serde::Deserialize;
use uuid::Uuid;

/// How long a `/coverage` snapshot is trusted before a refresh is triggered.
const COVERAGE_TTL: Duration = Duration::from_secs(60);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(90);

pub const DEFAULT_P4_URL: &str = "http://localhost:4242";

#[derive(Debug, thiserror::Error)]
pub enum P4Error {
    #[error("p4 unreachable: {0}")]
    Transport(String),
    #[error("p4 returned {status}: {body}")]
    Status { status: u16, body: String },
    #[error("p4 sent a body we could not read: {0}")]
    Decode(String),
}

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .expect("reqwest client builds with default roots")
}

fn base(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

// ─────────────────────────────── wire types ───────────────────────────────

/// `GET /coverage`. `retailers` is the aggregator's list; `market` is the demo storefront.
/// Both are places P4 can complete a purchase, so both count as covered.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CoverageResponse {
    #[serde(default)]
    pub retailers: Vec<String>,
    #[serde(default)]
    pub market: Vec<String>,
}

impl CoverageResponse {
    pub fn into_retailers(self) -> Vec<String> {
        self.retailers.into_iter().chain(self.market).collect()
    }
}

/// `POST /checkout` and `GET /purchases/{key}` share this shape.
#[derive(Debug, Clone, Deserialize)]
pub struct CheckoutResponse {
    pub status: String,
    #[serde(default)]
    pub order_ref: Option<String>,
    #[serde(default)]
    pub total_cents: Option<i64>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub decline_reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub zinc_order_id: Option<String>,
    #[serde(default)]
    pub merchant_order_id: Option<String>,
}

impl CheckoutResponse {
    /// The order a `PURCHASED` body describes, when it carries enough to name one.
    pub fn confirmed_order(&self) -> Option<ConfirmedOrder> {
        let id = self
            .order_ref
            .clone()
            .or_else(|| self.zinc_order_id.clone())
            .or_else(|| self.merchant_order_id.clone())?;
        Some(ConfirmedOrder {
            id,
            total_minor: self.total_cents?,
            // Stripe answers in lowercase; the domain carries "EUR" everywhere else.
            currency: self
                .currency
                .clone()
                .unwrap_or_else(|| "EUR".into())
                .to_uppercase(),
        })
    }

    /// Stripe's own words, kept verbatim — P2 renders this line unedited.
    fn decline_line(&self) -> String {
        match (self.decline_reason.as_deref(), self.message.as_deref()) {
            (Some(reason), Some(message)) => format!("{reason}: {message}"),
            (Some(reason), None) => reason.to_string(),
            (None, Some(message)) => message.to_string(),
            (None, None) => format!("p4 reported {}", self.status.to_lowercase()),
        }
    }

    /// The contract's five statuses, mapped onto the engine's four outcomes.
    pub fn into_result(self) -> CheckoutResult {
        match self.status.to_ascii_uppercase().as_str() {
            "PURCHASED" => match self.confirmed_order() {
                Some(order) => CheckoutResult::Confirmed(order),
                // P4 says it bought but did not say what. Never call that a failure.
                None => CheckoutResult::Unknown,
            },
            "NEEDS_ATTENTION" => CheckoutResult::PaymentRequired,
            "DECLINED" | "FAILED" => CheckoutResult::Declined(self.decline_line()),
            _ => CheckoutResult::Unknown,
        }
    }
}

/// `POST /funds/commit`.
#[derive(Debug, Clone, Deserialize)]
pub struct CommitResponse {
    pub hold_id: String,
    pub status: String,
    #[serde(default)]
    pub expires: Option<String>,
    #[serde(default)]
    pub committed_cents: Option<i64>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

impl CommitResponse {
    /// 3DS did not finish at arm time: the hold exists but cannot be captured yet.
    pub fn needs_attention(&self) -> bool {
        self.status.eq_ignore_ascii_case("needs_attention")
    }
}

/// `POST /funds/release`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseResponse {
    pub status: String,
    #[serde(default)]
    pub amount_cents: Option<i64>,
    #[serde(default)]
    pub message: Option<String>,
}

// ─────────────────────────────── funds ───────────────────────────────

/// The money half of P4: the mandate hold at arm time, and its release at every terminal state.
#[derive(Clone)]
pub struct P4Funds {
    http: reqwest::Client,
    base: String,
}

impl P4Funds {
    pub fn new(url: &str) -> Self {
        Self {
            http: client(DEFAULT_TIMEOUT),
            base: base(url),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// Authorize the mandate ceiling. `attempt` must change on a re-arm or P4's idempotency key
    /// hands back the previous hold.
    pub async fn commit(
        &self,
        monitor_id: Uuid,
        maximum_minor: i64,
        currency: &str,
        attempt: i64,
    ) -> Result<CommitResponse, P4Error> {
        let body = serde_json::json!({
            "monitor_id": monitor_id,
            "maximum_minor": maximum_minor,
            "currency": currency,
            "attempt": attempt,
        });
        let response = self
            .http
            .post(format!("{}/funds/commit", self.base))
            .json(&body)
            .send()
            .await
            .map_err(|e| P4Error::Transport(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(P4Error::Status {
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        response
            .json()
            .await
            .map_err(|e| P4Error::Decode(e.to_string()))
    }

    /// Give the hold back. Idempotent at P4; `Ok(None)` means there was no hold to release.
    pub async fn release(
        &self,
        monitor_id: Uuid,
        reason: &str,
    ) -> Result<Option<ReleaseResponse>, P4Error> {
        let body = serde_json::json!({ "monitor_id": monitor_id, "reason": reason });
        let response = self
            .http
            .post(format!("{}/funds/release", self.base))
            .json(&body)
            .send()
            .await
            .map_err(|e| P4Error::Transport(e.to_string()))?;
        let status = response.status();
        if status.as_u16() == 404 {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(P4Error::Status {
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        response
            .json()
            .await
            .map(Some)
            .map_err(|e| P4Error::Decode(e.to_string()))
    }

    /// Release and log; never let money cleanup block a state change that already happened.
    pub async fn release_best_effort(&self, monitor_id: Uuid, reason: &str) {
        match self.release(monitor_id, reason).await {
            Ok(Some(response)) => {
                tracing::info!(%monitor_id, status = %response.status, reason, "p4 hold release")
            }
            Ok(None) => tracing::debug!(%monitor_id, reason, "p4 had no hold to release"),
            Err(error) => tracing::warn!(%monitor_id, %error, reason, "p4 hold release failed"),
        }
    }
}

// ─────────────────────────────── merchant ───────────────────────────────

#[derive(Debug, Default)]
struct CoverageCache {
    retailers: Vec<String>,
    fetched_at: Option<Instant>,
}

impl CoverageCache {
    fn is_stale(&self) -> bool {
        self.fetched_at
            .is_none_or(|fetched| fetched.elapsed() >= COVERAGE_TTL)
    }
}

/// [`Merchant`] implemented over P4's HTTP surface.
#[derive(Clone)]
pub struct P4Merchant {
    http: reqwest::Client,
    base: String,
    demo_fallback: bool,
    coverage: Arc<RwLock<CoverageCache>>,
    refreshing: Arc<AtomicBool>,
}

impl P4Merchant {
    pub fn new(url: &str) -> Self {
        Self {
            http: client(DEFAULT_TIMEOUT),
            base: base(url),
            demo_fallback: false,
            coverage: Arc::new(RwLock::new(CoverageCache::default())),
            refreshing: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Also accept the in-process demo retailer, so `MERCHANT=p4` can still run the demo script.
    pub fn with_demo_fallback(mut self, enabled: bool) -> Self {
        self.demo_fallback = enabled;
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// Load `/coverage` once, up front. `supports` is synchronous and must never block, so an
    /// unprimed merchant reports "not covered" until the first background refresh lands.
    pub async fn prime(&self) -> Result<Vec<String>, P4Error> {
        let retailers = Self::fetch_coverage(&self.http, &self.base).await?;
        self.store_coverage(retailers.clone());
        Ok(retailers)
    }

    pub fn covered_retailers(&self) -> Vec<String> {
        self.coverage
            .read()
            .map(|c| c.retailers.clone())
            .unwrap_or_default()
    }

    fn store_coverage(&self, retailers: Vec<String>) {
        if let Ok(mut cache) = self.coverage.write() {
            cache.retailers = retailers;
            cache.fetched_at = Some(Instant::now());
        }
    }

    async fn fetch_coverage(http: &reqwest::Client, base: &str) -> Result<Vec<String>, P4Error> {
        let response = http
            .get(format!("{base}/coverage"))
            .send()
            .await
            .map_err(|e| P4Error::Transport(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(P4Error::Status {
                status: status.as_u16(),
                body: response.text().await.unwrap_or_default(),
            });
        }
        let body: CoverageResponse = response
            .json()
            .await
            .map_err(|e| P4Error::Decode(e.to_string()))?;
        Ok(body.into_retailers())
    }

    /// Refresh in the background. `supports` is on the hot path and stays lock-free and sync.
    fn spawn_refresh(&self) {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.refreshing.store(false, Ordering::Release);
            return;
        };
        let (http, base) = (self.http.clone(), self.base.clone());
        let (coverage, refreshing) = (self.coverage.clone(), self.refreshing.clone());
        handle.spawn(async move {
            match Self::fetch_coverage(&http, &base).await {
                Ok(retailers) => {
                    if let Ok(mut cache) = coverage.write() {
                        cache.retailers = retailers;
                        cache.fetched_at = Some(Instant::now());
                    }
                }
                Err(error) => tracing::warn!(%error, "p4 coverage refresh failed"),
            }
            refreshing.store(false, Ordering::Release);
        });
    }
}

#[async_trait]
impl Merchant for P4Merchant {
    fn supports(&self, offer: &NormalizedOffer) -> bool {
        if self.demo_fallback && offer.retailer.eq_ignore_ascii_case("demo") {
            return true;
        }
        let (covered, stale) = match self.coverage.read() {
            Ok(cache) => (
                cache
                    .retailers
                    .iter()
                    .any(|r| r.eq_ignore_ascii_case(&offer.retailer)),
                cache.is_stale(),
            ),
            Err(_) => (false, true),
        };
        if stale {
            self.spawn_refresh();
        }
        covered
    }

    async fn checkout(
        &self,
        monitor: &Monitor,
        offer: &NormalizedOffer,
        idempotency_key: &str,
    ) -> Result<CheckoutResult, MerchantError> {
        // No ceiling check here, on purpose. Stripe refuses an over-mandate capture and that
        // refusal is the demo's proof the limit is enforced outside this process.
        let body = serde_json::json!({
            "monitor_id": monitor.id,
            "idempotency_key": idempotency_key,
            "offer": {
                "source_url": offer.source_url,
                "url": offer.source_url,
                "retailer": offer.retailer,
                "total_minor": offer.total_minor,
                "currency": offer.currency,
            },
        });
        let response = match self
            .http
            .post(format!("{}/checkout", self.base))
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            // Never reached P4: nothing was captured, nothing was ordered.
            Err(error) if error.is_connect() => {
                return Err(MerchantError::Unavailable(error.to_string()));
            }
            // Timed out, or died mid-response. P4 may have bought. Resolve through find_order.
            Err(error) => {
                tracing::warn!(%error, "p4 checkout left an unknown result");
                return Ok(CheckoutResult::Unknown);
            }
        };
        let status = response.status();
        if !status.is_success() {
            // P4 answers every money outcome with 200; a non-2xx is a malformed request.
            return Err(MerchantError::Unavailable(format!(
                "p4 checkout returned {}: {}",
                status.as_u16(),
                response.text().await.unwrap_or_default()
            )));
        }
        match response.json::<CheckoutResponse>().await {
            Ok(parsed) => Ok(parsed.into_result()),
            Err(error) => {
                tracing::warn!(%error, "p4 checkout body was undecodable");
                Ok(CheckoutResult::Unknown)
            }
        }
    }

    async fn find_order(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<ConfirmedOrder>, MerchantError> {
        let response = self
            .http
            .get(format!("{}/purchases/{idempotency_key}", self.base))
            .send()
            .await
            .map_err(|e| MerchantError::Unavailable(e.to_string()))?;
        match response.status().as_u16() {
            200 => Ok(response
                .json::<CheckoutResponse>()
                .await
                .map_err(|e| MerchantError::Unavailable(e.to_string()))?
                .confirmed_order()),
            // 202: captured, but the retailer has not settled. Not a purchase we can confirm yet.
            202 | 404 => Ok(None),
            other => Err(MerchantError::Unavailable(format!(
                "p4 purchases returned {other}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> CheckoutResponse {
        serde_json::from_str(json).expect("fixture parses")
    }

    #[test]
    fn purchased_becomes_a_confirmed_order_with_an_uppercase_currency() {
        let result = parse(
            r#"{"status":"PURCHASED","order_ref":"W55917434","retailer":"amazon",
                "total_cents":24800,"currency":"eur","released_cents":200,
                "zinc_order_id":"zinc-123","monitor_id":"m1"}"#,
        )
        .into_result();
        assert_eq!(
            result,
            CheckoutResult::Confirmed(ConfirmedOrder {
                id: "W55917434".into(),
                total_minor: 24_800,
                currency: "EUR".into(),
            })
        );
    }

    #[test]
    fn purchased_falls_back_to_the_zinc_order_id_when_there_is_no_order_ref() {
        let result = parse(r#"{"status":"PURCHASED","total_cents":100,"zinc_order_id":"z-9"}"#)
            .into_result();
        assert_eq!(
            result,
            CheckoutResult::Confirmed(ConfirmedOrder {
                id: "z-9".into(),
                total_minor: 100,
                currency: "EUR".into(),
            })
        );
    }

    #[test]
    fn purchased_without_an_identifiable_order_is_unknown_not_failed() {
        assert_eq!(
            parse(r#"{"status":"PURCHASED","total_cents":100}"#).into_result(),
            CheckoutResult::Unknown
        );
    }

    /// Fixture 4: €465 against a €250 mandate. Stripe refuses; we only relay it.
    #[test]
    fn declined_carries_stripes_own_words() {
        assert_eq!(
            parse(
                r#"{"status":"DECLINED","decline_reason":"amount_too_large",
                    "message":"Amount to capture is greater than the authorized amount.",
                    "enforced_by":"stripe"}"#
            )
            .into_result(),
            CheckoutResult::Declined(
                "amount_too_large: Amount to capture is greater than the authorized amount.".into()
            )
        );
    }

    #[test]
    fn failed_is_a_decline_with_the_aggregators_reason() {
        assert_eq!(
            parse(
                r#"{"status":"FAILED","decline_reason":"out_of_stock",
                    "message":"Retailer did not complete the order","refunded_cents":24800}"#
            )
            .into_result(),
            CheckoutResult::Declined("out_of_stock: Retailer did not complete the order".into())
        );
    }

    #[test]
    fn needs_attention_is_a_payment_prompt() {
        assert_eq!(
            parse(r#"{"status":"NEEDS_ATTENTION","decline_reason":"authentication_required"}"#)
                .into_result(),
            CheckoutResult::PaymentRequired
        );
    }

    #[test]
    fn unknown_stays_unknown_so_the_engine_verifies_before_retrying() {
        assert_eq!(
            parse(
                r#"{"status":"UNKNOWN","message":"Order still pending at the retailer",
                    "captured_cents":24800,"zinc_order_id":"z-1"}"#
            )
            .into_result(),
            CheckoutResult::Unknown
        );
        assert_eq!(
            parse(r#"{"status":"something-new"}"#).into_result(),
            CheckoutResult::Unknown
        );
    }

    #[test]
    fn a_decline_with_no_reason_still_says_something() {
        assert_eq!(
            parse(r#"{"status":"DECLINED"}"#).into_result(),
            CheckoutResult::Declined("p4 reported declined".into())
        );
    }

    #[test]
    fn commit_distinguishes_a_committed_hold_from_one_awaiting_3ds() {
        let committed: CommitResponse = serde_json::from_str(
            r#"{"hold_id":"pi_1","status":"committed","expires":"2026-09-19T11:00:00.000Z",
                "committed_cents":25000,"currency":"eur","client_secret":"pi_1_secret_x"}"#,
        )
        .unwrap();
        assert!(!committed.needs_attention());
        assert_eq!(committed.hold_id, "pi_1");
        assert_eq!(committed.committed_cents, Some(25_000));

        let pending: CommitResponse = serde_json::from_str(
            r#"{"hold_id":"pi_2","status":"needs_attention","expires":"2026-09-19T11:00:00.000Z",
                "committed_cents":25000,"currency":"eur","client_secret":"pi_2_secret_x",
                "reason":"authentication_required","message":"Your bank wants to confirm this hold."}"#,
        )
        .unwrap();
        assert!(pending.needs_attention());
        assert_eq!(pending.reason.as_deref(), Some("authentication_required"));
    }

    #[test]
    fn coverage_folds_the_market_storefronts_in_with_the_aggregator() {
        let coverage: CoverageResponse = serde_json::from_str(
            r#"{"retailers":["amazon","amazon_de","bestbuy"],"market":["store-a","store-b"]}"#,
        )
        .unwrap();
        assert_eq!(
            coverage.into_retailers(),
            vec!["amazon", "amazon_de", "bestbuy", "store-a", "store-b"]
        );
    }

    #[test]
    fn release_reports_spent_holds_without_erroring() {
        let spent: ReleaseResponse = serde_json::from_str(
            r#"{"status":"spent","message":"Funds were captured for a purchase",
                "hold_id":"pi_1","amount_cents":25000}"#,
        )
        .unwrap();
        assert_eq!(spent.status, "spent");
        assert_eq!(spent.amount_cents, Some(25_000));
    }

    #[tokio::test]
    async fn supports_is_false_until_coverage_is_primed_and_honours_the_demo_fallback() {
        let merchant = P4Merchant::new("http://127.0.0.1:1").with_demo_fallback(true);
        let offer = crate::tests_support::offer("amazon");
        assert!(!merchant.supports(&offer));
        assert!(merchant.supports(&crate::tests_support::offer("demo")));

        merchant.store_coverage(vec!["amazon".into(), "store-a".into()]);
        assert!(merchant.supports(&offer));
        assert!(merchant.supports(&crate::tests_support::offer("AMAZON")));
        assert!(merchant.supports(&crate::tests_support::offer("store-a")));
        assert!(!merchant.supports(&crate::tests_support::offer("walmart")));
    }

    #[tokio::test]
    async fn the_demo_fallback_is_off_by_default() {
        let merchant = P4Merchant::new("http://127.0.0.1:1");
        merchant.store_coverage(vec!["amazon".into()]);
        assert!(!merchant.supports(&crate::tests_support::offer("demo")));
    }
}

#[cfg(test)]
mod tests_support {
    use chrono::Utc;
    use domain::{CanonicalProduct, NormalizedOffer, ProductCondition};
    use std::collections::HashMap;
    use url::Url;

    pub fn offer(retailer: &str) -> NormalizedOffer {
        NormalizedOffer {
            product: CanonicalProduct {
                name: "PS5 Slim Digital".into(),
                brand: Some("Sony".into()),
                model: Some("CFI-2016B".into()),
                identifiers: HashMap::new(),
            },
            retailer: retailer.into(),
            available: true,
            item_price_minor: Some(24_800),
            shipping_minor: Some(0),
            total_minor: Some(24_800),
            currency: Some("EUR".into()),
            condition: Some(ProductCondition::New),
            variants: HashMap::new(),
            source_url: Url::parse("https://zinc.com/shop/products/test-success").unwrap(),
            checked_at: Utc::now(),
        }
    }
}
