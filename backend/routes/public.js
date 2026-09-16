import { Router } from "express";
import { query } from "../db.js";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Meeting Schedule always displays in India time, independent of the browser's
// or the server/database session's local timezone. calendar_events.start_time
// is a TIMESTAMPTZ holding the correct absolute instant (Google/Microsoft send
// an explicit UTC offset; Postgres normalizes it on insert) - only the display
// layer converts it, never the stored value.
const DISPLAY_TIME_ZONE = "Asia/Kolkata";
const istDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: DISPLAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const istTimeFormatter = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TIME_ZONE, hour: "numeric", minute: "2-digit" });

function toIstDateString(date) {
  return istDateFormatter.format(date); // en-CA formats as YYYY-MM-DD
}
function toIstTimeString(date) {
  return istTimeFormatter.format(date);
}

function getDateParam(req) {
  const selectedDate = String(req.query.date || "").trim();
  if (!DATE_RE.test(selectedDate)) {
    const err = new Error("A valid date query parameter in YYYY-MM-DD format is required");
    err.status = 400;
    throw err;
  }
  return selectedDate;
}

const calendarEventsSql = `
  select ce.id, ce.subject, ce.start_time, ce.end_time, ce.all_day, ce.meeting_link, ce.location, ce.attendees,
         cc.provider, cs.calendar_name, cs.is_primary as calendar_is_primary
  from calendar_events ce
  join calendar_connections cc on cc.id = ce.calendar_connection_id
  left join calendar_selections cs
    on cs.calendar_connection_id = ce.calendar_connection_id
   and cs.external_calendar_id = ce.external_calendar_id
  where cc.is_active = true
    -- All-day events are stored as a bare UTC-midnight-anchored calendar date
    -- (no real timezone attached) and must keep that date as-is. Timed events
    -- are matched by their India calendar date, same as they're displayed -
    -- so a meeting just after midnight IST still falls under the right day
    -- even if the DB/session default timezone is UTC.
    and (case when ce.all_day then ce.start_time::date
              else (ce.start_time at time zone 'Asia/Kolkata')::date end) = $1::date
  order by ce.start_time`;

function toMeetingRow(event) {
  const isAllDay = Boolean(event.all_day);
  return {
    id: event.id,
    date: isAllDay ? event.start_time.toISOString().slice(0, 10) : toIstDateString(event.start_time),
    time: isAllDay ? null : toIstTimeString(event.start_time),
    allDay: isAllDay,
    name: event.subject,
    team: event.location || null,
    room: null,
    provider: event.provider,
    // Only shown for a non-primary source calendar (e.g. a shared "Other
    // calendar") so the primary calendar's rows look exactly as before.
    calendarName: event.calendar_is_primary === false ? event.calendar_name : null,
    meetingLink: event.meeting_link,
    sortKey: event.start_time.toISOString()
  };
}

const detailQueries = {
  meetings: {
    sql: `select id,meeting_date as date,meeting_time as time,meeting_name as name,team,meeting_room as room
          from meeting_schedule where meeting_date=$1 order by sort_order,created_at,id`
  },
  tasks: {
    sql: `select id,task_date as date,task_time as time,task_name as name,status
          from tasks_data where task_date=$1 order by sort_order,created_at,id`
  },
  notes: {
    sql: `select id,note_date as date,note_title as title,note_description as description
          from notes_data where note_date=$1 and active=true order by sort_order,created_at,id`
  },
  reminders: {
    sql: `select id,reminder_date as date,reminder_time as time,reminder_description as description
          from reminders_data where reminder_date=$1 order by sort_order,created_at,id`
  },
  departments: {
    sql: `select id,schedule_date as date,department_name as department,start_time as start,end_time as "end",location
          from department_schedule where schedule_date=$1 order by sort_order,created_at,id`
  }
};

router.get("/dashboard", async (req, res, next) => {
  try {
    const selectedDate = getDateParam(req);

    const [calendar, meetings, departments, manpowerImages, tasks, notes, reminders, calendarEvents] = await Promise.all([
      query(
        `select id,event_date as date,event_title as title,description
         from calendar_data where event_date=$1 order by created_at,id`,
        [selectedDate]
      ),
      query(detailQueries.meetings.sql, [selectedDate]),
      query(
        `select id,schedule_date as date,department_name as department,start_time as start,end_time as "end",location
         from department_schedule where schedule_date=$1 order by sort_order,created_at,id limit 1`,
        [selectedDate]
      ),
      query(
        `select id,"date",image_url,title,description,created_at
         from manpower_images where "date"=$1 order by created_at,id`,
        [selectedDate]
      ),
      query(detailQueries.tasks.sql, [selectedDate]),
      query(detailQueries.notes.sql, [selectedDate]),
      query(detailQueries.reminders.sql, [selectedDate]),
      query(calendarEventsSql, [selectedDate])
    ]);

    res.json({
      selectedDate,
      calendar: calendar.rows,
      meetings: meetings.rows,
      departments: departments.rows,
      manpowerImages: manpowerImages.rows,
      tasks: tasks.rows,
      notes: notes.rows,
      reminders: reminders.rows,
      calendarEvents: calendarEvents.rows.map(toMeetingRow)
    });
  } catch (err) {
    next(err);
  }
});

router.get("/manpower-images/:id/download", async (req, res, next) => {
  try {
    const result = await query(`select image_url,title from manpower_images where id=$1 limit 1`, [req.params.id]);
    const image = result.rows[0];
    if (!image) return res.status(404).json({ message: "Image not found" });

    const response = await fetch(image.image_url);
    if (!response.ok) {
      const err = new Error("Unable to download image from storage");
      err.status = 502;
      throw err;
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const safeName = String(image.title || "manpower-image").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "manpower-image";
    const bytes = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.${extension}"`);
    res.setHeader("Content-Length", String(bytes.length));
    res.send(bytes);
  } catch (err) {
    next(err);
  }
});

router.get("/details/:module", async (req, res, next) => {
  try {
    const selectedDate = getDateParam(req);
    const config = detailQueries[req.params.module];
    if (!config) return res.status(404).json({ message: "Unknown detail module" });
    const result = await query(config.sql, [selectedDate]);

    let rows = result.rows;
    if (req.params.module === "meetings") {
      // Manually-entered meetings keep their existing sort_order (their "time" is
      // free text, not reliably sortable); synced calendar events are appended
      // afterward, ordered by their real start_time.
      const calendarEvents = await query(calendarEventsSql, [selectedDate]);
      rows = rows.concat(calendarEvents.rows.map(toMeetingRow));
    }

    res.json({ module: req.params.module, selectedDate, rows });
  } catch (err) {
    next(err);
  }
});

router.get("/calendar", async (req, res, next) => {
  try {
    const month = String(req.query.month || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ message: "month must be YYYY-MM" });

    const start = `${month}-01`;
    const result = await query(
      `select id,event_date as date,event_title as title,description
       from calendar_data
       where event_date >= $1::date
         and event_date < ($1::date + interval '1 month')
       order by event_date,created_at,id`,
      [start]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get("/reports", async (req, res, next) => {
  try {
    const type = String(req.query.type || "daily");
    const selectedDate = DATE_RE.test(String(req.query.date || ""))
      ? String(req.query.date)
      : new Date().toISOString().slice(0, 10);

    const [i, a, t, n, r, m, d, c] = await Promise.all([
      query('select count(*)::int count from manpower_images where "date"=$1', [selectedDate]),
      query("select count(*)::int count from attendance_data where reading_date=$1", [selectedDate]),
      query("select count(*)::int count from tasks_data where task_date=$1", [selectedDate]),
      query("select count(*)::int count from notes_data where note_date=$1", [selectedDate]),
      query("select count(*)::int count from reminders_data where reminder_date=$1", [selectedDate]),
      query("select count(*)::int count from meeting_schedule where meeting_date=$1", [selectedDate]),
      query("select count(*)::int count from department_schedule where schedule_date=$1", [selectedDate]),
      query("select count(*)::int count from calendar_data where event_date=$1", [selectedDate])
    ]);

    res.json({
      type,
      selectedDate,
      generatedAt: new Date().toISOString(),
      calendarEvents: c.rows[0].count,
      meetings: m.rows[0].count,
      departmentSchedules: d.rows[0].count,
      manpowerImages: i.rows[0].count,
      attendanceRecords: a.rows[0].count,
      taskRecords: t.rows[0].count,
      noteRecords: n.rows[0].count,
      reminderRecords: r.rows[0].count
    });
  } catch (err) {
    next(err);
  }
});

// Accounts (Receivables & Payables) source data: every invoice-level row.
// Aging, KPIs, DSO and the trend chart are all computed client-side from
// these raw lists, same as the FY/date-range and As-of-date filters.
function toDateStr(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

router.get("/receivables", async (req, res, next) => {
  try {
    const result = await query(
      `select id,customer_name,invoice_date,due_date,invoice_amount,balance
       from receivables_data order by invoice_date asc,created_at asc`
    );
    res.json({
      rows: result.rows.map(r => ({
        id: r.id,
        customer: r.customer_name,
        date: toDateStr(r.invoice_date),
        due: toDateStr(r.due_date),
        amount: Number(r.invoice_amount),
        balance: r.balance === null ? null : Number(r.balance)
      }))
    });
  } catch (err) {
    next(err);
  }
});

router.get("/payables", async (req, res, next) => {
  try {
    const result = await query(
      `select id,vendor_name,invoice_date,due_date,invoice_amount,balance
       from payables_data order by invoice_date asc,created_at asc`
    );
    res.json({
      rows: result.rows.map(r => ({
        id: r.id,
        customer: r.vendor_name,
        date: toDateStr(r.invoice_date),
        due: toDateStr(r.due_date),
        amount: Number(r.invoice_amount),
        balance: r.balance === null ? null : Number(r.balance)
      }))
    });
  } catch (err) {
    next(err);
  }
});

for (const [route, label] of [["projects","Projects"],["cctv","CCTV"]]) {
  router.get(`/${route}`, (req, res) => {
    res.json({ module: route, status: "under-development", message: `${label} Module Under Development` });
  });
}

export default router;
