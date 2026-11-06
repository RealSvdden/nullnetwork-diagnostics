-- D1 tables the ingest worker writes. This is a copy of the Nullnetwork admin
-- panel's migration 0051_diagnostics.sql; the panel owns the database and applies
-- migrations. Kept here so the worker is readable on its own.

CREATE TABLE IF NOT EXISTS diag_devices (
  device_id    TEXT    PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash      TEXT,
  country      TEXT,
  app_version  TEXT,
  fingerprint  TEXT,
  player_tag   TEXT,
  uploads      INTEGER NOT NULL DEFAULT 0,
  bytes        INTEGER NOT NULL DEFAULT 0,
  day          INTEGER NOT NULL DEFAULT 0,
  day_uploads  INTEGER NOT NULL DEFAULT 0,
  day_bytes    INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0,
  revoked_at   INTEGER,                 -- set by the trigger below when revoked flips to 1
  note         TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS diag_captures (
  ref             TEXT    PRIMARY KEY,
  device_id       TEXT    NOT NULL,
  module          TEXT    NOT NULL,
  category        TEXT    NOT NULL,
  signature       TEXT    NOT NULL,
  message         TEXT,
  report_id       TEXT,
  status          TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'complete')),
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  captured_at     INTEGER,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  files           TEXT    NOT NULL DEFAULT '[]',
  files_done      TEXT    NOT NULL DEFAULT '[]',
  player_tag      TEXT,
  note            TEXT,
  game_version    TEXT,
  app_version     TEXT,
  os              TEXT,
  cpu             TEXT,
  ram_gb          INTEGER,
  country         TEXT,
  ip_hash         TEXT,
  session_seconds INTEGER,
  meta            TEXT    NOT NULL DEFAULT '{}'
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_diag_captures_time   ON diag_captures (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_captures_cat    ON diag_captures (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_captures_sig    ON diag_captures (signature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_captures_device ON diag_captures (device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS diag_nonces (
  device_id TEXT    NOT NULL,
  nonce     TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
) WITHOUT ROWID;

-- IP buckets (see ipBucket() in the worker: IPv4 /32, IPv6 /64) that a revoked install
-- registered or uploaded from. POST /v1/register refuses a bucket whose revoked_at is
-- within the last 30 days with the same 403 a revoked device gets, so "reset install id"
-- cannot undo a staff revoke. Rows are written by the trigger below (admin panel revoke)
-- and by the worker when a revoked install contacts it from a new bucket.
CREATE TABLE IF NOT EXISTS diag_revoked_ips (
  ip_hash    TEXT    PRIMARY KEY,
  device_id  TEXT    NOT NULL,
  revoked_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_diag_revoked_ips_time ON diag_revoked_ips (revoked_at);

-- The admin panel revokes with UPDATE diag_devices SET revoked = 1 ...; this stamps the
-- time and records every bucket the device was seen from.
CREATE TRIGGER IF NOT EXISTS trg_diag_devices_revoked
AFTER UPDATE OF revoked ON diag_devices
WHEN NEW.revoked = 1 AND (OLD.revoked IS NULL OR OLD.revoked = 0)
BEGIN
  UPDATE diag_devices SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE device_id = NEW.device_id;
  INSERT INTO diag_revoked_ips (ip_hash, device_id, revoked_at)
    SELECT ip_hash, NEW.device_id, CAST(strftime('%s', 'now') AS INTEGER) FROM (
      SELECT NEW.ip_hash AS ip_hash
      UNION
      SELECT ip_hash FROM diag_captures WHERE device_id = NEW.device_id
    ) WHERE ip_hash IS NOT NULL
    ON CONFLICT (ip_hash) DO UPDATE SET revoked_at = excluded.revoked_at, device_id = excluded.device_id;
END;
