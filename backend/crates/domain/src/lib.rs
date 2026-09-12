use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProductCondition {
    New,
    Refurbished,
    Used,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CanonicalProduct {
    pub name: String,
    pub brand: Option<String>,
    pub model: Option<String>,
    pub identifiers: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PurchaseConstraints {
    pub maximum_total_minor: i64,
    pub currency: String,
    pub condition: Option<ProductCondition>,
    pub variants: HashMap<String, String>,
    pub bundles_allowed: bool,
    pub approved_retailers: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MonitorStatus {
    Active,
    Evaluating,
    Executing,
    Purchased,
    PaymentRequired,
    Failed,
    Expired,
    Cancelled,
}

impl MonitorStatus {
    pub fn can_transition_to(self, next: Self) -> bool {
        use MonitorStatus::*;
        matches!(
            (self, next),
            (Active, Evaluating | Expired | Cancelled)
                | (Evaluating, Active | Executing | Expired | Cancelled)
                | (Executing, Purchased | Active | PaymentRequired | Failed)
                | (PaymentRequired, Active | Cancelled | Expired)
                | (Failed, Active | Cancelled)
                | (Purchased, Purchased)
                | (Expired, Expired)
                | (Cancelled, Cancelled)
        )
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Purchased | Self::Expired | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Monitor {
    pub id: Uuid,
    pub url: Url,
    pub product: Option<CanonicalProduct>,
    pub constraints: PurchaseConstraints,
    pub deadline: DateTime<Utc>,
    pub status: MonitorStatus,
    pub check_interval_seconds: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchedPage {
    pub requested_url: Url,
    pub final_url: Url,
    pub status: u16,
    pub html: String,
    pub fetched_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedOffer {
    pub product: CanonicalProduct,
    pub retailer: String,
    pub available: bool,
    pub item_price_minor: Option<i64>,
    pub shipping_minor: Option<i64>,
    pub total_minor: Option<i64>,
    pub currency: Option<String>,
    pub condition: Option<ProductCondition>,
    pub variants: HashMap<String, String>,
    pub source_url: Url,
    pub checked_at: DateTime<Utc>,
}

#[derive(Debug, thiserror::Error)]
pub enum OfferSourceError {
    #[error("invalid or unsafe URL: {0}")]
    UnsafeUrl(String),
    #[error("fetch failed: {0}")]
    Fetch(String),
    #[error("offer extraction failed: {0}")]
    Extraction(String),
}

#[async_trait]
pub trait OfferSource: Send + Sync {
    async fn check(&self, monitor: &Monitor) -> Result<NormalizedOffer, OfferSourceError>;
    async fn revalidate(
        &self,
        offer: &NormalizedOffer,
    ) -> Result<NormalizedOffer, OfferSourceError>;
}

#[cfg(test)]
mod tests {
    use super::MonitorStatus;

    #[test]
    fn state_machine_allows_the_purchase_path() {
        assert!(MonitorStatus::Active.can_transition_to(MonitorStatus::Evaluating));
        assert!(MonitorStatus::Evaluating.can_transition_to(MonitorStatus::Executing));
        assert!(MonitorStatus::Executing.can_transition_to(MonitorStatus::Purchased));
        assert!(MonitorStatus::Purchased.is_terminal());
    }

    #[test]
    fn state_machine_rejects_skipping_execution() {
        assert!(!MonitorStatus::Active.can_transition_to(MonitorStatus::Purchased));
        assert!(!MonitorStatus::Cancelled.can_transition_to(MonitorStatus::Active));
    }
}
