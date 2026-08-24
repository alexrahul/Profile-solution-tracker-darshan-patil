import { query, pool } from "../db.js";
import { encryptToken, decryptToken } from "../cryptoUtil.js";
import { refreshAccessToken, fetchEvents } from "./calendarProviders.js";

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

export async function syncConnection(connection) {
  const accessToken = await ensureFreshAccessToken(connection);

  const timeMin = new Date(Date.now() - SYNC_WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000);
  const timeMax = new Date(Date.now() + SYNC_WINDOW_FUTURE_DAYS * 24 * 60 * 60 * 1000);

  const events = await fetchEvents(connection.provider, accessToken, timeMin, timeMax);

  const client = await pool.connect();
  try {
    await client.query("begin");

    const seenIds = events.map(e => e.externalEventId);
    await client.query(
      `delete from calendar_events
       where calendar_connection_id=$1
         and start_time >= $2 and start_time <= $3
         and not (external_event_id = any($4::text[]))`,
      [connection.id, timeMin, timeMax, seenIds]
    );

    for (const event of events) {
      await client.query(
        `insert into calendar_events(
           calendar_connection_id,external_event_id,subject,description,
           start_time,end_time,all_day,meeting_link,location,attendees,last_synced_at
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         on conflict(calendar_connection_id,external_event_id) do update
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
          connection.id,
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

  return events.length;
}

export async function syncAllActiveConnections() {
  const { rows: connections } = await query(
    `select * from calendar_connections where is_active=true`
  );

  for (const connection of connections) {
    try {
      const count = await syncConnection(connection);
      console.log(`[calendar-sync] ${connection.provider} connection ${connection.id}: synced ${count} events`);
    } catch (err) {
      console.error(`[calendar-sync] ${connection.provider} connection ${connection.id} failed:`, err.message);
      if (HARD_AUTH_ERRORS.has(err.code) || HARD_AUTH_ERRORS.has(err.providerError)) {
        await query(`update calendar_connections set is_active=false where id=$1`, [connection.id]);
      }
    }
  }
}
