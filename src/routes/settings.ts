import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/http";
import { getManualOrderConfig } from "../lib/manualOrder";

const router = Router();

/* GET /api/settings/manual-order — public config for the offline-first request
   flow: WhatsApp number, UPI id, response window and customer notices. The
   storefront reads this to render the PDP notice and build wa.me links. */
router.get(
  "/manual-order",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getManualOrderConfig());
  })
);

/* GET /api/settings/hero — public hero background overrides for the storefront
   carousel. Returns { images: (string | null)[] } aligned to slide index; an
   empty array means "use the built-in defaults". */
router.get(
  "/hero",
  asyncHandler(async (_req: Request, res: Response) => {
    const setting = await prisma.siteSetting.findUnique({ where: { key: "hero" } });
    const value = setting?.value as { images?: unknown } | null;
    const images = Array.isArray(value?.images)
      ? value!.images.map((u: unknown) => (typeof u === "string" && u.trim() ? u.trim() : null))
      : [];
    res.json({ images });
  })
);

export default router;
