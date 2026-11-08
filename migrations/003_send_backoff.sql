-- A provider's retry hint must survive worker retries and restarts.
ALTER TABLE message_intents ADD COLUMN next_attempt_at timestamptz;
