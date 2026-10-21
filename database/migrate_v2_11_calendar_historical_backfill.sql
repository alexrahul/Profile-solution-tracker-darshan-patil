-- Profile Solution Dashboard v2.11.0
-- Historical calendar backfill. Purely additive - a new table only, no
-- existing columns, tables or data are changed or removed. Safe to re-run.
-- Run this AFTER the v2.10 migration.

BEGIN;

-- Tracks which (connection, calendar, calendar-month) windows have already
-- been fetched from the provider and cached in calendar_events, beyond the
-- regular periodic sync's rolling window (today - SYNC_WINDOW_PAST_DAYS
-- forward). Lets a historical date be backfilled once, on demand, and then
-- served from cache on every later visit instead of re-fetching live each time.
CREATE TABLE IF NOT EXISTS calendar_sync_coverage(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_connection_id UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  external_calendar_id VARCHAR(500) NOT NULL,
  covered DATERANGE NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_coverage_lookup ON calendar_sync_coverage(calendar_connection_id,external_calendar_id);

COMMIT;
