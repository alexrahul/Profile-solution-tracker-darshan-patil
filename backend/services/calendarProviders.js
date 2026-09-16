function backendUrl() {
  return process.env.BACKEND_URL || "http://localhost:4000";
}

function redirectUri(provider) {
  return `${backendUrl()}/api/calendar/callback/${provider.toLowerCase()}`;
}

const GOOGLE = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  calendarListUrl: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
  eventsUrl: calendarId => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  // calendar.readonly covers every calendar the account can see, including
  // secondary/shared/subscribed calendars already added under "Other calendars" -
  // no extra scope or re-consent is needed to read them.
  scope: "https://www.googleapis.com/auth/calendar.readonly email",
  clientId: () => process.env.GOOGLE_CLIENT_ID,
  clientSecret: () => process.env.GOOGLE_CLIENT_SECRET
};

const MICROSOFT = {
  authUrl: () => `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || "common"}/oauth2/v2.0/authorize`,
  tokenUrl: () => `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || "common"}/oauth2/v2.0/token`,
  eventsUrl: "https://graph.microsoft.com/v1.0/me/events",
  userInfoUrl: "https://graph.microsoft.com/v1.0/me",
  scope: "offline_access Calendars.Read User.Read",
  clientId: () => process.env.MS_CLIENT_ID,
  clientSecret: () => process.env.MS_CLIENT_SECRET
};

function providerConfig(provider) {
  if (provider === "GOOGLE") return GOOGLE;
  if (provider === "MICROSOFT") return MICROSOFT;
  const err = new Error("Unsupported calendar provider");
  err.status = 400;
  throw err;
}

export function buildAuthUrl(provider, state) {
  const cfg = providerConfig(provider);
  const authUrl = typeof cfg.authUrl === "function" ? cfg.authUrl() : cfg.authUrl;
  const params = new URLSearchParams({
    client_id: cfg.clientId(),
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: cfg.scope,
    state
  });
  if (provider === "GOOGLE") {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  return `${authUrl}?${params.toString()}`;
}

async function tokenRequest(provider, body) {
  const cfg = providerConfig(provider);
  const tokenUrl = typeof cfg.tokenUrl === "function" ? cfg.tokenUrl() : cfg.tokenUrl;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId(),
      client_secret: cfg.clientSecret(),
      ...body
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error_description || data.error || "Calendar token request failed");
    err.status = 502;
    err.providerError = data.error;
    throw err;
  }
  return data;
}

export async function exchangeCode(provider, code) {
  const data = await tokenRequest(provider, {
    code,
    redirect_uri: redirectUri(provider),
    grant_type: "authorization_code"
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: data.expires_in
  };
}

export async function fetchAccountEmail(provider, accessToken) {
  const cfg = providerConfig(provider);
  const response = await fetch(cfg.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return null;
  const data = await response.json();
  if (provider === "GOOGLE") return data.email || null;
  if (provider === "MICROSOFT") return data.mail || data.userPrincipalName || null;
  return null;
}

export async function refreshAccessToken(provider, refreshToken) {
  const data = await tokenRequest(provider, {
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in
  };
}

export function extractMeetingLink(provider, rawEvent) {
  if (provider === "GOOGLE") {
    const entryPoints = rawEvent.conferenceData?.entryPoints || [];
    const video = entryPoints.find(e => e.entryPointType === "video");
    return video?.uri || rawEvent.hangoutLink || null;
  }
  if (provider === "MICROSOFT") {
    return rawEvent.onlineMeeting?.joinUrl || null;
  }
  return null;
}

// Google all-day events carry a bare "YYYY-MM-DD" (no time/offset). Anchoring
// that to UTC midnight keeps the event on the same calendar day regardless of
// the database server's local timezone setting.
function normalizeGoogleEvent(rawEvent, calendarId) {
  const isAllDay = Boolean(rawEvent.start?.date && !rawEvent.start?.dateTime);
  const startTime = isAllDay ? `${rawEvent.start.date}T00:00:00.000Z` : rawEvent.start?.dateTime;
  const endTime = isAllDay
    ? (rawEvent.end?.date ? `${rawEvent.end.date}T00:00:00.000Z` : null)
    : (rawEvent.end?.dateTime || null);

  return {
    externalCalendarId: calendarId,
    externalEventId: rawEvent.id,
    subject: rawEvent.summary || "(No title)",
    description: rawEvent.description || null,
    startTime,
    endTime,
    allDay: isAllDay,
    status: rawEvent.status || "confirmed",
    meetingLink: extractMeetingLink("GOOGLE", rawEvent),
    location: rawEvent.location || null,
    attendees: (rawEvent.attendees || []).map(a => ({ email: a.email, name: a.displayName || null, responseStatus: a.responseStatus || null }))
  };
}

function normalizeMicrosoftEvent(rawEvent, calendarId) {
  return {
    externalCalendarId: calendarId,
    externalEventId: rawEvent.id,
    subject: rawEvent.subject || "(No title)",
    description: rawEvent.bodyPreview || null,
    startTime: rawEvent.start?.dateTime ? `${rawEvent.start.dateTime}Z` : null,
    endTime: rawEvent.end?.dateTime ? `${rawEvent.end.dateTime}Z` : null,
    allDay: Boolean(rawEvent.isAllDay),
    status: rawEvent.isCancelled ? "cancelled" : "confirmed",
    meetingLink: extractMeetingLink("MICROSOFT", rawEvent),
    location: rawEvent.location?.displayName || null,
    attendees: (rawEvent.attendees || []).map(a => ({
      email: a.emailAddress?.address || null,
      name: a.emailAddress?.name || null,
      responseStatus: a.status?.response || null
    }))
  };
}

// Lists every calendar the connected account can see (My Calendars + "Other
// calendars": shared and subscribed calendars the user has already added in
// Google Calendar). Paginated - Google returns calendarList in pages.
async function listGoogleCalendars(accessToken) {
  const calendars = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ maxResults: "250", minAccessRole: "freeBusyReader" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${GOOGLE.calendarListUrl}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    if (!response.ok) {
      const err = new Error(data.error?.message || "Failed to list Google calendars");
      err.status = response.status;
      err.providerError = data.error?.status;
      throw err;
    }
    for (const item of data.items || []) {
      if (item.deleted) continue;
      calendars.push({
        externalCalendarId: item.id,
        name: item.summaryOverride || item.summary || item.id,
        accessRole: item.accessRole || null,
        isPrimary: Boolean(item.primary),
        // freeBusyReader can only see busy/free blocks, not event details -
        // events.list on it fails with 403, so it's listed but not selectable.
        readable: item.accessRole !== "freeBusyReader"
      });
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return calendars;
}

// Microsoft support here is limited to the account's default calendar, matching
// prior behavior. Exposed the same shape as Google so the sync/selection code
// path is provider-agnostic.
async function listMicrosoftCalendars() {
  return [{ externalCalendarId: "primary", name: "Default Calendar", accessRole: "owner", isPrimary: true, readable: true }];
}

export async function listCalendars(provider, accessToken) {
  if (provider === "GOOGLE") return listGoogleCalendars(accessToken);
  if (provider === "MICROSOFT") return listMicrosoftCalendars();
  return [];
}

async function fetchGoogleEventsForCalendar(accessToken, calendarId, timeMin, timeMax) {
  const rawEvents = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true", // expands recurring events into individual instances
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "2500"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const url = `${GOOGLE.eventsUrl(calendarId)}?${params.toString()}`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json();
    if (!response.ok) {
      const err = new Error(data.error?.message || "Failed to fetch calendar events");
      err.status = response.status;
      err.providerError = data.error?.status;
      throw err;
    }
    rawEvents.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return rawEvents
    .filter(e => e.status !== "cancelled")
    .map(e => normalizeGoogleEvent(e, calendarId))
    .filter(e => e.startTime);
}

async function fetchMicrosoftEventsForCalendar(accessToken, calendarId, timeMin, timeMax) {
  const rawEvents = [];
  let url = (() => {
    const params = new URLSearchParams({
      $filter: `start/dateTime ge '${timeMin.toISOString()}' and end/dateTime le '${timeMax.toISOString()}'`,
      $orderby: "start/dateTime",
      $top: "250"
    });
    return `${MICROSOFT.eventsUrl}?${params.toString()}`;
  })();
  const headers = { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' };

  while (url) {
    const response = await fetch(url, { headers });
    const data = await response.json();
    if (!response.ok) {
      const err = new Error(data.error?.message || "Failed to fetch calendar events");
      err.status = response.status;
      err.providerError = data.error?.code;
      throw err;
    }
    rawEvents.push(...(data.value || []));
    url = data["@odata.nextLink"] || null;
  }

  return rawEvents
    .filter(e => !e.isCancelled)
    .map(e => normalizeMicrosoftEvent(e, calendarId))
    .filter(e => e.startTime);
}

export async function fetchEventsForCalendar(provider, accessToken, calendarId, timeMin, timeMax) {
  if (provider === "GOOGLE") return fetchGoogleEventsForCalendar(accessToken, calendarId, timeMin, timeMax);
  if (provider === "MICROSOFT") return fetchMicrosoftEventsForCalendar(accessToken, calendarId, timeMin, timeMax);
  return [];
}
