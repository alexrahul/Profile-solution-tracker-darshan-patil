-- Profile Solutions Dashboard v2.4.0
-- Run this AFTER the v2.3 migration when upgrading an existing Supabase database.
-- IMPORTANT: This migration intentionally removes the KPI and electricity tables,
-- because those modules were explicitly removed from the application.

BEGIN;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS dashboard_preferences(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hide_dashboard BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

DROP TRIGGER IF EXISTS trg_dashboard_preferences_updated_at ON dashboard_preferences;
CREATE TRIGGER trg_dashboard_preferences_updated_at
BEFORE UPDATE ON dashboard_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_dashboard_preferences_user
ON dashboard_preferences(user_id);

-- Ensure the manpower image table required by the primary image viewer exists.
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

CREATE INDEX IF NOT EXISTS idx_manpower_images_date ON manpower_images("date");

DROP TRIGGER IF EXISTS trg_manpower_images_updated_at ON manpower_images;
CREATE TRIGGER trg_manpower_images_updated_at
BEFORE UPDATE ON manpower_images
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Removed modules.
DROP TABLE IF EXISTS electricity_readings CASCADE;
DROP TABLE IF EXISTS electricity_data CASCADE;
DROP TABLE IF EXISTS kpi_data CASCADE;

COMMIT;
