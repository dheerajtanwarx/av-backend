import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/http";
import { toNumber, inr } from "../lib/money";
import { requireAuth, requireAdmin } from "../middleware/authMiddleware";
import { OrderRequestStatus } from "../../generated/prisma/client";
import { ACTIONS, emitEvent, emitStockAlerts, notifyTx } from "../lib/notify";
import { getManualOrderConfig, waLink } from "../lib/manualOrder";
import { publishCommerceEvent } from "../analytics/ingest";

/* Offline-First Manual Order Approval — request lifecycle.

   A request never reserves or decrements stock. The offline store always has
   priority. Stock is only taken on the PAID -> CONFIRMED step, which also spawns
   a real fulfilment Order so invoices / tracking / QR keep working unchanged. */

const reqNo = (id: number) => "REQ-" + String(id).padStart(6, "0");

/** Parse a human request number ("REQ-000012" / "req-12" / "12") to its id. */
function parseReqNo(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const digits = String(raw).replace(/\D/g, "");
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
  slug: string;
};

/** Resolve raw cart/PDP lines to concrete variants with a price snapshot.
    Returns a string error message instead of throwing for caller-friendly 400s. */
async function resolveItems(
  items: IncomingItem[]
): Promise<{ resolved: ResolvedItem[] } | { error: string }> {
  const resolved: ResolvedItem[] = [];
  for (const it of items) {
    const qty = Math.max(1, Number(it.qty ?? 1));
    const product = await prisma.product.findUnique({
      where: { slug: String(it.slug ?? "") },
      include: { variants: { orderBy: { id: "asc" } } },
    });
    if (!product || product.variants.length === 0) {
      return { error: `Unknown product: ${it.slug}` };
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
      slug: product.slug,
    });
  }
  return { resolved };
}

/** Human, customer-facing label for each status. */
const STATUS_LABEL: Record<OrderRequestStatus, string> = {
  PENDING_APPROVAL: "Pending Admin Approval",
  APPROVED: "Approved (Waiting for Payment)",
  PAYMENT_SUBMITTED: "Payment Submitted",
  PAID: "Paid",
  CONFIRMED: "Confirmed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

const requestInclude = {
  items: {
    include: {
      // Resolve the live product for a thumbnail + admin deep-link. The
      // name/colour shown to users still come from the snapshots, so a renamed
      // or removed product never corrupts an existing request.
      variant: {
        select: {
          id: true,
          product: {
            select: {
              id: true,
              slug: true,
              images: {
                select: { imageUrl: true },
                orderBy: { sortOrder: "asc" as const },
                take: 1,
              },
            },
          },
        },
      },
    },
  },
  address: true,
  user: { select: { id: true, name: true, email: true, phone: true } },
  order: { select: { id: true, status: true } },
};

/** Shape a request row for the API. `forAdmin` adds internal fields. */
function serializeRequest(r: any, forAdmin = false) {
  const base = {
    no: reqNo(r.id),
    id: r.id,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status as OrderRequestStatus],
    total: toNumber(r.totalAmount),
    totalDisplay: inr(toNumber(r.totalAmount)),
    upiId: r.upiIdSnapshot,
    paymentRef: r.paymentRef,
    paymentProofUrl: r.paymentProofUrl,
    customerNote: r.customerNote,
    rejectionReason: r.rejectionReason,
    orderNo: r.orderId ? "AVC-" + String(r.orderId).padStart(6, "0") : null,
    createdAt: r.createdAt,
    approvedAt: r.approvedAt,
    paidAt: r.paidAt,
    confirmedAt: r.confirmedAt,
    address: r.address ?? null,
    items: (r.items ?? []).map((it: any) => ({
      name: it.nameSnapshot,
      color: it.colorSnapshot,
      size: it.size,
      qty: it.quantity,
      unitPrice: toNumber(it.unitPrice),
      price: inr(toNumber(it.unitPrice)),
      lineTotal: toNumber(it.totalPrice),
      productId: it.variant?.product?.id ?? null,
      slug: it.variant?.product?.slug ?? null,
      image: it.variant?.product?.images?.[0]?.imageUrl ?? null,
    })),
  };
  if (!forAdmin) return base;
  return {
    ...base,
    adminNote: r.adminNote,
    customer: r.user
      ? { id: r.user.id, name: r.user.name, email: r.user.email, phone: r.user.phone }
      : null,
  };
}

/** Build the prefilled WhatsApp message a customer sends to request an order.
    Each line carries the storefront product link so the admin can open and
    verify the exact product straight from WhatsApp. */
function buildRequestMessage(
  r: { id: number; items: ResolvedItem[]; total: number },
  customer: { name: string | null; phone: string | null },
  storefrontUrl: string
): string {
  const base = storefrontUrl.replace(/\/+$/, "");
  const lines = r.items
    .map((it) => {
      const head = `• ${it.name} (${it.color})${it.size ? ` — ${it.size}` : ""} ×${it.qty}`;
      const link = it.slug ? `\n  ${base}/product/${it.slug}` : "";
      return head + link;
    })
    .join("\n");
  return [
    "Hi AV Creation 👋",
    "I'd like to request this order:",
    "",
    `Order Ref: ${reqNo(r.id)}`,
    "Items:",
    lines,
    `Indicative total: ${inr(r.total)}`,
    "",
    customer.name ? `Name: ${customer.name}` : "",
    customer.phone ? `Phone: ${customer.phone}` : "",
    "",
    "I understand stock isn't reserved until you confirm availability.",
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n");
}

/** Build the prefilled WhatsApp message an admin sends with payment instructions. */
function buildPaymentMessage(
  r: { id: number; total: number },
  cfg: { upiId: string; upiName: string }
): string {
  return [
    `Your order ${reqNo(r.id)} is approved ✅`,
    "",
    "Please pay manually using any UPI app (PhonePe / Google Pay / Paytm):",
    `UPI ID: ${cfg.upiId}`,
    `Name: ${cfg.upiName}`,
    `Amount: ${inr(r.total)}`,
    `Reference: ${reqNo(r.id)}`,
    "",
    "After paying, reply here with the transaction ID or a screenshot so we can verify and confirm your order.",
  ].join("\n");
}

/* ============================ CUSTOMER ROUTER ============================ */

export const orderRequestsRouter = Router();

/* POST /api/order-requests — create a request from cart/PDP lines.
   Never touches stock. Returns the request plus a wa.me link to send. */
orderRequestsRouter.post(
  "/",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const items: IncomingItem[] = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      res.status(400).json({ error: "Your bag is empty" });
      return;
    }
    const userId = Number(req.currentUser!.id);
    const customerNote =
      typeof body.customerNote === "string" ? body.customerNote.slice(0, 1000) : null;

    const resolution = await resolveItems(items);
    if ("error" in resolution) {
      res.status(400).json({ error: resolution.error });
      return;
    }
    const { resolved } = resolution;
    const total = resolved.reduce((s, r) => s + r.unitPrice * r.qty, 0);

    // Optional address: reuse one the customer passed, else their default/first.
    let addressId: number | null = null;
    if (body.addressId) {
      const addr = await prisma.address.findFirst({
        where: { id: Number(body.addressId), userId },
        select: { id: true },
      });
      addressId = addr?.id ?? null;
    } else {
      const addr = await prisma.address.findFirst({
        where: { userId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      addressId = addr?.id ?? null;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, phone: true, email: true },
    });

    const created = await notifyTx(async (tx) => {
      const request = await tx.orderRequest.create({
        data: {
          userId,
          addressId,
          status: "PENDING_APPROVAL",
          totalAmount: total,
          customerNote,
          items: {
            create: resolved.map((r) => ({
              variantId: r.variantId,
              size: r.size,
              quantity: r.qty,
              unitPrice: r.unitPrice,
              totalPrice: r.unitPrice * r.qty,
              nameSnapshot: r.name,
              colorSnapshot: r.color,
            })),
          },
        },
        include: requestInclude,
      });

      // Clear the requested lines from the server cart (request basket → request).
      await tx.cartItem.deleteMany({
        where: { userId, variantId: { in: resolved.map((r) => r.variantId) } },
      });

      await emitEvent(
        tx,
        {
          type: "NEW_ORDER",
          title: `New order request ${reqNo(request.id)} — ${inr(total)} (awaiting approval)`,
          body: `${user?.name ?? "A customer"} requested ${resolved
            .map((r) => `${r.name} (${r.color}) ×${r.qty}`)
            .join(", ")}. Check availability, then approve or reject.`,
          meta: {
            requestNo: reqNo(request.id),
            requestId: request.id,
            total,
            customerName: user?.name ?? null,
            customerPhone: user?.phone ?? null,
            itemCount: resolved.reduce((s, r) => s + r.qty, 0),
          },
        },
        {
          action: ACTIONS.ORDER_PLACED,
          actorType: "CUSTOMER",
          actorId: userId,
          entityType: "order_request",
          entityId: request.id,
          meta: { total, status: "PENDING_APPROVAL" },
          req,
        }
      );

      return request;
    });

    const cfg = await getManualOrderConfig();
    const message = buildRequestMessage(
      { id: created.id, items: resolved, total },
      { name: user?.name ?? null, phone: user?.phone ?? null },
      process.env.FRONTEND_URL ?? "http://localhost:3000"
    );

    res.status(201).json({
      request: serializeRequest(created),
      whatsapp: {
        link: waLink(cfg.whatsappNumber, message),
        number: cfg.whatsappNumber,
        responseWindow: cfg.responseWindow,
      },
    });
  })
);

/* GET /api/order-requests — the signed-in customer's requests. */
orderRequestsRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = Number(req.currentUser!.id);
    const rows = await prisma.orderRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: requestInclude,
    });
    res.json(rows.map((r) => serializeRequest(r)));
  })
);

/* GET /api/order-requests/:id — one of the customer's own requests. */
orderRequestsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    const userId = Number(req.currentUser!.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const row = await prisma.orderRequest.findFirst({
      where: { id, userId },
      include: requestInclude,
    });
    if (!row) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    res.json(serializeRequest(row));
  })
);

/* POST /api/order-requests/:id/payment — customer submits UPI ref / proof.
   Only valid while APPROVED (awaiting payment). */
orderRequestsRouter.post(
  "/:id/payment",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    const userId = Number(req.currentUser!.id);
    const paymentRef =
      typeof req.body?.paymentRef === "string" ? req.body.paymentRef.trim().slice(0, 120) : "";
    const paymentProofUrl =
      typeof req.body?.paymentProofUrl === "string" ? req.body.paymentProofUrl.trim() : null;

    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    if (!paymentRef && !paymentProofUrl) {
      res.status(400).json({ error: "Enter the UPI transaction ID or attach a screenshot." });
      return;
    }
    const existing = await prisma.orderRequest.findFirst({
      where: { id, userId },
      select: { status: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (existing.status !== "APPROVED") {
      res.status(409).json({
        error: `Payment can only be submitted while the request is approved (current: ${STATUS_LABEL[existing.status]}).`,
      });
      return;
    }

    const updated = await notifyTx(async (tx) => {
      // Status-guarded update so a concurrent admin action can't be clobbered.
      const result = await tx.orderRequest.updateMany({
        where: { id, status: "APPROVED" },
        data: {
          status: "PAYMENT_SUBMITTED",
          paymentRef: paymentRef || null,
          paymentProofUrl,
          paymentSubmittedAt: new Date(),
        },
      });
      if (result.count === 0) throw new Error("STATE_CHANGED");
      const row = await tx.orderRequest.findUnique({ where: { id }, include: requestInclude });
      await emitEvent(
        tx,
        {
          type: "PAYMENT_SUCCESS",
          title: `Payment submitted for ${reqNo(id)} — verify it`,
          body: `Customer submitted payment (${paymentRef || "screenshot attached"}). Verify and mark as paid.`,
          meta: { requestId: id, requestNo: reqNo(id), paymentRef: paymentRef || null },
        },
        {
          action: ACTIONS.ORDER_STATUS_CHANGED,
          actorType: "CUSTOMER",
          actorId: userId,
          entityType: "order_request",
          entityId: id,
          meta: { to: "PAYMENT_SUBMITTED" },
          req,
        }
      );
      return row;
    }).catch((e) => {
      if (e.message === "STATE_CHANGED") return null;
      throw e;
    });

    if (!updated) {
      res.status(409).json({ error: "This request is no longer awaiting payment." });
      return;
    }
    res.json(serializeRequest(updated));
  })
);

/* PATCH /api/order-requests/:id/cancel — customer withdraws a request. */
orderRequestsRouter.patch(
  "/:id/cancel",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    const userId = Number(req.currentUser!.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const existing = await prisma.orderRequest.findFirst({
      where: { id, userId },
      select: { status: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    const cancellable: OrderRequestStatus[] = ["PENDING_APPROVAL", "APPROVED", "PAYMENT_SUBMITTED"];
    if (!cancellable.includes(existing.status)) {
      res.status(409).json({
        error: `A ${STATUS_LABEL[existing.status]} request can't be cancelled.`,
      });
      return;
    }
    const updated = await notifyTx(async (tx) => {
      const result = await tx.orderRequest.updateMany({
        where: { id, status: { in: cancellable } },
        data: { status: "CANCELLED" },
      });
      if (result.count === 0) throw new Error("STATE_CHANGED");
      const row = await tx.orderRequest.findUnique({ where: { id }, include: requestInclude });
      await emitEvent(
        tx,
        {
          type: "ORDER_CANCELLED",
          title: `Order request ${reqNo(id)} cancelled by customer`,
          body: `The customer withdrew request ${reqNo(id)}.`,
          meta: { requestId: id, requestNo: reqNo(id) },
        },
        {
          action: ACTIONS.ORDER_CANCELLED,
          actorType: "CUSTOMER",
          actorId: userId,
          entityType: "order_request",
          entityId: id,
          meta: { to: "CANCELLED" },
          req,
        }
      );
      return row;
    }).catch((e) => {
      if (e.message === "STATE_CHANGED") return null;
      throw e;
    });
    if (!updated) {
      res.status(409).json({ error: "This request can no longer be cancelled." });
      return;
    }
    res.json(serializeRequest(updated));
  })
);

/* ============================= ADMIN ROUTER ============================= */

export const adminOrderRequestsRouter = Router();
adminOrderRequestsRouter.use(asyncHandler(requireAdmin));

/* GET /api/admin/order-requests?status=&q= — all requests, newest first. */
adminOrderRequestsRouter.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const status = String(req.query.status ?? "").toUpperCase();
    const q = String(req.query.q ?? "").trim();
    const valid = Object.keys(STATUS_LABEL) as OrderRequestStatus[];
    const where: any = {};
    if (valid.includes(status as OrderRequestStatus)) where.status = status;
    if (q) {
      const idGuess = parseReqNo(q);
      where.OR = [
        ...(idGuess ? [{ id: idGuess }] : []),
        { user: { name: { contains: q } } },
        { user: { email: { contains: q } } },
        { user: { phone: { contains: q } } },
      ];
    }
    const rows = await prisma.orderRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: requestInclude,
    });

    // Status chip counts for the dashboard header (single grouped query).
    const grouped = await prisma.orderRequest.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const g of grouped) counts[g.status] = g._count._all;

    res.json({ requests: rows.map((r) => serializeRequest(r, true)), counts });
  })
);

/* GET /api/admin/order-requests/:id */
adminOrderRequestsRouter.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const row = await prisma.orderRequest.findUnique({ where: { id }, include: requestInclude });
    if (!row) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    res.json(serializeRequest(row, true));
  })
);

/** Run a guarded admin transition; returns the fresh row or null if the row
    had already moved on (concurrent action). */
async function transition(
  id: number,
  from: OrderRequestStatus | OrderRequestStatus[],
  data: Record<string, unknown>,
  emit: (tx: any, row: any) => Promise<void>
) {
  const fromList = Array.isArray(from) ? from : [from];
  return notifyTx(async (tx) => {
    const result = await tx.orderRequest.updateMany({
      where: { id, status: { in: fromList } },
      data,
    });
    if (result.count === 0) throw new Error("STATE_CHANGED");
    const row = await tx.orderRequest.findUnique({ where: { id }, include: requestInclude });
    await emit(tx, row);
    return row;
  }).catch((e) => {
    if (e.message === "STATE_CHANGED") return null;
    throw e;
  });
}

/* PATCH /api/admin/order-requests/:id/approve — stock verified, send UPI. */
adminOrderRequestsRouter.patch(
  "/:id/approve",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const adminId = Number(req.currentUser!.id);
    const cfg = await getManualOrderConfig();
    const adminNote =
      typeof req.body?.adminNote === "string" ? req.body.adminNote.slice(0, 1000) : undefined;

    const updated = await transition(
      id,
      "PENDING_APPROVAL",
      {
        status: "APPROVED",
        upiIdSnapshot: cfg.upiId,
        approvedAt: new Date(),
        ...(adminNote !== undefined ? { adminNote } : {}),
      },
      async (tx, row) => {
        await emitEvent(
          tx,
          {
            type: "ORDER_STATUS_CHANGE",
            title: `Request ${reqNo(id)} approved — awaiting payment`,
            body: `Approved. Payment instructions (UPI ${cfg.upiId}) ready to send to the customer.`,
            meta: { requestId: id, requestNo: reqNo(id), upiId: cfg.upiId },
          },
          {
            action: ACTIONS.ORDER_STATUS_CHANGED,
            actorType: "ADMIN",
            actorId: adminId,
            entityType: "order_request",
            entityId: id,
            meta: { to: "APPROVED" },
            req,
          }
        );
      }
    );
    if (!updated) {
      res.status(409).json({ error: "Only a pending request can be approved." });
      return;
    }
    const message = buildPaymentMessage(
      { id, total: toNumber(updated.totalAmount) },
      { upiId: cfg.upiId, upiName: cfg.upiName }
    );
    res.json({
      request: serializeRequest(updated, true),
      whatsapp: {
        link: updated.user?.phone ? waLink(updated.user.phone, message) : null,
        number: updated.user?.phone ?? null,
        message,
      },
    });
  })
);

/* PATCH /api/admin/order-requests/:id/reject — out of stock / declined. */
adminOrderRequestsRouter.patch(
  "/:id/reject",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const adminId = Number(req.currentUser!.id);
    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 500)
        : "This product is out of stock.";

    const updated = await transition(
      id,
      ["PENDING_APPROVAL", "APPROVED", "PAYMENT_SUBMITTED"],
      { status: "REJECTED", rejectionReason: reason },
      async (tx, _row) => {
        await emitEvent(
          tx,
          {
            type: "ORDER_STATUS_CHANGE",
            title: `Request ${reqNo(id)} rejected`,
            body: `Rejected: ${reason}`,
            meta: { requestId: id, requestNo: reqNo(id), reason },
          },
          {
            action: ACTIONS.ORDER_STATUS_CHANGED,
            actorType: "ADMIN",
            actorId: adminId,
            entityType: "order_request",
            entityId: id,
            meta: { to: "REJECTED", reason },
            req,
          }
        );
      }
    );
    if (!updated) {
      res.status(409).json({ error: "This request can no longer be rejected." });
      return;
    }
    res.json({ request: serializeRequest(updated, true) });
  })
);

/* PATCH /api/admin/order-requests/:id/mark-paid — payment verified. */
adminOrderRequestsRouter.patch(
  "/:id/mark-paid",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const adminId = Number(req.currentUser!.id);
    const updated = await transition(
      id,
      ["PAYMENT_SUBMITTED", "APPROVED"], // allow marking paid even if proof came over WhatsApp
      { status: "PAID", paidAt: new Date() },
      async (tx, _row) => {
        await emitEvent(
          tx,
          {
            type: "PAYMENT_SUCCESS",
            title: `Payment verified for ${reqNo(id)}`,
            body: `Payment confirmed. Confirm the order to deduct stock and start fulfilment.`,
            meta: { requestId: id, requestNo: reqNo(id) },
          },
          {
            action: ACTIONS.ORDER_STATUS_CHANGED,
            actorType: "ADMIN",
            actorId: adminId,
            entityType: "order_request",
            entityId: id,
            meta: { to: "PAID" },
            req,
          }
        );
      }
    );
    if (!updated) {
      res.status(409).json({ error: "Only an approved/submitted request can be marked paid." });
      return;
    }
    res.json({ request: serializeRequest(updated, true) });
  })
);

/* PATCH /api/admin/order-requests/:id/confirm — deduct stock + spawn Order.
   This is the ONLY place stock is taken, honouring offline-first priority. */
adminOrderRequestsRouter.patch(
  "/:id/confirm",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const adminId = Number(req.currentUser!.id);

    const request = await prisma.orderRequest.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!request) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    if (request.status !== "PAID") {
      res.status(409).json({
        error: `Only a paid request can be confirmed (current: ${STATUS_LABEL[request.status]}).`,
      });
      return;
    }

    // A fulfilment Order needs a shipping address. Use the request's address or
    // fall back to the customer's default; block with a clear message if none.
    let addressId = request.addressId;
    if (!addressId) {
      const addr = await prisma.address.findFirst({
        where: { userId: request.userId },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      addressId = addr?.id ?? null;
    }
    if (!addressId) {
      res.status(409).json({
        error: "Add a delivery address to this customer before confirming the order.",
      });
      return;
    }

    // Aggregate demand per variant (lines can share a variant across sizes).
    const needByVariant = new Map<number, number>();
    for (const it of request.items) {
      needByVariant.set(it.variantId, (needByVariant.get(it.variantId) ?? 0) + it.quantity);
    }

    type ConfirmResult =
      | { ok: true; row: any }
      | { ok: false; shortage: { variantId: number } };

    const result: ConfirmResult = await notifyTx(async (tx) => {
      // Atomic conditional decrement — only matches while enough stock remains,
      // so an offline sale that emptied stock first will (correctly) block this.
      for (const [variantId, need] of needByVariant) {
        const dec = await tx.productVariant.updateMany({
          where: { id: variantId, stockQty: { gte: need } },
          data: { stockQty: { decrement: need } },
        });
        if (dec.count === 0) return { ok: false as const, shortage: { variantId } };
      }

      const finalAmount = toNumber(request.totalAmount);

      // Spawn the real fulfilment Order (CONFIRMED) + a manual UPI payment row.
      const order = await tx.order.create({
        data: {
          userId: request.userId,
          addressId: addressId!,
          totalAmount: finalAmount,
          discount: 0,
          finalAmount,
          status: "CONFIRMED",
          shippingMethod: "manual",
          shippingFee: 0,
          notes: `From manual order request ${reqNo(request.id)}`,
          items: {
            create: request.items.map((it) => ({
              variantId: it.variantId,
              size: it.size,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              totalPrice: it.totalPrice,
            })),
          },
          payments: {
            create: {
              method: "UPI",
              status: "SUCCESS",
              amount: finalAmount,
              gateway: "manual-upi",
              transactionId: request.paymentRef || null,
              paidAt: request.paidAt ?? new Date(),
            },
          },
        },
      });

      const updatedReq = await tx.orderRequest.update({
        where: { id },
        data: { status: "CONFIRMED", confirmedAt: new Date(), orderId: order.id },
        include: requestInclude,
      });

      await emitEvent(
        tx,
        {
          type: "ORDER_STATUS_CHANGE",
          title: `Request ${reqNo(id)} confirmed — order ${("AVC-" + String(order.id).padStart(6, "0"))} created`,
          body: `Stock deducted and a fulfilment order was created. Track it under Orders.`,
          orderId: order.id,
          meta: { requestId: id, requestNo: reqNo(id), orderId: order.id },
        },
        {
          action: ACTIONS.ORDER_STATUS_CHANGED,
          actorType: "ADMIN",
          actorId: adminId,
          entityType: "order_request",
          entityId: id,
          meta: { to: "CONFIRMED", orderId: order.id },
          req,
        }
      );

      // Stock-threshold alerts for anything this confirmation pushed low/out.
      await emitStockAlerts(
        tx,
        req,
        [...needByVariant.entries()].map(([variantId, qty]) => ({ variantId, qty }))
      );

      return { ok: true as const, row: updatedReq };
    });

    if (!result.ok) {
      res.status(409).json({
        error:
          "Not enough stock to confirm — it may have sold offline. Reject the request or restock first.",
        code: "OUT_OF_STOCK",
      });
      return;
    }

    // Realized sale → live feed (post-commit, so a rolled-back confirm never
    // emits). Attribute to the buyer's first-touch source when we know it.
    const visitor = await prisma.analyticsVisitor
      .findFirst({ where: { userId: request.userId }, select: { firstSource: true } })
      .catch(() => null);
    publishCommerceEvent({
      name: "order_confirmed",
      productName: reqNo(request.id),
      source: visitor?.firstSource ?? "direct",
      value: toNumber(request.totalAmount),
      loggedIn: true,
    });

    res.json({ request: serializeRequest(result.row, true) });
  })
);

/* PATCH /api/admin/order-requests/:id/cancel — admin withdraws a request. */
adminOrderRequestsRouter.patch(
  "/:id/cancel",
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseReqNo(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Invalid request id" });
      return;
    }
    const adminId = Number(req.currentUser!.id);
    const updated = await transition(
      id,
      ["PENDING_APPROVAL", "APPROVED", "PAYMENT_SUBMITTED", "PAID"],
      { status: "CANCELLED" },
      async (tx, _row) => {
        await emitEvent(
          tx,
          {
            type: "ORDER_CANCELLED",
            title: `Request ${reqNo(id)} cancelled by admin`,
            body: `Admin cancelled request ${reqNo(id)}.`,
            meta: { requestId: id, requestNo: reqNo(id) },
          },
          {
            action: ACTIONS.ORDER_CANCELLED,
            actorType: "ADMIN",
            actorId: adminId,
            entityType: "order_request",
            entityId: id,
            meta: { to: "CANCELLED" },
            req,
          }
        );
      }
    );
    if (!updated) {
      res.status(409).json({ error: "This request can no longer be cancelled." });
      return;
    }
    res.json({ request: serializeRequest(updated, true) });
  })
);
