-- Profile Solution Dashboard v2.10.0
-- Calendar sync / dashboard performance fixes. Purely additive - no columns,
-- tables or data are changed or removed. Safe to re-run.
-- Run this AFTER the v2.9 migration.

BEGIN;

-- Matches the exact expression public.js's dashboard query filters calendar
-- events on (the IST calendar day for timed events, the bare UTC-anchored day
-- for all-day ones), so that lookup can use an index scan instead of
-- evaluating the timezone conversion against every row on every request.
CREATE INDEX IF NOT EXISTS idx_calendar_events_local_date ON calendar_events (
  (case when all_day then (start_time at time zone 'UTC')::date
        else (start_time at time zone 'Asia/Kolkata')::date end)
);

COMMIT;
