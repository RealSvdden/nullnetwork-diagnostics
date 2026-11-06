-- Migration for the Nullnetwork admin panel (owner of the D1 database): copy this into
-- its migrations folder as the next number and apply it BEFORE deploying a worker that
-- reads diag_revoked_ips, or every registration will fail with 500 until it is applied.
--
-- What it does: a revoked install blocks the IP bucket(s) it was seen from (IPv4 /32,
-- IPv6 /64, salted hashes only) from registering again for 30 days. The panel's existing
-- UPDATE diag_devices SET revoked = 1 is enough; the trigger does the bookkeeping.
--
-- Note for whoever applies it: the trigger body contains semicolons. wrangler d1
-- execute/migrations handle BEGIN ... END blocks; a tool that splits on ';' does not.

ALTER TABLE diag_devices ADD COLUMN revoked_at INTEGER;

CREATE TABLE IF NOT EXISTS diag_revoked_ips (
  ip_hash    TEXT    PRIMARY KEY,
  device_id  TEXT    NOT NULL,
  revoked_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_diag_revoked_ips_time ON diag_revoked_ips (revoked_at);

-- Installs revoked before this migration: date the revoke at their last contact and
-- block the buckets they registered and uploaded from.
UPDATE diag_devices SET revoked_at = last_seen_at WHERE revoked = 1 AND revoked_at IS NULL;

INSERT OR IGNORE INTO diag_revoked_ips (ip_hash, device_id, revoked_at)
  SELECT ip_hash, device_id, revoked_at FROM diag_devices WHERE revoked = 1 AND ip_hash IS NOT NULL;

INSERT OR IGNORE INTO diag_revoked_ips (ip_hash, device_id, revoked_at)
  SELECT c.ip_hash, c.device_id, d.revoked_at
  FROM diag_captures c JOIN diag_devices d ON d.device_id = c.device_id
  WHERE d.revoked = 1 AND c.ip_hash IS NOT NULL;

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
