import crypto from "crypto";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

const ACCESS_TOKEN_TTL = "30m";
const REFRESH_TOKEN_TTL = "7d";
const REFRESH_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function jwtSecret() {
  return process.env.JWT_SECRET;
}

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: "access" },
    jwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

export function signRefreshToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: "refresh", jti: sessionId },
    jwtSecret(),
    { expiresIn: REFRESH_TOKEN_TTL }
  );
}

export async function createTokenPair(user) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_SESSION_MS);

  await query(
    `insert into refresh_sessions(id,user_id,expires_at)
     values($1,$2,$3)`,
    [sessionId, user.id, expiresAt]
  );

  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user, sessionId),
    expiresInSeconds: 30 * 60
  };
}

export function verifyRefreshToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret());
  } catch (err) {
    err.status = 401;
    err.code = err.name === "TokenExpiredError" ? "REFRESH_EXPIRED" : "INVALID_REFRESH_TOKEN";
    throw err;
  }
  if (payload.type !== "refresh" || !payload.jti || !payload.sub) {
    const err = new Error("Invalid refresh token");
    err.status = 401;
    err.code = "INVALID_REFRESH_TOKEN";
    throw err;
  }
  return payload;
}

export async function rotateRefreshToken(refreshToken) {
  const payload = verifyRefreshToken(refreshToken);
  const result = await query(
    `select u.id,u.name,u.email,u.role,u.active
       from refresh_sessions rs
       join users u on u.id=rs.user_id
      where rs.id=$1
        and rs.user_id=$2
        and rs.revoked_at is null
        and rs.expires_at > now()
      limit 1`,
    [payload.jti, payload.sub]
  );

  const session = result.rows[0];
  if (!session || !session.active || session.role !== "ADMIN") {
    const err = new Error("Refresh session is no longer valid");
    err.status = 401;
    err.code = "REFRESH_SESSION_EXPIRED";
    throw err;
  }

  await query("update refresh_sessions set revoked_at=now() where id=$1", [payload.jti]);
  return createTokenPair(session);
}

export async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  try {
    const payload = verifyRefreshToken(refreshToken);
    await query("update refresh_sessions set revoked_at=coalesce(revoked_at,now()) where id=$1", [payload.jti]);
  } catch {
    // Logout is idempotent. Invalid/expired refresh tokens are treated as already logged out.
  }
}

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required", code: "AUTH_REQUIRED" });
  }

  try {
    const payload = jwt.verify(header.slice(7), jwtSecret());
    if (payload.type && payload.type !== "access") {
      return res.status(401).json({ message: "Invalid access token", code: "INVALID_TOKEN" });
    }
    if (payload.role !== "ADMIN") {
      return res.status(403).json({ message: "Admin access required", code: "ADMIN_REQUIRED" });
    }
    req.user = payload;
    next();
  } catch (err) {
    if (err?.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Access token expired", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ message: "Invalid access token", code: "INVALID_TOKEN" });
  }
}
