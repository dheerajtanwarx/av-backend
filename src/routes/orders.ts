import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, isEmail } from "../lib/http";
import { toNumber, inr } from "../lib/money";
import { requireAuth, optionalAuth, requireAdmin } from "../middleware/authMiddleware";
import { PaymentMethod, PaymentStatus, OrderStatus } from "../../generated/prisma/client";
import { buildInvoicePdf } from "../lib/invoice";
import { orderQrDataUrl } from "../lib/qr";
import { ACTIONS, emitEvent, emitStockAlerts, logActivity, notifyTx } from "../lib/notify";
import {
  ORDER_STATUS_FILTERS,
  PENDING_STATUSES,
  orderFilterWhere,
  startOfTodayIST,
} from "../lib/orderFilters";

const router = Router();

const PAYMENT_MAP: Record<string, PaymentMethod> = {
  upi: "UPI",
  card: "CARD",
  netbanking: "NETBANKING",
  cod: "COD",
  wallet: "WALLET",
};

const SHIPPING: Record<string, { fee: number; days: number }> = {
  standard: { fee: 0, days: 28 },
  priority: { fee: 1200, days: 18 },
};

const orderNo = (id: number) => "AVC-" + String(id).padStart(6, "0");

/** Parse a human order number ("AVC-000024" / "avc-24" / "24") back to its id. */
function parseOrderNo(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isInteger(n) && n > 0 ? n : null;
}

type IncomingItem = { slug?: string; color?: string; size?: string; qty?: number };

type ResolvedItem = {
  variantId: number;
  size: string | null;
  qty: number;
  unitPrice: number;
  stockQty: number;
  name: string;
  color: string;
};

/** Thrown inside the order transaction when a conditional stock decrement
    matches no row (someone else bought the last units mid-checkout). */
class OutOfStockError extends Error {
  variantId: number;
  constructor(variantId: number) {
    super("out of stock");
    this.variantId = variantId;
  }
}

/** Friendly 409 payload for one or more unavailable lines. */
function outOfStockResponse(
  res: Response,
  shortages: { name: string; color: string; available: number; requested: number }[]
) {
  const lines = shortages.map((s) =>
    s.available <= 0
      ? `${s.name} (${s.color}) is out of stock`
      : `only ${s.available} left of ${s.name} (${s.color}) — you asked for ${s.requested}`
  );
  res.status(409).json({
    error: `Some items in your bag are no longer available: ${lines.join("; ")}. Please update your bag and try again.`,
    code: "OUT_OF_STOCK",
    items: shortages,
  });
}

/* POST /api/orders/track — public order lookup by order number + email.
   No auth: the email acts as the shared secret. Matches against the buyer's
   account email (set for Google + guest checkouts). */
router.post(
  "/track",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseOrderNo(req.body?.orderNo);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!id || !isEmail(email)) {
      res.status(400).json({ error: "Enter a valid order ID and email." });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: { ...orderInclude, user: { select: { email: true } } },
    });
    if (!order || (order.user.email ?? "").toLowerCase() !== email) {
      res.status(404).json({ error: "No order found for that ID and email." });
      return;
    }
    res.json(serializeOrder(order));
  })
);

/* POST /api/orders — guest or authenticated checkout. */
router.post(
  "/",
  optionalAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const items: IncomingItem[] = Array.isArray(body.items) ? body.items : [];
    const address = body.address ?? {};
    const paymentId = String(body.payment ?? "").toLowerCase();
    const deliveryId = String(body.delivery ?? "standard").toLowerCase();
    const promoCode = body.promoCode
      ? String(body.promoCode).trim().toUpperCase()
      : null;

    if (items.length === 0) {
      res.status(400).json({ error: "Your bag is empty" });
      return;
    }
    const required = ["first", "last", "email", "phone", "address", "pin", "city", "state"];
    for (const f of required) {
      if (!address[f] || String(address[f]).trim() === "") {
        res.status(400).json({ error: `Missing address field: ${f}` });
        return;
      }
    }
    if (!isEmail(address.email)) {
      res.status(400).json({ error: "Enter a valid email" });
      return;
    }
    const method = PAYMENT_MAP[paymentId];
    if (!method) {
      res.status(400).json({ error: "Choose a valid payment method" });
      return;
    }
    const shipping = SHIPPING[deliveryId] ?? SHIPPING.standard;

    // Resolve each cart line to a concrete ProductVariant.
    const resolved: ResolvedItem[] = [];
    for (const it of items) {
      const qty = Math.max(1, Number(it.qty ?? 1));
      const product = await prisma.product.findUnique({
        where: { slug: String(it.slug ?? "") },
        include: { variants: { orderBy: { id: "asc" } } },
      });
      if (!product || product.variants.length === 0) {
        res.status(400).json({ error: `Unknown product: ${it.slug}` });
        return;
      }
      const variant =
        product.variants.find(
          (v) => v.color.toLowerCase() === String(it.color ?? "").toLowerCase()
        ) ?? product.variants[0];
      resolved.push({
        variantId: variant.id,
        size: it.size ?? null,
        qty,
        unitPrice: toNumber(variant.price),
        stockQty: variant.stockQty,
        name: product.name,
        color: variant.color,
      });
    }

    // Stock pre-check. Lines can share a variant (same colour, different
    // sizes), so demand is aggregated per variant before comparing. This is
    // a fast-fail courtesy read; the authoritative guard is the conditional
    // decrement inside the transaction below.
    const needByVariant = new Map<number, number>();
    for (const r of resolved) {
      needByVariant.set(r.variantId, (needByVariant.get(r.variantId) ?? 0) + r.qty);
    }
    const shortages = [...needByVariant.entries()]
      .map(([variantId, need]) => {
        const line = resolved.find((r: ResolvedItem) => r.variantId === variantId)!;
        return { name: line.name, color: line.color, available: line.stockQty, requested: need };
      })
      .filter((s) => s.requested > s.available);
    if (shortages.length > 0) {
      outOfStockResponse(res, shortages);
      return;
    }

    const subtotal = resolved.reduce((s, r) => s + r.unitPrice * r.qty, 0);

    // Promo discount (server-validated).
    let discount = 0;
    if (promoCode) {
      const promo = await prisma.promo.findUnique({ where: { code: promoCode } });
      const valid =
        promo &&
        promo.active &&
        (!promo.expiresAt || promo.expiresAt >= new Date()) &&
        (!promo.minSpend || subtotal >= toNumber(promo.minSpend));
      if (valid) discount = Math.round(subtotal * toNumber(promo.pct));
    }

    const finalAmount = subtotal - discount + shipping.fee;

    // Find-or-create the buyer (guest checkout auto-creates / links by email).
    let userId: number;
    if (req.currentUser) {
      userId = Number(req.currentUser.id);
    } else {
      const email = String(address.email).toLowerCase();
      const existing = await prisma.user.findUnique({ where: { email } });
      userId = existing
        ? existing.id
        : (
            await prisma.user.create({
              data: {
                email,
                name: `${address.first} ${address.last}`.trim(),
                phone: String(address.phone),
              },
            })
          ).id;
    }

    const paymentStatus: PaymentStatus = method === "COD" ? "PENDING" : "SUCCESS";

    let order;
    try {
      order = await notifyTx(async (tx) => {
        // Conditional decrement first: only matches while enough stock remains,
        // so two concurrent checkouts can't both take the last unit and the
        // quantity can never go negative. Zero rows matched → roll back.
        for (const [variantId, need] of needByVariant) {
          const updated = await tx.productVariant.updateMany({
            where: { id: variantId, stockQty: { gte: need } },
            data: { stockQty: { decrement: need } },
          });
          if (updated.count === 0) throw new OutOfStockError(variantId);
        }

        // Reuse the buyer's existing saved address when the checkout details
        // match one exactly, instead of inserting a fresh row every order.
        // Without this, each checkout left a duplicate entry that piled up in
        // the profile address book.
        const addrData = {
          userId,
          fullName: `${address.first} ${address.last}`.trim(),
          phone: String(address.phone),
          street: String(address.address),
          city: String(address.city),
          state: String(address.state),
          pincode: String(address.pin),
        };
        const addr =
          (await tx.address.findFirst({ where: addrData })) ??
          (await tx.address.create({ data: addrData }));

        const created = await tx.order.create({
            data: {
              userId,
              addressId: addr.id,
              totalAmount: subtotal,
              discount,
              finalAmount,
              shippingMethod: deliveryId,
              shippingFee: shipping.fee,
              status: "PLACED",
              items: {
                create: resolved.map((r: ResolvedItem) => ({
                  variantId: r.variantId,
                  size: r.size,
                  quantity: r.qty,
                  unitPrice: r.unitPrice,
                  totalPrice: r.unitPrice * r.qty,
                })),
              },
              payments: {
                create: {
                  method,
                  status: paymentStatus,
                  amount: finalAmount,
                  gateway: "mock",
                  paidAt: paymentStatus === "SUCCESS" ? new Date() : null,
                },
              },
            },
        });

        // Clear the purchased lines from the user's server cart. This runs inside
        // the same transaction as the order creation so cart cleanup and order
        // creation are atomic: either both happen or neither does. The server
        // cart (cart_items, keyed by userId) is the source of truth that GET
        // /api/cart and the login-merge read from, so without this the cart
        // repopulates on the next refresh/login. Scoped to the ordered variants
        // so items added on another device mid-checkout aren't wiped.
        await tx.cartItem.deleteMany({
          where: { userId, variantId: { in: resolved.map((r) => r.variantId) } },
        });

        // Admin notification + audit log join the checkout transaction, so an
        // order can never exist without its trail. Payment is folded into the
        // NEW_ORDER notification (mock payments settle at checkout — they are
        // not a separate event).
        const customerName = `${address.first} ${address.last}`.trim();
        const itemCount = resolved.reduce((s, r) => s + r.qty, 0);
        await emitEvent(
          tx,
          {
            type: "NEW_ORDER",
            title: `New order ${orderNo(created.id)} — ${inr(finalAmount)} via ${method}`,
            body: `${customerName} ordered ${resolved
              .map((r) => `${r.name} (${r.color}) ×${r.qty}`)
              .join(", ")}. Payment ${paymentStatus === "SUCCESS" ? "captured" : "pending (COD)"}.`,
            orderId: created.id,
            meta: {
              orderNo: orderNo(created.id),
              total: finalAmount,
              customerName,
              customerEmail: String(address.email).toLowerCase(),
              itemCount,
              placedAt: created.placedAt.toISOString(),
              payment: { method, status: paymentStatus },
              items: resolved.map((r) => ({
                name: r.name,
                color: r.color,
                size: r.size,
                qty: r.qty,
              })),
            },
          },
          {
            action: ACTIONS.ORDER_PLACED,
            actorType: "CUSTOMER",
            actorId: userId,
            entityType: "order",
            entityId: created.id,
            meta: { total: finalAmount, payment: method, guest: !req.currentUser },
            req,
          }
        );

        // Raise SYSTEM_ALERTs for variants this purchase pushed to zero / low.
        await emitStockAlerts(
          tx,
          undefined,
          [...needByVariant.entries()].map(([variantId, qty]) => ({ variantId, qty }))
        );

        return created;
      });
    } catch (err) {
      if (err instanceof OutOfStockError) {
        const variant = await prisma.productVariant.findUnique({
          where: { id: err.variantId },
          include: { product: { select: { name: true } } },
        });
        outOfStockResponse(res, [
          {
            name: variant?.product.name ?? "An item",
            color: variant?.color ?? "",
            available: Math.max(0, variant?.stockQty ?? 0),
            requested: needByVariant.get(err.variantId) ?? 0,
          },
        ]);
        return;
      }
      throw err;
    }

    const etaDate = new Date(Date.now() + shipping.days * 86_400_000);
    const eta = etaDate.toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

    res.status(201).json({
      no: orderNo(order.id),
      id: order.id,
      eta,
      etaWindow: deliveryId === "priority" ? "2–3 weeks" : "3–4 weeks",
      subtotal,
      discount,
      shippingFee: shipping.fee,
      total: finalAmount,
      status: order.status,
    });
  })
);

const RETURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Derive the customer-facing refund state from the payment rows — no extra
    schema column needed. A refund is only ever owed once an order is
    CANCELLED/RETURNED and money was actually captured:
      • a still-captured payment (SUCCESS) ⇒ refund PENDING (owed, not yet paid)
      • a REFUNDED payment                  ⇒ refund COMPLETED
      • COD / never-captured                ⇒ null (nothing to refund)
    The admin's "mark refund completed" action flips SUCCESS → REFUNDED, which
    is exactly what moves this from PENDING to COMPLETED for the customer. */
function refundInfo(o: any) {
  if (o.status !== "CANCELLED" && o.status !== "RETURNED") return null;
  const payments = o.payments ?? [];
  const method = payments[0]?.method ?? null;
  if (payments.some((p: any) => p.status === "REFUNDED"))
    return { status: "COMPLETED", amount: toNumber(o.finalAmount), method };
  if (payments.some((p: any) => p.status === "SUCCESS"))
    return { status: "PENDING", amount: toNumber(o.finalAmount), method };
  return null;
}

/* Shape an order row for the read endpoints. */
function serializeOrder(o: any) {
  const returnEligibleUntil =
    o.status === "DELIVERED"
      ? new Date(new Date(o.updatedAt).getTime() + RETURN_WINDOW_MS).toISOString()
      : null;

  return {
    no: orderNo(o.id),
    id: o.id,
    status: o.status,
    placedAt: o.placedAt,
    returnEligibleUntil,
    refund: refundInfo(o),
    subtotal: toNumber(o.totalAmount),
    discount: toNumber(o.discount),
    shippingFee: toNumber(o.shippingFee),
    total: toNumber(o.finalAmount),
    shippingMethod: o.shippingMethod,
    trackingNumber: o.trackingNumber,
    address: o.address,
    payment: o.payments?.[0]?.method ?? null,
    items: (o.items ?? []).map((it: any) => ({
      productId: it.variant.product.id,
      name: it.variant.product.name,
      slug: it.variant.product.slug,
      color: it.variant.color,
      size: it.size,
      qty: it.quantity,
      unitPrice: toNumber(it.unitPrice),
      price: inr(toNumber(it.unitPrice)),
      image: it.variant.product.images?.[0]?.imageUrl ?? "",
    })),
  };
}

const orderInclude = {
  address: true,
  payments: true,
  items: {
    include: {
      variant: {
        include: {
          product: {
            include: {
              images: { select: { imageUrl: true }, orderBy: { sortOrder: "asc" as const }, take: 1 },
            },
          },
        },
      },
    },
  },
};

/* GET /api/orders — the signed-in user's orders. */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = Number(req.currentUser!.id);
    const orders = await prisma.order.findMany({
      where: { userId },
      include: orderInclude,
      orderBy: { placedAt: "desc" },
    });
    res.json(orders.map(serializeOrder));
  })
);

/* ============================================================
   Admin order management (ADMIN role only)
   ------------------------------------------------------------
   These routes are registered BEFORE the generic "/:id" handler
   so "/admin" isn't swallowed as an order id.
   ============================================================ */

/** The forward fulfilment path an admin drives an order along. */
const ADMIN_STATUS_FLOW: OrderStatus[] = ["PLACED", "PROCESSING", "SHIPPED", "DELIVERED"];

/** Canonical ordering used to reject backward / sideways transitions.
    CONFIRMED is ranked between PLACED and PROCESSING so an order parked in
    CONFIRMED (e.g. from the legacy flow) can still be moved forward. */
const STATUS_RANK: Record<string, number> = {
  PLACED: 0,
  CONFIRMED: 1,
  PROCESSING: 2,
  SHIPPED: 3,
  DELIVERED: 4,
};

/** Detail include: everything serializeOrder needs + the customer record. */
const adminOrderInclude = {
  ...orderInclude,
  user: { select: { id: true, name: true, email: true, phone: true } },
};

/** Detail payload = the shared order shape + customer block. */
function serializeAdminOrder(o: any) {
  return {
    ...serializeOrder(o),
    customer: {
      id: o.user?.id ?? null,
      name: o.user?.name ?? o.address?.fullName ?? null,
      email: o.user?.email ?? null,
      phone: o.user?.phone ?? o.address?.phone ?? null,
    },
  };
}

/* GET /api/orders/admin — paginated order list with search + status filter.
   Query: q (order no / customer name / email), status (a single OrderStatus,
   the derived `pending` / `today` / `refunded` filters, or "all"), page
   (1-based), pageSize. Returns rows + pagination + per-filter counts for the
   chips (counts honour the search but not the active filter). */
router.get(
  "/admin",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    // Resolve the requested filter (status / pending / today / refunded) to a
    // shared where-fragment; null means "all" (no extra constraint).
    const filterWhere = orderFilterWhere(String(req.query.status ?? "all"));

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10));

    // Search filter (applied to both the list and the chip counts).
    const searchWhere: any = {};
    if (q) {
      const idMatch = parseOrderNo(q);
      searchWhere.OR = [
        { user: { name: { contains: q } } },
        { user: { email: { contains: q } } },
        ...(idMatch ? [{ id: idMatch }] : []),
      ];
    }

    const where = filterWhere ? { ...searchWhere, ...filterWhere } : searchWhere;

    const [total, rows, grouped, todayCount, refundedCount] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { placedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { name: true, email: true } },
          payments: { select: { method: true }, take: 1, orderBy: { id: "asc" } },
          _count: { select: { items: true } },
        },
      }),
      prisma.order.groupBy({
        by: ["status"],
        where: searchWhere,
        _count: { _all: true },
      }),
      prisma.order.count({ where: { ...searchWhere, placedAt: { gte: startOfTodayIST() } } }),
      prisma.order.count({
        where: { ...searchWhere, payments: { some: { status: "REFUNDED" } } },
      }),
    ]);

    const counts: Record<string, number> = { all: 0 };
    for (const f of ORDER_STATUS_FILTERS) counts[f] = 0;
    for (const g of grouped) {
      counts[g.status] = g._count._all;
      counts.all += g._count._all;
    }
    // Derived chip counts: pending is the sum of its statuses (no extra query);
    // today and refunded come from their own count queries above.
    counts.pending = PENDING_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
    counts.today = todayCount;
    counts.refunded = refundedCount;

    res.json({
      orders: rows.map((o) => ({
        id: o.id,
        no: orderNo(o.id),
        customer: {
          name: o.user?.name || "Guest",
          email: o.user?.email ?? null,
        },
        placedAt: o.placedAt,
        total: toNumber(o.finalAmount),
        payment: o.payments[0]?.method ?? null,
        status: o.status,
        itemCount: o._count.items,
      })),
      counts,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  })
);

/* GET /api/orders/admin/lookup?code=AVC-000024 — resolve a scanned packing-slip
   QR (or a typed order number) to its order id, so the admin scan page can jump
   straight to the order. The QR carries only the order number — no token, no
   auth — so this stays behind requireAdmin like every other admin route.
   Registered before "/admin/:id" so "lookup" isn't read as an order id. */
router.get(
  "/admin/lookup",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseOrderNo(req.query.code);
    if (!id) {
      res.status(400).json({ error: "Unrecognised order code" });
      return;
    }
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (!order) {
      res.status(404).json({ error: `No order found for ${String(req.query.code)}` });
      return;
    }
    res.json({ id: order.id, no: orderNo(order.id) });
  })
);

/* GET /api/orders/admin/:id — full order detail for the admin (any owner). */
router.get(
  "/admin/:id",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: adminOrderInclude,
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const payload = serializeAdminOrder(order);
    // Pack/dispatch QR for the order — rendered on the order page and printed on
    // the packing slip so the same code can be scanned back in at dispatch.
    res.json({ ...payload, qr: await orderQrDataUrl(payload.no) });
  })
);

/* PATCH /api/orders/admin/:id/status — drive the fulfilment workflow forward
   (PLACED → PROCESSING → SHIPPED → DELIVERED). Forward-only: a request to move
   to the current/an earlier status, or to touch a CANCELLED/RETURNED order, is
   rejected. The transition is status-guarded so two concurrent updates can't
   race. Persisted to the orders table. */
router.patch(
  "/admin/:id/status",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }

    const target = String(req.body?.status ?? "").toUpperCase();
    if (!ADMIN_STATUS_FLOW.includes(target as OrderStatus)) {
      res.status(400).json({
        error: "status must be one of PLACED, PROCESSING, SHIPPED, DELIVERED",
      });
      return;
    }

    // Optional courier tracking number, typically supplied alongside the move to
    // SHIPPED (the dedicated /tracking route handles it arriving later).
    const trackingRaw = req.body?.trackingNumber;
    const trackingNumber =
      typeof trackingRaw === "string" && trackingRaw.trim()
        ? trackingRaw.trim().slice(0, 100)
        : null;

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.status === "CANCELLED" || order.status === "RETURNED") {
      res.status(400).json({
        error: `A ${order.status.toLowerCase()} order can no longer be updated.`,
      });
      return;
    }

    const currentRank = STATUS_RANK[order.status] ?? 0;
    const targetRank = STATUS_RANK[target];
    if (targetRank <= currentRank) {
      res.status(400).json({
        error: `Order is already ${order.status}. Status can only move forward.`,
      });
      return;
    }

    // Status-guarded transition: only updates while the row still holds the
    // status we read, so a concurrent update can't be silently overwritten.
    // Notification + audit log share the transaction with the transition.
    const transitioned = await notifyTx(async (tx) => {
      const t = await tx.order.updateMany({
        where: { id, status: order.status },
        data: { status: target as OrderStatus, ...(trackingNumber ? { trackingNumber } : {}) },
      });
      if (t.count === 0) return false;

      // SHIPPED/DELIVERED are logistics news (DELIVERY_UPDATE); the rest of
      // the flow is fulfilment news (ORDER_STATUS_CHANGE).
      const isDelivery = target === "SHIPPED" || target === "DELIVERED";
      await emitEvent(
        tx,
        {
          type: isDelivery ? "DELIVERY_UPDATE" : "ORDER_STATUS_CHANGE",
          title: `Order ${orderNo(id)} ${target.toLowerCase()}`,
          body: `Order ${orderNo(id)} moved from ${order.status} to ${target}.`,
          orderId: id,
          meta: { from: order.status, to: target },
        },
        {
          action: ACTIONS.ORDER_STATUS_CHANGED,
          actorType: "ADMIN",
          actorId: Number(req.currentUser!.id),
          entityType: "order",
          entityId: id,
          meta: { from: order.status, to: target },
          req,
        }
      );
      return true;
    });
    if (!transitioned) {
      res.status(409).json({ error: "Order was updated by someone else. Please reload." });
      return;
    }

    const updated = await prisma.order.findUnique({
      where: { id },
      include: adminOrderInclude,
    });
    res.json(serializeAdminOrder(updated));
  })
);

/* PATCH /api/orders/admin/:id/tracking — set / update / clear the courier
   tracking number. Optional and decoupled from status: the number usually
   arrives from the courier after the order is already marked SHIPPED. Pass an
   empty string to clear it. Audit-logged; emits a DELIVERY_UPDATE so the trail
   matches the rest of the fulfilment flow. */
router.patch(
  "/admin/:id/tracking",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const raw = req.body?.trackingNumber;
    if (typeof raw !== "string") {
      res.status(400).json({ error: "trackingNumber is required" });
      return;
    }
    const trackingNumber = raw.trim().slice(0, 100) || null;

    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, trackingNumber: true },
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    await notifyTx(async (tx) => {
      await tx.order.update({ where: { id }, data: { trackingNumber } });
      await emitEvent(
        tx,
        {
          type: "DELIVERY_UPDATE",
          title: trackingNumber
            ? `Tracking added for order ${orderNo(id)}`
            : `Tracking cleared for order ${orderNo(id)}`,
          body: trackingNumber
            ? `Order ${orderNo(id)} tracking number set to ${trackingNumber}.`
            : `Order ${orderNo(id)} tracking number was cleared.`,
          orderId: id,
          meta: { trackingNumber },
        },
        {
          action: ACTIONS.ORDER_TRACKING_UPDATED,
          actorType: "ADMIN",
          actorId: Number(req.currentUser!.id),
          entityType: "order",
          entityId: id,
          meta: { from: order.trackingNumber, to: trackingNumber },
          req,
        }
      );
    });

    const updated = await prisma.order.findUnique({
      where: { id },
      include: adminOrderInclude,
    });
    const payload = serializeAdminOrder(updated);
    res.json({ ...payload, qr: await orderQrDataUrl(payload.no) });
  })
);

/* GET /api/orders/admin/:id/invoice — invoice/order-summary PDF for any
   order, any status (the customer-facing route is ownership-checked and
   DELIVERED-only; admins print from the notification center / order page). */
router.get(
  "/admin/:id/invoice",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: { ...orderInclude, user: { select: { name: true, email: true } } },
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const serialized = serializeOrder(order);
    const pdf = await buildInvoicePdf({
      ...serialized,
      customer: { name: order.user?.name ?? null, email: order.user?.email ?? null },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Invoice-${serialized.no}.pdf"`);
    res.send(pdf);
  })
);

/* PATCH /api/orders/admin/:id/notes — append a timestamped internal note to
   the order. Notes are admin-facing only (order.notes), audit-logged, no
   customer notification. */
router.patch(
  "/admin/:id/notes",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const note = String(req.body?.note ?? "").trim().slice(0, 1000);
    if (!note) {
      res.status(400).json({ error: "note is required" });
      return;
    }
    const order = await prisma.order.findUnique({ where: { id }, select: { notes: true } });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    const stamp = new Date().toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    });
    const entry = `[${stamp} · ${req.currentUser!.email ?? "admin"}] ${note}`;
    const notes = order.notes ? `${order.notes}\n${entry}` : entry;

    const updated = await notifyTx(async (tx) => {
      const row = await tx.order.update({ where: { id }, data: { notes } });
      await logActivity(tx, {
        action: ACTIONS.ORDER_NOTE_ADDED,
        actorType: "ADMIN",
        actorId: Number(req.currentUser!.id),
        entityType: "order",
        entityId: id,
        meta: { note },
        req,
      });
      return row;
    });
    res.json({ id, notes: updated.notes });
  })
);

/* POST /api/orders/admin/:id/refund — flip any still-captured payment on a
   cancelled/returned order to REFUNDED (mock gateway — no real money moves).
   Idempotent: cancel/return already auto-refund captured payments, so this
   usually reports there was nothing left to do. First real trigger for the
   REFUND_COMPLETED notification type. */
router.post(
  "/admin/:id/refund",
  asyncHandler(requireAdmin),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: { select: { name: true } }, address: { select: { fullName: true } } },
    });
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.status !== "CANCELLED" && order.status !== "RETURNED") {
      res.status(400).json({ error: "Refunds apply to cancelled or returned orders only" });
      return;
    }

    const refunded: number = await notifyTx(async (tx) => {
      const flipped = await tx.payment.updateMany({
        where: { orderId: id, status: "SUCCESS" },
        data: { status: "REFUNDED" },
      });
      if (flipped.count === 0) return 0;

      const customerName = order.user?.name ?? order.address?.fullName ?? "Customer";
      const total = toNumber(order.finalAmount);
      await emitEvent(
        tx,
        {
          type: "REFUND_COMPLETED",
          title: `Refund completed for order ${orderNo(id)}`,
          body: `${inr(total)} marked refunded to ${customerName} for ${order.status.toLowerCase()} order ${orderNo(id)}.`,
          orderId: id,
          meta: { orderNo: orderNo(id), total, customerName },
        },
        {
          action: ACTIONS.ORDER_REFUND_PROCESSED,
          actorType: "ADMIN",
          actorId: Number(req.currentUser!.id),
          entityType: "order",
          entityId: id,
          meta: { amount: total },
          req,
        }
      );
      return flipped.count;
    });

    const updated = await prisma.order.findUnique({
      where: { id },
      include: adminOrderInclude,
    });
    res.json({
      refunded,
      message:
        refunded > 0
          ? "Refund marked completed — the customer now sees it as refunded."
          : "No captured payment left to refund.",
      order: updated ? serializeAdminOrder(updated) : null,
    });
  })
);

/* GET /api/orders/:id — a single order (ownership-checked). */
router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: orderInclude,
    });
    if (!order || order.userId !== Number(req.currentUser!.id)) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.json(serializeOrder(order));
  })
);

/* GET /api/orders/:id/invoice — downloadable PDF invoice for a delivered order
   (ownership-checked). An invoice is only issued once the order is DELIVERED. */
router.get(
  "/:id/invoice",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: { ...orderInclude, user: { select: { name: true, email: true } } },
    });
    if (!order || order.userId !== Number(req.currentUser!.id)) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.status !== "DELIVERED") {
      res.status(400).json({ error: "An invoice is available once your order is delivered." });
      return;
    }

    const serialized = serializeOrder(order);
    const pdf = await buildInvoicePdf({
      ...serialized,
      customer: { name: order.user?.name ?? null, email: order.user?.email ?? null },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="Invoice-${serialized.no}.pdf"`);
    res.send(pdf);
  })
);

/* PATCH /api/orders/:id/cancel — cancel if still PLACED or CONFIRMED */
router.patch(
  "/:id/cancel",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        user: { select: { name: true, email: true, phone: true } },
        address: { select: { fullName: true, phone: true } },
        payments: { orderBy: { id: "asc" } },
      },
    });
    if (!order || order.userId !== Number(req.currentUser!.id)) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (!["PLACED", "CONFIRMED"].includes(order.status)) {
      res.status(400).json({ error: "This order can no longer be cancelled" });
      return;
    }
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 500) : null;
    const updated = await notifyTx(async (tx) => {
      // Status-guarded transition: a concurrent cancel (double click, second
      // tab) matches zero rows on the second attempt, so the stock below is
      // restored exactly once.
      const transitioned = await tx.order.updateMany({
        where: { id, status: { in: ["PLACED", "CONFIRMED"] } },
        data: { status: "CANCELLED", ...(reason ? { notes: reason } : {}) },
      });
      if (transitioned.count === 0) return null;

      for (const it of order.items) {
        await tx.productVariant.update({
          where: { id: it.variantId },
          data: { stockQty: { increment: it.quantity } },
        });
      }

      const customerName = order.user?.name ?? order.address?.fullName ?? "Customer";
      const total = toNumber(order.finalAmount);
      const payment = order.payments[0] ?? null;
      const paymentStatus = payment?.status ?? null;
      // A captured (paid) payment leaves a refund owed to the customer. We do
      // NOT auto-refund here: the refund stays PENDING and the customer is shown
      // a reassurance that their money is on its way. An admin completes it from
      // the order page (POST /admin/:id/refund), which flips the payment to
      // REFUNDED and moves the customer's status to COMPLETED. COD / unpaid
      // orders have no money to return.
      const refundOwed = paymentStatus === "SUCCESS";
      const refundStatus = refundOwed ? "PENDING" : "NOT_REQUIRED";

      await emitEvent(
        tx,
        {
          type: "ORDER_CANCELLED",
          // Cancellations surface as critical (red) in the admin UI.
          priority: "CRITICAL",
          title: `Order ${orderNo(id)} cancelled by customer`,
          body: `${customerName} cancelled order ${orderNo(id)} (${inr(total)}) while ${order.status}${
            reason ? ` — "${reason}"` : ""
          }. Payment: ${paymentStatus ?? "none"}. Refund: ${refundStatus}${
            refundOwed ? " — awaiting admin to process" : ""
          }. Stock restored.`,
          orderId: id,
          meta: {
            orderNo: orderNo(id),
            previousStatus: order.status,
            total,
            customerName,
            customerEmail: order.user?.email ?? null,
            customerPhone: order.user?.phone ?? order.address?.phone ?? null,
            reason,
            cancelledAt: new Date().toISOString(),
            paymentMethod: payment?.method ?? null,
            paymentStatus,
            refundStatus,
          },
        },
        {
          action: ACTIONS.ORDER_CANCELLED,
          actorType: "CUSTOMER",
          actorId: order.userId,
          entityType: "order",
          entityId: id,
          meta: {
            previousStatus: order.status,
            reason,
            refundOwed,
          },
          req,
        }
      );

      return tx.order.findUnique({ where: { id }, include: orderInclude });
    });
    if (!updated) {
      res.status(400).json({ error: "This order can no longer be cancelled" });
      return;
    }
    res.json(serializeOrder(updated));
  })
);

/* PATCH /api/orders/:id/return — request a return within 7 days of delivery */
router.patch(
  "/:id/return",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true, payments: { orderBy: { id: "asc" } } },
    });
    if (!order || order.userId !== Number(req.currentUser!.id)) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    if (order.status !== "DELIVERED") {
      res.status(400).json({ error: "Only delivered orders can be returned" });
      return;
    }
    const deadline = new Date(new Date(order.updatedAt).getTime() + RETURN_WINDOW_MS);
    if (new Date() > deadline) {
      res.status(400).json({ error: "Return window has closed. Returns must be requested within 7 days of delivery." });
      return;
    }
    const reason = req.body?.reason ? String(req.body.reason) : null;
    const updated = await notifyTx(async (tx) => {
      // Status-guarded transition (same pattern as cancel) so a double-submitted
      // return can't restock the items twice.
      const transitioned = await tx.order.updateMany({
        where: { id, status: "DELIVERED" },
        data: { status: "RETURNED", notes: reason ?? order.notes },
      });
      if (transitioned.count === 0) return null;

      for (const it of order.items) {
        await tx.productVariant.update({
          where: { id: it.variantId },
          data: { stockQty: { increment: it.quantity } },
        });
      }
      // No auto-refund: a captured payment leaves a refund PENDING (owed to the
      // customer) until an admin completes it from the order page. COD / unpaid
      // returns have no money to send back.
      const refundOwed = order.payments.some((p) => p.status === "SUCCESS");

      // RETURNED rides the ORDER_STATUS_CHANGE type but at HIGH priority —
      // money is going back.
      await emitEvent(
        tx,
        {
          type: "ORDER_STATUS_CHANGE",
          priority: "HIGH",
          title: `Return requested for order ${orderNo(id)}`,
          body: `Order ${orderNo(id)} (${inr(toNumber(order.finalAmount))}) was returned${
            reason ? ` — "${reason}"` : ""
          }. Stock restored${refundOwed ? "; refund pending — awaiting admin to process" : ""}.`,
          orderId: id,
          meta: {
            from: "DELIVERED",
            to: "RETURNED",
            reason,
            refundOwed,
            refundStatus: refundOwed ? "PENDING" : "NOT_REQUIRED",
          },
        },
        {
          action: ACTIONS.ORDER_RETURNED,
          actorType: "CUSTOMER",
          actorId: order.userId,
          entityType: "order",
          entityId: id,
          meta: { reason, refundOwed },
          req,
        }
      );

      return tx.order.findUnique({ where: { id }, include: orderInclude });
    });
    if (!updated) {
      res.status(400).json({ error: "This order has already been returned" });
      return;
    }
    res.json(serializeOrder(updated));
  })
);

/* PATCH /api/orders/:id/advance — DEV ONLY. Moves an order one step along the
   fulfilment path (PLACED → CONFIRMED → PROCESSING → SHIPPED → DELIVERED) so the
   return + review flows (which require a DELIVERED order) can be tested end-to-end
   without an admin panel. Disabled in production. */
const FULFILMENT_FLOW = ["PLACED", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED"];

router.patch(
  "/:id/advance",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "Not available" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid order id" });
      return;
    }
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.userId !== Number(req.currentUser!.id)) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const idx = FULFILMENT_FLOW.indexOf(order.status);
    if (idx === -1 || idx === FULFILMENT_FLOW.length - 1) {
      res.status(400).json({ error: `Order can't be advanced from ${order.status}` });
      return;
    }
    const next = FULFILMENT_FLOW[idx + 1] as typeof order.status;
    // Dev-only shortcut, but it still mutates the shared database — so it
    // emits and logs exactly like the real admin transition, flagged dev:true.
    const updated = await notifyTx(async (tx) => {
      const row = await tx.order.update({
        where: { id },
        data: { status: next },
        include: orderInclude,
      });
      const isDelivery = next === "SHIPPED" || next === "DELIVERED";
      await emitEvent(
        tx,
        {
          type: isDelivery ? "DELIVERY_UPDATE" : "ORDER_STATUS_CHANGE",
          title: `Order ${orderNo(id)} ${next.toLowerCase()} (dev advance)`,
          body: `Order ${orderNo(id)} moved from ${order.status} to ${next} via the dev advance endpoint.`,
          orderId: id,
          meta: { from: order.status, to: next, dev: true },
        },
        {
          action: ACTIONS.ORDER_STATUS_CHANGED,
          actorType: "CUSTOMER",
          actorId: order.userId,
          entityType: "order",
          entityId: id,
          meta: { from: order.status, to: next, dev: true },
          req,
        }
      );
      return row;
    });
    res.json(serializeOrder(updated));
  })
);

export default router;
