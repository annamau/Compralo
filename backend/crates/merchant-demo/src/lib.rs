use async_trait::async_trait;
use domain::{Monitor, NormalizedOffer};
use execution::{CheckoutResult, ConfirmedOrder, Merchant, MerchantError};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DemoOutcome {
    Success,
    PaymentRequired,
    Declined,
    TimeoutBeforeOrder,
    TimeoutAfterOrder,
}

#[derive(Clone)]
pub struct DemoMerchant {
    outcome: Arc<RwLock<DemoOutcome>>,
    orders: Arc<RwLock<HashMap<String, ConfirmedOrder>>>,
}

impl Default for DemoMerchant {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoMerchant {
    pub fn new() -> Self {
        Self {
            outcome: Arc::new(RwLock::new(DemoOutcome::Success)),
            orders: Arc::new(RwLock::new(HashMap::new())),
        }
    }
    pub async fn set_outcome(&self, outcome: DemoOutcome) {
        *self.outcome.write().await = outcome;
    }
    pub async fn order_count(&self) -> usize {
        self.orders.read().await.len()
    }
    fn make_order(offer: &NormalizedOffer) -> ConfirmedOrder {
        ConfirmedOrder {
            id: format!("demo-{}", Uuid::new_v4()),
            total_minor: offer.total_minor.expect("qualified offer has total"),
            currency: offer
                .currency
                .clone()
                .expect("qualified offer has currency"),
        }
    }
}

#[async_trait]
impl Merchant for DemoMerchant {
    fn supports(&self, offer: &NormalizedOffer) -> bool {
        offer.retailer.eq_ignore_ascii_case("demo")
    }

    async fn checkout(
        &self,
        _monitor: &Monitor,
        offer: &NormalizedOffer,
        key: &str,
    ) -> Result<CheckoutResult, MerchantError> {
        if let Some(existing) = self.orders.read().await.get(key).cloned() {
            return Ok(CheckoutResult::Confirmed(existing));
        }
        match *self.outcome.read().await {
            DemoOutcome::Success => {
                let order = Self::make_order(offer);
                self.orders.write().await.insert(key.into(), order.clone());
                Ok(CheckoutResult::Confirmed(order))
            }
            DemoOutcome::PaymentRequired => Ok(CheckoutResult::PaymentRequired),
            DemoOutcome::Declined => Ok(CheckoutResult::Declined("demo payment declined".into())),
            DemoOutcome::TimeoutBeforeOrder => Ok(CheckoutResult::Unknown),
            DemoOutcome::TimeoutAfterOrder => {
                let order = Self::make_order(offer);
                self.orders.write().await.insert(key.into(), order);
                Ok(CheckoutResult::Unknown)
            }
        }
    }

    async fn find_order(&self, key: &str) -> Result<Option<ConfirmedOrder>, MerchantError> {
        Ok(self.orders.read().await.get(key).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use domain::{CanonicalProduct, MonitorStatus, ProductCondition, PurchaseConstraints};
    use std::collections::HashMap;
    use url::Url;
    fn values() -> (Monitor, NormalizedOffer) {
        let product = CanonicalProduct {
            name: "Console".into(),
            brand: None,
            model: Some("X".into()),
            identifiers: HashMap::new(),
        };
        let offer = NormalizedOffer {
            product: product.clone(),
            retailer: "demo".into(),
            available: true,
            item_price_minor: Some(100),
            shipping_minor: Some(0),
            total_minor: Some(100),
            currency: Some("EUR".into()),
            condition: Some(ProductCondition::New),
            variants: HashMap::new(),
            source_url: Url::parse("https://demo.test/p").unwrap(),
            checked_at: Utc::now(),
        };
        let monitor = Monitor {
            id: Uuid::new_v4(),
            url: offer.source_url.clone(),
            product: Some(product),
            constraints: PurchaseConstraints {
                maximum_total_minor: 100,
                currency: "EUR".into(),
                condition: Some(ProductCondition::New),
                variants: HashMap::new(),
                bundles_allowed: false,
                approved_retailers: vec!["demo".into()],
            },
            deadline: Utc::now() + Duration::days(1),
            status: MonitorStatus::Active,
            check_interval_seconds: 60,
            created_at: Utc::now(),
        };
        (monitor, offer)
    }
    #[tokio::test]
    async fn checkout_is_idempotent() {
        let merchant = DemoMerchant::new();
        let (m, o) = values();
        let first = merchant.checkout(&m, &o, "same").await.unwrap();
        let second = merchant.checkout(&m, &o, "same").await.unwrap();
        assert_eq!(first, second);
        assert_eq!(merchant.order_count().await, 1);
    }
}
