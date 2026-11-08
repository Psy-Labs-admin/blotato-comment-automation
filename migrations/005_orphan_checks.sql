-- Rotate orphan inspections across active waits without altering status timestamps.
ALTER TABLE automation_runs ADD COLUMN workflow_checked_at timestamptz;
