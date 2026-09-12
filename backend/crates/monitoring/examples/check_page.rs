use monitoring::{FetchConfig, SpiderFetcher};
#[tokio::main]
async fn main() {
    let url = url::Url::parse(&std::env::args().nth(1).expect("product URL required")).unwrap();
    let result = SpiderFetcher::new(FetchConfig::default()).fetch(&url).await;
    match result {
        Ok(page) => println!("status={} bytes={} body={}", page.status, page.html.len(), page.html.chars().take(700).collect::<String>()),
        Err(error) => println!("{error}"),
    }
}
