import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { query } from "./db.js";
import { requireAdmin } from "./auth.js";
import authRoutes from "./routes/auth.js";
import publicRoutes from "./routes/public.js";
import adminRoutes from "./routes/admin.js";
import calendarRoutes from "./routes/calendar.js";
import { syncAllActiveConnections } from "./services/calendarSync.js";

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters");
}

const app = express();
const port = Number(process.env.PORT || 4000);
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (req, res, next) => {
  try {
    await query("select 1");
    res.json({ status: "UP", service: "Profile Solutions Dashboard API", database: "connected" });
  } catch (e) {
    next(e);
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/admin", requireAdmin, adminRoutes);
// Not mounted under requireAdmin: the OAuth callback is a plain browser
// redirect from Google/Microsoft with no Authorization header. Individual
// routes inside apply requireAdmin themselves where needed.
app.use("/api/calendar", calendarRoutes);

app.use((err, req, res, next) => {
  console.error(err);

  let status = err.status || 500;
  let message = err.message || "Unexpected server error";

  if (err.code === "23505") {
    status = 409;
    message = "A record already exists for this date/key. Edit the existing record instead.";
  } else if (err.code === "23514" || err.code === "23502" || err.code === "22P02") {
    status = 400;
    message = "Invalid data. Please check the required fields and values.";
  } else if (err.code === "LIMIT_FILE_SIZE") {
    status = 400;
    message = "Image is too large. Maximum upload size is 10 MB.";
  }

  res.status(status).json({
    message: status === 500 ? "Unexpected server error" : message,
    code: err.code || undefined,
    detail: process.env.NODE_ENV === "development" ? err.message : undefined
  });
});

app.listen(port, () => console.log(`Profile Solutions Dashboard API running on http://localhost:${port}`));

// Polls connected Google/Microsoft calendars every 5 minutes. This can later be
// upgraded to Google "watch" channels / Microsoft Graph webhook subscriptions
// for push-based near-instant sync instead of polling.
setInterval(() => {
  syncAllActiveConnections().catch(err => console.error("[calendar-sync] batch sync failed:", err.message));
}, 5 * 60 * 1000);
