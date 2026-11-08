-- Fence expired relay claims so late results cannot overwrite a newer delivery.
ALTER TABLE outbox ADD COLUMN claim_token uuid;
