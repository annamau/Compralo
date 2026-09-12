PRAGMA foreign_keys = ON;

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  product_json TEXT,
  constraints_json TEXT NOT NULL,
  deadline TEXT NOT NULL,
  status TEXT NOT NULL,
  check_interval_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE monitor_jobs (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
  next_check_at TEXT NOT NULL,
  last_checked_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT
);
CREATE INDEX monitor_jobs_due_idx ON monitor_jobs(next_check_at);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  offer_json TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  merchant_order_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_successful_execution_per_monitor
  ON execution_attempts(monitor_id) WHERE status = 'succeeded';

CREATE TABLE merchant_orders (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE payment_authorizations (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  provider_reference TEXT NOT NULL,
  maximum_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE monitor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX monitor_events_monitor_idx ON monitor_events(monitor_id, id);

