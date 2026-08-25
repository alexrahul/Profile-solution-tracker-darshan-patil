import { Router } from "express";
import jwt from "jsonwebtoken";
import { query } from "../db.js";
import { requireAdmin } from "../auth.js";
import { encryptToken } from "../cryptoUtil.js";
import { buildAuthUrl, exchangeCode, fetchAccountEmail } from "../services/calendarProviders.js";
import { syncConnection } from "../services/calendarSync.js";

const router = Router();

function jwtSecret() {
  return process.env.JWT_SECRET;
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || "http://localhost:3000").split(",")[0].trim();
}

function normalizeProvider(raw) {
  const provider = String(raw || "").toUpperCase();
  return provider === "GOOGLE" || provider === "MICROSOFT" ? provider : null;
}

function redirectToSettings(res, status) {
  res.redirect(`${frontendUrl()}/index.html?calendar=${status}#settings`);
}

// Initiates the OAuth flow. This is a top-level browser redirect (triggered by
// window.location from the Settings page), so the admin's access token can't be
// sent as an Authorization header — it's passed as a query param instead and
// verified manually here. The route redirects immediately without rendering
// anything, which keeps the token out of any Referer header on a later request.
router.get("/connect/:provider", (req, res) => {
  const provider = normalizeProvider(req.params.provider);
  if (!provider) return res.status(400).json({ message: "Unsupported calendar provider" });

  let payload;
  try {
    payload = jwt.verify(String(req.query.token || ""), jwtSecret());
  } catch {
    return redirectToSettings(res, "error");
  }
  if ((payload.type && payload.type !== "access") || payload.role !== "ADMIN") {
    return redirectToSettings(res, "error");
  }

  const state = jwt.sign({ sub: payload.sub, provider }, jwtSecret(), { expiresIn: "5m" });
  res.redirect(buildAuthUrl(provider, state));
});

// Public callback: Google/Microsoft redirect the browser here with no auth header.
// The signed, short-lived `state` param (minted in /connect above) identifies the user.
router.get("/callback/:provider", async (req, res) => {
  const provider = normalizeProvider(req.params.provider);
  if (!provider) return redirectToSettings(res, "error");

  try {
    if (req.query.error || !req.query.code || !req.query.state) {
      throw new Error("Calendar authorization was cancelled or incomplete");
    }

    const state = jwt.verify(String(req.query.state), jwtSecret());
    if (state.provider !== provider) throw new Error("Calendar authorization state mismatch");

    const tokens = await exchangeCode(provider, String(req.query.code));
    const tokenExpiry = new Date(Date.now() + (tokens.expiresIn || 3600) * 1000);

    let connectedEmail = null;
    try {
      connectedEmail = await fetchAccountEmail(provider, tokens.accessToken);
    } catch (emailErr) {
      console.error(`[calendar] ${provider} email lookup failed:`, emailErr.message);
    }

    const result = await query(
      `insert into calendar_connections(user_id,provider,access_token_encrypted,refresh_token_encrypted,token_expiry,connected_email,is_active,connected_at)
       values($1,$2,$3,$4,$5,$6,true,now())
       on conflict(user_id,provider) do update
       set access_token_encrypted=excluded.access_token_encrypted,
           refresh_token_encrypted=coalesce(excluded.refresh_token_encrypted,calendar_connections.refresh_token_encrypted),
           token_expiry=excluded.token_expiry,
           connected_email=excluded.connected_email,
           is_active=true,
           connected_at=now()
       returning *`,
      [
        state.sub,
        provider,
        encryptToken(tokens.accessToken),
        tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
        tokenExpiry,
        connectedEmail
      ]
    );

    try {
      await syncConnection(result.rows[0]);
    } catch (syncErr) {
      console.error(`[calendar] initial sync failed for ${provider} connection ${result.rows[0].id}:`, syncErr.message);
    }

    redirectToSettings(res, "connected");
  } catch (err) {
    console.error(`[calendar] ${provider} connect failed:`, err.message);
    redirectToSettings(res, "error");
  }
});

router.get("/connections", requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `select id,provider,connected_at,connected_email,is_active from calendar_connections where user_id=$1 order by provider`,
      [req.user.sub]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.post("/connections/:id/sync", requireAdmin, async (req, res, next) => {
  try {
    const existing = await query(`select * from calendar_connections where id=$1 limit 1`, [req.params.id]);
    const connection = existing.rows[0];
    if (!connection) return res.status(404).json({ message: "Connection not found" });
    if (connection.user_id !== req.user.sub) return res.status(403).json({ message: "Not your calendar connection" });
    if (!connection.is_active) return res.status(409).json({ message: "Connection is inactive. Reconnect to resume syncing." });

    const synced = await syncConnection(connection);
    res.json({ synced });
  } catch (err) {
    next(err);
  }
});

router.delete("/connections/:id", requireAdmin, async (req, res, next) => {
  try {
    const existing = await query(`select id,user_id from calendar_connections where id=$1 limit 1`, [req.params.id]);
    const connection = existing.rows[0];
    if (!connection) return res.status(404).json({ message: "Connection not found" });
    if (connection.user_id !== req.user.sub) return res.status(403).json({ message: "Not your calendar connection" });

    await query(`delete from calendar_connections where id=$1`, [req.params.id]);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

export default router;
