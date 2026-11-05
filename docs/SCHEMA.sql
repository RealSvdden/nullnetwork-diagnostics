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
