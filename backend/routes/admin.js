import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { query, pool } from "../db.js";
import { deleteManpowerImage, uploadManpowerImage, validateImageFile } from "../storage.js";

const router = Router();
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const cfg = {
  calendar: {
    table: "calendar_data",
    fields: {
      event_date: { required: true, type: "date" },
      event_title: { required: true, type: "text" },
      description: { required: false, type: "text" }
    }
  },
  receivables: {
    table: "receivables_data",
    orderBy: "invoice_date asc,created_at asc",
    fields: {
      customer_name: { required: true, type: "text" },
      invoice_date: { required: true, type: "date" },
      due_date: { required: true, type: "date" },
      invoice_amount: { required: true, type: "number" },
      balance: { required: false, type: "number" }
    }
  },
  payables: {
    table: "payables_data",
    orderBy: "invoice_date asc,created_at asc",
    fields: {
      vendor_name: { required: true, type: "text" },
      invoice_date: { required: true, type: "date" },
      due_date: { required: true, type: "date" },
      invoice_amount: { required: true, type: "number" },
      balance: { required: false, type: "number" }
    }
  },
  meetings: {
    table: "meeting_schedule",
    fields: {
      meeting_date: { required: true, type: "date" },
      meeting_time: { required: true, type: "text" },
      meeting_name: { required: true, type: "text" },
      team: { required: false, type: "text" },
      meeting_room: { required: false, type: "text" }
    }
  },
  departments: {
    table: "department_schedule",
    fields: {
      schedule_date: { required: true, type: "date" },
      department_name: { required: true, type: "text" },
      start_time: { required: true, type: "text" },
      end_time: { required: true, type: "text" },
      location: { required: true, type: "text" }
    }
  },
  attendance: {
    table: "attendance_data",
    fields: {
      reading_date: { required: true, type: "date" },
      location_name: { required: true, type: "enum", values: ["Manpower", "Wada", "HO"] },
      present_count: { required: true, type: "number" },
      absent_count: { required: true, type: "number" },
      half_day_count: { required: true, type: "number" }
    }
  },
  "manpower-images": {
    table: "manpower_images",
    fields: {
      date: { required: true, type: "date" },
      title: { required: true, type: "text" },
      description: { required: false, type: "text" }
    }
  },
  tasks: {
    table: "tasks_data",
    fields: {
      task_date: { required: true, type: "date" },
      task_time: { required: true, type: "text" },
      task_name: { required: true, type: "text" },
      status: { required: true, type: "enum", values: ["Pending", "Completed", "Overdue"] }
    }
  },
  notes: {
    table: "notes_data",
    fields: {
      note_date: { required: true, type: "date" },
      note_title: { required: true, type: "text" },
      note_description: { required: true, type: "text" }
    }
  },
  reminders: {
    table: "reminders_data",
    fields: {
      reminder_date: { required: true, type: "date" },
      reminder_time: { required: true, type: "text" },
      reminder_description: { required: true, type: "text" }
    }
  }
};

function qid(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
function getCfg(name) {
  const c = cfg[name];
  if (!c) {
    const e = new Error("Unknown data module");
    e.status = 404;
    throw e;
  }
  return c;
}
function normalizeValue(field, rule, raw) {
  if (raw === undefined || raw === null || raw === "") {
    if (rule.required) {
      const e = new Error(`${field} is required`);
      e.status = 400;
      throw e;
    }
    return null;
  }
  if (rule.type === "date") {
    const value = String(raw).trim();
    if (!DATE_RE.test(value)) {
      const e = new Error(`${field} must be in YYYY-MM-DD format`);
      e.status = 400;
      throw e;
    }
    return value;
  }
  if (rule.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      const e = new Error(`${field} must be a non-negative number`);
      e.status = 400;
      throw e;
    }
    return value;
  }
  const value = String(raw).trim();
  if (rule.type === "enum" && !rule.values.includes(value)) {
    const e = new Error(`${field} must be one of: ${rule.values.join(", ")}`);
    e.status = 400;
    throw e;
  }
  if (rule.required && !value) {
    const e = new Error(`${field} is required`);
    e.status = 400;
    throw e;
  }
  return value || null;
}
function normalizePayload(c, body = {}) {
  const columns = Object.keys(c.fields);
  const values = columns.map(field => {
    const rule = c.fields[field];
    let raw = body[field];
    if ((raw === undefined || raw === null || raw === "") && Array.isArray(rule.aliases)) {
      for (const alias of rule.aliases) {
        const candidate = body[alias];
        if (candidate !== undefined && candidate !== null && candidate !== "") {
          raw = candidate;
          break;
        }
      }
    }
    return normalizeValue(field, rule, raw);
  });
  return { columns, values };
}
function insertSql(c, columns) {
  return `insert into ${qid(c.table)} (${columns.map(qid).join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")}) returning *`;
}

// Database-backed dashboard preference for the authenticated Admin user.
router.get("/preferences/dashboard", async (req, res, next) => {
  try {
    const result = await query(
      `select hide_dashboard from dashboard_preferences where user_id=$1 limit 1`,
      [req.user.sub]
    );
    res.json({ hideDashboard: Boolean(result.rows[0]?.hide_dashboard) });
  } catch (e) {
    next(e);
  }
});

router.put("/preferences/dashboard", async (req, res, next) => {
  try {
    if (typeof req.body?.hideDashboard !== "boolean") {
      return res.status(400).json({ message: "hideDashboard must be true or false" });
    }
    const result = await query(
      `insert into dashboard_preferences(user_id,hide_dashboard)
       values($1,$2)
       on conflict(user_id) do update
       set hide_dashboard=excluded.hide_dashboard,updated_at=now()
       returning hide_dashboard,updated_at`,
      [req.user.sub, req.body.hideDashboard]
    );
    res.json({
      hideDashboard: Boolean(result.rows[0].hide_dashboard),
      updatedAt: result.rows[0].updated_at
    });
  } catch (e) {
    next(e);
  }
});

// Manpower images use multipart/form-data and Supabase Storage.
router.post("/manpower-images", imageUpload.single("image"), async (req, res, next) => {
  let uploaded = null;
  try {
    validateImageFile(req.file);
    const c = getCfg("manpower-images");
    const { values } = normalizePayload(c, req.body);
    const [date, title, description] = values;
    uploaded = await uploadManpowerImage(req.file, date);

    const result = await query(
      `insert into manpower_images ("date",image_url,storage_path,title,description)
       values($1,$2,$3,$4,$5) returning *`,
      [date, uploaded.imageUrl, uploaded.storagePath, title, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (uploaded?.storagePath) await deleteManpowerImage(uploaded.storagePath);
    next(e);
  }
});

router.put("/manpower-images/:id", imageUpload.single("image"), async (req, res, next) => {
  let replacement = null;
  try {
    const existingResult = await query("select * from manpower_images where id=$1 limit 1", [req.params.id]);
    const existing = existingResult.rows[0];
    if (!existing) return res.status(404).json({ message: "Record not found" });

    const c = getCfg("manpower-images");
    const { values } = normalizePayload(c, req.body);
    const [date, title, description] = values;

    let imageUrl = existing.image_url;
    let storagePath = existing.storage_path;
    if (req.file) {
      validateImageFile(req.file);
      replacement = await uploadManpowerImage(req.file, date);
      imageUrl = replacement.imageUrl;
      storagePath = replacement.storagePath;
    }

    const result = await query(
      `update manpower_images
       set "date"=$1,title=$2,description=$3,image_url=$4,storage_path=$5
       where id=$6 returning *`,
      [date, title, description, imageUrl, storagePath, req.params.id]
    );

    if (replacement && existing.storage_path && existing.storage_path !== replacement.storagePath) {
      await deleteManpowerImage(existing.storage_path);
    }
    res.json(result.rows[0]);
  } catch (e) {
    if (replacement?.storagePath) await deleteManpowerImage(replacement.storagePath);
    next(e);
  }
});

router.delete("/manpower-images/:id", async (req, res, next) => {
  try {
    const result = await query("delete from manpower_images where id=$1 returning id,storage_path", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ message: "Record not found" });
    await deleteManpowerImage(result.rows[0].storage_path);
    res.json({ deleted: true, id: req.params.id });
  } catch (e) {
    next(e);
  }
});

router.post("/manpower-images/bulk", (req, res) => {
  res.status(400).json({ message: "Bulk CSV upload is not available for images. Use the Manpower Images upload form." });
});

router.get("/:module", async (req, res, next) => {
  try {
    const c = getCfg(req.params.module);
    const result = await query(`select * from ${qid(c.table)} order by ${c.orderBy || "created_at desc,id desc"}`);
    res.json(result.rows);
  } catch (e) {
    next(e);
  }
});

router.post("/:module", async (req, res, next) => {
  try {
    const c = getCfg(req.params.module);
    const { columns, values } = normalizePayload(c, req.body);
    const result = await query(insertSql(c, columns), values);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

router.put("/:module/:id", async (req, res, next) => {
  try {
    const c = getCfg(req.params.module);
    const { columns, values } = normalizePayload(c, req.body);
    const set = columns.map((field, i) => `${qid(field)}=$${i + 1}`).join(",");
    values.push(req.params.id);
    const result = await query(`update ${qid(c.table)} set ${set} where id=$${values.length} returning *`, values);
    if (!result.rows[0]) return res.status(404).json({ message: "Record not found" });
    res.json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

router.delete("/:module/:id", async (req, res, next) => {
  try {
    const c = getCfg(req.params.module);
    const result = await query(`delete from ${qid(c.table)} where id=$1 returning id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ message: "Record not found" });
    res.json({ deleted: true, id: req.params.id });
  } catch (e) {
    next(e);
  }
});

router.post("/:module/bulk", csvUpload.single("file"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const c = getCfg(req.params.module);
    if (!req.file) return res.status(400).json({ message: "CSV file is required" });

    const rows = parse(req.file.buffer.toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
    if (!rows.length) return res.status(400).json({ message: "CSV contains no data rows" });

    await client.query("begin");
    let inserted = 0;
    for (const row of rows) {
      const { columns, values } = normalizePayload(c, row);
      await client.query(insertSql(c, columns), values);
      inserted += 1;
    }
    await client.query("commit");
    res.json({ inserted });
  } catch (e) {
    try { await client.query("rollback"); } catch {}
    next(e);
  } finally {
    client.release();
  }
});

// Receivables/Payables bulk import: unlike the generic CSV-file /:module/bulk
// route above, the file (.xlsx/.xls/.csv) is parsed and validated in the
// browser (SheetJS) so Excel dates, Indian-comma amounts and per-row error
// messages all come from the same logic the upload preview already showed the
// admin - this endpoint just persists the already-clean rows.
const BULK_IMPORT_MODULES = new Set(["receivables", "payables"]);
router.post("/:module/bulk-import", async (req, res, next) => {
  if (!BULK_IMPORT_MODULES.has(req.params.module)) {
    return res.status(404).json({ message: "Bulk import is only available for receivables and payables" });
  }

  const client = await pool.connect();
  try {
    const c = getCfg(req.params.module);
    const mode = req.body?.mode === "replace" ? "replace" : "append";
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) return res.status(400).json({ message: "rows must be a non-empty array" });

    await client.query("begin");
    if (mode === "replace") {
      await client.query(`delete from ${qid(c.table)}`);
    }
    let inserted = 0;
    for (const row of rows) {
      const { columns, values } = normalizePayload(c, row);
      await client.query(insertSql(c, columns), values);
      inserted += 1;
    }
    await client.query("commit");
    res.json({ inserted, mode });
  } catch (e) {
    try { await client.query("rollback"); } catch {}
    next(e);
  } finally {
    client.release();
  }
});

export default router;
