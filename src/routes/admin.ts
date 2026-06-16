import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/http";
import { toNumber } from "../lib/money";
import { requireAdmin } from "../middleware/authMiddleware";
import { uploadImage, cloudinaryConfigured } from "../lib/cloudinary";
import { OrderStatus } from "../../generated/prisma/client";
import { PENDING_STATUSES, startOfTodayIST } from "../lib/orderFilters";
import {
  MANUAL_ORDER_KEY,
  getManualOrderConfig,
  normalizeManualOrderConfig,
} from "../lib/manualOrder";

const router = Router();

/* In-memory upload: images go straight to Cloudinary, never touch disk.
   5 MB cap, images only. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith("image/"));
  },
});

/** Run multer for a single `image` field, turning its errors into JSON 400s. */
function singleImage(req: Request, res: Response, next: NextFunction): void {
  upload.single("image")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === "LIMIT_FILE_SIZE" ? "Image must be under 5 MB." : "Upload failed.";
      res.status(400).json({ error: msg });
      return;
    }
    if (err) {
      res.status(400).json({ error: "Upload failed." });
      return;
    }
    next();
  });
}

/** Every order status, in fulfilment order, so the status breakdown is stable. */
const ALL_STATUSES: OrderStatus[] = [
  "PLACED",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "RETURNED",
];

/** Statuses that count toward revenue — cancelled/returned orders are refunded
    (mock gateway) so they're excluded. */
const REVENUE_STATUSES: OrderStatus[] = [
  "PLACED",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
];

const TREND_DAYS = 14;

/** Local-time YYYY-MM-DD key for day bucketing. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* GET /api/admin/dashboard — headline stats, a daily orders/revenue trend for
   the last TREND_DAYS, and the order count by status. Admin only. */
router.get(
  "/dashboard",
  asyncHandler(requireAdmin),
  asyncHandler(async (_req: Request, res: Response) => {
    // Window start = midnight, (TREND_DAYS - 1) days ago.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (TREND_DAYS - 1));

    const [
      revenueAgg,
      totalOrders,
      totalCustomers,
      totalProducts,
      pendingOrders,
      deliveredOrders,
      todayOrders,
      cancelledOrders,
      refunds,
      byStatusRaw,
      windowOrders,
    ] = await Promise.all([
      prisma.order.aggregate({
        _sum: { finalAmount: true },
        where: { status: { in: REVENUE_STATUSES } },
      }),
      prisma.order.count(),
      prisma.user.count({ where: { role: "USER" } }),
      prisma.product.count(),
      prisma.order.count({ where: { status: { in: PENDING_STATUSES } } }),
      prisma.order.count({ where: { status: "DELIVERED" } }),
      prisma.order.count({ where: { placedAt: { gte: startOfTodayIST() } } }),
      prisma.order.count({ where: { status: "CANCELLED" } }),
      // "Refunds" = payments flipped to REFUNDED (mock gateway: cancel/return
      // auto-refund captured payments, plus the admin refund endpoint).
      prisma.payment.count({ where: { status: "REFUNDED" } }),
      prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.order.findMany({
        where: { placedAt: { gte: start } },
        select: { placedAt: true, finalAmount: true, status: true },
      }),
    ]);

    // Pre-seed every day in the window so gaps render as zero, not missing.
    const buckets = new Map<string, { orders: number; revenue: number }>();
    for (let i = 0; i < TREND_DAYS; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      buckets.set(dayKey(d), { orders: 0, revenue: 0 });
    }
    for (const o of windowOrders) {
      const b = buckets.get(dayKey(o.placedAt));
      if (!b) continue;
      b.orders += 1;
      if (REVENUE_STATUSES.includes(o.status)) b.revenue += toNumber(o.finalAmount);
    }
    const daily = [...buckets.entries()].map(([date, v]) => ({
      date,
      orders: v.orders,
      revenue: v.revenue,
    }));

    const byStatus = ALL_STATUSES.map((status) => ({
      status,
      count: byStatusRaw.find((g) => g.status === status)?._count._all ?? 0,
    }));

    res.json({
      stats: {
        totalRevenue: toNumber(revenueAgg._sum.finalAmount),
        totalOrders,
        totalCustomers,
        totalProducts,
        pendingOrders,
        deliveredOrders,
        todayOrders,
        cancelledOrders,
        refunds,
      },
      daily,
      byStatus,
      rangeDays: TREND_DAYS,
    });
  })
);

/* ---------- Image upload (Cloudinary) ---------- */

/* POST /api/admin/upload — multipart form field `image`. Returns the hosted
   URL. Storage backend is Cloudinary for now (swappable for S3 later). */
router.post(
  "/upload",
  asyncHandler(requireAdmin),
  singleImage,
  asyncHandler(async (req: Request, res: Response) => {
    if (!cloudinaryConfigured) {
      res.status(503).json({ error: "Image uploads are not configured on the server." });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No image provided." });
      return;
    }
    const folder = typeof req.body?.folder === "string" ? req.body.folder : undefined;
    const result = await uploadImage(req.file.buffer, folder);
    res.json({ url: result.url, publicId: result.publicId });
  })
);

/* ---------- Categories (flat list for product forms) ---------- */

/* GET /api/admin/categories — every category, flat, for the product dropdown. */
router.get(
  "/categories",
  asyncHandler(requireAdmin),
  asyncHandler(async (_req: Request, res: Response) => {
    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true, parentId: true },
    });
    res.json(categories);
  })
);

/* ---------- Homepage hero images ---------- */

const HERO_KEY = "hero";

/** Normalise the stored hero value into a flat list of override URLs. */
function readHeroImages(value: unknown): (string | null)[] {
  if (value && typeof value === "object" && Array.isArray((value as any).images)) {
    return (value as any).images.map((u: unknown) =>
      typeof u === "string" && u.trim() ? u.trim() : null
    );
  }
  return [];
}

/* PUT /api/admin/hero — set the per-slide hero background overrides.
   Body: { images: (string | null)[] } aligned to slide index. */
router.put(
  "/hero",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const raw = req.body?.images;
    if (!Array.isArray(raw)) {
      res.status(400).json({ error: "images must be an array." });
      return;
    }
    const images = raw
      .slice(0, 12)
      .map((u: unknown) => (typeof u === "string" && u.trim() ? u.trim() : null));

    await prisma.siteSetting.upsert({
      where: { key: HERO_KEY },
      create: { key: HERO_KEY, value: { images } },
      update: { value: { images } },
    });
    res.json({ images });
  })
);

/* ---------- Manual order (offline-first) config ---------- */

/* GET /api/admin/settings/manual-order — current config (defaults filled in). */
router.get(
  "/settings/manual-order",
  asyncHandler(requireAdmin),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await getManualOrderConfig());
  })
);

/* PUT /api/admin/settings/manual-order — edit WhatsApp number, UPI id, hours,
   and the customer notices. Body is partial; missing keys keep their defaults. */
router.put(
  "/settings/manual-order",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const config = normalizeManualOrderConfig(req.body ?? {});
    const value = { ...config } as Record<string, string>;
    await prisma.siteSetting.upsert({
      where: { key: MANUAL_ORDER_KEY },
      create: { key: MANUAL_ORDER_KEY, value },
      update: { value },
    });
    res.json(config);
  })
);

export default router;
