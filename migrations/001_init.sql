-- Comment-triggered automations: facts and invariants live here; step progression lives in Temporal.
-- Tenant isolation is enforced by composite foreign keys (id, tenant_id): a row can only reference
-- rows of the same tenant, so a bug in a query cannot silently link two customers' data.

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- An already-existing connected social account (tokens live in the existing integration; we keep a reference only).
CREATE TABLE social_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  platform             text NOT NULL CHECK (platform IN ('instagram')),
  external_account_id  text NOT NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'unauthorized', 'disconnected')),
  sends_paused         boolean NOT NULL DEFAULT false,
  sends_paused_reason  text,
  -- Versioned adapter contract: windows, budgets, reconciliation support. Unknown capability => send not allowed.
  capabilities         jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_account_id),
  UNIQUE (id, tenant_id)
);

CREATE TABLE automations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  connection_id      uuid NOT NULL,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  priority           int NOT NULL DEFAULT 0,
  cooldown_seconds   int NOT NULL DEFAULT 86400 CHECK (cooldown_seconds >= 0),
  active_version_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id),
  UNIQUE (id, tenant_id)
);

-- Immutable published definitions. Runs pin a version; editing creates a new row.
CREATE TABLE automation_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  automation_id  uuid NOT NULL,
  version        int NOT NULL,
  definition     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, version),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (automation_id, tenant_id) REFERENCES automations(id, tenant_id)
);
ALTER TABLE automations ADD FOREIGN KEY (active_version_id, tenant_id) REFERENCES automation_versions(id, tenant_id);

-- One row per (connected account, participant). The row lock serialises everything that happens
-- in one conversation: triggers, inbound DMs, prompt boundaries, consumption and expiry.
CREATE TABLE conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  connection_id         uuid NOT NULL,
  participant_id        text NOT NULL,            -- platform-scoped id, never the username
  owner_run_id          uuid,                     -- the single active automation run (if any)
  last_inbound_seq      bigint NOT NULL DEFAULT 0,
  last_inbound_dm_at    timestamptz,              -- drives the platform messaging window
  opted_out             boolean NOT NULL DEFAULT false,
  human_takeover        boolean NOT NULL DEFAULT false,
  last_run_finished_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, participant_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id)
);

-- Durable inbox: every accepted platform event, deduplicated, with an explainable routing outcome.
CREATE TABLE inbox_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  connection_id       uuid NOT NULL,
  conversation_id     uuid NOT NULL,
  event_type          text NOT NULL CHECK (event_type IN ('comment.created', 'message.received')),
  provider_event_key  text NOT NULL,              -- comment id / message id from the provider
  seq                 bigint NOT NULL,            -- per-conversation arrival order (assigned under the row lock)
  participant_id      text NOT NULL,
  media_id            text,
  comment_id          text,
  text                text NOT NULL,              -- minimal normalised payload; retention policy applies
  occurred_at         timestamptz NOT NULL,       -- provider time (informational)
  received_at         timestamptz NOT NULL,       -- our durable acceptance time (admissibility vs deadline)
  routing_status      text NOT NULL DEFAULT 'pending' CHECK (routing_status IN ('pending', 'routed')),
  routing_outcome     text,
  run_id              uuid,
  UNIQUE (connection_id, event_type, provider_event_key),
  UNIQUE (conversation_id, seq),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id)
);
CREATE INDEX inbox_pending_idx ON inbox_events (received_at) WHERE routing_status = 'pending';

-- Application-level run. Status is a projection for people; it never drives execution.
CREATE TABLE automation_runs (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  automation_id     uuid NOT NULL,
  version_id        uuid NOT NULL,
  conversation_id   uuid NOT NULL,
  trigger_event_id  uuid NOT NULL UNIQUE,             -- one run per trigger event
  workflow_id       text NOT NULL UNIQUE,
  status            text NOT NULL CHECK (status IN ('starting', 'running', 'waiting_input', 'blocked_unknown',
                                                    'completed', 'expired', 'cancelled', 'failed')),
  status_reason     text,
  current_step      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id),
  FOREIGN KEY (automation_id, tenant_id) REFERENCES automations(id, tenant_id),
  FOREIGN KEY (version_id, tenant_id) REFERENCES automation_versions(id, tenant_id),
  FOREIGN KEY (trigger_event_id, tenant_id) REFERENCES inbox_events(id, tenant_id)
);
CREATE INDEX runs_status_idx ON automation_runs (tenant_id, status);
ALTER TABLE conversations ADD FOREIGN KEY (owner_run_id, tenant_id) REFERENCES automation_runs(id, tenant_id);

-- Authoritative control plane for a run (checked by every send), not a projection of workflow state.
CREATE TABLE run_controls (
  run_id            uuid PRIMARY KEY REFERENCES automation_runs(id),
  cancel_requested  boolean NOT NULL DEFAULT false,
  cancel_reason     text,
  requested_at      timestamptz
);

-- Contract for matching inbound input to a question. Not a scheduler: Temporal owns the timer.
CREATE TABLE input_waits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  run_id               uuid NOT NULL,
  step_id              text NOT NULL,
  prompt_step_id       text NOT NULL,
  conversation_id      uuid NOT NULL,
  status               text NOT NULL CHECK (status IN ('prepared', 'active', 'consumed', 'expired', 'cancelled')),
  timeout_ms           bigint NOT NULL,
  max_clarifications   int NOT NULL,
  clarifications_used  int NOT NULL DEFAULT 0,
  boundary_seq         bigint,           -- inbound messages with seq <= boundary predate the question
  prompt_started_at    timestamptz,      -- fixed when the first prompt attempt is reserved
  deadline             timestamptz,      -- prompt_started_at + timeout; never moves
  consumed_event_id    uuid,
  lead_id              uuid,
  closed_at            timestamptz,
  UNIQUE (run_id, step_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES automation_runs(id, tenant_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id),
  FOREIGN KEY (consumed_event_id, tenant_id) REFERENCES inbox_events(id, tenant_id)
);

-- Each inbound event is evaluated by at most one wait, exactly once (including invalid answers).
CREATE TABLE input_consumptions (
  inbox_event_id  uuid PRIMARY KEY,
  wait_id         uuid NOT NULL,
  tenant_id       uuid NOT NULL,
  result          text NOT NULL CHECK (result IN ('valid', 'invalid', 'ambiguous')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (inbox_event_id, tenant_id) REFERENCES inbox_events(id, tenant_id),
  FOREIGN KEY (wait_id, tenant_id) REFERENCES input_waits(id, tenant_id)
);

-- Send ledger: one row per logical outbound action. Retries are attempts of the same intent.
CREATE TABLE message_intents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  run_id               uuid NOT NULL,
  step_id              text NOT NULL,
  action_no            int NOT NULL,           -- 1 = the step's message, 2.. = clarifications
  connection_id        uuid NOT NULL,
  conversation_id      uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('comment_reply', 'private_reply', 'dm')),
  target               jsonb NOT NULL,         -- {"commentId": ...} or {"recipientId": ...}
  body                 text NOT NULL,
  fingerprint          text NOT NULL,          -- immutable hash of (kind, target, body)
  wait_id              uuid,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'in_flight', 'accepted', 'rejected', 'unknown', 'blocked', 'cancelled')),
  status_reason        text,
  current_attempt_id   uuid,
  attempt_count        int NOT NULL DEFAULT 0,
  provider_message_id  text,
  resolved_by          text,                   -- provider | late_result | reconciliation | operator
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_id, action_no),
  FOREIGN KEY (run_id, tenant_id) REFERENCES automation_runs(id, tenant_id),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id),
  FOREIGN KEY (wait_id, tenant_id) REFERENCES input_waits(id, tenant_id)
);
CREATE INDEX intents_unresolved_idx ON message_intents (tenant_id, status) WHERE status IN ('in_flight', 'unknown');

CREATE TABLE message_attempts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id            uuid NOT NULL REFERENCES message_intents(id),
  attempt_no           int NOT NULL,
  started_at           timestamptz NOT NULL,
  finished_at          timestamptz,
  outcome              text CHECK (outcome IN ('accepted', 'rejected', 'not_sent', 'unknown')),
  http_status          int,
  provider_code        text,
  provider_message_id  text,
  recorded_late        boolean NOT NULL DEFAULT false,   -- result arrived after the intent was fenced
  UNIQUE (intent_id, attempt_no)
);

-- Shared per-account send budget (fixed windows). Reserved before the call, never refunded for unknowns.
CREATE TABLE send_budget (
  connection_id  uuid NOT NULL REFERENCES social_connections(id),
  window_start   timestamptz NOT NULL,
  used           int NOT NULL,
  PRIMARY KEY (connection_id, window_start)
);

-- Transactional outbox: commands to Temporal and business events to integrations.
CREATE TABLE outbox (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid,
  kind             text NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'dead')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  done_at          timestamptz
);
CREATE INDEX outbox_ready_idx ON outbox (kind, next_attempt_at) WHERE status = 'pending';

CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  connection_id    uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  participant_id   text NOT NULL,
  run_id           uuid NOT NULL UNIQUE,
  source_event_id  uuid NOT NULL,
  email            text NOT NULL,
  email_status     text NOT NULL DEFAULT 'format_valid_unverified',
  crm_status       text NOT NULL DEFAULT 'pending' CHECK (crm_status IN ('pending', 'synced', 'failed')),
  crm_synced_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id),
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES automation_runs(id, tenant_id),
  FOREIGN KEY (source_event_id, tenant_id) REFERENCES inbox_events(id, tenant_id)
);

-- Grouped operational incidents (what gets sent to Telegram), not one alert per event.
CREATE TABLE incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  connection_id     uuid,
  error_class       text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  occurrences       int NOT NULL DEFAULT 1,
  affected_runs     uuid[] NOT NULL DEFAULT '{}',
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_notified_at  timestamptz,
  notify_count      int NOT NULL DEFAULT 0,
  resolved_at       timestamptz,
  FOREIGN KEY (connection_id, tenant_id) REFERENCES social_connections(id, tenant_id)
);
CREATE UNIQUE INDEX incidents_open_uq ON incidents
  (tenant_id, coalesce(connection_id, '00000000-0000-0000-0000-000000000000'::uuid), error_class)
  WHERE status = 'open';

-- Append-only decision log: the "why did this stop?" timeline.
CREATE TABLE run_audit_events (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  run_id           uuid,
  conversation_id  uuid,
  inbox_event_id   uuid,
  intent_id        uuid,
  type             text NOT NULL,
  reason           text,
  data             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_run_idx ON run_audit_events (run_id, id);
CREATE INDEX audit_conversation_idx ON run_audit_events (conversation_id, id);
