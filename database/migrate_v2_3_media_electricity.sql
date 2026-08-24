-- Profile Solutions Dashboard v2.3.0
-- Run this once in Supabase SQL Editor after v2.1 and v2.2 migrations.
-- It adds manpower image metadata and multi-reading electricity analytics.
-- Existing tables/data are preserved.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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

CREATE TABLE IF NOT EXISTS electricity_readings(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 "date" DATE NOT NULL,
 "time" TIME NOT NULL,
 meter_reading NUMERIC(18,2) NOT NULL CHECK(meter_reading >= 0),
 consumption NUMERIC(18,2) NOT NULL CHECK(consumption >= 0),
 remarks TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_electricity_readings_date_time
ON electricity_readings("date","time");

DROP TRIGGER IF EXISTS trg_electricity_readings_updated_at ON electricity_readings;
CREATE TRIGGER trg_electricity_readings_updated_at
BEFORE UPDATE ON electricity_readings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Preserve historical daily totals from older versions.
-- Each legacy daily record is migrated once as a 23:59 reading with a migration remark.
INSERT INTO electricity_readings("date","time",meter_reading,consumption,remarks)
SELECT e.reading_date,
       TIME '23:59',
       0,
       e.consumption_value,
       'Migrated from legacy electricity_data; meter reading unavailable'
FROM electricity_data e
WHERE NOT EXISTS (
  SELECT 1
  FROM electricity_readings r
  WHERE r."date" = e.reading_date
    AND r.remarks = 'Migrated from legacy electricity_data; meter reading unavailable'
);
