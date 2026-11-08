CREATE TABLE operator_sessions (
  session_hash text PRIMARY KEY,
  credential_hash text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX operator_session_expiry ON operator_sessions(expires_at);

CREATE TABLE operator_login_tickets (
  ticket_hash text PRIMARY KEY,
  credential_hash text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX operator_ticket_expiry ON operator_login_tickets(expires_at);
