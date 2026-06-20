import { Router, Request, Response } from "express";
import { ingestBatch, TrackBatch } from "../analytics/ingest";
import { clientIp } from "../lib/geo";
import { optionalAuth } from "../middleware/authMiddleware";

/* ============================================================
   POST /api/track — public event collector.
   ------------------------------------------------------------
   No auth (anonymous visitors are the whole point). Returns 204
   immediately and ingests off the response path so the browser's
   sendBeacon never waits. A lightweight per-IP rate limit stops a
   single client from flooding the firehose.
   ============================================================ */

const router = Router();

/* ---- crude in-memory per-IP rate limit (60 batches / 10s) ---- */
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 60;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const e = hits.get(key);
  if (!e || now > e.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  e.count += 1;
  return e.count > MAX_PER_WINDOW;
}
// Keep the map from growing unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
}, 60_000).unref();

function selfHost(req: Request): string | null {
  try {
    return new URL(process.env.FRONTEND_URL ?? "http://localhost:3000").host;
  } catch {
    return null;
  }
}

// optionalAuth populates req.currentUser from the av_token cookie when present
// (never rejects — anonymous visitors are expected). We attribute events to
// that server-verified id only, ignoring any userId in the request body.
router.post("/", optionalAuth, (req: Request, res: Response) => {
  const ip = clientIp(req.headers["x-forwarded-for"] as string | undefined, req.ip);
  // Always 204 first — analytics must never slow or break the page.
  res.status(204).end();

  if (rateLimited(ip ?? "anon")) return;

  const authUserId = req.currentUser?.id != null ? Number(req.currentUser.id) : null;
  const batch = req.body as TrackBatch;
  ingestBatch(batch, {
    ip,
    userAgent: req.get("user-agent"),
    selfHost: selfHost(req),
    authUserId: Number.isInteger(authUserId) ? authUserId : null,
  }).catch((err) => console.error("[track] ingest failed", err));
});

export default router;
