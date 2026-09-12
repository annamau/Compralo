use chrono::{DateTime, Utc};
use domain::{Monitor, MonitorStatus, NormalizedOffer};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectionReason {
    MonitorNotActive,
    DeadlineExpired,
    ProductMismatch,
    VariantMismatch {
        key: String,
        expected: String,
        actual: Option<String>,
    },
    BundleNotAllowed,
    ConditionMismatch,
    RetailerNotApproved,
    OutOfStock,
    CurrencyUnknown,
    CurrencyMismatch,
    ItemPriceUnknown,
    ShippingUnknown,
    TotalUnknown,
    TotalAboveMaximum {
        maximum: i64,
        actual: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", content = "reasons", rename_all = "snake_case")]
pub enum EvaluationDecision {
    Qualified,
    Rejected(Vec<RejectionReason>),
}

pub fn evaluate(
    monitor: &Monitor,
    offer: &NormalizedOffer,
    now: DateTime<Utc>,
) -> EvaluationDecision {
    let mut reasons = Vec::new();
    if monitor.status != MonitorStatus::Active
        && monitor.status != MonitorStatus::Evaluating
        && monitor.status != MonitorStatus::Executing
    {
        reasons.push(RejectionReason::MonitorNotActive);
    }
    if now >= monitor.deadline {
        reasons.push(RejectionReason::DeadlineExpired);
    }
    if let Some(expected) = &monitor.product {
        let identifier_match = expected.identifiers.iter().any(|(kind, value)| {
            offer
                .product
                .identifiers
                .get(kind)
                .is_some_and(|actual| actual.eq_ignore_ascii_case(value))
        });
        let model_match = match (&expected.model, &offer.product.model) {
            (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
            _ => expected.name.eq_ignore_ascii_case(&offer.product.name),
        };
        if !identifier_match && !model_match {
            reasons.push(RejectionReason::ProductMismatch);
        }
    }
    for (key, expected) in &monitor.constraints.variants {
        let actual = offer.variants.get(key);
        if !actual.is_some_and(|value| value.eq_ignore_ascii_case(expected)) {
            reasons.push(RejectionReason::VariantMismatch {
                key: key.clone(),
                expected: expected.clone(),
                actual: actual.cloned(),
            });
        }
    }
    if !monitor.constraints.bundles_allowed
        && offer
            .variants
            .get("bundle")
            .is_some_and(|v| !v.eq_ignore_ascii_case("none") && v != "false")
    {
        reasons.push(RejectionReason::BundleNotAllowed);
    }
    if monitor
        .constraints
        .condition
        .as_ref()
        .is_some_and(|expected| offer.condition.as_ref() != Some(expected))
    {
        reasons.push(RejectionReason::ConditionMismatch);
    }
    if !monitor.constraints.approved_retailers.is_empty()
        && !monitor
            .constraints
            .approved_retailers
            .iter()
            .any(|r| r.eq_ignore_ascii_case(&offer.retailer))
    {
        reasons.push(RejectionReason::RetailerNotApproved);
    }
    if !offer.available {
        reasons.push(RejectionReason::OutOfStock);
    }
    match &offer.currency {
        None => reasons.push(RejectionReason::CurrencyUnknown),
        Some(currency) if !currency.eq_ignore_ascii_case(&monitor.constraints.currency) => {
            reasons.push(RejectionReason::CurrencyMismatch)
        }
        _ => {}
    }
    if offer.item_price_minor.is_none() {
        reasons.push(RejectionReason::ItemPriceUnknown);
    }
    if offer.shipping_minor.is_none() {
        reasons.push(RejectionReason::ShippingUnknown);
    }
    match offer.total_minor {
        None => reasons.push(RejectionReason::TotalUnknown),
        Some(total) if total > monitor.constraints.maximum_total_minor => {
            reasons.push(RejectionReason::TotalAboveMaximum {
                maximum: monitor.constraints.maximum_total_minor,
                actual: total,
            })
        }
        _ => {}
    }
    if reasons.is_empty() {
        EvaluationDecision::Qualified
    } else {
        EvaluationDecision::Rejected(reasons)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use domain::{CanonicalProduct, ProductCondition, PurchaseConstraints};
    use std::collections::HashMap;
    use url::Url;
    use uuid::Uuid;

    fn monitor() -> Monitor {
        Monitor {
            id: Uuid::new_v4(),
            url: Url::parse("https://shop.example/ps5").unwrap(),
            product: Some(CanonicalProduct {
                name: "PS5 Slim Digital".into(),
                brand: Some("Sony".into()),
                model: Some("CFI-2016B".into()),
                identifiers: HashMap::new(),
            }),
            constraints: PurchaseConstraints {
                maximum_total_minor: 45_000,
                currency: "EUR".into(),
                condition: Some(ProductCondition::New),
                variants: HashMap::from([("edition".into(), "digital".into())]),
                bundles_allowed: false,
                approved_retailers: vec!["demo".into()],
            },
            deadline: Utc::now() + Duration::days(30),
            status: MonitorStatus::Active,
            check_interval_seconds: 60,
            created_at: Utc::now(),
        }
    }
    fn offer() -> NormalizedOffer {
        NormalizedOffer {
            product: monitor().product.unwrap(),
            retailer: "demo".into(),
            available: true,
            item_price_minor: Some(44_800),
            shipping_minor: Some(0),
            total_minor: Some(44_800),
            currency: Some("EUR".into()),
            condition: Some(ProductCondition::New),
            variants: HashMap::from([("edition".into(), "digital".into())]),
            source_url: Url::parse("https://shop.example/ps5").unwrap(),
            checked_at: Utc::now(),
        }
    }
    #[test]
    fn qualifies_exact_offer() {
        assert_eq!(
            evaluate(&monitor(), &offer(), Utc::now()),
            EvaluationDecision::Qualified
        );
    }
    #[test]
    fn rejects_wrong_variant_and_total() {
        let mut offer = offer();
        offer.variants.insert("edition".into(), "disc".into());
        offer.total_minor = Some(46_000);
        let EvaluationDecision::Rejected(reasons) = evaluate(&monitor(), &offer, Utc::now()) else {
            panic!()
        };
        assert!(
            reasons
                .iter()
                .any(|r| matches!(r, RejectionReason::VariantMismatch { .. }))
        );
        assert!(
            reasons
                .iter()
                .any(|r| matches!(r, RejectionReason::TotalAboveMaximum { .. }))
        );
    }
    #[test]
    fn accepts_exact_limit() {
        let mut o = offer();
        o.total_minor = Some(45_000);
        assert_eq!(
            evaluate(&monitor(), &o, Utc::now()),
            EvaluationDecision::Qualified
        );
    }
}
