-- Extend tenant checks to optional links and the diagnostic/event tables.
ALTER TABLE leads ADD CONSTRAINT leads_id_tenant_uq UNIQUE (id, tenant_id);
ALTER TABLE message_intents ADD CONSTRAINT intents_id_tenant_uq UNIQUE (id, tenant_id);
ALTER TABLE inbox_events ADD CONSTRAINT inbox_run_tenant_fk
  FOREIGN KEY (run_id, tenant_id) REFERENCES automation_runs(id, tenant_id);
ALTER TABLE input_waits ADD CONSTRAINT waits_lead_tenant_fk
  FOREIGN KEY (lead_id, tenant_id) REFERENCES leads(id, tenant_id);
ALTER TABLE incidents ADD CONSTRAINT incidents_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE outbox ADD CONSTRAINT outbox_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE run_audit_events ADD CONSTRAINT audit_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE run_audit_events ADD CONSTRAINT audit_run_tenant_fk
  FOREIGN KEY (run_id, tenant_id) REFERENCES automation_runs(id, tenant_id);
ALTER TABLE run_audit_events ADD CONSTRAINT audit_conversation_tenant_fk
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id);
ALTER TABLE run_audit_events ADD CONSTRAINT audit_inbox_tenant_fk
  FOREIGN KEY (inbox_event_id, tenant_id) REFERENCES inbox_events(id, tenant_id);
ALTER TABLE run_audit_events ADD CONSTRAINT audit_intent_tenant_fk
  FOREIGN KEY (intent_id, tenant_id) REFERENCES message_intents(id, tenant_id);
