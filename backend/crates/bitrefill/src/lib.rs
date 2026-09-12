//! Explicitly approved, payment-link-only Bitrefill slice. Never used by the auto-buy worker.
use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, AeadCore, OsRng},
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

const MCP: &str = "https://api.bitrefill.com/mcp";
const PROVIDER: &str = "https://api.bitrefill.com";
const MAX_EUR: i64 = 1000;
const DAILY_EUR: i64 = 5000;
const TTL: i64 = 300;
fn now() -> i64 {
    Utc::now().timestamp()
}
fn random() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn digest(v: &str) -> String {
    B64.encode(Sha256::digest(v.as_bytes()))
}

type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
struct Error(StatusCode, &'static str);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn bad(s: &'static str) -> Error {
    Error(StatusCode::BAD_REQUEST, s)
}
fn internal(_: impl std::fmt::Display) -> Error {
    Error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Operation could not be saved. Do not retry a purchase; check its status.",
    )
}
fn provider(_: impl std::fmt::Display) -> Error {
    Error(
        StatusCode::BAD_GATEWAY,
        "Bitrefill did not return a compatible response. Reconnect or check the existing order; do not repurchase.",
    )
}

#[derive(Clone)]
struct App {
    pool: SqlitePool,
    cipher: Aes256Gcm,
    http: reqwest::Client,
    mcp: String,
    origin: String,
    client_id: String,
    oauth: Value,
    enabled: bool,
    gate: Arc<Mutex<()>>,
}
impl App {
    fn cookie_name(&self) -> String {
        format!(
            "compralo_br_{}",
            Url::parse(&self.origin)
                .expect("validated origin")
                .port_or_known_default()
                .unwrap_or(443)
        )
    }
    fn seal(&self, v: &Value) -> Result<Vec<u8>> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let mut out = nonce.to_vec();
        out.extend(
            self.cipher
                .encrypt(&nonce, serde_json::to_vec(v).map_err(internal)?.as_ref())
                .map_err(internal)?,
        );
        Ok(out)
    }
    fn unseal(&self, bytes: &[u8]) -> Result<Value> {
        if bytes.len() < 12 {
            return Err(internal("ciphertext"));
        }
        let raw = self
            .cipher
            .decrypt(bytes[..12].into(), &bytes[12..])
            .map_err(internal)?;
        serde_json::from_slice(&raw).map_err(internal)
    }
    async fn save_session(&self, id: &str, value: &Value) -> Result<()> {
        sqlx::query("UPDATE bitrefill_sessions SET payload=? WHERE id=?")
            .bind(self.seal(value)?)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }
    async fn session(
        &self,
        headers: &HeaderMap,
        mutation: bool,
        connected: bool,
    ) -> Result<(String, Value)> {
        let id = headers
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.split(';')
                    .find_map(|c| c.trim().strip_prefix(&format!("{}=", self.cookie_name())))
                    .map(digest)
            })
            .ok_or(Error(
                StatusCode::UNAUTHORIZED,
                "Open Bitrefill and connect your account.",
            ))?;
        let row = sqlx::query("SELECT payload FROM bitrefill_sessions WHERE id=? AND expires>?")
            .bind(&id)
            .bind(now())
            .fetch_optional(&self.pool)
            .await
            .map_err(internal)?
            .ok_or(Error(
                StatusCode::UNAUTHORIZED,
                "Session expired. Reconnect.",
            ))?;
        let v = self.unseal(&row.get::<Vec<u8>, _>("payload"))?;
        if mutation
            && (headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
                != Some(self.origin.as_str())
                || headers.get("x-csrf-token").and_then(|v| v.to_str().ok()) != v["csrf"].as_str())
        {
            return Err(Error(
                StatusCode::FORBIDDEN,
                "Invalid request origin or CSRF token.",
            ));
        }
        if connected && v["token"]["access_token"].as_str().is_none() {
            return Err(Error(
                StatusCode::UNAUTHORIZED,
                "Connect your Bitrefill account first.",
            ));
        }
        Ok((id, v))
    }
    async fn token(&self, sid: &str, session: &mut Value) -> Result<String> {
        if session["token_expires"].as_i64().unwrap_or(0) <= now() + 30 {
            let refresh = session["token"]["refresh_token"]
                .as_str()
                .ok_or(Error(StatusCode::UNAUTHORIZED, "Reconnect Bitrefill."))?;
            let token = self
                .http
                .post(self.oauth["token_endpoint"].as_str().unwrap())
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh),
                    ("client_id", &self.client_id),
                    ("resource", MCP),
                ])
                .send()
                .await
                .map_err(provider)?;
            if !token.status().is_success() {
                return Err(Error(
                    StatusCode::UNAUTHORIZED,
                    "Bitrefill session expired. Reconnect.",
                ));
            }
            let token: Value = token.json().await.map_err(provider)?;
            session["token_expires"] = json!(now() + token["expires_in"].as_i64().unwrap_or(0));
            session["token"] = token;
            self.save_session(sid, session).await?;
        }
        session["token"]["access_token"]
            .as_str()
            .map(str::to_owned)
            .ok_or(Error(StatusCode::UNAUTHORIZED, "Reconnect Bitrefill."))
    }
    async fn rpc(&self, token: &str, method: &str, params: Value) -> Result<Value> {
        let r = self
            .http
            .post(&self.mcp)
            .bearer_auth(token)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-03-26")
            .json(&json!({"jsonrpc":"2.0","id":random(),"method":method,"params":params}))
            .send()
            .await
            .map_err(provider)?;
        if r.status() == StatusCode::UNAUTHORIZED {
            return Err(Error(
                StatusCode::UNAUTHORIZED,
                "Bitrefill disconnected. Reconnect your account.",
            ));
        }
        if !r.status().is_success() {
            return Err(provider("HTTP"));
        }
        if r.content_length().unwrap_or(0) > 2_000_000 {
            return Err(provider("oversized"));
        }
        let text = r.text().await.map_err(provider)?;
        if text.len() > 2_000_000 {
            return Err(provider("oversized"));
        }
        parse_rpc(&text)
    }
    async fn call(&self, token: &str, name: &str, args: Value) -> Result<Value> {
        let value = self
            .rpc(token, "tools/call", json!({"name":name,"arguments":args}))
            .await?;
        if value["isError"].as_bool() == Some(true) {
            return Err(provider("tool error"));
        }
        if let Some(v) = value.get("structuredContent") {
            return Ok(v.clone());
        }
        let text = value["content"]
            .as_array()
            .and_then(|a| a.iter().find_map(|b| b.get("text").and_then(Value::as_str)))
            .ok_or(provider("missing tool content"))?;
        serde_json::from_str(text)
            .or_else(|_| toon_format::decode_default(text))
            .map_err(provider)
    }
    async fn event(&self, order: &str, kind: &str) -> Result<()> {
        sqlx::query("INSERT INTO bitrefill_events(order_id,kind,created) VALUES (?,?,?)")
            .bind(order)
            .bind(kind)
            .bind(now())
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }
}
fn parse_rpc(text: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(text)
        .or_else(|_| {
            text.lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .find_map(|s| serde_json::from_str::<Value>(s.trim()).ok())
                .ok_or_else(|| serde_json::from_str::<Value>("").unwrap_err())
        })
        .map_err(provider)?;
    if value.get("error").is_some() {
        return Err(provider("rpc"));
    }
    value.get("result").cloned().ok_or(provider("result"))
}

pub async fn configured_router(pool: SqlitePool) -> anyhow::Result<Router> {
    let Some(origin) = std::env::var("BITREFILL_PUBLIC_ORIGIN")
        .ok()
        .filter(|v| !v.trim().is_empty())
    else {
        return Ok(Router::new().route("/bitrefill",get(||async{Html("Bitrefill is not configured on this server yet. Set BITREFILL_PUBLIC_ORIGIN and BITREFILL_ENCRYPTION_KEY; see deploy/BITREFILL.md.")})));
    };
    let origin = origin.trim_end_matches('/').to_string();
    let u = Url::parse(&origin)?;
    anyhow::ensure!(
        u.path() == "/"
            && u.query().is_none()
            && u.fragment().is_none()
            && u.username().is_empty()
            && u.password().is_none(),
        "BITREFILL_PUBLIC_ORIGIN must be an origin"
    );
    anyhow::ensure!(
        u.scheme() == "https" || (u.scheme() == "http" && u.host_str() == Some("127.0.0.1")),
        "Bitrefill requires HTTPS or 127.0.0.1 for development"
    );
    let key = B64.decode(std::env::var("BITREFILL_ENCRYPTION_KEY")?)?;
    anyhow::ensure!(
        key.len() == 32,
        "BITREFILL_ENCRYPTION_KEY must encode 32 random bytes, base64url without padding"
    );
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow::anyhow!("invalid encryption key"))?;
    schema(&pool).await?;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    let resource: Value = http
        .get(format!("{PROVIDER}/.well-known/oauth-protected-resource"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    anyhow::ensure!(
        resource["authorization_servers"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(format!("{PROVIDER}/oauth/mcp")))),
        "unexpected OAuth issuer"
    );
    let oauth: Value = http
        .get(format!(
            "{PROVIDER}/.well-known/oauth-authorization-server/oauth/mcp"
        ))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    for field in [
        "authorization_endpoint",
        "token_endpoint",
        "revocation_endpoint",
        "registration_endpoint",
    ] {
        let endpoint = Url::parse(
            oauth[field]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("OAuth endpoint missing"))?,
        )?;
        anyhow::ensure!(
            endpoint.origin().ascii_serialization() == PROVIDER,
            "unexpected OAuth origin"
        );
    }
    let client_id = match std::env::var("BITREFILL_CLIENT_ID")
        .ok()
        .filter(|v| !v.is_empty())
    {
        Some(v) => v,
        None if u.scheme() == "https" => format!("{origin}/bitrefill/oauth-client.json"),
        None => {
            let old: Option<String> =
                sqlx::query_scalar("SELECT value FROM bitrefill_config WHERE key='client_id'")
                    .fetch_optional(&pool)
                    .await?;
            if let Some(v) = old {
                v
            } else {
                let doc = client_document(&origin);
                let registered: Value = http
                    .post(oauth["registration_endpoint"].as_str().unwrap())
                    .json(&doc)
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                let id = registered["client_id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("OAuth registration did not return client_id"))?
                    .to_string();
                sqlx::query("INSERT INTO bitrefill_config(key,value) VALUES ('client_id',?)")
                    .bind(&id)
                    .execute(&pool)
                    .await?;
                id
            }
        }
    };
    let app = App {
        pool,
        cipher,
        http,
        mcp: MCP.into(),
        origin,
        client_id,
        oauth,
        enabled: std::env::var("BITREFILL_PURCHASES_ENABLED").as_deref() == Ok("true"),
        gate: Arc::new(Mutex::new(())),
    };
    Ok(routes(app))
}
async fn schema(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::raw_sql("CREATE TABLE IF NOT EXISTS bitrefill_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bitrefill_sessions(id TEXT PRIMARY KEY,payload BLOB NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bitrefill_quotes(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload BLOB NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,expires INTEGER NOT NULL,amount INTEGER NOT NULL,created INTEGER NOT NULL,invoice_id TEXT,invoice BLOB,last_poll INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS bitrefill_events(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bitrefill_rate(owner TEXT NOT NULL,minute INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(owner,minute));").execute(pool).await?;
    Ok(())
}
fn routes(app: App) -> Router {
    Router::new().route("/bitrefill",get(page)).route("/bitrefill/app.js",get(js)).route("/bitrefill/style.css",get(css)).route("/bitrefill/oauth-client.json",get(client_metadata))
    .route("/v1/integrations/bitrefill/status",get(status)).route("/v1/integrations/bitrefill/oauth/start",post(oauth_start)).route("/v1/integrations/bitrefill/oauth/callback",get(oauth_callback))
    .route("/v1/integrations/bitrefill",axum::routing::delete(disconnect))
    .route("/v1/bitrefill/search",post(search)).route("/v1/bitrefill/products/{id}",get(details))
    .route("/v1/bitrefill/quotes",post(quote)).route("/v1/bitrefill/quotes/{id}/approve",post(approve)).route("/v1/bitrefill/quotes/{id}/purchase",post(purchase)).route("/v1/bitrefill/quotes/{id}/cancel",post(cancel))
    .route("/v1/bitrefill/orders",get(orders)).route("/v1/bitrefill/orders/{id}",get(order)).route("/v1/bitrefill/orders/{id}/reveal",post(reveal))
    .layer(axum::middleware::from_fn(|req:axum::extract::Request,next:axum::middleware::Next|async move{
        let mut r=next.run(req).await;
        for (k,v) in [("cache-control","no-store"),("referrer-policy","no-referrer"),("x-content-type-options","nosniff"),("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")] {r.headers_mut().insert(axum::http::HeaderName::from_static(k),axum::http::HeaderValue::from_static(v));}r
    })).with_state(app)
}
fn client_document(origin: &str) -> Value {
    json!({"client_id":format!("{origin}/bitrefill/oauth-client.json"),"client_name":"Compralo","redirect_uris":[format!("{origin}/v1/integrations/bitrefill/oauth/callback")],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"})
}
async fn client_metadata(State(a): State<App>) -> Json<Value> {
    Json(client_document(&a.origin))
}
async fn page(State(a): State<App>, headers: HeaderMap) -> Result<Response> {
    let mut response = Html(include_str!("../web/index.html")).into_response();
    if a.session(&headers, false, false).await.is_err() {
        let raw = random();
        let id = digest(&raw);
        let value = json!({"csrf":random()});
        sqlx::query("INSERT INTO bitrefill_sessions(id,payload,expires) VALUES (?,?,?)")
            .bind(id)
            .bind(a.seal(&value)?)
            .bind(now() + 86400)
            .execute(&a.pool)
            .await
            .map_err(internal)?;
        let secure = if a.origin.starts_with("https:") {
            "; Secure"
        } else {
            ""
        };
        response.headers_mut().insert(
            header::SET_COOKIE,
            format!(
                "{}={raw}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400{secure}",
                a.cookie_name()
            )
            .parse()
            .map_err(internal)?,
        );
    }
    Ok(response)
}
async fn js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript")],
        include_str!("../web/app.js"),
    )
}
async fn css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css")],
        include_str!("../web/style.css"),
    )
}
async fn status(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = a.session(&h, false, false).await?;
    Ok(Json(
        json!({"connected":s["token"]["access_token"].is_string(),"csrf":s["csrf"],"purchases_enabled":a.enabled,"test_provider":a.mcp != MCP,"maximum_eur":"10.00","capabilities":s["capabilities"],"mode":"Payment link only; no automatic wallet or balance charges"}),
    ))
}
async fn oauth_start(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let _g = a.gate.lock().await;
    let (id, mut s) = a.session(&h, true, false).await?;
    let state = random();
    let verifier = random();
    s["oauth"] = json!({"state":digest(&state),"verifier":verifier,"expires":now()+TTL});
    a.save_session(&id, &s).await?;
    let mut url =
        Url::parse(a.oauth["authorization_endpoint"].as_str().unwrap()).map_err(internal)?;
    url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", &a.client_id),
        (
            "redirect_uri",
            &format!("{}/v1/integrations/bitrefill/oauth/callback", a.origin),
        ),
        ("scope", "mcp"),
        ("resource", MCP),
        ("state", &state),
        ("code_challenge", &digest(&verifier)),
        ("code_challenge_method", "S256"),
    ]);
    Ok(Json(json!({"url":url.as_str()})))
}
#[derive(Deserialize)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
    iss: Option<String>,
}
async fn oauth_callback(
    State(a): State<App>,
    h: HeaderMap,
    Query(q): Query<Callback>,
) -> Result<Redirect> {
    let _g = a.gate.lock().await;
    let (id, mut s) = a.session(&h, false, false).await?;
    if q.iss
        .as_deref()
        .is_some_and(|v| v != format!("{PROVIDER}/oauth/mcp"))
        || s["oauth"]["state"].as_str() != q.state.as_deref().map(digest).as_deref()
        || s["oauth"]["expires"].as_i64().unwrap_or(0) < now()
    {
        return Err(bad("OAuth request expired or state did not match."));
    }
    let verifier = s["oauth"]["verifier"]
        .as_str()
        .ok_or(bad("No OAuth request."))?
        .to_owned();
    s["oauth"] = Value::Null;
    a.save_session(&id, &s).await?;
    let r = a
        .http
        .post(a.oauth["token_endpoint"].as_str().unwrap())
        .form(&[
            ("grant_type", "authorization_code"),
            (
                "code",
                q.code
                    .as_deref()
                    .ok_or(bad("Bitrefill connection was not authorized."))?,
            ),
            ("client_id", &a.client_id),
            (
                "redirect_uri",
                &format!("{}/v1/integrations/bitrefill/oauth/callback", a.origin),
            ),
            ("code_verifier", &verifier),
            ("resource", MCP),
        ])
        .send()
        .await
        .map_err(provider)?;
    if !r.status().is_success() {
        return Err(provider("token exchange"));
    }
    let token: Value = r.json().await.map_err(provider)?;
    let access = token["access_token"]
        .as_str()
        .ok_or(provider("access token"))?;
    let discovered = a.rpc(access, "tools/list", json!({})).await?;
    validate_capabilities(&discovered)?;
    s["capabilities"] = discovered;
    s["token_expires"] = json!(now() + token["expires_in"].as_i64().unwrap_or(0));
    s["token"] = token;
    a.save_session(&id, &s).await?;
    Ok(Redirect::to("/bitrefill"))
}
fn validate_capabilities(v: &Value) -> Result<()> {
    let tools = v["tools"].as_array().ok_or(provider("tools"))?;
    for (name, fields) in [
        ("search-products", vec!["intent", "country", "product_type"]),
        ("get-product-details", vec!["product_id", "currency"]),
        (
            "buy-products",
            vec!["cart_items", "payment_method", "return_payment_link"],
        ),
        ("get-invoice-by-id", vec!["invoice_id"]),
    ] {
        let schema = tools
            .iter()
            .find(|x| x["name"] == name)
            .ok_or(provider("missing tool"))?;
        if schema["inputSchema"]["type"] != "object"
            || fields
                .iter()
                .any(|f| schema["inputSchema"]["properties"].get(f).is_none())
        {
            return Err(provider("schema changed"));
        }
        if name == "buy-products"
            && schema["inputSchema"]["properties"]["cart_items"]["items"]["properties"]
                .get("package_value")
                .is_none()
        {
            return Err(provider("package schema changed"));
        }
    }
    Ok(())
}
async fn disconnect(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let _g = a.gate.lock().await;
    let (id, s) = a.session(&h, true, false).await?;
    // Delete local access regardless of revocation availability; surface whether provider revocation succeeded.
    let revoked = if let Some(t) = s["token"]["refresh_token"].as_str() {
        a.http
            .post(a.oauth["revocation_endpoint"].as_str().unwrap())
            .form(&[("token", t), ("client_id", &a.client_id)])
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    } else {
        true
    };
    a.save_session(&id, &json!({"csrf":s["csrf"]})).await?;
    sqlx::query("UPDATE bitrefill_quotes SET status='cancelled' WHERE owner=? AND status IN ('quoted','approved')").bind(id).execute(&a.pool).await.map_err(internal)?;
    Ok(Json(json!({"connected":false,"provider_revoked":revoked})))
}
async fn rate(a: &App, id: &str) -> Result<()> {
    let count:i64=sqlx::query_scalar("INSERT INTO bitrefill_rate(owner,minute,count) VALUES (?,?,1) ON CONFLICT(owner,minute) DO UPDATE SET count=count+1 RETURNING count").bind(id).bind(now()/60).fetch_one(&a.pool).await.map_err(internal)?;
    if count > 12 {
        return Err(Error(
            StatusCode::TOO_MANY_REQUESTS,
            "Please wait a minute before more catalog requests.",
        ));
    }
    Ok(())
}
#[derive(Deserialize)]
struct Search {
    query: String,
    country: String,
}
fn country(v: &str) -> Result<String> {
    if v.len() != 2 || !v.bytes().all(|c| c.is_ascii_alphabetic()) {
        return Err(bad("Choose a two-letter country code."));
    }
    Ok(v.to_ascii_uppercase())
}
async fn search(State(a): State<App>, h: HeaderMap, Json(q): Json<Search>) -> Result<Json<Value>> {
    let _g = a.gate.lock().await;
    let (id, mut s) = a.session(&h, true, true).await?;
    rate(&a, &id).await?;
    let token = a.token(&id, &mut s).await?;
    let c = country(&q.country)?;
    if q.query.len() > 200 {
        return Err(bad("Search is too long."));
    }
    let v=a.call(&token,"search-products",json!({"query":q.query,"intent":"Find a low-value retailer gift card for the selected country","country":c,"product_type":"giftcard","per_page":50})).await?;
    // Bitrefill search can include other countries even with country set. Filter independently.
    let products = v["products"]
        .as_array()
        .ok_or(provider("products"))?
        .iter()
        .filter(|p| {
            p["countries"]
                .as_array()
                .is_some_and(|a| a.contains(&json!(c)))
                && p["type"] == "giftcards"
        })
        .map(|p| json!({"id":p["slug"],"name":p["name"],"countries":p["countries"]}))
        .collect::<Vec<_>>();
    s["searched"] = json!({"kind":"giftcard","country":c,"ids":products.iter().map(|p|p["id"].clone()).collect::<Vec<_>>()});
    a.save_session(&id, &s).await?;
    Ok(Json(json!({"products":products})))
}
async fn details(
    State(a): State<App>,
    h: HeaderMap,
    Path(pid): Path<String>,
) -> Result<Json<Value>> {
    let _g = a.gate.lock().await;
    let (id, mut s) = a.session(&h, false, true).await?;
    rate(&a, &id).await?;
    check_searched(&s, &pid)?;
    let token = a.token(&id, &mut s).await?;
    let d = a
        .call(
            &token,
            "get-product-details",
            json!({"product_id":pid,"currency":"EUR"}),
        )
        .await?;
    Ok(Json(public_details(&d)?))
}
fn check_searched(s: &Value, pid: &str) -> Result<()> {
    if s["searched"]["kind"] != "giftcard"
        || !s["searched"]["ids"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(pid)))
    {
        return Err(bad("Search this product for your country first."));
    }
    Ok(())
}
fn public_details(d: &Value) -> Result<Value> {
    if d["in_stock"] != true
        || d["recipient_type"] != "none"
        || d["categories"].as_array().is_none_or(|a| {
            a.iter().any(|v| {
                matches!(
                    v.as_str(),
                    Some("esim" | "refill" | "bill-pay" | "payment-cards")
                )
            })
        })
        || d.get("prepayment").is_some_and(|v| !v.is_null())
    {
        return Err(bad(
            "This slice supports available retailer gift cards without prepayment forms only.",
        ));
    }
    Ok(
        json!({"id":d["id"],"name":d["name"],"packages":d["packages"],"country":d["country_code"],"instructions":d["instructions"],"currency":d["currency"],"restrictions":format!("{}\n{}\n{}", d["specialNote"].as_str().unwrap_or(""), d["descriptions"].as_str().unwrap_or(""), d["termsConditions"].as_str().unwrap_or("")),"payment_methods":d["payment_methods"]}),
    )
}
fn euros(v: &Value) -> Result<i64> {
    let text = v
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string());
    let mut p = text.split('.');
    let whole = p.next().unwrap_or("");
    let decimal = p.next().unwrap_or("");
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || decimal.len() > 2
        || !decimal.bytes().all(|b| b.is_ascii_digit())
        || p.next().is_some()
    {
        return Err(bad(
            "Provider price cannot be represented exactly in EUR cents.",
        ));
    }
    let major: i64 = whole.parse().map_err(|_| bad("Invalid price."))?;
    let minor: i64 = format!("{decimal:0<2}")
        .parse()
        .map_err(|_| bad("Invalid price."))?;
    major
        .checked_mul(100)
        .and_then(|n| n.checked_add(minor))
        .ok_or(bad("Invalid price."))
}
#[derive(Deserialize)]
struct QuoteInput {
    product_id: String,
    package_value: String,
    country: String,
}
fn normalized_quote(d: &Value, input: &QuoteInput) -> Result<Value> {
    let public = public_details(d)?;
    if d["id"] != input.product_id || d["country_code"] != input.country {
        return Err(bad(
            "Product country does not exactly match. Choose a country-specific gift card.",
        ));
    }
    let p = d["packages"]
        .as_array()
        .and_then(|a| a.iter().find(|p| p["package_value"] == input.package_value))
        .ok_or(bad("Choose a current denomination."))?;
    if p["payment_currency"] != "EUR" {
        return Err(bad("EUR pricing is unavailable."));
    }
    let amount = euros(&p["payment_price"])?;
    if !(1..=MAX_EUR).contains(&amount) {
        return Err(bad(
            "This first slice is capped at 10 EUR catalog price per purchase.",
        ));
    }
    if !d["payment_methods"]["address_based"]
        .as_array()
        .is_some_and(|a| a.contains(&json!("bitcoin")))
    {
        return Err(bad("Bitcoin payment link is unavailable for this product."));
    }
    Ok(
        json!({"product_id":input.product_id,"name":d["name"],"package_value":input.package_value,"country":input.country,"product_type":"giftcard","face_value":input.package_value,"face_currency":p["package_currency"],"quantity":1,"catalog_total_minor":amount,"catalog_currency":"EUR","payment_method":"bitcoin","payment_network":"Bitcoin","recipient":"Connected Bitrefill account; redeem the gift card with the named retailer","restrictions":public["restrictions"],"instructions":public["instructions"],"warning":"You are buying a gift card, not a physical product. Retailer checkout is a separate step. Country and redemption restrictions apply; unused balance may remain. May be non-refundable. Catalog price is not a locked crypto quote. Exact Bitcoin total, exchange rate, fees and expiry must be reviewed on Bitrefill before you pay. No automatic payment."}),
    )
}
async fn quote(
    State(a): State<App>,
    h: HeaderMap,
    Json(mut q): Json<QuoteInput>,
) -> Result<Json<Value>> {
    let _g = a.gate.lock().await;
    let (id, mut s) = a.session(&h, true, true).await?;
    rate(&a, &id).await?;
    check_searched(&s, &q.product_id)?;
    q.country = country(&q.country)?;
    if s["searched"]["country"] != q.country {
        return Err(bad("Search again for the selected country."));
    }
    let token = a.token(&id, &mut s).await?;
    let d = a
        .call(
            &token,
            "get-product-details",
            json!({"product_id":q.product_id,"currency":"EUR"}),
        )
        .await?;
    let v = normalized_quote(&d, &q)?;
    let quote_id = Uuid::new_v4().to_string();
    let hash = digest(&serde_json::to_string(&v).map_err(internal)?);
    sqlx::query("INSERT INTO bitrefill_quotes(id,owner,payload,hash,status,expires,amount,created) VALUES (?,?,?,?,'quoted',?,?,?)").bind(&quote_id).bind(id).bind(a.seal(&v)?).bind(&hash).bind(now()+TTL).bind(v["catalog_total_minor"].as_i64().unwrap()).bind(now()).execute(&a.pool).await.map_err(internal)?;
    a.event(&quote_id, "quote_created").await?;
    Ok(Json(
        json!({"quote_id":quote_id,"quote_hash":hash,"expires_at":now()+TTL,"quote":v}),
    ))
}
#[derive(Deserialize)]
struct Approval {
    quote_hash: String,
    acknowledged: bool,
}
async fn approve(
    State(a): State<App>,
    h: HeaderMap,
    Path(qid): Path<String>,
    Json(input): Json<Approval>,
) -> Result<Json<Value>> {
    let (id, _) = a.session(&h, true, true).await?;
    if !input.acknowledged {
        return Err(bad("Explicit acknowledgement is required."));
    }
    let n=sqlx::query("UPDATE bitrefill_quotes SET status='approved' WHERE id=? AND owner=? AND status='quoted' AND hash=? AND expires>?").bind(&qid).bind(id).bind(input.quote_hash).bind(now()).execute(&a.pool).await.map_err(internal)?.rows_affected();
    if n != 1 {
        return Err(bad(
            "Quote expired, changed or already approved. Review a new quote.",
        ));
    }
    a.event(&qid, "invoice_creation_approved").await?;
    Ok(Json(json!({"status":"approved","order_id":qid})))
}
async fn purchase(
    State(a): State<App>,
    h: HeaderMap,
    Path(qid): Path<String>,
) -> Result<Json<Value>> {
    if !a.enabled {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "Invoice creation is disabled on this server.",
        ));
    }
    let _g = a.gate.lock().await;
    let (owner, mut s) = a.session(&h, true, true).await?;
    let row = owned(&a, &owner, &qid).await?;
    let state: String = row.get("status");
    if !matches!(state.as_str(), "quoted" | "approved") {
        return Ok(Json(summary(&a, &row)?));
    }
    if state != "approved" || row.get::<i64, _>("expires") <= now() {
        return Err(bad("Review and approve an unexpired quote first."));
    }
    let q = a.unseal(&row.get::<Vec<u8>, _>("payload"))?;
    let token = a.token(&owner, &mut s).await?;
    // Tool discovery is repeated for this exact credential immediately before mutation.
    let capabilities = a.rpc(&token, "tools/list", json!({})).await?;
    validate_capabilities(&capabilities)?;
    let buy_schema = capabilities["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "buy-products")
        .unwrap();
    if buy_schema["inputSchema"]["required"]
        .as_array()
        .is_some_and(|a| a.contains(&json!("email")))
    {
        return Err(bad(
            "Guest purchases are disabled. Connect a personal Bitrefill account.",
        ));
    }
    let d = a
        .call(
            &token,
            "get-product-details",
            json!({"product_id":q["product_id"],"currency":"EUR"}),
        )
        .await?;
    let current = normalized_quote(
        &d,
        &QuoteInput {
            product_id: q["product_id"].as_str().unwrap().into(),
            package_value: q["package_value"].as_str().unwrap().into(),
            country: q["country"].as_str().unwrap().into(),
        },
    )?;
    if digest(&serde_json::to_string(&current).map_err(internal)?) != row.get::<String, _>("hash") {
        sqlx::query("UPDATE bitrefill_quotes SET status='expired' WHERE id=?")
            .bind(&qid)
            .execute(&a.pool)
            .await
            .map_err(internal)?;
        return Err(bad(
            "Product or price changed. Create and approve a new quote.",
        ));
    }
    // Durable atomic claim across replicas. An uncertain provider result stays claimed forever.
    let n=sqlx::query("UPDATE bitrefill_quotes SET status='reconciliation_required' WHERE id=? AND owner=? AND status='approved' AND expires>? AND (SELECT COALESCE(SUM(amount),0) FROM bitrefill_quotes WHERE created>=? AND status IN ('reconciliation_required','awaiting_payment','payment_pending','fulfilled'))+amount<=?")
        .bind(&qid).bind(&owner).bind(now()).bind(now()-86400).bind(DAILY_EUR).execute(&a.pool).await.map_err(internal)?.rows_affected();
    if n != 1 {
        return Err(bad(
            "Approval expired, purchase already started or daily limit reached.",
        ));
    }
    a.event(&qid, "invoice_request_started").await?;
    let result=a.call(&token,"buy-products",json!({"cart_items":[{"product_id":q["product_id"],"package_value":q["package_value"]}],"payment_method":"bitcoin","return_payment_link":true})).await;
    // Never retry buy-products, including protocol errors/timeouts. Provider has no idempotency argument.
    match result {
        Ok(v) => {
            let invoice = v.get("response").unwrap_or(&v);
            if let Some(iid) = invoice["invoice_id"].as_str() {
                sqlx::query("UPDATE bitrefill_quotes SET invoice_id=?,invoice=?,status='awaiting_payment' WHERE id=?").bind(iid).bind(a.seal(invoice)?).bind(&qid).execute(&a.pool).await.map_err(internal)?;
                a.event(&qid, "invoice_created").await?;
            } else {
                a.event(&qid, "reconciliation_required").await?;
            }
        }
        Err(_) => {
            a.event(&qid, "reconciliation_required").await?;
        }
    }
    Ok(Json(summary(&a, &owned(&a, &owner, &qid).await?)?))
}
async fn owned(a: &App, owner: &str, id: &str) -> Result<sqlx::sqlite::SqliteRow> {
    sqlx::query("SELECT * FROM bitrefill_quotes WHERE id=? AND owner=?")
        .bind(id)
        .bind(owner)
        .fetch_optional(&a.pool)
        .await
        .map_err(internal)?
        .ok_or(Error(StatusCode::NOT_FOUND, "Order not found."))
}
fn payment_link(v: &Value) -> Option<String> {
    let link = v["payment_link"].as_str()?;
    let u = Url::parse(link).ok()?;
    if u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str()
            .is_some_and(|h| h == "bitrefill.com" || h.ends_with(".bitrefill.com"))
    {
        Some(link.into())
    } else {
        None
    }
}
fn summary(a: &App, row: &sqlx::sqlite::SqliteRow) -> Result<Value> {
    let invoice = row
        .get::<Option<Vec<u8>>, _>("invoice")
        .map(|b| a.unseal(&b))
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(
        json!({"order_id":row.get::<String,_>("id"),"status":row.get::<String,_>("status"),"invoice_id":row.get::<Option<String>,_>("invoice_id"),"quote":a.unseal(&row.get::<Vec<u8>,_>("payload"))?,"payment_link":payment_link(&invoice),"provider_status":invoice.get("invoice_status").or_else(||invoice.get("status")),"delivery_available":row.get::<String,_>("status")=="fulfilled"}),
    )
}
async fn orders(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>> {
    let (owner, _) = a.session(&h, false, true).await?;
    let rows =
        sqlx::query("SELECT * FROM bitrefill_quotes WHERE owner=? ORDER BY created DESC LIMIT 30")
            .bind(owner)
            .fetch_all(&a.pool)
            .await
            .map_err(internal)?;
    Ok(Json(
        json!({"orders":rows.iter().map(|r|summary(&a,r)).collect::<Result<Vec<_>>>()?}),
    ))
}
async fn order(State(a): State<App>, h: HeaderMap, Path(qid): Path<String>) -> Result<Json<Value>> {
    let _g = a.gate.lock().await;
    let (owner, mut s) = a.session(&h, false, true).await?;
    let row = owned(&a, &owner, &qid).await?;
    if let Some(iid) = row.get::<Option<String>, _>("invoice_id") {
        let state: String = row.get("status");
        if matches!(
            state.as_str(),
            "awaiting_payment" | "payment_pending" | "reconciliation_required"
        ) && row.get::<i64, _>("last_poll") + 15 <= now()
        {
            sqlx::query("UPDATE bitrefill_quotes SET last_poll=? WHERE id=?")
                .bind(now())
                .bind(&qid)
                .execute(&a.pool)
                .await
                .map_err(internal)?;
            let token = a.token(&owner, &mut s).await?;
            let previous = row
                .get::<Option<Vec<u8>>, _>("invoice")
                .map(|b| a.unseal(&b))
                .transpose()?
                .unwrap_or(json!({}));
            let mut args = json!({"invoice_id":iid});
            if let Some(t) = previous.get("invoice_access_token") {
                args["invoice_access_token"] = t.clone();
            }
            match a.call(&token, "get-invoice-by-id", args).await {
                Ok(v) => {
                    let mut v = v.get("response").unwrap_or(&v).clone();
                    let status = v
                        .get("invoice_status")
                        .or_else(|| v.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let next = match status {
                        "complete" => "fulfilled",
                        "unpaid" => "awaiting_payment",
                        "payment_detected" | "payment_confirmed" | "pending" => "payment_pending",
                        _ => "reconciliation_required",
                    };
                    for k in ["payment_link", "invoice_access_token"] {
                        if v.get(k).is_none()
                            && let Some(old) = previous.get(k)
                        {
                            v[k] = old.clone();
                        }
                    }
                    sqlx::query("UPDATE bitrefill_quotes SET invoice=?,status=? WHERE id=?")
                        .bind(a.seal(&v)?)
                        .bind(next)
                        .bind(&qid)
                        .execute(&a.pool)
                        .await
                        .map_err(internal)?;
                    if state != next {
                        a.event(&qid, next).await?;
                    }
                }
                Err(_) => {
                    a.event(&qid, "poll_delayed").await?;
                }
            }
        }
    }
    let mut out = summary(&a, &owned(&a, &owner, &qid).await?)?;
    let events =
        sqlx::query("SELECT kind,created FROM bitrefill_events WHERE order_id=? ORDER BY id")
            .bind(qid)
            .fetch_all(&a.pool)
            .await
            .map_err(internal)?;
    out["events"] = json!(
        events
            .iter()
            .map(|r| json!({"kind":r.get::<String,_>("kind"),"at":r.get::<i64,_>("created")}))
            .collect::<Vec<_>>()
    );
    Ok(Json(out))
}
async fn reveal(
    State(a): State<App>,
    h: HeaderMap,
    Path(qid): Path<String>,
) -> Result<Json<Value>> {
    let (owner, _) = a.session(&h, true, true).await?;
    let row = owned(&a, &owner, &qid).await?;
    if row.get::<String, _>("status") != "fulfilled" {
        return Err(bad("Delivery is not complete yet."));
    }
    let invoice = a.unseal(&row.get::<Vec<u8>, _>("invoice"))?;
    let delivered = invoice["orders"]
        .as_array()
        .ok_or(provider("orders"))?
        .iter()
        .map(|o| json!({"redemption_info":o["redemption_info"],"status":o["status"]}))
        .collect::<Vec<_>>();
    a.event(&qid, "delivery_revealed").await?;
    Ok(Json(json!({"delivery":delivered})))
}
async fn cancel(
    State(a): State<App>,
    h: HeaderMap,
    Path(qid): Path<String>,
) -> Result<Json<Value>> {
    let (owner, _) = a.session(&h, true, true).await?;
    let n=sqlx::query("UPDATE bitrefill_quotes SET status='cancelled' WHERE id=? AND owner=? AND status IN ('quoted','approved')").bind(&qid).bind(owner).execute(&a.pool).await.map_err(internal)?.rows_affected();
    if n != 1 {
        return Err(bad(
            "An invoice may already exist. Do not pay it; check Bitrefill status. This action cannot cancel a payment.",
        ));
    }
    a.event(&qid, "cancelled").await?;
    Ok(Json(json!({"status":"cancelled"})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tower::ServiceExt;
    #[derive(Clone)]
    struct Mock {
        calls: Arc<AtomicUsize>,
        mode: Arc<AtomicUsize>,
    }
    fn detail() -> Value {
        toon_format::decode_default(include_str!("../tests/fixtures/details.toon")).unwrap()
    }
    async fn mock(State(m): State<Mock>, Json(v): Json<Value>) -> Json<Value> {
        let result = if v["method"] == "tools/list" {
            let mut tools: Value =
                serde_json::from_str(include_str!("../tests/fixtures/tools.json")).unwrap();
            // Production OAuth user schema has no guest email requirement.
            for t in tools["tools"].as_array_mut().unwrap() {
                if t["name"] == "buy-products" {
                    t["inputSchema"]["required"] = json!(["cart_items", "payment_method"]);
                }
            }
            tools
        } else {
            let name = v["params"]["name"].as_str().unwrap();
            let content = match name {
                "get-product-details" => {
                    let mut d = detail();
                    if m.mode.load(Ordering::SeqCst) == 2 {
                        d["packages"][0]["payment_price"] = json!("2.19");
                    }
                    d
                }
                "buy-products" => {
                    m.calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(v["params"]["arguments"]["payment_method"], "bitcoin");
                    assert_eq!(
                        v["params"]["arguments"]["cart_items"]
                            .as_array()
                            .unwrap()
                            .len(),
                        1
                    );
                    if m.mode.load(Ordering::SeqCst) == 1 {
                        return Json(
                            json!({"result":{"isError":true,"content":[{"text":"PAYMENT_UNCERTAIN secret-code"}]}}),
                        );
                    }
                    json!({"response":{"invoice_id":"invoice-1","payment_link":"https://www.bitrefill.com/checkout?token=private-link","invoice_access_token":"private-invoice-token"}})
                }
                "get-invoice-by-id" => {
                    json!({"invoice_status":"complete","orders":[{"status":"delivered","redemption_info":"secret-gift-card-code"}]})
                }
                "search-products" => {
                    json!({"products":[{"slug":"amazon_es-spain","name":"Amazon.es Spain · TEST FIXTURE","countries":["ES"],"type":"giftcards"}]})
                }
                _ => panic!("unexpected tool"),
            };
            json!({"content":[{"type":"text","text":content.to_string()}]})
        };
        Json(json!({"result":result,"jsonrpc":"2.0","id":v["id"]}))
    }
    async fn setup() -> (App, Mock) {
        let mock_state = Mock {
            calls: Arc::new(AtomicUsize::new(0)),
            mode: Arc::new(AtomicUsize::new(0)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/", post(mock))
            .with_state(mock_state.clone());
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        schema(&pool).await.unwrap();
        let a = App {
            pool,
            cipher: Aes256Gcm::new_from_slice(&[42; 32]).unwrap(),
            http: reqwest::Client::new(),
            mcp: format!("http://{addr}/"),
            origin: "http://127.0.0.1:8082".into(),
            client_id: "test-client".into(),
            oauth: json!({}),
            enabled: true,
            gate: Arc::new(Mutex::new(())),
        };
        let session = json!({"csrf":"csrf","token":{"access_token":"private-oauth-token"},"token_expires":now()+3600,"searched":{"kind":"giftcard","country":"ES","ids":["amazon_es-spain"]}});
        sqlx::query("INSERT INTO bitrefill_sessions VALUES (?,?,?)")
            .bind(digest("session"))
            .bind(a.seal(&session).unwrap())
            .bind(now() + 3600)
            .execute(&a.pool)
            .await
            .unwrap();
        (a, mock_state)
    }
    async fn request(a: &App, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        request_headers(a, path, body, "session", "csrf").await
    }
    async fn request_headers(
        a: &App,
        path: &str,
        body: Option<Value>,
        cookie: &str,
        csrf: &str,
    ) -> (StatusCode, Value) {
        let mut r = Request::builder()
            .uri(path)
            .header("Cookie", format!("{}={cookie}", a.cookie_name()))
            .header("Origin", &a.origin)
            .header("X-CSRF-Token", csrf)
            .header("Content-Type", "application/json");
        if body.is_some() {
            r = r.method("POST");
        }
        let r = routes(a.clone())
            .oneshot(
                r.body(
                    body.map(|v| Body::from(v.to_string()))
                        .unwrap_or(Body::empty()),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let status = r.status();
        let b = to_bytes(r.into_body(), 2_000_000).await.unwrap();
        (status, serde_json::from_slice(&b).unwrap())
    }
    async fn make_quote(a: &App) -> Value {
        let (s, v) = request(
            a,
            "/v1/bitrefill/quotes",
            Some(json!({"product_id":"amazon_es-spain","package_value":"5","country":"ES"})),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn approved(a: &App) -> String {
        let q = make_quote(a).await;
        let id = q["quote_id"].as_str().unwrap();
        let (s, v) = request(
            a,
            &format!("/v1/bitrefill/quotes/{id}/approve"),
            Some(json!({"quote_hash":q["quote_hash"],"acknowledged":true})),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        id.into()
    }
    #[test]
    fn gift_cards_require_classified_search_and_reject_esims() {
        let old = json!({"searched":{"country":"ES","ids":["amazon_es-spain"]}});
        assert!(check_searched(&old, "amazon_es-spain").is_err());
        let mut d = detail();
        let input = QuoteInput {
            product_id: "amazon_es-spain".into(),
            package_value: "5".into(),
            country: "ES".into(),
        };
        let q = normalized_quote(&d, &input).unwrap();
        assert_eq!(q["face_value"], "5");
        assert_eq!(q["face_currency"], "EUR");
        assert_eq!(q["catalog_total_minor"], 512);
        d["categories"] = json!(["esim"]);
        assert!(normalized_quote(&d, &input).is_err());
    }

    #[test]
    fn actual_provider_toon_and_price_precision() {
        let d = detail();
        assert_eq!(d["packages"][0]["package_value"], "5");
        assert_eq!(euros(&d["packages"][0]["payment_price"]).unwrap(), 512);
        for s in ["-1", "NaN", "1.001", "9999999999999999999", "1e3"] {
            assert!(euros(&json!(s)).is_err());
        }
    }
    #[test]
    fn capability_contract_fails_closed() {
        let mut tools: Value =
            serde_json::from_str(include_str!("../tests/fixtures/tools.json")).unwrap();
        assert!(validate_capabilities(&tools).is_ok());
        tools["tools"]
            .as_array_mut()
            .unwrap()
            .retain(|v| v["name"] != "buy-products");
        assert!(validate_capabilities(&tools).is_err());
    }
    #[test]
    fn invalid_links_are_not_exposed() {
        for link in [
            "http://bitrefill.com/x",
            "https://bitrefill.com.evil.com/x",
            "javascript:alert(1)",
            "https://evil.com",
        ] {
            assert!(payment_link(&json!({"payment_link":link})).is_none());
        }
    }
    #[tokio::test]
    async fn approval_required_expiry_hash_csrf_and_owner() {
        let (a, m) = setup().await;
        let q = make_quote(&a).await;
        let id = q["quote_id"].as_str().unwrap();
        let url = format!("/v1/bitrefill/quotes/{id}/purchase");
        assert_eq!(
            request(&a, &url, Some(json!({}))).await.0,
            StatusCode::BAD_REQUEST
        );
        let approval = format!("/v1/bitrefill/quotes/{id}/approve");
        let payload = json!({"quote_hash":q["quote_hash"],"acknowledged":true});
        assert_eq!(
            request_headers(&a, &approval, Some(payload.clone()), "session", "wrong")
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(
                &a,
                &approval,
                Some(json!({"quote_hash":"changed","acknowledged":true}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request_headers(
                &a,
                &format!("/v1/bitrefill/orders/{id}"),
                None,
                "someone-else",
                "csrf"
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        sqlx::query("UPDATE bitrefill_quotes SET expires=0")
            .execute(&a.pool)
            .await
            .unwrap();
        assert_eq!(
            request(&a, &approval, Some(payload)).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(m.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn changed_quote_never_buys() {
        let (a, m) = setup().await;
        let id = approved(&a).await;
        m.mode.store(2, Ordering::SeqCst);
        assert_eq!(
            request(
                &a,
                &format!("/v1/bitrefill/quotes/{id}/purchase"),
                Some(json!({}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(m.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn concurrent_retry_single_invoice_persistence_and_secret_reveal() {
        let (a, m) = setup().await;
        let id = approved(&a).await;
        let url = format!("/v1/bitrefill/quotes/{id}/purchase");
        let mut another = a.clone();
        another.gate = Arc::new(Mutex::new(()));
        let (r1, r2) = tokio::join!(
            request(&a, &url, Some(json!({}))),
            request(&another, &url, Some(json!({})))
        );
        assert!(r1.0 == StatusCode::OK || r2.0 == StatusCode::OK);
        assert_eq!(m.calls.load(Ordering::SeqCst), 1);
        let (_, v) = request(&another, &url, Some(json!({}))).await;
        assert_eq!(v["status"], "awaiting_payment");
        assert_eq!(m.calls.load(Ordering::SeqCst), 1);
        let (_, v) = request(&a, &format!("/v1/bitrefill/orders/{id}"), None).await;
        assert_eq!(v["status"], "fulfilled");
        assert!(!v.to_string().contains("secret-gift-card-code"));
        assert!(!v.to_string().contains("private-invoice-token"));
        let (_, v) = request(
            &a,
            &format!("/v1/bitrefill/orders/{id}/reveal"),
            Some(json!({})),
        )
        .await;
        assert!(v.to_string().contains("secret-gift-card-code"));
        let bytes: Vec<u8> = sqlx::query_scalar("SELECT invoice FROM bitrefill_quotes WHERE id=?")
            .bind(&id)
            .fetch_one(&a.pool)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("secret-gift-card-code"));
        let events: Vec<String> = sqlx::query_scalar("SELECT kind FROM bitrefill_events")
            .fetch_all(&a.pool)
            .await
            .unwrap();
        assert!(events.contains(&"delivery_revealed".into()));
        assert!(!events.join("").contains("private"));
    }
    #[tokio::test]
    async fn uncertain_result_survives_restart_without_repurchase() {
        let (a, m) = setup().await;
        let id = approved(&a).await;
        m.mode.store(1, Ordering::SeqCst);
        let url = format!("/v1/bitrefill/quotes/{id}/purchase");
        let (_, v) = request(&a, &url, Some(json!({}))).await;
        assert_eq!(v["status"], "reconciliation_required");
        let mut restart = a.clone();
        restart.gate = Arc::new(Mutex::new(()));
        let (_, v) = request(&restart, &url, Some(json!({}))).await;
        assert_eq!(v["status"], "reconciliation_required");
        assert_eq!(m.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cancellation_and_kill_switch_block_invoice() {
        let (mut a, m) = setup().await;
        let id = approved(&a).await;
        let url = format!("/v1/bitrefill/quotes/{id}/purchase");
        a.enabled = false;
        assert_eq!(
            request(&a, &url, Some(json!({}))).await.0,
            StatusCode::FORBIDDEN
        );
        a.enabled = true;
        assert_eq!(
            request(
                &a,
                &format!("/v1/bitrefill/quotes/{id}/cancel"),
                Some(json!({}))
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, v) = request(&a, &url, Some(json!({}))).await;
        assert_eq!(v["status"], "cancelled");
        assert_eq!(m.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn encryption_tampering_is_detected() {
        let (a, _) = setup().await;
        let mut encrypted = a.seal(&json!({"token":"private"})).unwrap();
        encrypted[15] ^= 1;
        assert!(a.unseal(&encrypted).is_err());
    }
    #[tokio::test]
    async fn authenticated_other_session_cannot_read_or_reveal() {
        let (a, _) = setup().await;
        let id = approved(&a).await;
        let session = json!({"csrf":"other-csrf", "token":{"access_token":"other-token"},"token_expires":now()+3600});
        sqlx::query("INSERT INTO bitrefill_sessions VALUES (?,?,?)")
            .bind(digest("other"))
            .bind(a.seal(&session).unwrap())
            .bind(now() + 3600)
            .execute(&a.pool)
            .await
            .unwrap();
        assert_eq!(
            request_headers(
                &a,
                &format!("/v1/bitrefill/orders/{id}"),
                None,
                "other",
                "other-csrf"
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request_headers(
                &a,
                &format!("/v1/bitrefill/orders/{id}/reveal"),
                Some(json!({})),
                "other",
                "other-csrf"
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    #[tokio::test]
    async fn platform_daily_cap_and_region_cannot_be_bypassed() {
        let (a, m) = setup().await;
        let id = approved(&a).await;
        sqlx::query("INSERT INTO bitrefill_quotes(id,owner,payload,hash,status,expires,amount,created) VALUES ('prior','other',?,'x','fulfilled',?,?,?)").bind(a.seal(&json!({})).unwrap()).bind(now()+300).bind(DAILY_EUR).bind(now()).execute(&a.pool).await.unwrap();
        assert_eq!(
            request(
                &a,
                &format!("/v1/bitrefill/quotes/{id}/purchase"),
                Some(json!({}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            request(
                &a,
                "/v1/bitrefill/quotes",
                Some(json!({"product_id":"amazon_es-spain","package_value":"5","country":"US"}))
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(m.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn disconnected_session_cannot_purchase_and_oauth_state_is_required() {
        let (a, m) = setup().await;
        let id = approved(&a).await;
        a.save_session(&digest("session"), &json!({"csrf":"csrf"}))
            .await
            .unwrap();
        assert_eq!(
            request(
                &a,
                &format!("/v1/bitrefill/quotes/{id}/purchase"),
                Some(json!({}))
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &a,
                "/v1/integrations/bitrefill/oauth/callback?code=untrusted&state=wrong",
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(m.calls.load(Ordering::SeqCst), 0);
    }
    // Only compiled into the test binary; no production authentication bypass.
    #[tokio::test]
    #[ignore = "interactive UI fixture, run explicitly and stop after browser checks"]
    async fn browser_fixture() {
        let (mut a, _) = setup().await;
        a.origin = "http://127.0.0.1:8083".into();
        let app = routes(a).route(
            "/test-start",
            get(|| async {
                (
                    [(
                        header::SET_COOKIE,
                        "compralo_br_8083=session; HttpOnly; SameSite=Lax; Path=/",
                    )],
                    Redirect::to("/bitrefill"),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:8083")
            .await
            .unwrap();
        println!("TEST PROVIDER ONLY: http://127.0.0.1:8083/test-start");
        axum::serve(listener, app).await.unwrap();
    }
}
