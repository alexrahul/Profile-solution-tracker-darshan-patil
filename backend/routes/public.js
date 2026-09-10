import { Router } from "express";
import { query } from "../db.js";

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  select ce.id, ce.subject, ce.start_time, ce.end_time, ce.meeting_link, ce.location, ce.attendees, cc.provider
  from calendar_events ce
  join calendar_connections cc on cc.id = ce.calendar_connection_id
  where cc.is_active = true and ce.start_time::date = $1::date
  order by ce.start_time`;

function toMeetingRow(event) {
  return {
    id: event.id,
    date: event.start_time.toISOString().slice(0, 10),
    time: event.start_time.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }),
    name: event.subject,
    team: event.location || null,
    room: null,
    provider: event.provider,
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

// Accounts KPI dashboard source data: every monthly financial row, ascending by
// month. Aggregation and date-range filtering happen client-side on this list.
router.get("/accounts", async (req, res, next) => {
  try {
    const result = await query(
      `select id,t_month,sales_order_amount,purchase_order_amount,invoice_amount
       from accounts_data order by t_month asc`
    );
    res.json({
      module: "accounts",
      unitLabel: "₹ in Lakhs",
      rows: result.rows.map(r => ({
        id: r.id,
        month: r.t_month,
        salesOrder: Number(r.sales_order_amount),
        purchaseOrder: Number(r.purchase_order_amount),
        invoice: Number(r.invoice_amount)
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
