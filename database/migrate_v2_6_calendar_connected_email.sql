-- Profile Solutions Dashboard v2.6.0
-- Run this AFTER the v2.5 calendar integration migration.
-- Stores the connected account's own email address so Settings can show which
-- Google/Microsoft account a calendar connection actually points to.

BEGIN;

ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS connected_email VARCHAR(255);

COMMIT;
