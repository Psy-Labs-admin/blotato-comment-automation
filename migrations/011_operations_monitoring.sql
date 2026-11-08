ALTER TABLE outbox ADD COLUMN retry_generation bigint NOT NULL DEFAULT 0 CHECK (retry_generation >= 0);

CREATE TABLE service_heartbeats (
  instance_id uuid PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('worker', 'relay')),
  temporal_namespace text NOT NULL,
  task_queue text NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'degraded', 'stopping')),
  started_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX service_heartbeat_pipeline_idx ON service_heartbeats(temporal_namespace, task_queue, role, observed_at DESC);
CREATE INDEX incidents_tenant_timeline_idx ON incidents(tenant_id, status, first_seen_at DESC, id DESC);
CREATE INDEX outbox_tenant_status_idx ON outbox(tenant_id, status, id DESC);
