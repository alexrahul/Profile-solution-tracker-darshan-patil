-- Run this ONCE in Supabase SQL Editor when upgrading from v2.0.0.
-- Existing records in tables that previously had no date column are backfilled
-- using their created_at date so they remain accessible and can then be edited by Admin.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE calendar_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE meeting_schedule ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE kpi_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE department_schedule ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE electricity_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE attendance_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE tasks_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE notes_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reminders_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE meeting_schedule ADD COLUMN IF NOT EXISTS meeting_date DATE;
UPDATE meeting_schedule SET meeting_date = created_at::date WHERE meeting_date IS NULL;
ALTER TABLE meeting_schedule ALTER COLUMN meeting_date SET NOT NULL;

ALTER TABLE department_schedule ADD COLUMN IF NOT EXISTS schedule_date DATE;
UPDATE department_schedule SET schedule_date = created_at::date WHERE schedule_date IS NULL;
ALTER TABLE department_schedule ALTER COLUMN schedule_date SET NOT NULL;

ALTER TABLE notes_data ADD COLUMN IF NOT EXISTS note_date DATE;
UPDATE notes_data SET note_date = created_at::date WHERE note_date IS NULL;
ALTER TABLE notes_data ALTER COLUMN note_date SET NOT NULL;

-- v2.0 already had these date columns, but remove implicit CURRENT_DATE defaults so
-- every new record must explicitly carry the date selected by Admin.
ALTER TABLE tasks_data ALTER COLUMN task_date DROP DEFAULT;
ALTER TABLE reminders_data ALTER COLUMN reminder_date DROP DEFAULT;

-- KPI is one daily snapshot. Keep the latest row if older versions created duplicates.
DELETE FROM kpi_data older
USING kpi_data newer
WHERE older.data_date = newer.data_date
  AND (older.created_at, older.id) < (newer.created_at, newer.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_data_date ON kpi_data(data_date);

CREATE INDEX IF NOT EXISTS idx_calendar_date ON calendar_data(event_date);
CREATE INDEX IF NOT EXISTS idx_meeting_date ON meeting_schedule(meeting_date);
CREATE INDEX IF NOT EXISTS idx_kpi_date ON kpi_data(data_date DESC);
CREATE INDEX IF NOT EXISTS idx_department_date ON department_schedule(schedule_date);
CREATE INDEX IF NOT EXISTS idx_electricity_date ON electricity_data(reading_date);
CREATE INDEX IF NOT EXISTS idx_attendance_date_location ON attendance_data(reading_date,location_name);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks_data(task_date);
CREATE INDEX IF NOT EXISTS idx_notes_date ON notes_data(note_date);
CREATE INDEX IF NOT EXISTS idx_reminders_date ON reminders_data(reminder_date);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_calendar_updated_at ON calendar_data;
CREATE TRIGGER trg_calendar_updated_at BEFORE UPDATE ON calendar_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_meetings_updated_at ON meeting_schedule;
CREATE TRIGGER trg_meetings_updated_at BEFORE UPDATE ON meeting_schedule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_kpi_updated_at ON kpi_data;
CREATE TRIGGER trg_kpi_updated_at BEFORE UPDATE ON kpi_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_departments_updated_at ON department_schedule;
CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON department_schedule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_electricity_updated_at ON electricity_data;
CREATE TRIGGER trg_electricity_updated_at BEFORE UPDATE ON electricity_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_attendance_updated_at ON attendance_data;
CREATE TRIGGER trg_attendance_updated_at BEFORE UPDATE ON attendance_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks_data;
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON tasks_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_notes_updated_at ON notes_data;
CREATE TRIGGER trg_notes_updated_at BEFORE UPDATE ON notes_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_reminders_updated_at ON reminders_data;
CREATE TRIGGER trg_reminders_updated_at BEFORE UPDATE ON reminders_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
