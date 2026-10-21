import { query, pool } from "../db.js";
import { encryptToken, decryptToken } from "../cryptoUtil.js";
import { refreshAccessToken, listCalendars, fetchEventsForCalendar } from "./calendarProviders.js";

const SYNC_WINDOW_PAST_DAYS = 1;
const SYNC_WINDOW_FUTURE_DAYS = 30;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const HARD_AUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

async function ensureFreshAccessToken(connection) {
  const expiry = connection.token_expiry ? new Date(connection.token_expiry).getTime() : 0;
  const needsRefresh = !expiry || expiry - Date.now() < REFRESH_MARGIN_MS;

  if (!needsRefresh) {
    return decryptToken(connection.access_token_encrypted);
  }

  const refreshToken = decryptToken(connection.refresh_token_encrypted);
  if (!refreshToken) {
    const err = new Error("No refresh token available to renew calendar access");
    err.code = "invalid_grant";
    throw err;
  }

  const refreshed = await refreshAccessToken(connection.provider, refreshToken);
  const newExpiry = new Date(Date.now() + (refreshed.expiresIn || 3600) * 1000);

  await query(
    `update calendar_connections
     set access_token_encrypted=$1, refresh_token_encrypted=$2, token_expiry=$3
     where id=$4`,
    [
      encryptToken(refreshed.accessToken),
      encryptToken(refreshed.refreshToken),
      newExpiry,
      connection.id
    ]
  );

  return refreshed.accessToken;
}

async function upsertCalendarSelection(connectionId, cal) {
  // `selected` is only set from `cal.isPrimary` on the INITIAL insert (the
  // primary calendar keeps working with zero setup, matching prior behavior).
  // On conflict it's deliberately left out of the SET list so a user's saved
  // selection is never overwritten by a routine discovery/sync pass.
  const result = await query(
    `insert into calendar_selections(calendar_connection_id,external_calendar_id,calendar_name,access_role,is_primary,selected)
     values($1,$2,$3,$4,$5,$5)
     on conflict(calendar_connection_id,external_calendar_id) do update
       set calendar_name=excluded.calendar_name,
           access_role=excluded.access_role,
           is_primary=excluded.is_primary,
           updated_at=now()
     returning *`,
    [connectionId, cal.externalCalendarId, cal.name, cal.accessRole, cal.isPrimary]
  );
  return { ...result.rows[0], readable: cal.readable !== false };
}

// Refreshes the set of calendars known for this connection (My Calendars +
// Google "Other calendars" already added on the account) without touching
// which ones are selected or re-fetching their events.
export async function discoverCalendars(connection, accessToken) {
  const remote = await listCalendars(connection.provider, accessToken);
  const rows = [];
  for (const cal of remote) {
    rows.push(await upsertCalendarSelection(connection.id, cal));
  }
  return rows;
}

export async function listCalendarsForConnection(connection) {
  const accessToken = await ensureFreshAccessToken(connection);
  return discoverCalendars(connection, accessToken);
}

async function replaceCalendarEvents(connectionId, calendarId, events, timeMin, timeMax) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const seenIds = events.map(e => e.externalEventId);
    // Anything previously cached for this calendar+window that didn't come back
    // this pass has been edited-away, cancelled or deleted upstream - drop it.
    await client.query(
      `delete from calendar_events
       where calendar_connection_id=$1 and external_calendar_id=$2
         and start_time >= $3 and start_time <= $4
         and not (external_event_id = any($5::text[]))`,
      [connectionId, calendarId, timeMin, timeMax, seenIds]
    );

    for (const event of events) {
      await client.query(
        `insert into calendar_events(
           calendar_connection_id,external_calendar_id,external_event_id,subject,description,
           start_time,end_time,all_day,meeting_link,location,attendees,last_synced_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         on conflict(calendar_connection_id,external_calendar_id,external_event_id) do update
         set subject=excluded.subject,
             description=excluded.description,
             start_time=excluded.start_time,
             end_time=excluded.end_time,
             all_day=excluded.all_day,
             meeting_link=excluded.meeting_link,
             location=excluded.location,
             attendees=excluded.attendees,
             last_synced_at=now()`,
        [
          connectionId,
          calendarId,
          event.externalEventId,
          event.subject,
          event.description,
          event.startTime,
          event.endTime,
          event.allDay,
          event.meetingLink,
          event.location,
          JSON.stringify(event.attendees || [])
        ]
      );
    }

    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

// Syncs every selected, readable calendar for a connection. A failure on one
// calendar is recorded on that calendar's selection row and does not stop the
// others, and does not clear that calendar's last-known-good cached events.
export async function syncConnection(connection) {
  const accessToken = await ensureFreshAccessToken(connection);
  const selections = await discoverCalendars(connection, accessToken);

  const timeMin = new Date(Date.now() - SYNC_WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000);
  const timeMax = new Date(Date.now() + SYNC_WINDOW_FUTURE_DAYS * 24 * 60 * 60 * 1000);

  let totalSynced = 0;
  let syncedCalendars = 0;
  const errors = [];

  for (const sel of selections) {
    if (!sel.selected) continue;

    if (sel.readable === false) {
      const message = "This calendar only shares free/busy time, so its event details can't be read. Unselect it, or ask the owner to share full event details.";
      await query(`update calendar_selections set last_sync_error=$1 where id=$2`, [message, sel.id]);
      errors.push({ calendarId: sel.external_calendar_id, calendar: sel.calendar_name, message });
      continue;
    }

    try {
      const events = await fetchEventsForCalendar(connection.provider, accessToken, sel.external_calendar_id, timeMin, timeMax);
      await replaceCalendarEvents(connection.id, sel.external_calendar_id, events, timeMin, timeMax);
      totalSynced += events.length;
      syncedCalendars += 1;
      await query(`update calendar_selections set last_synced_at=now(), last_sync_error=null where id=$1`, [sel.id]);
    } catch (err) {
      console.error(`[calendar-sync] ${connection.provider} calendar "${sel.calendar_name}" (${sel.external_calendar_id}) failed:`, err.message);
      await query(`update calendar_selections set last_sync_error=$1 where id=$2`, [err.message, sel.id]);
      errors.push({ calendarId: sel.external_calendar_id, calendar: sel.calendar_name, message: err.message });
    }
  }

  return { synced: totalSynced, calendars: syncedCalendars, errors };
}

/* ------------------------------------------------------------------ *
 * Historical backfill
 *
 * The periodic sync above only ever keeps a rolling window from
 * SYNC_WINDOW_PAST_DAYS back through SYNC_WINDOW_FUTURE_DAYS forward - a date
 * further in the past than that is never synced by it at all, so the
 * dashboard would show "No meetings" for e.g. last month regardless of what
 * actually exists in Google/Microsoft. ensureHistoricalCoverage() backfills
 * such a date on demand, bounded to the single calendar month containing it,
 * and records that month as covered so a later visit is served from cache
 * instead of re-fetching live every time.
 * ------------------------------------------------------------------ */

// In-process de-dupe so two requests landing at the same moment for the same
// (connection, calendar, month) - e.g. two browser tabs, or the dashboard and
// the month-calendar endpoint firing together - share one fetch instead of
// each starting their own.
const backfillLocks = new Map();

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Everywhere else in the app treats the IST calendar day as the source of
// truth (display, date filtering), so the backfill window must too - a
// naive UTC-aligned month window would miss a meeting that falls just after
// midnight IST on the 1st (still the previous UTC day) or just before
// midnight IST on the last day (already the next UTC day).
function monthRangeContaining(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;

  // Plain calendar-day boundaries (IST, timezone-agnostic) for the coverage
  // bookkeeping - this is just "which dates have been backfilled", unrelated
  // to any absolute instant.
  const istStartDate = `${y}-${String(m).padStart(2, "0")}-01`;
  const istEndDate = `${nextY}-${String(nextM).padStart(2, "0")}-01`;

  // The same two boundaries re-expressed as the UTC instant they actually
  // fall at (IST = UTC+5:30), for the provider fetch and the delete-sweep
  // window, which both operate on absolute instants, not calendar dates.
  const fetchStart = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);
  const fetchEnd = new Date(Date.UTC(nextY, nextM - 1, 1) - IST_OFFSET_MS);

  return { istStartDate, istEndDate, fetchStart, fetchEnd };
}

async function isDateCovered(connectionId, calendarId, dateStr) {
  const { rows } = await query(
    `select 1 from calendar_sync_coverage
     where calendar_connection_id=$1 and external_calendar_id=$2 and covered @> $3::date limit 1`,
    [connectionId, calendarId, dateStr]
  );
  return rows.length > 0;
}

async function recordCoverage(connectionId, calendarId, istStartDate, istEndDate) {
  await query(
    `insert into calendar_sync_coverage(calendar_connection_id,external_calendar_id,covered)
     values($1,$2,daterange($3::date,$4::date,'[)'))`,
    [connectionId, calendarId, istStartDate, istEndDate]
  );
}

async function backfillCalendarMonth(connection, accessToken, sel, dateStr) {
  if (await isDateCovered(connection.id, sel.external_calendar_id, dateStr)) return null;

  const { istStartDate, istEndDate, fetchStart, fetchEnd } = monthRangeContaining(dateStr);
  try {
    const events = await fetchEventsForCalendar(connection.provider, accessToken, sel.external_calendar_id, fetchStart, fetchEnd);
    await replaceCalendarEvents(connection.id, sel.external_calendar_id, events, fetchStart, fetchEnd);
    await recordCoverage(connection.id, sel.external_calendar_id, istStartDate, istEndDate);
    await query(`update calendar_selections set last_sync_error=null where id=$1`, [sel.id]);
    return null;
  } catch (err) {
    console.error(`[calendar-backfill] ${connection.provider} calendar "${sel.calendar_name}" (${sel.external_calendar_id}) for ${dateStr.slice(0, 7)} failed:`, err.message);
    await query(`update calendar_selections set last_sync_error=$1 where id=$2`, [err.message, sel.id]);
    return { provider: connection.provider, calendar: sel.calendar_name, message: err.message };
  }
}

// Backfills every active connection's selected, readable calendars for the
// month containing `dateStr`, but only when that date falls outside the
// regular rolling sync window - dates already covered by the periodic sync
// are left alone (no live call, no latency added to the common case). A
// backfill failure (e.g. an expired token) is collected as a warning rather
// than thrown, so it never blocks the rest of the dashboard from loading.
export async function ensureHistoricalCoverage(dateStr) {
  const rollingFloor = new Date(Date.now() - SYNC_WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000);
  const requested = new Date(`${dateStr}T00:00:00.000Z`);
  if (requested >= rollingFloor) return { warnings: [] };

  const { rows: connections } = await query(`select * from calendar_connections where is_active=true`);
  const warnings = [];

  for (const connection of connections) {
    let accessToken;
    try {
      accessToken = await ensureFreshAccessToken(connection);
    } catch (err) {
      warnings.push({ provider: connection.provider, message: `Could not refresh access for historical sync: ${err.message}` });
      continue;
    }

    const { rows: selections } = await query(
      `select * from calendar_selections where calendar_connection_id=$1 and selected=true`,
      [connection.id]
    );

    for (const sel of selections) {
      // freeBusyReader-only shares can't have their event details read at
      // all (matches the same check the regular periodic sync applies).
      if (sel.access_role === "freeBusyReader") continue;

      const key = `${connection.id}:${sel.external_calendar_id}:${dateStr.slice(0, 7)}`;
      let task = backfillLocks.get(key);
      if (!task) {
        task = backfillCalendarMonth(connection, accessToken, sel, dateStr);
        backfillLocks.set(key, task);
        task.finally(() => backfillLocks.delete(key));
      }

      const warning = await task;
      if (warning) warnings.push(warning);
    }
  }

  return { warnings };
}

// Applies a new set of selected calendar ids, drops cached events for any
// calendar the admin just deselected (so stale entries don't linger in Meeting
// Schedule), then re-syncs so newly-selected calendars populate immediately.
export async function updateCalendarSelections(connection, selectedCalendarIds) {
  const idSet = new Set(selectedCalendarIds.map(String));
  const { rows: existing } = await query(`select * from calendar_selections where calendar_connection_id=$1`, [connection.id]);

  for (const row of existing) {
    const shouldSelect = idSet.has(row.external_calendar_id);
    if (shouldSelect === row.selected) continue;

    await query(`update calendar_selections set selected=$1, updated_at=now() where id=$2`, [shouldSelect, row.id]);
    if (!shouldSelect) {
      await query(`delete from calendar_events where calendar_connection_id=$1 and external_calendar_id=$2`, [connection.id, row.external_calendar_id]);
    }
  }

  return syncConnection(connection);
}

export async function syncAllActiveConnections() {
  const { rows: connections } = await query(
    `select * from calendar_connections where is_active=true`
  );

  for (const connection of connections) {
    try {
      const result = await syncConnection(connection);
      console.log(`[calendar-sync] ${connection.provider} connection ${connection.id}: synced ${result.synced} events across ${result.calendars} calendar(s)${result.errors.length ? `, ${result.errors.length} calendar(s) failed` : ""}`);
    } catch (err) {
      console.error(`[calendar-sync] ${connection.provider} connection ${connection.id} failed:`, err.message);
      if (HARD_AUTH_ERRORS.has(err.code) || HARD_AUTH_ERRORS.has(err.providerError)) {
        await query(`update calendar_connections set is_active=false where id=$1`, [connection.id]);
      }
    }
  }
}
