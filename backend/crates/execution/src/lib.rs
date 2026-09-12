use async_trait::async_trait;
use domain::{Monitor, NormalizedOffer, OfferSource};
use persistence::{Store, StoreError};
use rule_engine::{EvaluationDecision, evaluate};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmedOrder {
    pub id: String,
    pub total_minor: i64,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckoutResult {
    Confirmed(ConfirmedOrder),
    PaymentRequired,
    Declined(String),
    Unknown,
}

#[derive(Debug, thiserror::Error)]
pub enum MerchantError {
    #[error("merchant unavailable: {0}")]
    Unavailable(String),
}

#[async_trait]
pub trait Merchant: Send + Sync {
    fn supports(&self, offer: &NormalizedOffer) -> bool;

    async fn checkout(
        &self,
        monitor: &Monitor,
        offer: &NormalizedOffer,
        idempotency_key: &str,
    ) -> Result<CheckoutResult, MerchantError>;
    async fn find_order(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<ConfirmedOrder>, MerchantError>;
}

#[derive(Debug, thiserror::Error)]
pub enum ExecutionError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("offer source failed: {0}")]
    Source(String),
    #[error("merchant failed: {0}")]
    Merchant(String),
    #[error("offer no longer qualifies")]
    RevalidationRejected,
    #[error("retailer does not support automatic checkout")]
    UnsupportedMerchant,
    #[error("no payment authorization covers this purchase")]
    MissingPaymentAuthorization,
    #[error("payment authentication required")]
    PaymentRequired,
    #[error("payment declined: {0}")]
    Declined(String),
    #[error("merchant result remains unknown")]
    UnknownResult,
}

#[derive(Clone)]
pub struct ExecutionEngine {
    store: Store,
}

impl ExecutionEngine {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn execute(
        &self,
        monitor: &Monitor,
        offer: &NormalizedOffer,
        source: &dyn OfferSource,
        merchant: &dyn Merchant,
    ) -> Result<ConfirmedOrder, ExecutionError> {
        let key = format!("monitor:{}", monitor.id);
        if let Some(order) = merchant
            .find_order(&key)
            .await
            .map_err(|e| ExecutionError::Merchant(e.to_string()))?
        {
            return Ok(order);
        }
        if !merchant.supports(offer) {
            return Err(ExecutionError::UnsupportedMerchant);
        }
        let total = offer
            .total_minor
            .ok_or(ExecutionError::RevalidationRejected)?;
        let currency = offer
            .currency
            .as_deref()
            .ok_or(ExecutionError::RevalidationRejected)?;
        if !self
            .store
            .has_valid_payment_authorization(monitor.id, total, currency)
            .await?
        {
            return Err(ExecutionError::MissingPaymentAuthorization);
        }
        let attempt = self.store.claim_execution(monitor.id, &key).await?;
        let current = self.store.get_monitor(monitor.id).await?;
        let revalidated = match source.revalidate(offer).await {
            Ok(value) => value,
            Err(error) => {
                self.store
                    .fail_execution(monitor.id, attempt, false, &error.to_string())
                    .await?;
                return Err(ExecutionError::Source(error.to_string()));
            }
        };
        if !matches!(
            evaluate(&current, &revalidated, chrono::Utc::now()),
            EvaluationDecision::Qualified
        ) {
            self.store
                .fail_execution(monitor.id, attempt, false, "offer failed revalidation")
                .await?;
            return Err(ExecutionError::RevalidationRejected);
        }
        let result = merchant
            .checkout(&current, &revalidated, &key)
            .await
            .map_err(|e| ExecutionError::Merchant(e.to_string()))?;
        match result {
            CheckoutResult::Confirmed(order) => {
                self.store
                    .complete_execution(
                        monitor.id,
                        attempt,
                        &order.id,
                        order.total_minor,
                        &order.currency,
                        &key,
                    )
                    .await?;
                Ok(order)
            }
            CheckoutResult::PaymentRequired => {
                self.store
                    .fail_execution(monitor.id, attempt, true, "payment authentication required")
                    .await?;
                Err(ExecutionError::PaymentRequired)
            }
            CheckoutResult::Declined(reason) => {
                self.store
                    .fail_execution(monitor.id, attempt, false, &reason)
                    .await?;
                Err(ExecutionError::Declined(reason))
            }
            CheckoutResult::Unknown => {
                if let Some(order) = merchant
                    .find_order(&key)
                    .await
                    .map_err(|e| ExecutionError::Merchant(e.to_string()))?
                {
                    self.store
                        .complete_execution(
                            monitor.id,
                            attempt,
                            &order.id,
                            order.total_minor,
                            &order.currency,
                            &key,
                        )
                        .await?;
                    Ok(order)
                } else {
                    self.store
                        .fail_execution(monitor.id, attempt, false, "unknown checkout result")
                        .await?;
                    Err(ExecutionError::UnknownResult)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use domain::{
        CanonicalProduct, MonitorStatus, OfferSourceError, ProductCondition, PurchaseConstraints,
    };
    use std::collections::HashMap;
    use url::Url;
    use uuid::Uuid;

    #[derive(Clone)]
    struct StaticSource(NormalizedOffer);
    #[async_trait]
    impl OfferSource for StaticSource {
        async fn check(&self, _: &Monitor) -> Result<NormalizedOffer, OfferSourceError> {
            Ok(self.0.clone())
        }
        async fn revalidate(
            &self,
            _: &NormalizedOffer,
        ) -> Result<NormalizedOffer, OfferSourceError> {
            Ok(self.0.clone())
        }
    }

    struct SuccessfulMerchant;
    #[async_trait]
    impl Merchant for SuccessfulMerchant {
        fn supports(&self, _: &NormalizedOffer) -> bool {
            true
        }

        async fn checkout(
            &self,
            _: &Monitor,
            _: &NormalizedOffer,
            _: &str,
        ) -> Result<CheckoutResult, MerchantError> {
            Ok(CheckoutResult::Confirmed(ConfirmedOrder {
                id: "order-1".into(),
                total_minor: 44_800,
                currency: "EUR".into(),
            }))
        }
        async fn find_order(&self, _: &str) -> Result<Option<ConfirmedOrder>, MerchantError> {
            Ok(None)
        }
    }

    fn values() -> (Monitor, NormalizedOffer) {
        let product = CanonicalProduct {
            name: "PS5 Slim Digital".into(),
            brand: Some("Sony".into()),
            model: Some("CFI-2016B".into()),
            identifiers: HashMap::new(),
        };
        let url = Url::parse("https://demo.example/ps5").unwrap();
        let offer = NormalizedOffer {
            product: product.clone(),
            retailer: "demo".into(),
            available: true,
            item_price_minor: Some(44_800),
            shipping_minor: Some(0),
            total_minor: Some(44_800),
            currency: Some("EUR".into()),
            condition: Some(ProductCondition::New),
            variants: HashMap::from([("edition".into(), "digital".into())]),
            source_url: url.clone(),
            checked_at: Utc::now(),
        };
        let monitor = Monitor {
            id: Uuid::new_v4(),
            url,
            product: Some(product),
            constraints: PurchaseConstraints {
                maximum_total_minor: 45_000,
                currency: "EUR".into(),
                condition: Some(ProductCondition::New),
                variants: HashMap::from([("edition".into(), "digital".into())]),
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
    async fn qualified_offer_is_confirmed_once_and_stops_monitoring() {
        let store = Store::in_memory().await.unwrap();
        store.migrate().await.unwrap();
        let (monitor, offer) = values();
        store.create_monitor(&monitor).await.unwrap();
        store
            .create_payment_authorization(monitor.id, 45_000, "EUR")
            .await
            .unwrap();
        let order = ExecutionEngine::new(store.clone())
            .execute(
                &monitor,
                &offer,
                &StaticSource(offer.clone()),
                &SuccessfulMerchant,
            )
            .await
            .unwrap();
        assert_eq!(order.id, "order-1");
        assert_eq!(
            store.get_monitor(monitor.id).await.unwrap().status,
            MonitorStatus::Purchased
        );
        assert!(
            store
                .claim_due_job("worker", Duration::seconds(30))
                .await
                .unwrap()
                .is_none()
        );
    }
}
