-- Machine credentials are separate from operator sessions and monitoring tokens.
-- Only a SHA-256 digest is persisted; revocation is checked on every API request.
CREATE TABLE integration_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  scope text NOT NULL CHECK (scope IN ('read', 'write')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX integration_keys_tenant ON integration_keys(tenant_id, created_at);

-- Keyset pagination resolves creation time and UUID within one workspace.
CREATE INDEX drafts_workspace_page ON automation_drafts(tenant_id, created_at DESC, id DESC);
CREATE INDEX automations_workspace_page ON automations(tenant_id, created_at DESC, id DESC);
CREATE INDEX runs_workspace_page ON automation_runs(tenant_id, created_at DESC, id DESC);
CREATE INDEX leads_workspace_page ON leads(tenant_id, created_at DESC, id DESC);
