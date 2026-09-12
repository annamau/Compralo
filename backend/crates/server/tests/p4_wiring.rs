//! End-to-end wiring against a running P4 money service.
//!
//! These drive the real worker, the real execution engine and the real rule engine against a
//! live P4 — which means real Stripe test-mode holds and real Zinc sandbox orders. They skip
//! themselves when P4 is not listening, so `cargo test --workspace` stays green on a laptop
//! with nothing else running.
//!
//! Start the service first:
//!
//! ```sh
//! cd ../Compralo/money && PORT=4242 npm start          # http://localhost:4242
//! P4_URL=http://localhost:4242 cargo test -p server --test p4_wiring -- --nocapture
//! ```

use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::{Duration as ChronoDuration, Utc};
use domain::{
    CanonicalProduct, Monitor, MonitorStatus, NormalizedOffer, OfferSource, OfferSourceError,
    ProductCondition, PurchaseConstraints,
};
use merchant_p4::{DEFAULT_P4_URL, P4Funds, P4Merchant};
use persistence::Store;
use rule_engine::{EvaluationDecision, RejectionReason};
use server::MonitorWorker;
use url::Url;
use uuid::Uuid;

/// Zinc's sandbox rehearsal slug that always settles as `order_placed`.
const ZINC_SUCCESS: &str = "https://zinc.com/shop/products/test-success";

/// `Some(url)` when P4 answers `/health`; `None` (and a skip note) otherwise.
async fn live_p4() -> Option<String> {
    let url = std::env::var("P4_URL").unwrap_or_else(|_| DEFAULT_P4_URL.into());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1_500))
        .build()
        .ok()?;
    match client.get(format!("{url}/health")).send().await {
        Ok(response) if response.status().is_success() => Some(url),
        _ => {
            eprintln!("SKIP: no P4 money service at {url} (start it with `cd ../Compralo/money && PORT=4242 npm start`)");
            None
        }
    }
}

#[derive(Clone)]
struct StaticSource(NormalizedOffer);

#[async_trait::async_trait]
impl OfferSource for StaticSource {
    async fn check(&self, _: &Monitor) -> Result<NormalizedOffer, OfferSourceError> {
        Ok(self.0.clone())
    }
    async fn revalidate(&self, _: &NormalizedOffer) -> Result<NormalizedOffer, OfferSourceError> {
        Ok(self.0.clone())
    }
}

fn product() -> CanonicalProduct {
    CanonicalProduct {
        name: "PS5 Slim Digital".into(),
        brand: Some("Sony".into()),
        model: Some("CFI-2016B".into()),
        identifiers: HashMap::new(),
    }
}

fn monitor(maximum_total_minor: i64) -> Monitor {
    Monitor {
        id: Uuid::new_v4(),
        url: Url::parse(ZINC_SUCCESS).unwrap(),
        product: Some(product()),
        constraints: PurchaseConstraints {
            maximum_total_minor,
            currency: "EUR".into(),
            condition: Some(ProductCondition::New),
            variants: HashMap::new(),
            bundles_allowed: false,
            approved_retailers: vec!["amazon".into()],
        },
        // The mandate hold lives ~7 days, so a demo deadline must sit inside it.
        deadline: Utc::now() + ChronoDuration::days(3),
        status: MonitorStatus::Active,
        check_interval_seconds: 60,
        created_at: Utc::now(),
    }
}

fn offer(retailer: &str, total_minor: i64) -> NormalizedOffer {
    NormalizedOffer {
        product: product(),
        retailer: retailer.into(),
        available: true,
        item_price_minor: Some(total_minor),
        shipping_minor: Some(0),
        total_minor: Some(total_minor),
        currency: Some("EUR".into()),
        condition: Some(ProductCondition::New),
        variants: HashMap::new(),
        source_url: Url::parse(ZINC_SUCCESS).unwrap(),
        checked_at: Utc::now(),
    }
}

async fn print_events(store: &Store, id: Uuid, title: &str) {
    eprintln!("\n──── {title} ({id}) ────");
    for event in store.events(id).await.unwrap() {
        eprintln!("{:>3}  {:<28} {}", event.id, event.kind, event.payload);
    }
    eprintln!(
        "     status: {:?}",
        store.get_monitor(id).await.unwrap().status
    );
}

/// The happy path, through every layer: gate → hold → Stripe capture → Zinc order → `purchased`.
#[tokio::test]
async fn a_qualifying_amazon_offer_is_bought_through_p4() {
    let Some(url) = live_p4().await else { return };
    let store = Store::in_memory().await.unwrap();
    store.migrate().await.unwrap();

    let monitor = monitor(25_000);
    store.create_monitor(&monitor).await.unwrap();

    // Arm: P4 authorizes the ceiling at Stripe and hands back the hold.
    let funds = P4Funds::new(&url);
    let commit = funds
        .commit(monitor.id, 25_000, "EUR", 1)
        .await
        .expect("p4 commits the mandate hold");
    assert_eq!(commit.status, "committed", "{commit:?}");
    assert!(commit.hold_id.starts_with("pi_"), "{commit:?}");
    assert_eq!(commit.committed_cents, Some(25_000));

    let (_, stored_reference) = store
        .create_payment_authorization_with_reference(
            monitor.id,
            Some(&commit.hold_id),
            25_000,
            "EUR",
            commit.needs_attention(),
        )
        .await
        .unwrap();
    assert_eq!(
        stored_reference, commit.hold_id,
        "the Stripe hold is what we persist, not a local stand-in"
    );

    let merchant = P4Merchant::new(&url);
    let covered = merchant.prime().await.expect("p4 publishes coverage");
    assert!(covered.iter().any(|r| r == "amazon"), "{covered:?}");

    // €248 against a €250 mandate: qualifies, and P4 captures only what it cost.
    let offer = offer("amazon", 24_800);
    assert!(execution::Merchant::supports(&merchant, &offer));

    let worker = MonitorWorker::new(
        store.clone(),
        Arc::new(StaticSource(offer)),
        Arc::new(merchant),
        "p4-integration",
    );
    assert!(worker.tick().await.unwrap(), "the worker claimed the job");

    print_events(&store, monitor.id, "purchased through P4").await;

    assert_eq!(
        store.get_monitor(monitor.id).await.unwrap().status,
        MonitorStatus::Purchased
    );
    let confirmed = store
        .events(monitor.id)
        .await
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "purchase_confirmed")
        .expect("a purchase_confirmed event");
    let order_id = confirmed.payload["order_id"]
        .as_str()
        .expect("the merchant order id")
        .to_string();
    assert!(!order_id.is_empty(), "merchant order id must not be empty");
    eprintln!("     merchant order id: {order_id}");

    // Idempotency: P4 remembers the purchase under the engine's key, so a repeat never re-buys.
    let found =
        execution::Merchant::find_order(&P4Merchant::new(&url), &format!("monitor:{}", monitor.id))
            .await
            .unwrap()
            .expect("find_order resolves the purchase we just made");
    assert_eq!(found.id, order_id);
    assert_eq!(found.total_minor, 24_800);
    assert_eq!(found.currency, "EUR");
}

/// €465 against a €250 mandate never reaches P4: P1's gate rejects it first.
///
/// Fixture 4's point — Stripe refusing an over-mandate capture with `amount_too_large` — is
/// therefore not reachable through the engine. It is only reachable by calling P4 directly.
#[tokio::test]
async fn an_over_mandate_offer_is_stopped_by_the_gate_before_p4() {
    let Some(url) = live_p4().await else { return };
    let store = Store::in_memory().await.unwrap();
    store.migrate().await.unwrap();

    let monitor = monitor(25_000);
    store.create_monitor(&monitor).await.unwrap();

    let funds = P4Funds::new(&url);
    let commit = funds
        .commit(monitor.id, 25_000, "EUR", 1)
        .await
        .expect("p4 commits the mandate hold");
    store
        .create_payment_authorization_with_reference(
            monitor.id,
            Some(&commit.hold_id),
            25_000,
            "EUR",
            commit.needs_attention(),
        )
        .await
        .unwrap();

    let merchant = P4Merchant::new(&url);
    merchant.prime().await.expect("p4 publishes coverage");

    let worker = MonitorWorker::new(
        store.clone(),
        Arc::new(StaticSource(offer("amazon", 46_500))),
        Arc::new(merchant),
        "p4-integration",
    );
    assert!(worker.tick().await.unwrap());

    print_events(&store, monitor.id, "rejected by the gate, never sent to P4").await;

    let events = store.events(monitor.id).await.unwrap();
    let evaluated = events
        .iter()
        .find(|e| e.kind == "offer_evaluated")
        .expect("an offer_evaluated event");
    let decision: EvaluationDecision =
        serde_json::from_value(evaluated.payload["decision"].clone()).unwrap();
    let EvaluationDecision::Rejected(reasons) = decision else {
        panic!("€465 must not qualify against a €250 mandate")
    };
    assert!(
        reasons.iter().any(|r| matches!(
            r,
            RejectionReason::TotalAboveMaximum {
                maximum: 25_000,
                actual: 46_500
            }
        )),
        "{reasons:?}"
    );

    // The proof P4 was never asked: execution never started, so nothing was captured.
    assert!(
        !events.iter().any(|e| e.kind == "execution_started"),
        "the gate must reject before the engine claims execution"
    );
    assert_eq!(
        store.get_monitor(monitor.id).await.unwrap().status,
        MonitorStatus::Active,
        "a rejected offer keeps the monitor watching"
    );

    // Leave no hold behind: every terminal state gives the money back.
    funds
        .release_best_effort(monitor.id, "integration_test_cleanup")
        .await;
}
