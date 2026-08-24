function backendUrl() {
  return process.env.BACKEND_URL || "http://localhost:4000";
}

function redirectUri(provider) {
  return `${backendUrl()}/api/calendar/callback/${provider.toLowerCase()}`;
}

const GOOGLE = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  eventsUrl: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  scope: "https://www.googleapis.com/auth/calendar.readonly",
  clientId: () => process.env.GOOGLE_CLIENT_ID,
  clientSecret: () => process.env.GOOGLE_CLIENT_SECRET
};

const MICROSOFT = {
  authUrl: () => `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || "common"}/oauth2/v2.0/authorize`,
  tokenUrl: () => `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || "common"}/oauth2/v2.0/token`,
  eventsUrl: "https://graph.microsoft.com/v1.0/me/events",
  scope: "offline_access Calendars.Read",
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

function normalizeGoogleEvent(rawEvent) {
  const isAllDay = Boolean(rawEvent.start?.date && !rawEvent.start?.dateTime);
  return {
    externalEventId: rawEvent.id,
    subject: rawEvent.summary || "(No title)",
    description: rawEvent.description || null,
    startTime: rawEvent.start?.dateTime || rawEvent.start?.date,
    endTime: rawEvent.end?.dateTime || rawEvent.end?.date || null,
    allDay: isAllDay,
    meetingLink: extractMeetingLink("GOOGLE", rawEvent),
    location: rawEvent.location || null,
    attendees: (rawEvent.attendees || []).map(a => ({ email: a.email, name: a.displayName || null, responseStatus: a.responseStatus || null }))
  };
}

function normalizeMicrosoftEvent(rawEvent) {
  return {
    externalEventId: rawEvent.id,
    subject: rawEvent.subject || "(No title)",
    description: rawEvent.bodyPreview || null,
    startTime: rawEvent.start?.dateTime ? `${rawEvent.start.dateTime}Z` : null,
    endTime: rawEvent.end?.dateTime ? `${rawEvent.end.dateTime}Z` : null,
    allDay: Boolean(rawEvent.isAllDay),
    meetingLink: extractMeetingLink("MICROSOFT", rawEvent),
    location: rawEvent.location?.displayName || null,
    attendees: (rawEvent.attendees || []).map(a => ({
      email: a.emailAddress?.address || null,
      name: a.emailAddress?.name || null,
      responseStatus: a.status?.response || null
    }))
  };
}

export async function fetchEvents(provider, accessToken, timeMin, timeMax) {
  const cfg = providerConfig(provider);
  let url;
  const headers = { Authorization: `Bearer ${accessToken}` };

  if (provider === "GOOGLE") {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime"
    });
    url = `${cfg.eventsUrl}?${params.toString()}`;
  } else {
    headers.Prefer = 'outlook.timezone="UTC"';
    const params = new URLSearchParams({
      $filter: `start/dateTime ge '${timeMin.toISOString()}' and end/dateTime le '${timeMax.toISOString()}'`,
      $orderby: "start/dateTime"
    });
    url = `${cfg.eventsUrl}?${params.toString()}`;
  }

  const response = await fetch(url, { headers });
  const data = await response.json();
  if (!response.ok) {
    const err = new Error(data.error?.message || data.error_description || "Failed to fetch calendar events");
    err.status = response.status;
    err.providerError = data.error;
    throw err;
  }

  const rawEvents = data.items || data.value || [];
  return rawEvents.map(provider === "GOOGLE" ? normalizeGoogleEvent : normalizeMicrosoftEvent)
    .filter(e => e.startTime);
}
