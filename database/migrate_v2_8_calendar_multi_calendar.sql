-- Profile Solutions Dashboard v2.8.0
-- Multi-calendar sync: previously only each connected account's PRIMARY Google/
-- Microsoft calendar was ever fetched. This adds calendar discovery + per-
-- calendar selection so shared/subscribed calendars under Google "Other
-- calendars" can feed Meeting Schedule too.
-- Run this AFTER the v2.6 migration. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS calendar_selections(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_connection_id UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  external_calendar_id VARCHAR(500) NOT NULL,
  calendar_name VARCHAR(255),
  access_role VARCHAR(50),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  selected BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ,
  last_sync_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(calendar_connection_id,external_calendar_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_selections_connection ON calendar_selections(calendar_connection_id);

DROP TRIGGER IF EXISTS trg_calendar_selections_updated_at ON calendar_selections;
CREATE TRIGGER trg_calendar_selections_updated_at
BEFORE UPDATE ON calendar_selections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Track which source calendar each cached event came from.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS external_calendar_id VARCHAR(500) NOT NULL DEFAULT 'primary';

-- Widen the de-dup/upsert key from (connection, event id) to
-- (connection, calendar, event id) so the same event id can't collide across
-- two different calendars on the same connection. Find whatever the old
-- unique constraint was actually named (Postgres may have generated/truncated
-- it) rather than assuming a name.
DO $$
DECLARE
  old_constraint text;
BEGIN
  SELECT tc.constraint_name INTO old_constraint
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'calendar_events'
    AND tc.constraint_type = 'UNIQUE'
  GROUP BY tc.constraint_name
  HAVING array_agg(kcu.column_name ORDER BY kcu.ordinal_position) = ARRAY['calendar_connection_id','external_event_id'];

  IF old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE calendar_events DROP CONSTRAINT %I', old_constraint);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calendar_events_connection_calendar_event_key') THEN
    ALTER TABLE calendar_events
      ADD CONSTRAINT calendar_events_connection_calendar_event_key
      UNIQUE(calendar_connection_id,external_calendar_id,external_event_id);
  END IF;
END $$;

-- Seed a "primary calendar, selected" row for every connection that already
-- exists, so currently-working sync keeps working with zero action required.
-- Other calendars on the account are discovered (unselected) on the next sync
-- and the admin opts them in from Settings > Manage Calendars.
INSERT INTO calendar_selections(calendar_connection_id, external_calendar_id, calendar_name, is_primary, selected)
SELECT id, 'primary', 'Primary Calendar', true, true
FROM calendar_connections
ON CONFLICT (calendar_connection_id, external_calendar_id) DO NOTHING;

COMMIT;
