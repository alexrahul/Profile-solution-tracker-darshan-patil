# Profile Solutions Dashboard v2.5.0

## v2.5 changes

- Admins can connect a Google Calendar and/or Microsoft Outlook/365 Calendar from Settings.
- Connected calendars sync every 5 minutes and merge into the public Meeting Schedule
  widget and its "View All" detail view, including a clickable Google Meet / Teams link.
- New tables: `calendar_connections`, `calendar_events` (see `database/migrate_v2_5_calendar_integration.sql`).
- OAuth tokens are encrypted at rest (AES-256-GCM, `backend/cryptoUtil.js`) using `TOKEN_ENCRYPTION_KEY`.

### New environment variables

```env
BACKEND_URL=http://localhost:4000
TOKEN_ENCRYPTION_KEY=32-byte-base64-key
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=common
```

Generate `TOKEN_ENCRYPTION_KEY` with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### OAuth app setup (one-time, outside this codebase)

**Google Cloud Console:** create an OAuth client (Web application), enable the Calendar API,
set redirect URI to `${BACKEND_URL}/api/calendar/callback/google`, scope `calendar.readonly`.

**Azure AD (Entra ID):** register an app, add Microsoft Graph delegated permission
`Calendars.Read` (+ `offline_access`), set redirect URI to
`${BACKEND_URL}/api/calendar/callback/microsoft`.

### New calendar APIs

```text
GET    /api/calendar/connect/:provider   (google | microsoft, browser redirect)
GET    /api/calendar/callback/:provider  (OAuth provider redirect target)
GET    /api/calendar/connections         (Admin)
DELETE /api/calendar/connections/:id     (Admin)
```

## Stack

- Frontend: HTML + CSS + Vanilla JavaScript
- Backend: Node.js + Express
- Database: Supabase PostgreSQL
- Image storage: Supabase Storage
- Authentication: JWT access + refresh sessions
- Frontend deployment: Netlify
- Backend deployment: Render / Railway

## v2.4 changes

- Complete dark theme:
  - Primary background `#0B0F19`
  - Cards `#111827`
  - Sidebar `#050B18`
  - Borders `#1F2937`
  - Primary text white
  - Secondary text `#D1D5DB`
- Header Hide / Show Dashboard Data toggle.
- Admin hide/show preference stored in `dashboard_preferences`.
- Public/non-authenticated browser preference is stored locally in the browser.
- New sidebar modules:
  - Accounts
  - Projects
  - CCTV
- Placeholder frontend pages and public placeholder APIs added.
- Dashboard rearranged into a compact single-screen desktop grid.
- Calendar reduced in size.
- Meeting, Lunch, Tasks, Notes and Reminders are in the top dashboard row.
- Daily Lunch Meet shows one department/time slot in the dashboard.
- KPI cards and KPI API/data module removed.
- Electricity dashboard, API, data module and database tables removed.
- Manpower Image Viewer expanded across the full dashboard width.
- Inline image controls: Previous, Next, Zoom, Full Screen and Download.
- Dashboard API reduced to only the queries used by the active dashboard.

## Upgrade from v2.4

Run:

```text
database/migrate_v2_5_calendar_integration.sql
```

in Supabase SQL Editor. It creates `calendar_connections` and `calendar_events`
(both empty/inert until an Admin connects a calendar from Settings). Then add the
new environment variables listed above under "v2.5 changes" to `backend/.env`.

## Upgrade from v2.3

Back up your Supabase database first if you need historical KPI/electricity data.

Run:

```text
database/migrate_v2_4_dark_layout.sql
```

in Supabase SQL Editor.

**Important:** the v2.4 migration intentionally drops:

```text
kpi_data
electricity_data
electricity_readings
```

because those modules were explicitly removed.

It creates:

```text
dashboard_preferences
```

and preserves/ensures:

```text
manpower_images
```

## Environment

Keep your existing working `backend/.env`:

```env
PORT=4000
DATABASE_URL=YOUR_WORKING_SUPABASE_DATABASE_URL
JWT_SECRET=YOUR_EXISTING_JWT_SECRET
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=YOUR_SERVER_SECRET_KEY
SUPABASE_STORAGE_BUCKET=manpower-images
BACKEND_URL=http://localhost:4000
TOKEN_ENCRYPTION_KEY=YOUR_32_BYTE_BASE64_KEY
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=common
```

Never put `SUPABASE_SECRET_KEY` in frontend files.

## Local start

Backend:

```powershell
cd backend
npm install
npm start
```

Test:

```text
http://localhost:4000/api/health
```

Frontend:

```powershell
cd frontend
npx serve -l 3000 .
```

Open:

```text
http://localhost:3000
```

Press `Ctrl + F5` once after upgrading so the browser does not use the old JavaScript/CSS.

## New APIs

Public:

```text
GET /api/public/dashboard?date=YYYY-MM-DD
GET /api/public/calendar?month=YYYY-MM
GET /api/public/details/:module?date=YYYY-MM-DD
GET /api/public/accounts
GET /api/public/projects
GET /api/public/cctv
GET /api/public/reports?type=daily&date=YYYY-MM-DD
```

Admin:

```text
GET /api/admin/preferences/dashboard
PUT /api/admin/preferences/dashboard
```

PUT body:

```json
{
  "hideDashboard": true
}
```

The existing Calendar, Meetings, Department Schedule, Attendance, Manpower Images, Tasks, Notes and Reminder CRUD APIs remain available. See "New calendar APIs" above for the v2.5 calendar-connection endpoints.

## Dashboard visibility persistence

When an authenticated Admin changes Hide/Show Dashboard Data, the preference is stored in Supabase using the Admin user's UUID. For public visitors without an authenticated user ID, the preference remains browser-local so the public dashboard does not expose a write API.

## Performance

- Removed Chart.js because the electricity module no longer exists.
- Removed KPI/electricity queries from dashboard requests.
- Dashboard polling is 30 seconds and pauses while data is hidden.
- Dashboard queries run in parallel.
- Dashboard list cards render compact previews; View All uses detail APIs.
- Image viewer uses the exact date-filtered image records only.
