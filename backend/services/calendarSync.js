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
