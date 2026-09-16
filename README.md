# Profile Solutions Dashboard v2.5.0

## v2.9.1 changes

- App-wide dark scrollbars: every scrollable region (main page, tables,
  panels, the bulk-upload preview/error lists, dropdowns, modals, the image
  viewer) now uses a slim dark-slate thumb and a track matching its own
  surface (page background, or card colour for anything sitting on a card) -
  no more default/white scrollbar tracks, corners or arrow buttons.
  `::-webkit-scrollbar*` for Chrome/Edge/Safari, `scrollbar-width`/
  `scrollbar-color` for Firefox.
- Removed the decorative header widget (notification bell + "3" badge,
  avatar circle, "Reema Shah" name dropdown) - it had no behavior. The page
  title/subtitle and sidebar Logout are unaffected.

## v2.9 changes

- **Accounts is now a Receivables & Payables dashboard**, replacing the v2.7
  monthly Sales-Order/Purchase-Order/Invoice KPI view:
  - Filters: FY (Indian 1 Apr–31 Mar), custom From/To (on Invoice Date), and
    an As-of date for aging.
  - Two KPI rows: top-line totals (Receivables/Payables outstanding, Net
    Position, Total Invoiced, Customers with Balance, Overdue > 60 Days) and
    a "CEO View" row (Collection Efficiency, Total Collected, DSO, Overdue %,
    Top Customer Concentration, Invoices/Avg Size).
  - Side-by-side Receivables/Payables aging tables (0/30/45/60/120-day
    buckets on outstanding Balance, plus Total Amount and Balance), sorted by
    Total Amount ascending, with the Total Amount cell banded red/yellow/green
    across each table's own min-max range.
  - A Receivables vs Payables monthly trend line chart (Chart.js).
- **Data section**: new "Receivables Data" / "Payables Data" tabs with a
  bulk-editable grid (inline edit/add/remove, each persisted immediately) and
  a dedicated bulk-upload panel - download an `.xlsx`/`.xls`/`.csv` template,
  upload the same formats back (parsed and validated in the browser via
  SheetJS: DD-MM-YYYY or Excel date cells, ₹/comma amounts, blank Balance
  stays blank), with row-numbered errors and a preview, Append or Replace
  (with confirmation).
- New tables `receivables_data`, `payables_data`. The v2.7 `accounts_data`
  table is no longer used by the app (left in place, not dropped).
- New APIs: `GET /api/public/receivables`, `GET /api/public/payables`,
  `POST /api/admin/:module/bulk-import` (module = `receivables`|`payables`).
  Existing generic `/api/admin/:module` CRUD covers single-row add/edit/delete.
- Re-adds Chart.js (removed in v2.4) for the trend chart, plus SheetJS for
  in-browser spreadsheet parsing - both loaded from cdnjs.

## Upgrade to v2.9

Run `database/migrate_v2_9_receivables_payables.sql` in the Supabase SQL
Editor. Optionally run `database/seed_receivables_sample.sql` **once** (not
re-runnable - duplicate rows are intentionally allowed, matching real invoice
data) to load 260 sample receivable invoices across 31 customers.

## v2.8.1 changes

- **Fixed:** synced Google/Microsoft meeting times in Meeting Schedule (and
  View All) were off by exactly -5:30 - `toMeetingRow` formatted the stored
  instant with `timeZone: "UTC"` instead of India time. The stored timestamps
  were already correct (Google/Microsoft send an explicit offset; Postgres
  normalizes it on insert) - no data was wrong, only the display. No resync
  was needed or performed.
- Meeting start/end times and day-grouping for synced calendar events are now
  always formatted/matched in `Asia/Kolkata`, independent of the browser's or
  server's local timezone - fixes meetings landing on the wrong day near
  midnight IST too.
- All-day events keep their plain calendar date (no timezone conversion
  applied) and now render as "All day" instead of a shifted clock time.

## v2.8 changes

- **Fixed:** connected Google/Microsoft calendars only ever synced the account's
  **primary** calendar (`GOOGLE.eventsUrl` was hardcoded to
  `calendars/primary/events`), so shared/subscribed calendars listed under
  Google's "Other calendars" never appeared in Meeting Schedule.
- Calendar sync now discovers every calendar the connected account can see
  (paginated `calendarList`) and lets the Admin choose which ones feed Meeting
  Schedule from **Settings → Manage Calendars** (per provider). Selections are
  saved per connection; unselecting a calendar removes its cached events.
- Each synced calendar is fetched independently, with full result-set
  pagination on both the calendar list and the events list (`maxResults`/
  `pageToken` for Google, `@odata.nextLink` for Microsoft) so events are never
  silently dropped.
- A failure syncing one calendar (revoked share, free/busy-only access, etc.)
  is recorded on that calendar only - other calendars keep syncing and their
  already-cached events stay visible. The error is shown next to that calendar
  in Manage Calendars and in the Sync Now result.
- Recurring events continue to expand into per-instance rows
  (`singleEvents=true`); cancelled/deleted instances are dropped on the next
  sync. All-day events are now anchored to UTC midnight instead of a bare
  date, so they can't land on the wrong day depending on server timezone.
- A merged meeting row now shows its source calendar name when it came from a
  non-primary calendar (e.g. "Calendar"), so primary-calendar rows look
  exactly as before.
- New table `calendar_selections`; `calendar_events` gained
  `external_calendar_id` and a widened unique key. See
  `database/migrate_v2_8_calendar_multi_calendar.sql`.
- New APIs: `GET /api/calendar/connections/:id/calendars`,
  `PUT /api/calendar/connections/:id/calendars`. No new Google/Microsoft OAuth
  scopes needed - `calendar.readonly` already covers every calendar on the
  account, including ones already added under "Other calendars".

## Upgrade to v2.8

Run `database/migrate_v2_8_calendar_multi_calendar.sql` in the Supabase SQL
Editor (safe to re-run). Existing connections keep syncing their primary
calendar with no action needed; open **Settings → Manage Calendars** to opt
additional calendars (like "Other calendars" entries) into Meeting Schedule.

## v2.7 changes

- The **Accounts** page is now a live KPI dashboard instead of the
  "Accounts Module Under Development" placeholder:
  - Three total cards - Total Sales Orders, Total Purchase Orders, Total Invoices -
    each with the latest month's value and % change vs. the previous month
    (previous-month `0` is handled, no divide-by-zero).
  - A monthly trend chart (all three series) with a clickable legend to toggle
    series and a From / To month range filter that defaults to the last 12 months
    ("All time" toggle switches to the full history). KPI cards and chart both
    respect the selected range.
  - Friendly empty state (with an "Add data" shortcut) and a loading skeleton.
- New **Accounts** data type in the Data section: one row per month
  (`t_month` = `YYYY-MM`, unique), `sales_order_amount`, `purchase_order_amount`,
  `invoice_amount` (numeric, `>= 0`). Manual add/edit/delete plus CSV bulk upload
  and template download, reusing the existing Data-section pattern. CSV headers
  accept `t_month` or `month`. Records are listed by month ascending.
- New table `accounts_data` (see `database/migrate_v2_7_accounts.sql`). Optional
  sample data: `database/seed_accounts_sample.sql` (34 months, Dec 2023 - Sep 2026).
- Amounts are entered/stored in Lakhs (full precision); the dashboard displays
  them in Crores (1 Cr = 100 L). Change `ACCOUNTS_DISPLAY_DIVISOR` /
  `ACCOUNTS_UNIT_LABEL` in `frontend/app.js` to use a different unit.
- New API: `GET /api/public/accounts` returns every monthly row (ascending) plus a
  `unitLabel`. Accounts CRUD uses the existing `/api/admin/:module` routes with
  module `accounts`.

## Upgrade to v2.7

Run `database/migrate_v2_7_accounts.sql` in the Supabase SQL Editor (safe to
re-run). Optionally run `database/seed_accounts_sample.sql` to load sample data.

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
#   P r o f i l e - s o l u t i o n - t r a c k e r - d a r s h a n - p a t i l 
 
 #   P r o f i l e - s o l u t i o n - t r a c k e r - d a r s h a n - p a t i l 
 
 #   P r o f i l e - s o l u t i o n - t r a c k e r - d a r s h a n - p a t i l 
 
 #   P r o f i l e - s o l u t i o n - t r a c k e r - d a r s h a n - p a t i l 
 
 #   P r o f i l e - s o l u t i o n - t r a c k e r - d a r s h a n - p a t i l 
 
 