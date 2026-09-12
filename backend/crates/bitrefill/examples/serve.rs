//! Isolated local launch of the same routes mounted in the Rust server.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let database = std::env::var("DATABASE_URL")?;
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect(&database)
        .await?;
    let app = bitrefill::configured_router(pool).await?;
    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8082".into());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    println!("Bitrefill local slice listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
