-- Migration for the Nullnetwork admin panel (owner of the D1 database). Apply it BEFORE
-- deploying a worker that reads diag_revoked_ips or writes status 'expired', or every
-- registration and every expiry sweep will fail until it is applied.
--
-- What it does:
--  1. diag_captures.status gains the value 'expired': an open capture past its TTL keeps
--     its row (objects deleted) so it still counts toward the device's daily quotas.
--     SQLite cannot alter a CHECK constraint, so the table is rebuilt in place.
--  2. A revoked install blocks the IP bucket(s) it was seen from (IPv4 /32, IPv6 /64,
--     salted hashes only) from registering again for 30 days. The panel's existing
--     UPDATE diag_devices SET revoked = ? ... is enough: one trigger records the buckets
--     on revoke, the other removes them on un-revoke.
--
-- Note for whoever applies it: the trigger bodies contain semicolons. wrangler d1
-- execute/migrations handle BEGIN ... END blocks; a tool that splits on ';' does not.

-- 1. diag_captures: allow status 'expired' (rebuild; same columns, same order).
CREATE TABLE diag_captures_new (
  ref             TEXT    PRIMARY KEY,
  device_id       TEXT    NOT NULL,
  module          TEXT    NOT NULL,
  category        TEXT    NOT NULL,
  signature       TEXT    NOT NULL,
  message         TEXT,
  report_id       TEXT,
  status          TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'expired', 'complete')),
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

INSERT INTO diag_captures_new SELECT * FROM diag_captures;
DROP TABLE diag_captures;
ALTER TABLE diag_captures_new RENAME TO diag_captures;

CREATE INDEX IF NOT EXISTS idx_diag_captures_time   ON diag_captures (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_captures_cat    ON diag_captures (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_captures_sig    ON diag_captures (signature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_diag_captures_device ON diag_captures (device_id, created_at DESC);

-- 2. Revoke persistence.
ALTER TABLE diag_devices ADD COLUMN revoked_at INTEGER;

-- IP buckets (see ipBucket() in the worker: IPv4 /32, IPv6 /64) that a revoked install
-- registered or uploaded from. POST /v1/register refuses a bucket whose revoked_at is
-- within the last 30 days with the same 403 a revoked device gets, so "reset install id"
-- cannot undo a staff revoke. Rows are written by the revoke trigger below and by the
-- worker when a revoked install contacts it from a new bucket (at most 3 per device);
-- the un-revoke trigger removes that device's rows again. One row per (bucket, device)
-- so pardoning one install never lifts a block that another revoked install still holds.
CREATE TABLE IF NOT EXISTS diag_revoked_ips (
  ip_hash    TEXT    NOT NULL,
  device_id  TEXT    NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, device_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_diag_revoked_ips_device ON diag_revoked_ips (device_id);

-- Installs revoked before this migration: date the revoke at their last contact and
-- block the buckets they registered and uploaded from.
UPDATE diag_devices SET revoked_at = last_seen_at WHERE revoked = 1 AND revoked_at IS NULL;

INSERT OR IGNORE INTO diag_revoked_ips (ip_hash, device_id, revoked_at)
  SELECT ip_hash, device_id, revoked_at FROM diag_devices WHERE revoked = 1 AND ip_hash IS NOT NULL;

INSERT OR IGNORE INTO diag_revoked_ips (ip_hash, device_id, revoked_at)
  SELECT c.ip_hash, c.device_id, d.revoked_at
  FROM diag_captures c JOIN diag_devices d ON d.device_id = c.device_id
  WHERE d.revoked = 1 AND c.ip_hash IS NOT NULL;

-- Revoke (0 -> 1): the admin panel runs UPDATE diag_devices SET revoked = 1 ...; this stamps
-- the time and records every bucket the device was seen from.
CREATE TRIGGER IF NOT EXISTS trg_diag_devices_revoked
AFTER UPDATE OF revoked ON diag_devices
WHEN NEW.revoked = 1 AND (OLD.revoked IS NULL OR OLD.revoked = 0)
BEGIN
  UPDATE diag_devices SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE device_id = NEW.device_id;
  INSERT OR REPLACE INTO diag_revoked_ips (ip_hash, device_id, revoked_at)
    SELECT ip_hash, NEW.device_id, CAST(strftime('%s', 'now') AS INTEGER) FROM (
      SELECT NEW.ip_hash AS ip_hash
      UNION
      SELECT ip_hash FROM diag_captures WHERE device_id = NEW.device_id
    ) WHERE ip_hash IS NOT NULL;
END;

-- Un-revoke (1 -> 0): lift that device's block at once.
CREATE TRIGGER IF NOT EXISTS trg_diag_devices_unrevoked
AFTER UPDATE OF revoked ON diag_devices
WHEN NEW.revoked = 0 AND OLD.revoked = 1
BEGIN
  DELETE FROM diag_revoked_ips WHERE device_id = NEW.device_id;
  UPDATE diag_devices SET revoked_at = NULL WHERE device_id = NEW.device_id;
END;
