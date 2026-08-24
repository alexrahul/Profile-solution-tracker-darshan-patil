CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS users(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name VARCHAR(150) NOT NULL,
 email VARCHAR(255) UNIQUE NOT NULL,
 password_hash VARCHAR(255) NOT NULL,
 role VARCHAR(30) NOT NULL DEFAULT 'ADMIN',
 active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_sessions(
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_active ON refresh_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS dashboard_preferences(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
 hide_dashboard BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calendar_data(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 event_date DATE NOT NULL,
 event_title VARCHAR(255) NOT NULL,
 description TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meeting_schedule(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 meeting_date DATE NOT NULL,
 meeting_time VARCHAR(30) NOT NULL,
 meeting_name VARCHAR(255) NOT NULL,
 team VARCHAR(180),
 meeting_room VARCHAR(100),
 sort_order INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS department_schedule(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 schedule_date DATE NOT NULL,
 department_name VARCHAR(120) NOT NULL,
 start_time VARCHAR(30) NOT NULL,
 end_time VARCHAR(30) NOT NULL,
 location VARCHAR(180) NOT NULL,
 sort_order INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS manpower_images(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 "date" DATE NOT NULL,
 image_url TEXT NOT NULL,
 storage_path TEXT,
 title VARCHAR(255) NOT NULL,
 description TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_data(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reading_date DATE NOT NULL,
 location_name VARCHAR(50) NOT NULL CHECK(location_name IN ('Manpower','Wada','HO')),
 present_count INT NOT NULL DEFAULT 0 CHECK(present_count>=0),
 absent_count INT NOT NULL DEFAULT 0 CHECK(absent_count>=0),
 half_day_count INT NOT NULL DEFAULT 0 CHECK(half_day_count>=0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(reading_date,location_name)
);

CREATE TABLE IF NOT EXISTS tasks_data(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 task_date DATE NOT NULL,
 task_time VARCHAR(30) NOT NULL,
 task_name VARCHAR(255) NOT NULL,
 status VARCHAR(40) NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Completed','Overdue')),
 sort_order INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notes_data(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 note_date DATE NOT NULL,
 note_title VARCHAR(255) NOT NULL,
 note_description TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE,
 sort_order INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminders_data(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 reminder_date DATE NOT NULL,
 reminder_time VARCHAR(30) NOT NULL,
 reminder_description TEXT NOT NULL,
 sort_order INT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calendar_connections(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider VARCHAR(20) NOT NULL CHECK(provider IN ('GOOGLE','MICROSOFT')),
 access_token_encrypted TEXT NOT NULL,
 refresh_token_encrypted TEXT,
 token_expiry TIMESTAMPTZ,
 calendar_id VARCHAR(255) NOT NULL DEFAULT 'primary',
 connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id,provider)
);

CREATE TABLE IF NOT EXISTS calendar_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 calendar_connection_id UUID NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
 external_event_id VARCHAR(255) NOT NULL,
 subject VARCHAR(500),
 description TEXT,
 start_time TIMESTAMPTZ NOT NULL,
 end_time TIMESTAMPTZ,
 all_day BOOLEAN NOT NULL DEFAULT FALSE,
 meeting_link TEXT,
 location VARCHAR(500),
 attendees JSONB,
 last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(calendar_connection_id,external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_preferences_user ON dashboard_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_connections_user ON calendar_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_events_connection ON calendar_events(calendar_connection_id);
CREATE INDEX IF NOT EXISTS idx_calendar_date ON calendar_data(event_date);
CREATE INDEX IF NOT EXISTS idx_meeting_date ON meeting_schedule(meeting_date);
CREATE INDEX IF NOT EXISTS idx_department_date ON department_schedule(schedule_date);
CREATE INDEX IF NOT EXISTS idx_manpower_images_date ON manpower_images("date");
CREATE INDEX IF NOT EXISTS idx_attendance_date_location ON attendance_data(reading_date,location_name);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks_data(task_date);
CREATE INDEX IF NOT EXISTS idx_notes_date ON notes_data(note_date);
CREATE INDEX IF NOT EXISTS idx_reminders_date ON reminders_data(reminder_date);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_dashboard_preferences_updated_at ON dashboard_preferences;
CREATE TRIGGER trg_dashboard_preferences_updated_at BEFORE UPDATE ON dashboard_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_calendar_updated_at ON calendar_data;
CREATE TRIGGER trg_calendar_updated_at BEFORE UPDATE ON calendar_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_meetings_updated_at ON meeting_schedule;
CREATE TRIGGER trg_meetings_updated_at BEFORE UPDATE ON meeting_schedule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_departments_updated_at ON department_schedule;
CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON department_schedule FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_manpower_images_updated_at ON manpower_images;
CREATE TRIGGER trg_manpower_images_updated_at BEFORE UPDATE ON manpower_images FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_attendance_updated_at ON attendance_data;
CREATE TRIGGER trg_attendance_updated_at BEFORE UPDATE ON attendance_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks_data;
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON tasks_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_notes_updated_at ON notes_data;
CREATE TRIGGER trg_notes_updated_at BEFORE UPDATE ON notes_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_reminders_updated_at ON reminders_data;
CREATE TRIGGER trg_reminders_updated_at BEFORE UPDATE ON reminders_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_calendar_connections_updated_at ON calendar_connections;
CREATE TRIGGER trg_calendar_connections_updated_at BEFORE UPDATE ON calendar_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_calendar_events_updated_at ON calendar_events;
CREATE TRIGGER trg_calendar_events_updated_at BEFORE UPDATE ON calendar_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
