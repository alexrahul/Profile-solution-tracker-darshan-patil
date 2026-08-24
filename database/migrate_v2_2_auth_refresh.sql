-- Profile Solutions Dashboard v2.2.0 upgrade
-- Run this ONCE in Supabase SQL Editor AFTER migrate_v2_1_date_filter.sql.
-- It does not alter the approved dashboard data tables or delete existing records.

CREATE TABLE IF NOT EXISTS refresh_sessions(
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_active ON refresh_sessions(expires_at) WHERE revoked_at IS NULL;

-- Optional cleanup for stale sessions. Safe to run repeatedly.
DELETE FROM refresh_sessions
WHERE expires_at < now() - interval '7 days'
   OR (revoked_at is not null AND revoked_at < now() - interval '7 days');
