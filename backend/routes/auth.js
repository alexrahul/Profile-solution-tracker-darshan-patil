import { Router } from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { createTokenPair, requireAdmin, revokeRefreshToken, rotateRefreshToken } from "../auth.js";

const router = Router();

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message: "Email and password are required" });

    const result = await query(
      "select id,name,email,password_hash,role,active from users where lower(email)=lower($1) limit 1",
      [email]
    );
    const user = result.rows[0];

    if (!user || !user.active || user.role !== "ADMIN" || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const pair = await createTokenPair(user);
    res.json({
      ...pair,
      token: pair.accessToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    next(err);
  }
});

router.post("/refresh", async (req, res, next) => {
  try {
    const refreshToken = String(req.body?.refreshToken || "");
    if (!refreshToken) return res.status(401).json({ message: "Refresh token is required", code: "REFRESH_REQUIRED" });

    const pair = await rotateRefreshToken(refreshToken);
    res.json({ ...pair, token: pair.accessToken });
  } catch (err) {
    if (err?.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Refresh session expired", code: "REFRESH_EXPIRED" });
    }
    next(err);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    await revokeRefreshToken(String(req.body?.refreshToken || ""));
    res.json({ loggedOut: true });
  } catch (err) {
    next(err);
  }
});

router.get("/session", requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      "select id,name,email,role,active from users where id=$1 limit 1",
      [req.user.sub]
    );
    const user = result.rows[0];
    if (!user || !user.active || user.role !== "ADMIN") {
      return res.status(401).json({ message: "Session is no longer valid", code: "SESSION_INVALID" });
    }
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

router.post("/bootstrap-refresh", requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      "select id,name,email,role,active from users where id=$1 limit 1",
      [req.user.sub]
    );
    const user = result.rows[0];
    if (!user || !user.active || user.role !== "ADMIN") {
      return res.status(401).json({ message: "Session is no longer valid", code: "SESSION_INVALID" });
    }
    const pair = await createTokenPair(user);
    res.json({ ...pair, token: pair.accessToken });
  } catch (err) {
    next(err);
  }
});

export default router;
