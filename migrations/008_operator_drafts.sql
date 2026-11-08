ALTER TABLE social_connections ADD COLUMN display_name text;
ALTER TABLE social_connections ADD COLUMN verified_at timestamptz;
ALTER TABLE social_connections ADD COLUMN integration_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE social_connections ADD COLUMN integration_updated_at timestamptz;

CREATE TABLE automation_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  connection_id uuid,
  automation_id uuid UNIQUE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_revision integer,
  published_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id),
  FOREIGN KEY (automation_id, tenant_id) REFERENCES automations(id, tenant_id),
  FOREIGN KEY (published_version_id, tenant_id) REFERENCES automation_versions(id, tenant_id)
);
CREATE INDEX automation_drafts_tenant_idx ON automation_drafts (tenant_id, updated_at DESC, id);

CREATE TABLE integration_account_events (
  event_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_account_id text NOT NULL,
  integration_revision bigint NOT NULL,
  payload_digest text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
