use merchant_demo::DemoMerchant;
use monitoring::{FetchConfig, SpiderFetcher, SpiderOfferSource};
use persistence::Store;
use product_intelligence::ProductInterpreter;
use server::{AppState, MonitorWorker, router};
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://buy-agent.sqlite?mode=rwc".into());
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let store = Store::connect(&database_url).await?;
    store.migrate().await?;
    let listener = TcpListener::bind(&bind).await?;
    let merchant = DemoMerchant::new();
    let source = Arc::new(SpiderOfferSource::new(
        SpiderFetcher::new(FetchConfig::default()),
        Arc::new(ProductInterpreter::new()),
    ));
    let worker = MonitorWorker::new(
        store.clone(),
        source,
        Arc::new(merchant.clone()),
        format!("worker-{}", std::process::id()),
    );
    tokio::spawn(worker.run());
    tracing::info!(%bind,"server listening");
    axum::serve(listener, router(AppState { store, merchant })).await?;
    Ok(())
}
