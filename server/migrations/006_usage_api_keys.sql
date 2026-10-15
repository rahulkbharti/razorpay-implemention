-- Metered usage and API keys.

-- How much of a metered limit (e.g. "api_calls_monthly") a workspace used in each calendar month.
-- A new month is a new row, so usage starts again from zero; old rows are the usage history.
CREATE TABLE usage_counters (
  tenant_id   int NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  period      date NOT NULL, -- first day of the month, in India time (see entitlements.js)
  used        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, feature_key, period)
);

-- Keys a workspace's own code uses to call the API (/api/v1). The key itself is shown once when
-- it's created and never stored: only its SHA-256 hash, plus the last 4 characters to tell keys apart.
CREATE TABLE api_keys (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    int NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  last_four    text NOT NULL,
  created_by   int REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_tenant ON api_keys (tenant_id);
