use chrono::{DateTime, Duration, Utc};
use domain::{Monitor, MonitorStatus, NormalizedOffer};
use rule_engine::EvaluationDecision;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, Sqlite, SqlitePool, Transaction, sqlite::SqlitePoolOptions};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("invalid persisted data: {0}")]
    InvalidData(String),
    #[error("monitor not found")]
    NotFound,
    #[error("monitor cannot be changed from its current state")]
    InvalidState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorEvent {
    pub id: i64,
    pub monitor_id: Uuid,
    pub kind: String,
    pub payload: Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct LeasedJob {
    pub monitor: Monitor,
    pub lease_owner: String,
    pub lease_expires_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub async fn connect(database_url: &str) -> Result<Self, StoreError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub async fn in_memory() -> Result<Self, StoreError> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        Ok(Self { pool })
    }

    pub async fn migrate(&self) -> Result<(), StoreError> {
        sqlx::migrate!("../../migrations").run(&self.pool).await?;
        Ok(())
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub async fn create_monitor(&self, monitor: &Monitor) -> Result<(), StoreError> {
        let now = Utc::now();
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO monitors (id,url,product_json,constraints_json,deadline,status,check_interval_seconds,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
            .bind(monitor.id.to_string()).bind(monitor.url.as_str())
            .bind(monitor.product.as_ref().map(serde_json::to_string).transpose().map_err(data_err)?)
            .bind(serde_json::to_string(&monitor.constraints).map_err(data_err)?)
            .bind(monitor.deadline).bind(status_str(monitor.status)).bind(monitor.check_interval_seconds)
            .bind(monitor.created_at).bind(now).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO monitor_jobs (monitor_id,next_check_at) VALUES (?,?)")
            .bind(monitor.id.to_string())
            .bind(now)
            .execute(&mut *tx)
            .await?;
        append_event_tx(
            &mut tx,
            monitor.id,
            "monitor_created",
            serde_json::json!({"url": monitor.url}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn get_monitor(&self, id: Uuid) -> Result<Monitor, StoreError> {
        let row = sqlx::query("SELECT * FROM monitors WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?
            .ok_or(StoreError::NotFound)?;
        row_to_monitor(&row)
    }

    pub async fn set_product_if_missing(
        &self,
        id: Uuid,
        product: &domain::CanonicalProduct,
    ) -> Result<bool, StoreError> {
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query(
            "UPDATE monitors SET product_json=?, updated_at=? WHERE id=? AND product_json IS NULL AND status='active'",
        )
        .bind(serde_json::to_string(product).map_err(data_err)?)
        .bind(Utc::now())
        .bind(id.to_string())
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if changed {
            append_event_tx(
                &mut tx,
                id,
                "product_baseline_established",
                serde_json::json!({"product": product}),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(changed)
    }

    pub async fn list_monitors(&self) -> Result<Vec<Monitor>, StoreError> {
        sqlx::query("SELECT * FROM monitors ORDER BY created_at DESC")
            .fetch_all(&self.pool)
            .await?
            .iter()
            .map(row_to_monitor)
            .collect()
    }

    pub async fn cancel_monitor(&self, id: Uuid) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        let result = sqlx::query("UPDATE monitors SET status='cancelled', updated_at=? WHERE id=? AND status IN ('active','evaluating','payment_required','failed')")
            .bind(Utc::now()).bind(id.to_string()).execute(&mut *tx).await?;
        if result.rows_affected() != 1 {
            return Err(StoreError::InvalidState);
        }
        sqlx::query("DELETE FROM monitor_jobs WHERE monitor_id=?")
            .bind(id.to_string())
            .execute(&mut *tx)
            .await?;
        append_event_tx(&mut tx, id, "monitor_cancelled", serde_json::json!({})).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Expire everything past its deadline. Returns the monitors that moved, so the caller can
    /// release their committed funds — every terminal state gives the money back.
    pub async fn expire_due_monitors(&self, now: DateTime<Utc>) -> Result<Vec<Uuid>, StoreError> {
        let mut tx = self.pool.begin().await?;
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM monitors WHERE deadline<=? AND status IN ('active','evaluating','failed')",
        )
        .bind(now)
        .fetch_all(&mut *tx)
        .await?;
        let mut expired = Vec::with_capacity(ids.len());
        for raw_id in &ids {
            sqlx::query("UPDATE monitors SET status='expired', updated_at=? WHERE id=?")
                .bind(now)
                .bind(raw_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM monitor_jobs WHERE monitor_id=?")
                .bind(raw_id)
                .execute(&mut *tx)
                .await?;
            let id = parse_uuid(raw_id.clone())?;
            append_event_tx(&mut tx, id, "monitor_expired", serde_json::json!({})).await?;
            expired.push(id);
        }
        tx.commit().await?;
        Ok(expired)
    }

    pub async fn append_event(
        &self,
        id: Uuid,
        kind: &str,
        payload: Value,
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        append_event_tx(&mut tx, id, kind, payload).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn events(&self, id: Uuid) -> Result<Vec<MonitorEvent>, StoreError> {
        let rows = sqlx::query("SELECT id,monitor_id,kind,payload_json,created_at FROM monitor_events WHERE monitor_id=? ORDER BY id")
            .bind(id.to_string()).fetch_all(&self.pool).await?;
        rows.iter()
            .map(|r| {
                Ok(MonitorEvent {
                    id: r.get("id"),
                    monitor_id: parse_uuid(r.get::<String, _>("monitor_id"))?,
                    kind: r.get("kind"),
                    payload: serde_json::from_str(r.get("payload_json")).map_err(data_err)?,
                    created_at: r.get("created_at"),
                })
            })
            .collect()
    }

    pub async fn record_offer(
        &self,
        monitor_id: Uuid,
        offer: &NormalizedOffer,
        decision: &EvaluationDecision,
    ) -> Result<Uuid, StoreError> {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO offers (id,monitor_id,offer_json,decision_json,observed_at) VALUES (?,?,?,?,?)")
            .bind(id.to_string()).bind(monitor_id.to_string()).bind(serde_json::to_string(offer).map_err(data_err)?)
            .bind(serde_json::to_string(decision).map_err(data_err)?).bind(offer.checked_at).execute(&self.pool).await?;
        self.append_event(
            monitor_id,
            "offer_evaluated",
            serde_json::json!({"offer_id": id, "decision": decision}),
        )
        .await?;
        Ok(id)
    }

    pub async fn create_payment_authorization(
        &self,
        monitor_id: Uuid,
        maximum_minor: i64,
        currency: &str,
    ) -> Result<Uuid, StoreError> {
        self.create_payment_authorization_with_reference(
            monitor_id,
            None,
            maximum_minor,
            currency,
            false,
        )
        .await
        .map(|(id, _)| id)
    }

    /// Record the mandate hold. `provider_reference` is the payment provider's own handle — P4's
    /// Stripe `hold_id` once the money service is wired, and a local `demo-` stand-in otherwise.
    /// Returns the authorization id and the reference actually stored.
    ///
    /// `needs_attention` means the hold exists but 3DS did not finish, so it cannot be captured
    /// yet. The monitor is parked in `payment_required`, which also stops the checker claiming it
    /// (`claim_due_job` only leases `active` monitors) until the user confirms in the panel.
    pub async fn create_payment_authorization_with_reference(
        &self,
        monitor_id: Uuid,
        provider_reference: Option<&str>,
        maximum_minor: i64,
        currency: &str,
        needs_attention: bool,
    ) -> Result<(Uuid, String), StoreError> {
        self.get_monitor(monitor_id).await?;
        let id = Uuid::new_v4();
        let reference = provider_reference
            .map(str::to_string)
            .unwrap_or_else(|| format!("demo-{id}"));
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO payment_authorizations (id,monitor_id,provider_reference,maximum_minor,currency,status,created_at) VALUES (?,?,?,?,?,'authorized',?)")
            .bind(id.to_string()).bind(monitor_id.to_string()).bind(&reference)
            .bind(maximum_minor).bind(currency).bind(Utc::now()).execute(&mut *tx).await?;
        append_event_tx(
            &mut tx,
            monitor_id,
            "payment_authorized",
            serde_json::json!({
                "authorization_id": id,
                "maximum_minor": maximum_minor,
                "currency": currency,
                "provider_reference": reference,
                "status": if needs_attention { "needs_attention" } else { "committed" },
            }),
        )
        .await?;
        if needs_attention {
            sqlx::query("UPDATE monitors SET status='payment_required', updated_at=? WHERE id=? AND status IN ('active','evaluating')")
                .bind(Utc::now()).bind(monitor_id.to_string()).execute(&mut *tx).await?;
            append_event_tx(
                &mut tx,
                monitor_id,
                "payment_required",
                serde_json::json!({
                    "authorization_id": id,
                    "provider_reference": reference,
                    "error": "the bank asked the user to confirm this hold before it can be used",
                }),
            )
            .await?;
        }
        tx.commit().await?;
        Ok((id, reference))
    }

    pub async fn has_valid_payment_authorization(
        &self,
        monitor_id: Uuid,
        minimum_minor: i64,
        currency: &str,
    ) -> Result<bool, StoreError> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM payment_authorizations WHERE monitor_id=? AND status='authorized' AND maximum_minor>=? AND UPPER(currency)=UPPER(?)",
        )
        .bind(monitor_id.to_string())
        .bind(minimum_minor)
        .bind(currency)
        .fetch_one(&self.pool)
        .await?;
        Ok(count > 0)
    }

    pub async fn claim_due_job(
        &self,
        worker: &str,
        lease_for: Duration,
    ) -> Result<Option<LeasedJob>, StoreError> {
        let now = Utc::now();
        let expires = now + lease_for;
        let mut tx = self.pool.begin().await?;
        let row = sqlx::query("SELECT monitor_id FROM monitor_jobs j JOIN monitors m ON m.id=j.monitor_id WHERE m.status='active' AND j.next_check_at<=? AND (j.lease_expires_at IS NULL OR j.lease_expires_at<?) ORDER BY j.next_check_at LIMIT 1")
            .bind(now).bind(now).fetch_optional(&mut *tx).await?;
        let Some(row) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        let id: String = row.get("monitor_id");
        let changed = sqlx::query("UPDATE monitor_jobs SET lease_owner=?, lease_expires_at=? WHERE monitor_id=? AND (lease_expires_at IS NULL OR lease_expires_at<?)")
            .bind(worker).bind(expires).bind(&id).bind(now).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            tx.rollback().await?;
            return Ok(None);
        }
        let monitor_row = sqlx::query("SELECT * FROM monitors WHERE id=?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
        let monitor = row_to_monitor(&monitor_row)?;
        tx.commit().await?;
        Ok(Some(LeasedJob {
            monitor,
            lease_owner: worker.into(),
            lease_expires_at: expires,
        }))
    }

    pub async fn complete_job(
        &self,
        id: Uuid,
        worker: &str,
        success: bool,
    ) -> Result<(), StoreError> {
        let monitor = self.get_monitor(id).await?;
        let next = Utc::now()
            + Duration::seconds(if success {
                monitor.check_interval_seconds
            } else {
                failure_delay(
                    monitor.check_interval_seconds,
                    self.failure_count(id).await? + 1,
                )
            });
        let result = sqlx::query("UPDATE monitor_jobs SET next_check_at=?, last_checked_at=?, consecutive_failures=CASE WHEN ? THEN 0 ELSE consecutive_failures+1 END, lease_owner=NULL, lease_expires_at=NULL WHERE monitor_id=? AND lease_owner=?")
            .bind(next).bind(Utc::now()).bind(success).bind(id.to_string()).bind(worker).execute(&self.pool).await?;
        if result.rows_affected() != 1 {
            return Err(StoreError::InvalidState);
        }
        Ok(())
    }

    async fn failure_count(&self, id: Uuid) -> Result<i64, StoreError> {
        Ok(
            sqlx::query_scalar("SELECT consecutive_failures FROM monitor_jobs WHERE monitor_id=?")
                .bind(id.to_string())
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub async fn claim_execution(
        &self,
        monitor_id: Uuid,
        idempotency_key: &str,
    ) -> Result<Uuid, StoreError> {
        let mut tx = self.pool.begin().await?;
        let updated = sqlx::query("UPDATE monitors SET status='executing', updated_at=? WHERE id=? AND status IN ('active','evaluating')")
            .bind(Utc::now()).bind(monitor_id.to_string()).execute(&mut *tx).await?.rows_affected();
        if updated != 1 {
            return Err(StoreError::InvalidState);
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO execution_attempts (id,monitor_id,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,'started',?,?)")
            .bind(id.to_string()).bind(monitor_id.to_string()).bind(idempotency_key).bind(Utc::now()).bind(Utc::now()).execute(&mut *tx).await?;
        append_event_tx(
            &mut tx,
            monitor_id,
            "execution_started",
            serde_json::json!({"attempt_id": id}),
        )
        .await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn complete_execution(
        &self,
        monitor_id: Uuid,
        attempt_id: Uuid,
        order_id: &str,
        total_minor: i64,
        currency: &str,
        idempotency_key: &str,
    ) -> Result<(), StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT OR IGNORE INTO merchant_orders (id,monitor_id,idempotency_key,total_minor,currency,status,created_at) VALUES (?,?,?,?,?,'confirmed',?)")
            .bind(order_id).bind(monitor_id.to_string()).bind(idempotency_key).bind(total_minor).bind(currency).bind(Utc::now()).execute(&mut *tx).await?;
        sqlx::query("UPDATE execution_attempts SET status='succeeded', merchant_order_id=?, updated_at=? WHERE id=? AND status='started'")
            .bind(order_id).bind(Utc::now()).bind(attempt_id.to_string()).execute(&mut *tx).await?;
        sqlx::query("UPDATE monitors SET status='purchased', updated_at=? WHERE id=? AND status='executing'")
            .bind(Utc::now()).bind(monitor_id.to_string()).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM monitor_jobs WHERE monitor_id=?")
            .bind(monitor_id.to_string())
            .execute(&mut *tx)
            .await?;
        append_event_tx(
            &mut tx,
            monitor_id,
            "purchase_confirmed",
            serde_json::json!({"order_id": order_id}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn fail_execution(
        &self,
        monitor_id: Uuid,
        attempt_id: Uuid,
        payment_required: bool,
        error: &str,
    ) -> Result<(), StoreError> {
        let status = if payment_required {
            "payment_required"
        } else {
            "active"
        };
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "UPDATE execution_attempts SET status='failed', error=?, updated_at=? WHERE id=?",
        )
        .bind(error)
        .bind(Utc::now())
        .bind(attempt_id.to_string())
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE monitors SET status=?, updated_at=? WHERE id=? AND status='executing'")
            .bind(status)
            .bind(Utc::now())
            .bind(monitor_id.to_string())
            .execute(&mut *tx)
            .await?;
        append_event_tx(
            &mut tx,
            monitor_id,
            if payment_required {
                "payment_required"
            } else {
                "execution_failed"
            },
            serde_json::json!({"error": error}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

async fn append_event_tx(
    tx: &mut Transaction<'_, Sqlite>,
    id: Uuid,
    kind: &str,
    payload: Value,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO monitor_events (monitor_id,kind,payload_json,created_at) VALUES (?,?,?,?)",
    )
    .bind(id.to_string())
    .bind(kind)
    .bind(payload.to_string())
    .bind(Utc::now())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn row_to_monitor(row: &sqlx::sqlite::SqliteRow) -> Result<Monitor, StoreError> {
    let product = row
        .get::<Option<String>, _>("product_json")
        .map(|s| serde_json::from_str(&s).map_err(data_err))
        .transpose()?;
    Ok(Monitor {
        id: parse_uuid(row.get("id"))?,
        url: url::Url::parse(row.get("url")).map_err(data_err)?,
        product,
        constraints: serde_json::from_str(row.get("constraints_json")).map_err(data_err)?,
        deadline: row.get("deadline"),
        status: parse_status(row.get("status"))?,
        check_interval_seconds: row.get("check_interval_seconds"),
        created_at: row.get("created_at"),
    })
}

fn status_str(status: MonitorStatus) -> &'static str {
    match status {
        MonitorStatus::Active => "active",
        MonitorStatus::Evaluating => "evaluating",
        MonitorStatus::Executing => "executing",
        MonitorStatus::Purchased => "purchased",
        MonitorStatus::PaymentRequired => "payment_required",
        MonitorStatus::Failed => "failed",
        MonitorStatus::Expired => "expired",
        MonitorStatus::Cancelled => "cancelled",
    }
}
fn parse_status(s: String) -> Result<MonitorStatus, StoreError> {
    match s.as_str() {
        "active" => Ok(MonitorStatus::Active),
        "evaluating" => Ok(MonitorStatus::Evaluating),
        "executing" => Ok(MonitorStatus::Executing),
        "purchased" => Ok(MonitorStatus::Purchased),
        "payment_required" => Ok(MonitorStatus::PaymentRequired),
        "failed" => Ok(MonitorStatus::Failed),
        "expired" => Ok(MonitorStatus::Expired),
        "cancelled" => Ok(MonitorStatus::Cancelled),
        _ => Err(StoreError::InvalidData(format!("unknown status {s}"))),
    }
}
fn parse_uuid(s: String) -> Result<Uuid, StoreError> {
    Uuid::parse_str(&s).map_err(data_err)
}
fn data_err(e: impl std::fmt::Display) -> StoreError {
    StoreError::InvalidData(e.to_string())
}
fn failure_delay(base: i64, failures: i64) -> i64 {
    base.saturating_mul(1_i64 << failures.min(6) as u32)
        .min(3600)
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::PurchaseConstraints;
    use std::collections::HashMap;
    use url::Url;
    async fn store() -> Store {
        let s = Store::in_memory().await.unwrap();
        s.migrate().await.unwrap();
        s
    }
    fn monitor() -> Monitor {
        Monitor {
            id: Uuid::new_v4(),
            url: Url::parse("https://example.com/product").unwrap(),
            product: None,
            constraints: PurchaseConstraints {
                maximum_total_minor: 1000,
                currency: "EUR".into(),
                condition: None,
                variants: HashMap::new(),
                bundles_allowed: false,
                approved_retailers: vec![],
            },
            deadline: Utc::now() + Duration::days(1),
            status: MonitorStatus::Active,
            check_interval_seconds: 60,
            created_at: Utc::now(),
        }
    }
    #[tokio::test]
    async fn persists_and_leases_monitor() {
        let s = store().await;
        let m = monitor();
        s.create_monitor(&m).await.unwrap();
        assert_eq!(s.get_monitor(m.id).await.unwrap().url, m.url);
        let j = s
            .claim_due_job("w1", Duration::seconds(30))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(j.monitor.id, m.id);
        assert!(
            s.claim_due_job("w2", Duration::seconds(30))
                .await
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn execution_claim_is_atomic() {
        let s = store().await;
        let m = monitor();
        s.create_monitor(&m).await.unwrap();
        s.claim_execution(m.id, "key-1").await.unwrap();
        assert!(matches!(
            s.claim_execution(m.id, "key-2").await,
            Err(StoreError::InvalidState)
        ));
    }
}
