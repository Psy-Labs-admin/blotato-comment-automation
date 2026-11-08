-- Give poison events a durable retry schedule so bounded sweeps can reach later events.
ALTER TABLE inbox_events ADD COLUMN routing_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE inbox_events ADD COLUMN next_routing_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX inbox_routing_ready_idx ON inbox_events (next_routing_attempt_at, received_at, id)
  WHERE routing_status = 'pending';
