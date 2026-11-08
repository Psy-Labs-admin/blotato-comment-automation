CREATE TABLE post_metadata_cache (
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  media_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'denied', 'not_found')),
  metadata jsonb,
  fetched_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now(),
  refresh_token uuid,
  refreshing_until timestamptz,
  PRIMARY KEY (connection_id, media_id),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id)
);
ALTER TABLE inbox_events ADD COLUMN text_redacted_at timestamptz;
CREATE INDEX inbox_retention_idx ON inbox_events (received_at)
  WHERE routing_status = 'routed' AND text_redacted_at IS NULL;
