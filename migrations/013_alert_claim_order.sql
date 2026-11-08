-- Only the earliest pending notification per tenant/incident may be claimed.
-- This also covers predecessors deferred by backoff or owned by another relay.
CREATE INDEX outbox_pending_alert_incident_order
  ON outbox(tenant_id, (payload->>'incidentId'), id)
  WHERE kind='alert.notify' AND status='pending';
