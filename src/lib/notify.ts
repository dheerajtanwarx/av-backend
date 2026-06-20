import { Request } from "express";
import {
  ActorType,
  NotificationPriority,
  NotificationType,
  Prisma,
} from "../../generated/prisma/client";
import { prisma } from "./prisma";
import { publish, RealtimeEvent } from "./realtime";

/** Either the global prisma client or an interactive-transaction client —
    every helper here runs on whatever the caller passes, so the writes join
    the caller's transaction and an order can never exist without its audit
    trail (or vice versa). */
export type Db = Prisma.TransactionClient;

/* ------------------------------------------------------------------
   Real-time publishing with post-commit semantics.

   SSE events must never be pushed for a transaction that later rolls
   back, so emit helpers don't publish directly: when their `db` is a
   transaction opened through notifyTx(), events queue against that tx
   and flush only after commit. A failed transaction drops its queue.
   ------------------------------------------------------------------ */

const pendingByTx = new WeakMap<object, RealtimeEvent[]>();

/** prisma.$transaction with real-time awareness: anything the callback emits
    via the helpers below is published after the transaction commits, and
    silently discarded if it throws. Use this instead of prisma.$transaction
    whenever the callback calls emitNotification/logActivity/emitEvent. */
export async function notifyTx<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const queue: RealtimeEvent[] = [];
  const result = await prisma.$transaction(
    async (tx) => {
      pendingByTx.set(tx, queue);
      try {
        return await fn(tx);
      } finally {
        pendingByTx.delete(tx);
      }
    },
    // Checkout + notification fan-out + audit logging is many round-trips to
    // a remote DB; Prisma's 5s default timeout aborts mid-flight (P2028).
    { maxWait: 10_000, timeout: 25_000 }
  );
  for (const e of queue) publish(e);
  return result;
}

/** Queue onto the surrounding notifyTx, or publish immediately when the
    caller isn't inside one (non-transactional usage is already committed). */
function queueOrPublish(db: Db, event: RealtimeEvent): void {
  const queue = pendingByTx.get(db);
  if (queue) queue.push(event);
  else publish(event);
}

const orderNo = (id: number) => "AVC-" + String(id).padStart(6, "0");

/** Default priority per type. Stored per-row so an emitter can override it
    (e.g. SYSTEM_ALERT is CRITICAL at zero stock but HIGH at low stock). */
export const DEFAULT_PRIORITY: Record<NotificationType, NotificationPriority> = {
  NEW_ORDER: "HIGH",
  ORDER_CANCELLED: "HIGH",
  PAYMENT_SUCCESS: "MEDIUM",
  REFUND_REQUESTED: "HIGH",
  REFUND_COMPLETED: "MEDIUM",
  ORDER_STATUS_CHANGE: "INFO",
  DELIVERY_UPDATE: "MEDIUM",
  SYSTEM_ALERT: "HIGH",
};

/** Variants at or below this level (but above zero) raise a HIGH stock alert;
    hitting zero raises CRITICAL. */
export const LOW_STOCK_THRESHOLD = 5;

/** The activity-log action vocabulary. Namespaced strings, not a DB enum, so
    adding one is a code change rather than a migration against the shared
    production database. */
export const ACTIONS = {
  ORDER_PLACED: "order.placed",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ORDER_CANCELLED: "order.cancelled",
  ORDER_RETURNED: "order.returned",
  ORDER_NOTE_ADDED: "order.note_added",
  ORDER_TRACKING_UPDATED: "order.tracking_updated",
  ORDER_REFUND_PROCESSED: "order.refund_processed",
  STOCK_LOW: "stock.low",
  STOCK_OUT: "stock.out",
  AUTH_LOGIN: "auth.login",
  AUTH_SIGNUP: "auth.signup",
  AUTH_LOGOUT: "auth.logout",
  AUTH_LOGIN_FAILED: "auth.login_failed",
  NOTIFICATION_READ: "notification.read",
  NOTIFICATION_UNREAD: "notification.unread",
  NOTIFICATION_ARCHIVED: "notification.archived",
  NOTIFICATION_UNARCHIVED: "notification.unarchived",
  NOTIFICATION_READ_ALL: "notification.read_all",
  NOTIFICATION_READ_BULK: "notification.read_bulk",
  NOTIFICATION_ARCHIVED_BULK: "notification.archived_bulk",
  NOTIFICATION_UNARCHIVED_BULK: "notification.unarchived_bulk",
} as const;
export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  orderId?: number | null;
  meta?: Prisma.InputJsonValue;
}

/** Create a notification and fan it out to every user who is an ADMIN right
    now. Admins promoted later won't see it (the activity log is the global
    history). Returns the created notification. */
export async function emitNotification(db: Db, input: NotificationInput) {
  const admins = await db.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const created = await db.notification.create({
    data: {
      type: input.type,
      priority: input.priority ?? DEFAULT_PRIORITY[input.type],
      title: input.title.slice(0, 255),
      body: input.body,
      orderId: input.orderId ?? null,
      meta: input.meta,
      recipients: { create: admins.map((a) => ({ userId: a.id })) },
    },
  });
  queueOrPublish(db, {
    event: "notification:new",
    id: created.id,
    userIds: admins.map((a) => a.id),
    // Same shape the REST list endpoint serves, so clients can prepend it.
    data: {
      id: created.id,
      type: created.type,
      priority: created.priority,
      title: created.title,
      body: created.body,
      orderId: created.orderId,
      orderNo: created.orderId ? orderNo(created.orderId) : null,
      meta: created.meta,
      createdAt: created.createdAt,
      read: false,
      readAt: null,
      archived: false,
      archivedAt: null,
    },
  });
  return created;
}

export interface ActivityInput {
  action: Action;
  actorType: ActorType;
  actorId?: number | null;
  entityType: string;
  entityId?: number | null;
  meta?: Prisma.InputJsonValue;
  req?: Request;
}

/** Append one activity-log row. Pass `req` to capture the caller's IP and
    user agent for admin/customer actions; omit it for SYSTEM events. */
export async function logActivity(db: Db, input: ActivityInput) {
  const row = await db.activityLog.create({
    data: {
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      meta: input.meta,
      ip: input.req?.ip?.slice(0, 64) ?? null,
      userAgent: input.req?.get("user-agent")?.slice(0, 255) ?? null,
    },
  });
  queueOrPublish(db, {
    event: "activity:new",
    data: {
      id: row.id,
      action: row.action,
      actorType: row.actorType,
      actorId: row.actorId,
      entityType: row.entityType,
      entityId: row.entityId,
      meta: row.meta,
      createdAt: row.createdAt,
    },
  });
  // Order and stock events move the dashboard numbers; nudge open dashboards
  // to refetch rather than pushing recomputed stats over the wire.
  if (row.action.startsWith("order.") || row.action.startsWith("stock.")) {
    queueOrPublish(db, { event: "dashboard:update", data: { reason: row.action } });
  }
  return row;
}

/** Notify + log one business event: a single activity row carrying the
    created notification's id in meta (the event is logged once — there is no
    separate "notification.created" row). */
export async function emitEvent(
  db: Db,
  notification: NotificationInput,
  activity: Omit<ActivityInput, "meta"> & { meta?: Record<string, unknown> }
) {
  const created = await emitNotification(db, notification);
  await logActivity(db, {
    ...activity,
    meta: { ...(activity.meta ?? {}), notificationId: created.id },
  });
  return created;
}

/** After a checkout decremented stock, raise SYSTEM_ALERTs for variants that
    *crossed* a threshold in this purchase (CRITICAL at zero, HIGH at the low
    mark). Crossing detection (before > threshold ≥ after) means a variant
    alerts once per crossing, not once per order while it sits low. Runs in
    the checkout transaction. */
export async function emitStockAlerts(
  db: Db,
  req: Request | undefined,
  taken: { variantId: number; qty: number }[]
) {
  if (taken.length === 0) return;
  const variants = await db.productVariant.findMany({
    where: { id: { in: taken.map((t) => t.variantId) } },
    select: {
      id: true,
      color: true,
      stockQty: true,
      product: { select: { id: true, name: true } },
    },
  });
  const qtyByVariant = new Map(taken.map((t) => [t.variantId, t.qty]));

  for (const v of variants) {
    const after = v.stockQty;
    const before = after + (qtyByVariant.get(v.id) ?? 0);
    const label = `${v.product.name} (${v.color})`;

    if (after <= 0 && before > 0) {
      await emitEvent(
        db,
        {
          type: "SYSTEM_ALERT",
          priority: "CRITICAL",
          title: `Out of stock: ${label}`,
          body: `${label} just sold out. Restock to keep it purchasable.`,
          meta: { variantId: v.id, productId: v.product.id, stockQty: after },
        },
        {
          action: ACTIONS.STOCK_OUT,
          actorType: "SYSTEM",
          entityType: "variant",
          entityId: v.id,
          meta: { productId: v.product.id, stockQty: after },
          req,
        }
      );
    } else if (after <= LOW_STOCK_THRESHOLD && before > LOW_STOCK_THRESHOLD) {
      await emitEvent(
        db,
        {
          type: "SYSTEM_ALERT",
          priority: "HIGH",
          title: `Low stock: ${label}`,
          body: `${label} is down to ${after} unit${after === 1 ? "" : "s"}.`,
          meta: { variantId: v.id, productId: v.product.id, stockQty: after },
        },
        {
          action: ACTIONS.STOCK_LOW,
          actorType: "SYSTEM",
          entityType: "variant",
          entityId: v.id,
          meta: { productId: v.product.id, stockQty: after },
          req,
        }
      );
    }
  }
}
