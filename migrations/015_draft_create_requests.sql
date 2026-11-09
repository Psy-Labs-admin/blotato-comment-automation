-- Scoped to the workspace, never to a credential that can be rotated or revoked.
-- Reservation, draft and response commit together; failed attempts leave no reservation.
CREATE TABLE draft_create_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  input jsonb NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
