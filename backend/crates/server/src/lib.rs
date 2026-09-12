use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use domain::OfferSource;
use domain::{CanonicalProduct, Monitor, MonitorStatus, NormalizedOffer, PurchaseConstraints};
use execution::{ExecutionEngine, Merchant};
use merchant_demo::{DemoMerchant, DemoOutcome};
use merchant_p4::P4Funds;
use persistence::{MonitorEvent, Store, StoreError};
use rule_engine::{EvaluationDecision, evaluate};
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use url::{Host, Url};
use uuid::Uuid;

#[derive(Clone)]
pub struct AppState {
    pub store: Store,
    /// Kept as the concrete demo merchant so `/v1/demo/scenarios/{scenario}` can still drive it.
    pub merchant: DemoMerchant,
    /// P4's money service, when `MERCHANT=p4`. `None` keeps the self-contained demo behaviour.
    pub funds: Option<Arc<P4Funds>>,
}

pub struct MonitorWorker {
    store: Store,
    source: Arc<dyn OfferSource>,
    merchant: Arc<dyn Merchant>,
    funds: Option<Arc<P4Funds>>,
    worker_id: String,
}

impl MonitorWorker {
    pub fn new(
        store: Store,
        source: Arc<dyn OfferSource>,
        merchant: Arc<dyn Merchant>,
        worker_id: impl Into<String>,
    ) -> Self {
        Self {
            store,
            source,
            merchant,
            funds: None,
            worker_id: worker_id.into(),
        }
    }

    /// Give the worker a money service, so an expiry releases the hold behind it.
    pub fn with_funds(mut self, funds: Option<Arc<P4Funds>>) -> Self {
        self.funds = funds;
        self
    }

    pub async fn run(self) {
        loop {
            match self.tick().await {
                Ok(true) => {}
                Ok(false) => tokio::time::sleep(Duration::from_millis(500)).await,
                Err(error) => {
                    tracing::error!(%error, "monitor worker tick failed");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
        }
    }

    pub async fn tick(&self) -> anyhow::Result<bool> {
        // Every terminal state releases committed funds. Best effort: the expiry already
        // happened, and a money service that is down must not stall the checker.
        for monitor_id in self.store.expire_due_monitors(Utc::now()).await? {
            if let Some(funds) = &self.funds {
                funds
                    .release_best_effort(monitor_id, "deadline_expired")
                    .await;
            }
        }
        let Some(job) = self
            .store
            .claim_due_job(&self.worker_id, chrono::Duration::seconds(45))
            .await?
        else {
            return Ok(false);
        };
        let monitor = job.monitor;
        let offer = match self.source.check(&monitor).await {
            Ok(offer) => offer,
            Err(error) => {
                self.store
                    .append_event(
                        monitor.id,
                        "monitor_check_failed",
                        serde_json::json!({"error": error.to_string()}),
                    )
                    .await?;
                self.store
                    .complete_job(monitor.id, &self.worker_id, false)
                    .await?;
                return Ok(true);
            }
        };
        if monitor.product.is_none() {
            self.store
                .set_product_if_missing(monitor.id, &offer.product)
                .await?;
            self.store
                .append_event(
                    monitor.id,
                    "initial_offer_observed",
                    serde_json::json!({"offer": offer}),
                )
                .await?;
            self.store
                .complete_job(monitor.id, &self.worker_id, true)
                .await?;
            return Ok(true);
        }
        let decision = evaluate(&monitor, &offer, Utc::now());
        self.store
            .record_offer(monitor.id, &offer, &decision)
            .await?;
        match decision {
            EvaluationDecision::Qualified => {
                let engine = ExecutionEngine::new(self.store.clone());
                if let Err(error) = engine
                    .execute(
                        &monitor,
                        &offer,
                        self.source.as_ref(),
                        self.merchant.as_ref(),
                    )
                    .await
                {
                    self.store
                        .append_event(
                            monitor.id,
                            "qualified_offer_not_executed",
                            serde_json::json!({"error": error.to_string()}),
                        )
                        .await?;
                    if self.store.get_monitor(monitor.id).await?.status == MonitorStatus::Active {
                        self.store
                            .complete_job(monitor.id, &self.worker_id, false)
                            .await?;
                    }
                }
            }
            EvaluationDecision::Rejected(_) => {
                self.store
                    .complete_job(monitor.id, &self.worker_id, true)
                    .await?;
            }
        }
        Ok(true)
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/openapi.json", get(openapi))
        .route("/v1/monitors", post(create_monitor).get(list_monitors))
        .route("/v1/monitors/{id}", get(get_monitor))
        .route("/v1/monitors/{id}/cancel", post(cancel_monitor))
        .route("/v1/monitors/{id}/events", get(events))
        .route("/v1/monitors/{id}/events/stream", get(event_stream))
        .route(
            "/v1/monitors/{id}/payment-authorizations",
            post(authorize_payment),
        )
        .route("/v1/demo/offers/{id}", post(submit_offer))
        .route("/v1/demo/scenarios/{scenario}", post(set_scenario))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[derive(Debug, Deserialize)]
pub struct CreateMonitorRequest {
    pub url: Url,
    pub product: Option<CanonicalProduct>,
    pub constraints: PurchaseConstraints,
    pub deadline: DateTime<Utc>,
    #[serde(default = "default_interval")]
    pub check_interval_seconds: i64,
}
fn default_interval() -> i64 {
    60
}

async fn create_monitor(
    State(state): State<AppState>,
    Json(input): Json<CreateMonitorRequest>,
) -> Result<(StatusCode, Json<Monitor>), ApiError> {
    validate_public_url(&input.url)?;
    if input.constraints.maximum_total_minor <= 0 {
        return Err(ApiError::bad_request(
            "maximum_total_minor must be positive",
        ));
    }
    if input.constraints.currency.trim().is_empty() {
        return Err(ApiError::bad_request("currency is required"));
    }
    if input.deadline <= Utc::now() {
        return Err(ApiError::bad_request("deadline must be in the future"));
    }
    if !(10..=86_400).contains(&input.check_interval_seconds) {
        return Err(ApiError::bad_request(
            "check interval must be between 10 and 86400 seconds",
        ));
    }
    let monitor = Monitor {
        id: Uuid::new_v4(),
        url: input.url,
        product: input.product,
        constraints: input.constraints,
        deadline: input.deadline,
        status: MonitorStatus::Active,
        check_interval_seconds: input.check_interval_seconds,
        created_at: Utc::now(),
    };
    state.store.create_monitor(&monitor).await?;
    Ok((StatusCode::CREATED, Json(monitor)))
}

async fn list_monitors(State(state): State<AppState>) -> Result<Json<Vec<Monitor>>, ApiError> {
    Ok(Json(state.store.list_monitors().await?))
}
async fn get_monitor(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Monitor>, ApiError> {
    Ok(Json(state.store.get_monitor(id).await?))
}
async fn cancel_monitor(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    state.store.cancel_monitor(id).await?;
    // The cancellation is already durable; releasing the hold is cleanup, so it never fails
    // the request. P4's release is idempotent and safe to call without checking first.
    if let Some(funds) = &state.funds {
        funds.release_best_effort(id, "monitor_cancelled").await;
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn events(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<MonitorEvent>>, ApiError> {
    state.store.get_monitor(id).await?;
    Ok(Json(state.store.events(id).await?))
}

async fn event_stream(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    state.store.get_monitor(id).await?;
    let stream = async_stream::stream! {
        let mut last_id = 0;
        loop {
            if let Ok(events) = state.store.events(id).await {
                for item in events {
                    if item.id <= last_id { continue; }
                    last_id = item.id;
                    let event_kind = item.kind.clone();
                    yield Ok(Event::default().id(item.id.to_string()).event(event_kind).json_data(item).expect("serializable event"));
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
struct PaymentRequest {
    maximum_minor: i64,
    currency: String,
    /// Bumped on a re-arm. P4 keys the Stripe hold on it, so the same attempt returns the
    /// same hold and a new attempt authorizes a fresh one.
    #[serde(default = "first_attempt")]
    attempt: i64,
}
fn first_attempt() -> i64 {
    1
}

#[derive(Serialize)]
struct PaymentAuthorizationResponse {
    id: Uuid,
    /// The provider's handle on the money: P4's Stripe PaymentIntent, or a `demo-` stand-in.
    hold_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires: Option<String>,
    /// `committed` — the ceiling is held. `needs_attention` — the bank wants 3DS first.
    status: &'static str,
}

/// The mandate hold. One tap: authorize the ceiling now, capture the true price at buy time.
async fn authorize_payment(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(input): Json<PaymentRequest>,
) -> Result<(StatusCode, Json<PaymentAuthorizationResponse>), ApiError> {
    let monitor = state.store.get_monitor(id).await?;
    if input.maximum_minor < monitor.constraints.maximum_total_minor
        || !input
            .currency
            .eq_ignore_ascii_case(&monitor.constraints.currency)
    {
        return Err(ApiError::bad_request(
            "authorization must cover the instruction maximum and currency",
        ));
    }
    let commit = match &state.funds {
        Some(funds) => Some(
            funds
                .commit(id, input.maximum_minor, &input.currency, input.attempt)
                .await
                .map_err(|error| {
                    tracing::error!(%error, monitor_id = %id, "p4 refused the mandate hold");
                    ApiError::bad_gateway(format!("the money service refused the hold: {error}"))
                })?,
        ),
        None => None,
    };
    let needs_attention = commit.as_ref().is_some_and(|c| c.needs_attention());
    let (authorization_id, hold_id) = state
        .store
        .create_payment_authorization_with_reference(
            id,
            commit.as_ref().map(|c| c.hold_id.as_str()),
            input.maximum_minor,
            &input.currency,
            needs_attention,
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(PaymentAuthorizationResponse {
            id: authorization_id,
            hold_id,
            expires: commit.and_then(|c| c.expires),
            status: if needs_attention {
                "needs_attention"
            } else {
                "committed"
            },
        }),
    ))
}

async fn submit_offer(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(offer): Json<NormalizedOffer>,
) -> Result<Json<EvaluationDecision>, ApiError> {
    let monitor = state.store.get_monitor(id).await?;
    let decision = evaluate(&monitor, &offer, Utc::now());
    state.store.record_offer(id, &offer, &decision).await?;
    Ok(Json(decision))
}

async fn set_scenario(
    State(state): State<AppState>,
    Path(scenario): Path<String>,
) -> Result<StatusCode, ApiError> {
    let outcome = match scenario.as_str() {
        "success" => DemoOutcome::Success,
        "payment_required" => DemoOutcome::PaymentRequired,
        "declined" => DemoOutcome::Declined,
        "timeout_before_order" => DemoOutcome::TimeoutBeforeOrder,
        "timeout_after_order" => DemoOutcome::TimeoutAfterOrder,
        _ => return Err(ApiError::bad_request("unknown demo scenario")),
    };
    state.merchant.set_outcome(outcome).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn openapi() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"openapi":"3.1.0","info":{"title":"AI Buy Order API","version":"0.1.0"},"paths":{"/v1/monitors":{"post":{},"get":{}},"/v1/monitors/{id}":{"get":{}},"/v1/monitors/{id}/cancel":{"post":{}},"/v1/monitors/{id}/events":{"get":{}}}}),
    )
}

fn validate_public_url(url: &Url) -> Result<(), ApiError> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ApiError::bad_request(
            "only public HTTP(S) URLs without credentials are allowed",
        ));
    }
    match url.host() {
        Some(Host::Ipv4(ip))
            if ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() =>
        {
            Err(ApiError::bad_request(
                "private network URLs are not allowed",
            ))
        }
        Some(Host::Ipv6(ip))
            if ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local() =>
        {
            Err(ApiError::bad_request(
                "private network URLs are not allowed",
            ))
        }
        Some(Host::Domain(host))
            if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") =>
        {
            Err(ApiError::bad_request("localhost URLs are not allowed"))
        }
        None => Err(ApiError::bad_request("URL host is required")),
        _ => Ok(()),
    }
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }
    /// An upstream we depend on (today: P4) failed. Distinct from our own 400s on purpose.
    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }
}
impl From<StoreError> for ApiError {
    fn from(value: StoreError) -> Self {
        match value {
            StoreError::NotFound => Self {
                status: StatusCode::NOT_FOUND,
                message: value.to_string(),
            },
            StoreError::InvalidState => Self {
                status: StatusCode::CONFLICT,
                message: value.to_string(),
            },
            _ => Self {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                message: "internal storage error".into(),
            },
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(serde_json::json!({"error":self.message}))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use chrono::Duration as ChronoDuration;
    use domain::{OfferSourceError, ProductCondition};
    use std::collections::HashMap;
    use tower::ServiceExt;

    #[derive(Clone)]
    struct StaticSource(NormalizedOffer);

    #[async_trait::async_trait]
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

    async fn app() -> Router {
        let store = Store::in_memory().await.unwrap();
        store.migrate().await.unwrap();
        router(AppState {
            store,
            merchant: DemoMerchant::new(),
            funds: None,
        })
    }
    #[tokio::test]
    async fn health_works() {
        let response = app()
            .await
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    #[tokio::test]
    async fn rejects_private_url() {
        let payload = serde_json::json!({"url":"http://127.0.0.1/product","constraints":{"maximum_total_minor":100,"currency":"EUR","condition":null,"variants":{},"bundles_allowed":false,"approved_retailers":[]},"deadline":"2099-01-01T00:00:00Z","check_interval_seconds":60});
        let response = app()
            .await
            .oneshot(
                Request::post("/v1/monitors")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn worker_buys_a_qualified_authorized_offer() {
        let store = Store::in_memory().await.unwrap();
        store.migrate().await.unwrap();
        let product = CanonicalProduct {
            name: "PS5 Slim Digital".into(),
            brand: Some("Sony".into()),
            model: Some("CFI-2016B".into()),
            identifiers: HashMap::new(),
        };
        let url = Url::parse("https://demo.example/ps5").unwrap();
        let monitor = Monitor {
            id: Uuid::new_v4(),
            url: url.clone(),
            product: Some(product.clone()),
            constraints: PurchaseConstraints {
                maximum_total_minor: 45_000,
                currency: "EUR".into(),
                condition: Some(ProductCondition::New),
                variants: HashMap::from([("edition".into(), "digital".into())]),
                bundles_allowed: false,
                approved_retailers: vec!["demo".into()],
            },
            deadline: Utc::now() + ChronoDuration::days(1),
            status: MonitorStatus::Active,
            check_interval_seconds: 60,
            created_at: Utc::now(),
        };
        let offer = NormalizedOffer {
            product,
            retailer: "demo".into(),
            available: true,
            item_price_minor: Some(44_800),
            shipping_minor: Some(0),
            total_minor: Some(44_800),
            currency: Some("EUR".into()),
            condition: Some(ProductCondition::New),
            variants: HashMap::from([("edition".into(), "digital".into())]),
            source_url: url,
            checked_at: Utc::now(),
        };
        store.create_monitor(&monitor).await.unwrap();
        store
            .create_payment_authorization(monitor.id, 45_000, "EUR")
            .await
            .unwrap();
        let merchant = DemoMerchant::new();
        let worker = MonitorWorker::new(
            store.clone(),
            Arc::new(StaticSource(offer)),
            Arc::new(merchant.clone()),
            "test-worker",
        );

        assert!(worker.tick().await.unwrap());
        assert_eq!(
            store.get_monitor(monitor.id).await.unwrap().status,
            MonitorStatus::Purchased
        );
        assert_eq!(merchant.order_count().await, 1);
    }
}
