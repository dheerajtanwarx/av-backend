import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";

/* ============================================================
   GET /go/:code — marketing short link / QR target.
   ------------------------------------------------------------
   Printed on packaging, store signage, cards; embedded in QR codes.
   Resolves the code, bumps a denormalized click counter, then
   302-redirects to the frontend with UTM params baked in — so the
   landing page's analytics SDK attributes the visit exactly like any
   other source (utm_source=qr, etc.). Precise conversion still comes
   from the events the visitor then fires; this counter is just a fast
   "how many scans" tally for the admin list.

   Mounted at the app root (NOT under /api) so the printed URL is short:
   https://yourdomain.com/go/diwali-flyer
   ============================================================ */

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

const CODE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

router.get("/:code", async (req: Request, res: Response) => {
  const code = String(req.params.code ?? "");
  if (!CODE.test(code)) {
    res.redirect(302, FRONTEND_URL);
    return;
  }

  const link = await prisma.shortLink.findUnique({ where: { code } }).catch(() => null);
  if (!link || !link.active) {
    res.redirect(302, FRONTEND_URL);
    return;
  }

  // Best-effort click tally — never block the redirect on it.
  prisma.shortLink
    .update({ where: { id: link.id }, data: { clicks: { increment: 1 } } })
    .catch(() => {});

  // Build the destination with UTM params merged in (existing ones on the
  // target win, so a hand-crafted target URL isn't overwritten).
  const base = /^https?:\/\//i.test(link.target)
    ? link.target
    : `${FRONTEND_URL}${link.target.startsWith("/") ? "" : "/"}${link.target}`;
  let dest: URL;
  try {
    dest = new URL(base);
  } catch {
    res.redirect(302, FRONTEND_URL);
    return;
  }
  const setIfAbsent = (k: string, v: string | null) => {
    if (v && !dest.searchParams.has(k)) dest.searchParams.set(k, v);
  };
  setIfAbsent("utm_source", link.source ?? "qr");
  setIfAbsent("utm_medium", link.medium ?? "qr");
  setIfAbsent("utm_campaign", link.campaign);
  setIfAbsent("utm_content", link.content);

  res.redirect(302, dest.toString());
});

export default router;
