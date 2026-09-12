use anyhow::Context;
use execution::Merchant;
use merchant_demo::DemoMerchant;
use merchant_p4::{DEFAULT_P4_URL, P4Funds, P4Merchant};
use monitoring::{FetchConfig, SpiderFetcher, SpiderOfferSource};
use persistence::Store;
use product_intelligence::ProductInterpreter;
use server::{AppState, MonitorWorker, router};
use std::sync::Arc;
use tokio::net::TcpListener;

fn env_flag(key: &str) -> bool {
    std::env::var(key).is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes" | "on"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://buy-agent.sqlite?mode=rwc".into());
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let spider_cloud_api_key = std::env::var("SPIDER_CLOUD_API_KEY")
        .context("SPIDER_CLOUD_API_KEY is required; add it to .env")?;
    let store = Store::connect(&database_url).await?;
    store.migrate().await?;
    let listener = TcpListener::bind(&bind).await?;

    // The demo merchant stays on AppState whichever backend actually buys, because
    // `/v1/demo/scenarios/{scenario}` drives it directly.
    let merchant = DemoMerchant::new();

    // MERCHANT=p4 sends checkout and the mandate hold to P4's money service.
    // Anything else — the default — keeps the self-contained in-process demo.
    let p4_url = std::env::var("P4_URL").unwrap_or_else(|_| DEFAULT_P4_URL.into());
    let selected = std::env::var("MERCHANT").unwrap_or_else(|_| "demo".into());
    let (checkout_merchant, funds): (Arc<dyn Merchant>, Option<Arc<P4Funds>>) =
        match selected.trim().to_ascii_lowercase().as_str() {
            "p4" => {
                let p4 = P4Merchant::new(&p4_url).with_demo_fallback(env_flag("P4_DEMO_FALLBACK"));
                // `supports()` is synchronous and cannot await, so load coverage once up front.
                // Failing here is not fatal: the cache refreshes itself in the background.
                match p4.prime().await {
                    Ok(retailers) => {
                        tracing::info!(url = %p4_url, ?retailers, "p4 merchant ready")
                    }
                    Err(error) => tracing::warn!(
                        url = %p4_url, %error,
                        "p4 coverage unavailable at boot; retrying in the background"
                    ),
                }
                (Arc::new(p4), Some(Arc::new(P4Funds::new(&p4_url))))
            }
            other => {
                if other != "demo" {
                    tracing::warn!(merchant = other, "unknown MERCHANT; falling back to demo");
                }
                tracing::info!("demo merchant selected; no money leaves this process");
                (Arc::new(merchant.clone()), None)
            }
        };

    let fetch_config = FetchConfig {
        spider_cloud_api_key: Some(spider_cloud_api_key),
        ..FetchConfig::default()
    };
    let source = Arc::new(SpiderOfferSource::new(
        SpiderFetcher::new(fetch_config),
        Arc::new(ProductInterpreter::new()),
    ));
    let worker = MonitorWorker::new(
        store.clone(),
        source,
        // The router holds the same merchant, so `/v1/demo/offers` buys through whichever
        // backend `MERCHANT` selected — and shares its coverage cache with the checker.
        checkout_merchant.clone(),
        format!("worker-{}", std::process::id()),
    )
    .with_funds(funds.clone());
    tokio::spawn(worker.run());
    tracing::info!(%bind, "server listening");
    let bitrefill_routes = bitrefill::configured_router(store.pool().clone()).await?;
    axum::serve(
        listener,
        router(AppState {
            store,
            merchant,
            checkout_merchant,
            funds,
        })
        .merge(bitrefill_routes),
    )
    .await?;
    Ok(())
}
