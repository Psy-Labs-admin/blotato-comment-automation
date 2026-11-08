ALTER TABLE social_connections ADD COLUMN integration_kind text CHECK (integration_kind IN ('native', 'gateway'));

CREATE TABLE instagram_login_states (
  state_hash text PRIMARY KEY,
  binding_hash text NOT NULL,
  session_hash text NOT NULL REFERENCES operator_sessions(session_hash) ON DELETE CASCADE,
  credential_hash text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  expected_account_id text,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX instagram_login_expiry ON instagram_login_states(expires_at);

CREATE TABLE instagram_credentials (
  connection_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  encrypted_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  refresh_after timestamptz NOT NULL,
  token_version integer NOT NULL DEFAULT 1,
  granted_scopes text[] NOT NULL,
  refresh_claim uuid,
  refreshing_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id)
);
CREATE INDEX instagram_credentials_refresh ON instagram_credentials(refresh_after);
