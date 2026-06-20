import { Router, Request, Response } from "express";
import passport from "passport";
import jwt from "jsonwebtoken";
import { JwtPayload } from "../config/passport";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/authMiddleware";
import { ACTIONS, Action, logActivity } from "../lib/notify";

const router = Router();

/** Fire-and-forget auth audit row. Never awaited — logging must not slow or
    break sign-in. Captures IP + user agent from the request. */
function auditAuth(
  req: Request,
  action: Action,
  userId: number | null,
  meta?: Record<string, string | number | boolean | null>
): void {
  logActivity(prisma, {
    action,
    actorType: "CUSTOMER",
    actorId: userId,
    entityType: "user",
    entityId: userId,
    meta,
    req,
  }).catch((err) => console.error("[auth] audit failed", err));
}

const JWT_SECRET = process.env.JWT_SECRET!;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";
const COOKIE_NAME = "av_token";

// Frontend (Vercel) and backend (Render) are on different sites, so the auth
// cookie must be SameSite=None + Secure in production for the browser to send
// it on cross-site API requests. Locally we keep Lax over http.
const isProd = process.env.NODE_ENV === "production";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProd,
  sameSite: isProd ? ("none" as const) : ("lax" as const),
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function safeFrontendPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.startsWith("/") && !decoded.startsWith("//") ? decoded : "/";
  } catch {
    return "/";
  }
}

/* OTP policy */
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds

type AuthUser = { id: number; email: string | null; name: string | null };

/** Sign the JWT and set the av_token cookie. Shared by Google + phone flows. */
function issueAuthCookie(res: Response, user: AuthUser): JwtPayload {
  const payload: JwtPayload = {
    id: String(user.id),
    email: user.email ?? "",
    name: user.name ?? "",
  };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  return payload;
}

/** Validate an Indian 10-digit mobile and normalize to E.164 (+91XXXXXXXXXX). */
function normalizeIndianPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "").replace(/^91/, "");
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

router.get(
  "/google",
  (req: Request, res: Response, next) => {
    passport.authenticate("google", {
      session: false,
      scope: ["profile", "email"],
      state: encodeURIComponent(safeFrontendPath(req.query.next)),
    })(req, res, next);
  }
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: `${FRONTEND_URL}/login?error=oauth_failed`,
  }),
  (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    issueAuthCookie(res, user);
    auditAuth(req, ACTIONS.AUTH_LOGIN, user.id, { method: "google" });
    res.redirect(`${FRONTEND_URL}${safeFrontendPath(req.query.state)}`);
  }
);

/** Shape a user (with accounts) into the session-user payload the frontend expects. */
function serializeSessionUser(user: {
  id: number;
  email: string | null;
  name: string | null;
  phone: string | null;
  role: string;
  created_at: Date;
  accounts: { provider: string }[];
}) {
  return {
    id: String(user.id),
    email: user.email ?? "",
    name: user.name ?? "",
    phone: user.phone ?? "",
    role: user.role,
    createdAt: user.created_at.toISOString(),
    providers: user.accounts.map((account) => account.provider),
  };
}

router.get("/me", async (req: Request, res: Response) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const user = await prisma.user.findUnique({
      where: { id: Number(payload.id) },
      include: { accounts: { select: { provider: true } } },
    });

    if (!user) {
      res.status(401).json({ error: "User no longer exists" });
      return;
    }

    res.json({ user: serializeSessionUser(user) });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

/* PATCH /api/auth/me — update the signed-in user's own profile (name + phone).
   Email is intentionally read-only: it's tied to the Google identity. */
router.patch("/me", requireAuth, async (req: Request, res: Response) => {
  const userId = Number(req.currentUser!.id);
  const body = req.body ?? {};

  const data: { name?: string | null; phone?: string } = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length === 0) {
      res.status(400).json({ error: "Name can't be empty." });
      return;
    }
    data.name = name;
  }

  if (body.phone !== undefined && String(body.phone).trim() !== "") {
    const phone = normalizeIndianPhone(body.phone);
    if (!phone) {
      res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
      return;
    }
    data.phone = phone;
  }

  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "Nothing to update." });
    return;
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data,
      include: { accounts: { select: { provider: true } } },
    });
    res.json({ user: serializeSessionUser(user) });
  } catch (err: any) {
    // P2002 = unique constraint (another account already uses this phone).
    if (err?.code === "P2002") {
      res.status(409).json({ error: "That mobile number is already linked to another account." });
      return;
    }
    console.error("PATCH /me failed", err);
    res.status(500).json({ error: "Could not update your profile. Please try again." });
  }
});

router.post("/logout", (req: Request, res: Response) => {
  // The JWT isn't verified here (logout always succeeds), so actorId is unknown.
  auditAuth(req, ACTIONS.AUTH_LOGOUT, null, { method: "cookie" });
  res.clearCookie(COOKIE_NAME, {
    httpOnly: COOKIE_OPTIONS.httpOnly,
    secure: COOKIE_OPTIONS.secure,
    sameSite: COOKIE_OPTIONS.sameSite,
  });
  res.json({ success: true });
});

/* ============================================================
   Phone OTP (dev mock — no real SMS)
   ------------------------------------------------------------
   send:   validate phone, enforce login/signup existence rules,
           generate a 6-digit code, store it, log + return devOtp.
   verify: check the code, then find-or-create per mode and issue
           the same av_token JWT cookie the Google flow uses.
   ============================================================ */

router.post("/otp/send", async (req: Request, res: Response) => {
  const phone = normalizeIndianPhone(req.body?.phone);
  const mode = req.body?.mode === "signup" ? "signup" : "login";

  if (!phone) {
    res.status(400).json({ error: "Enter a valid 10-digit Indian mobile number." });
    return;
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { phone } });
    if (mode === "signup" && existingUser) {
      res.status(409).json({ error: "An account with this number already exists. Please log in." });
      return;
    }
    if (mode === "login" && !existingUser) {
      res.status(404).json({ error: "No account found for this number. Please sign up." });
      return;
    }

    // 30s resend cooldown per phone.
    const existingOtp = await prisma.otpToken.findUnique({ where: { phone } });
    if (existingOtp && Date.now() - existingOtp.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil(
        (OTP_RESEND_COOLDOWN_MS - (Date.now() - existingOtp.createdAt.getTime())) / 1000
      );
      res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
      return;
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + OTP_TTL_MS);

    await prisma.otpToken.upsert({
      where: { phone },
      create: { phone, otp, expires, userId: existingUser?.id ?? null },
      update: { otp, expires, createdAt: new Date(), userId: existingUser?.id ?? null },
    });

    // DEV MOCK: no SMS provider wired up — surface the code instead.
    console.log(`[otp] ${phone} -> ${otp} (mode=${mode}, expires in 5m)`);
    res.json({ ok: true, devOtp: otp });
  } catch (err) {
    console.error("otp/send failed", err);
    res.status(500).json({ error: "Could not send the code. Please try again." });
  }
});

router.post("/otp/verify", async (req: Request, res: Response) => {
  const phone = normalizeIndianPhone(req.body?.phone);
  const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";
  const mode = req.body?.mode === "signup" ? "signup" : "login";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";

  if (!phone || !/^\d{6}$/.test(otp)) {
    res.status(400).json({ error: "Invalid phone number or code." });
    return;
  }

  try {
    const token = await prisma.otpToken.findUnique({ where: { phone } });
    if (!token || token.otp !== otp) {
      auditAuth(req, ACTIONS.AUTH_LOGIN_FAILED, token?.userId ?? null, {
        method: "otp",
        reason: "bad_code",
      });
      res.status(400).json({ error: "Incorrect code. Please check and try again." });
      return;
    }
    if (token.expires.getTime() < Date.now()) {
      await prisma.otpToken.delete({ where: { phone } }).catch(() => {});
      res.status(400).json({ error: "This code has expired. Please request a new one." });
      return;
    }

    let user = await prisma.user.findUnique({ where: { phone } });

    if (mode === "signup") {
      if (user) {
        res.status(409).json({ error: "An account with this number already exists. Please log in." });
        return;
      }
      user = await prisma.user.create({ data: { phone, name: name || null } });
    } else {
      if (!user) {
        res.status(404).json({ error: "No account found for this number. Please sign up." });
        return;
      }
    }

    // Single-use: clear the code once consumed.
    await prisma.otpToken.delete({ where: { phone } }).catch(() => {});

    auditAuth(req, mode === "signup" ? ACTIONS.AUTH_SIGNUP : ACTIONS.AUTH_LOGIN, user.id, {
      method: "otp",
    });
    const payload = issueAuthCookie(res, user);
    res.json({ user: payload });
  } catch (err) {
    console.error("otp/verify failed", err);
    res.status(500).json({ error: "Could not verify the code. Please try again." });
  }
});

export default router;
