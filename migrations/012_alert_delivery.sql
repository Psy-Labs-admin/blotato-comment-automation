ALTER TABLE incidents ADD CONSTRAINT incidents_id_tenant_uq UNIQUE(id, tenant_id);
CREATE TABLE alert_deliveries (
  outbox_id bigint PRIMARY KEY REFERENCES outbox(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  incident_id uuid NOT NULL,
  channel text NOT NULL CHECK(channel IN ('telegram','webhook')),
  channel_key text NOT NULL,
  status text NOT NULL CHECK(status IN ('accepted','retryable','permanent','unknown','skipped')),
  attempts integer NOT NULL CHECK(attempts > 0),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  last_error_code text,
  provider_message_id text,
  retry_not_before timestamptz,
  FOREIGN KEY(incident_id, tenant_id) REFERENCES incidents(id, tenant_id)
);
CREATE INDEX alert_deliveries_tenant_time ON alert_deliveries(tenant_id, last_attempt_at DESC);
CREATE INDEX alert_deliveries_channel_retry ON alert_deliveries(channel_key, retry_not_before);
