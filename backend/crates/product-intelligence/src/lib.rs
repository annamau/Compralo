use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use domain::{CanonicalProduct, FetchedPage, NormalizedOffer, ProductCondition};
use rust_decimal::Decimal;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

#[derive(Debug, thiserror::Error)]
pub enum IntelligenceError {
    #[error("the page did not contain enough product data")]
    InsufficientData,
    #[error("retailer extractor failed: {0}")]
    Retailer(String),
    #[error("AI interpretation failed: {0}")]
    Ai(String),
}

pub trait RetailerExtractor: Send + Sync {
    fn supports(&self, url: &Url) -> bool;
    fn extract(&self, page: &FetchedPage) -> Result<Option<NormalizedOffer>, IntelligenceError>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageSummary {
    pub url: Url,
    pub title: Option<String>,
    pub metadata: HashMap<String, String>,
    pub visible_text: String,
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    async fn interpret(&self, summary: &PageSummary) -> Result<NormalizedOffer, IntelligenceError>;
}

/// Default AI implementation for deployments where no vendor has been configured.
pub struct DisabledAiProvider;

#[async_trait]
impl AiProvider for DisabledAiProvider {
    async fn interpret(
        &self,
        _summary: &PageSummary,
    ) -> Result<NormalizedOffer, IntelligenceError> {
        Err(IntelligenceError::Ai("no AI provider configured".into()))
    }
}

pub struct ProductInterpreter {
    retailer_extractors: Vec<Arc<dyn RetailerExtractor>>,
    ai: Option<Arc<dyn AiProvider>>,
}

impl Default for ProductInterpreter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProductInterpreter {
    pub fn new() -> Self {
        Self {
            retailer_extractors: Vec::new(),
            ai: None,
        }
    }

    pub fn with_retailer_extractor(mut self, extractor: Arc<dyn RetailerExtractor>) -> Self {
        self.retailer_extractors.push(extractor);
        self
    }

    pub fn with_ai_provider(mut self, provider: Arc<dyn AiProvider>) -> Self {
        self.ai = Some(provider);
        self
    }

    pub async fn extract(&self, page: &FetchedPage) -> Result<NormalizedOffer, IntelligenceError> {
        for extractor in &self.retailer_extractors {
            if extractor.supports(&page.final_url)
                && let Some(offer) = extractor.extract(page)?
            {
                return Ok(offer);
            }
        }
        if let Some(offer) = extract_json_ld(page).or_else(|| extract_metadata(page)) {
            return Ok(offer);
        }
        if let Some(ai) = &self.ai {
            return ai.interpret(&summarize(page)).await;
        }
        Err(IntelligenceError::InsufficientData)
    }
}

pub fn extract_json_ld(page: &FetchedPage) -> Option<NormalizedOffer> {
    let document = Html::parse_document(&page.html);
    let selector = Selector::parse("script[type='application/ld+json']").ok()?;
    for node in document.select(&selector) {
        let raw = node.text().collect::<String>();
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        for candidate in json_ld_candidates(&value) {
            if is_product(candidate)
                && let Some(offer) = product_from_json_ld(candidate, page)
            {
                return Some(offer);
            }
        }
    }
    None
}

pub fn extract_metadata(page: &FetchedPage) -> Option<NormalizedOffer> {
    let document = Html::parse_document(&page.html);
    let metadata = collect_metadata(&document);
    let name = metadata
        .get("og:title")
        .or_else(|| metadata.get("twitter:title"))
        .or_else(|| metadata.get("name"))?
        .trim()
        .to_string();
    if name.is_empty() {
        return None;
    }
    let item_price_minor = metadata
        .get("product:price:amount")
        .or_else(|| metadata.get("price"))
        .and_then(|v| price_to_minor(v));
    let currency = metadata
        .get("product:price:currency")
        .or_else(|| metadata.get("pricecurrency"))
        .map(|v| v.to_uppercase());
    let availability = metadata
        .get("product:availability")
        .or_else(|| metadata.get("availability"));
    let available = availability.map(|v| availability_value(v)).unwrap_or(false);
    let brand = metadata.get("product:brand").cloned();
    let mut identifiers = HashMap::new();
    if let Some(sku) = metadata
        .get("product:retailer_item_id")
        .or_else(|| metadata.get("sku"))
    {
        identifiers.insert("sku".into(), sku.clone());
    }
    Some(NormalizedOffer {
        product: CanonicalProduct {
            name,
            brand,
            model: metadata.get("model").cloned(),
            identifiers,
        },
        retailer: retailer_name(&page.final_url),
        available,
        item_price_minor,
        shipping_minor: None,
        total_minor: None,
        currency,
        condition: metadata.get("itemcondition").map(|v| parse_condition(v)),
        variants: HashMap::new(),
        source_url: page.final_url.clone(),
        checked_at: page.fetched_at,
    })
}

pub fn summarize(page: &FetchedPage) -> PageSummary {
    const MAX_TEXT_CHARS: usize = 8_000;
    let document = Html::parse_document(&page.html);
    let metadata = collect_metadata(&document);
    let title_selector = Selector::parse("title").expect("static selector");
    let title = document
        .select(&title_selector)
        .next()
        .map(|n| n.text().collect::<String>().trim().to_string())
        .filter(|s| !s.is_empty());
    let text_selector = Selector::parse("body").expect("static selector");
    let visible_text = document
        .select(&text_selector)
        .next()
        .map(|body| body.text().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TEXT_CHARS)
        .collect();
    PageSummary {
        url: page.final_url.clone(),
        title,
        metadata,
        visible_text,
    }
}

fn json_ld_candidates(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(values) => values.iter().collect(),
        Value::Object(map) => map
            .get("@graph")
            .and_then(Value::as_array)
            .map(|values| values.iter().collect())
            .unwrap_or_else(|| vec![value]),
        _ => Vec::new(),
    }
}

fn is_product(value: &Value) -> bool {
    match value.get("@type") {
        Some(Value::String(kind)) => kind.eq_ignore_ascii_case("product"),
        Some(Value::Array(kinds)) => kinds.iter().any(|k| {
            k.as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("product"))
        }),
        _ => false,
    }
}

fn product_from_json_ld(product: &Value, page: &FetchedPage) -> Option<NormalizedOffer> {
    let name = product.get("name")?.as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let offer = product.get("offers").and_then(first_object);
    let item_price_minor = offer
        .and_then(|o| o.get("price").or_else(|| o.get("lowPrice")))
        .and_then(value_to_price);
    let currency = offer
        .and_then(|o| o.get("priceCurrency"))
        .and_then(Value::as_str)
        .map(str::to_uppercase);
    let available = offer
        .and_then(|o| o.get("availability"))
        .and_then(Value::as_str)
        .map(availability_value)
        .unwrap_or(false);
    let shipping_minor = offer.and_then(extract_shipping);
    let total_minor = item_price_minor
        .zip(shipping_minor)
        .and_then(|(a, b)| a.checked_add(b));
    let mut identifiers = HashMap::new();
    for key in ["sku", "gtin", "gtin8", "gtin12", "gtin13", "gtin14", "mpn"] {
        if let Some(value) = product.get(key).and_then(Value::as_str) {
            identifiers.insert(key.to_string(), value.to_string());
        }
    }
    let brand = product
        .get("brand")
        .and_then(|v| v.as_str().or_else(|| v.get("name").and_then(Value::as_str)))
        .map(str::to_string);
    let condition = offer
        .and_then(|o| o.get("itemCondition"))
        .and_then(Value::as_str)
        .map(parse_condition);
    Some(NormalizedOffer {
        product: CanonicalProduct {
            name,
            brand,
            model: product
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            identifiers,
        },
        retailer: retailer_name(&page.final_url),
        available,
        item_price_minor,
        shipping_minor,
        total_minor,
        currency,
        condition,
        variants: extract_variants(product),
        source_url: page.final_url.clone(),
        checked_at: page.fetched_at,
    })
}

// Read explicit variant facts without inventing values when the page omits them.
fn extract_variants(product: &Value) -> HashMap<String, String> {
    let mut variants = HashMap::new();
    if let Some(properties) = product.get("additionalProperty") {
        let values = match properties {
            Value::Array(a) => a.iter().collect::<Vec<_>>(),
            other => vec![other],
        };
        for property in values {
            if let (Some(name), Some(value)) = (
                property.get("name").and_then(Value::as_str),
                property.get("value").and_then(Value::as_str),
            ) {
                variants.insert(
                    name.trim().to_lowercase().replace(' ', "_"),
                    value.trim().to_lowercase(),
                );
            }
        }
    }
    for key in ["color", "size", "material", "pattern"] {
        if let Some(value) = product.get(key).and_then(Value::as_str) {
            variants.insert(key.into(), value.trim().to_lowercase());
        }
    }
    variants
}

fn first_object(value: &Value) -> Option<&Value> {
    match value {
        Value::Object(_) => Some(value),
        Value::Array(values) => values.iter().find(|v| v.is_object()),
        _ => None,
    }
}

fn extract_shipping(offer: &Value) -> Option<i64> {
    let details = offer.get("shippingDetails").and_then(first_object)?;
    let rate = details.get("shippingRate")?;
    match rate {
        Value::Object(_) => rate.get("value").and_then(value_to_price),
        _ => value_to_price(rate),
    }
}

fn value_to_price(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(price_to_minor)
        .or_else(|| value.as_f64().and_then(|n| price_to_minor(&n.to_string())))
}

fn price_to_minor(value: &str) -> Option<i64> {
    use rust_decimal::prelude::ToPrimitive;
    let normalized = value.trim().replace(',', ".");
    normalized
        .parse::<Decimal>()
        .ok()?
        .checked_mul(Decimal::new(100, 0))?
        .round()
        .to_i64()
}

fn availability_value(value: &str) -> bool {
    let normalized = value
        .rsplit(['/', '#'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "instock" | "in_stock" | "available" | "limitedavailability"
    )
}

fn parse_condition(value: &str) -> ProductCondition {
    let value = value.to_ascii_lowercase();
    if value.contains("refurb") {
        ProductCondition::Refurbished
    } else if value.contains("used") {
        ProductCondition::Used
    } else if value.contains("new") {
        ProductCondition::New
    } else {
        ProductCondition::Unknown
    }
}

fn retailer_name(url: &Url) -> String {
    url.host_str()
        .unwrap_or("unknown")
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

fn collect_metadata(document: &Html) -> HashMap<String, String> {
    let selector = Selector::parse("meta").expect("static selector");
    document
        .select(&selector)
        .filter_map(|node| {
            let attrs = node.value();
            let key = attrs
                .attr("property")
                .or_else(|| attrs.attr("name"))
                .or_else(|| attrs.attr("itemprop"))?;
            let value = attrs.attr("content")?;
            Some((key.to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    #[test]
    fn reads_explicit_variants_without_inventing_missing_values() {
        let data = serde_json::json!({"additionalProperty": [
            {"name": "edition", "value": "Digital"},
            {"name": "storage", "value": "1TB"},
            {"name": "unknown"}
        ], "color": "White"});
        let variants = extract_variants(&data);
        assert_eq!(variants.get("edition").map(String::as_str), Some("digital"));
        assert_eq!(variants.get("storage").map(String::as_str), Some("1tb"));
        assert_eq!(variants.get("color").map(String::as_str), Some("white"));
        assert!(!variants.contains_key("unknown"));
        assert!(extract_variants(&serde_json::json!({})).is_empty());
    }

    fn page(html: &str) -> FetchedPage {
        let url = Url::parse("https://shop.example/products/ps5").unwrap();
        FetchedPage {
            requested_url: url.clone(),
            final_url: url,
            status: 200,
            html: html.into(),
            fetched_at: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
        }
    }

    #[test]
    fn extracts_json_ld_product_offer_and_shipping() {
        let offer =
            extract_json_ld(&page(include_str!("../tests/fixtures/ps5-jsonld.html"))).unwrap();
        assert_eq!(offer.product.name, "PlayStation 5 Slim Digital 1TB");
        assert_eq!(
            offer.product.identifiers.get("gtin13").unwrap(),
            "0711719577287"
        );
        assert_eq!(offer.item_price_minor, Some(43_999));
        assert_eq!(offer.shipping_minor, Some(599));
        assert_eq!(offer.total_minor, Some(44_598));
        assert_eq!(offer.currency.as_deref(), Some("EUR"));
        assert!(offer.available);
        assert_eq!(offer.condition, Some(ProductCondition::New));
    }

    #[test]
    fn extracts_open_graph_but_keeps_unknown_shipping_unsafe() {
        let offer =
            extract_metadata(&page(include_str!("../tests/fixtures/shoes-meta.html"))).unwrap();
        assert_eq!(offer.product.name, "Everyday Runner");
        assert_eq!(offer.item_price_minor, Some(17_450));
        assert_eq!(offer.shipping_minor, None);
        assert_eq!(offer.total_minor, None);
        assert!(offer.available);
    }

    #[test]
    fn summary_is_bounded() {
        let page = page(&format!("<html><body>{}</body></html>", "x".repeat(9_000)));
        assert_eq!(summarize(&page).visible_text.chars().count(), 8_000);
    }
}
