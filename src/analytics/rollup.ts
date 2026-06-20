import { prisma } from "../lib/prisma";
import { EVENTS, REQUEST_EVENTS } from "./events";

/* ============================================================
   Aggregation jobs — the firehose → rollup transform.
   ------------------------------------------------------------
   Strategy: every run RE-COMPUTES the current + previous local day
   from scratch (DELETE the day's agg rows, re-INSERT from source).
   This is:
     • idempotent  — re-running can't double-count;
     • bounded      — only 2 days of source rows are ever scanned;
     • self-healing — late events are absorbed on the next pass.
   The nightly reconcile re-runs the prior day one last time after
   it can no longer change.

   Buckets use DATE(createdAt) in the DB session timezone, so run
   MySQL in the business timezone (IST) for correct day boundaries.
   ============================================================ */

const SESSION_IDLE_MS = 30 * 60_000;

/** Local YYYY-MM-DD. */
function dayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The set of days a near-real-time pass recomputes. */
function recentDays(): string[] {
  const today = new Date();
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  return [dayStr(yest), dayStr(today)];
}

/** Statuses that count toward revenue (mirrors reports.ts). */
const REVENUE_STATUSES = "'PLACED','CONFIRMED','PROCESSING','SHIPPED','DELIVERED'";

async function rollupDay(day: string): Promise<void> {
  // ---- agg_daily_traffic (session-sourced) ----
  await prisma.$executeRawUnsafe(`DELETE FROM agg_daily_traffic WHERE day = ?`, day);
  await prisma.$executeRawUnsafe(
    `INSERT INTO agg_daily_traffic
       (day, source, medium, campaign, device, country,
        visitors, newVisitors, sessions, pageviews, bounces, durationSec, orders, revenue)
     SELECT ?,
            COALESCE(s.source,'direct'), COALESCE(s.medium,'none'),
            COALESCE(s.campaign,''), COALESCE(s.device,'unknown'),
            COALESCE(s.country,'unknown'),
            COUNT(DISTINCT s.visitorId),
            COUNT(DISTINCT CASE WHEN DATE(v.firstSeenAt) = ? THEN s.visitorId END),
            COUNT(*),
            SUM(s.pageviews),
            SUM(s.isBounce),
            SUM(COALESCE(s.durationSec,0)),
            0, 0
       FROM analytics_sessions s
       LEFT JOIN analytics_visitors v ON v.id = s.visitorId
      WHERE DATE(s.startedAt) = ?
      GROUP BY COALESCE(s.source,'direct'), COALESCE(s.medium,'none'),
               COALESCE(s.campaign,''), COALESCE(s.device,'unknown'),
               COALESCE(s.country,'unknown')`,
    day,
    day,
    day
  );

  // ---- agg_daily_product (behavioural cols from events) ----
  // The storefront identifies products by slug, so events carry props.slug;
  // we resolve it to the numeric productId via a join here. (Events may also
  // carry productId directly — coalesce so either path works.)
  await prisma.$executeRawUnsafe(`DELETE FROM agg_daily_product WHERE day = ?`, day);
  await prisma.$executeRawUnsafe(
    `INSERT INTO agg_daily_product (day, productId, views, uniqueViewers, addToCart, removeFromCart)
     SELECT ?, p.id,
            SUM(e.eventName = ?),
            COUNT(DISTINCT CASE WHEN e.eventName = ? THEN e.visitorId END),
            SUM(e.eventName = ?),
            SUM(e.eventName = ?)
       FROM analytics_events e
       JOIN products p
         ON p.id = e.productId
         OR p.slug = JSON_UNQUOTE(JSON_EXTRACT(e.props, '$.slug'))
      WHERE e.created_day = ?
        AND e.eventName IN (?, ?, ?)
      GROUP BY p.id`,
    day,
    EVENTS.PRODUCT_VIEW,
    EVENTS.PRODUCT_VIEW,
    EVENTS.ADD_TO_CART,
    EVENTS.REMOVE_FROM_CART,
    day,
    EVENTS.PRODUCT_VIEW,
    EVENTS.ADD_TO_CART,
    EVENTS.REMOVE_FROM_CART
  );

  // ---- agg_daily_product purchases/revenue (authoritative business tables) ----
  // Upsert onto the rows just inserted (a product can have sales but no views,
  // hence ON DUPLICATE handles both insert and merge).
  await prisma.$executeRawUnsafe(
    `INSERT INTO agg_daily_product (day, productId, purchases, qtySold, revenue)
     SELECT ?, pv.productId,
            COUNT(DISTINCT o.id),
            SUM(oi.quantity),
            SUM(oi.totalPrice)
       FROM order_items oi
       JOIN orders o            ON o.id = oi.orderId
       JOIN product_variants pv ON pv.id = oi.variantId
      WHERE DATE(o.placedAt) = ?
        AND o.status IN (${REVENUE_STATUSES})
      GROUP BY pv.productId
     ON DUPLICATE KEY UPDATE
        purchases = VALUES(purchases),
        qtySold   = VALUES(qtySold),
        revenue   = VALUES(revenue)`,
    day,
    day
  );

  // ---- agg_daily_funnel (event-sourced, per source) ----
  // All stage counts are DISTINCT SESSIONS (one consistent denominator); the
  // `orders` column holds "requests submitted" (request_submitted OR its legacy
  // alias order_placed) — realized confirmed orders are read authoritatively
  // from the orders table at query time, not from events.
  // Filtering on `created_day` (the partition key) lets MySQL prune to the
  // single day's partition instead of scanning the whole firehose.
  await prisma.$executeRawUnsafe(`DELETE FROM agg_daily_funnel WHERE day = ?`, day);
  await prisma.$executeRawUnsafe(
    `INSERT INTO agg_daily_funnel (day, source, visitors, productViews, addToCart, checkoutStarted, orders)
     SELECT ?, COALESCE(e.source,'direct'),
            COUNT(DISTINCT e.visitorId),
            COUNT(DISTINCT CASE WHEN e.eventName = ? THEN e.sessionId END),
            COUNT(DISTINCT CASE WHEN e.eventName = ? THEN e.sessionId END),
            COUNT(DISTINCT CASE WHEN e.eventName = ? THEN e.sessionId END),
            COUNT(DISTINCT CASE WHEN e.eventName IN (?, ?) THEN e.sessionId END)
       FROM analytics_events e
      WHERE e.created_day = ?
      GROUP BY COALESCE(e.source,'direct')`,
    day,
    EVENTS.PRODUCT_VIEW,
    EVENTS.ADD_TO_CART,
    EVENTS.CHECKOUT_STARTED,
    REQUEST_EVENTS[0],
    REQUEST_EVENTS[1],
    day
  );

  // ---- revenue-by-source (first-touch: order -> user -> visitor.firstSource) ----
  // Authoritative amounts from the orders table, attributed to the source the
  // buyer first arrived from. Orders by users we never tracked fall back to
  // 'direct' via the LEFT JOIN. Merges onto the funnel rows created above.
  await prisma.$executeRawUnsafe(
    `INSERT INTO agg_daily_funnel (day, source, revenue)
     SELECT ?, COALESCE(v.firstSource, 'direct') AS src, SUM(o.finalAmount)
       FROM orders o
       LEFT JOIN analytics_visitors v ON v.userId = o.userId
      WHERE DATE(o.placedAt) = ? AND o.status IN (${REVENUE_STATUSES})
      GROUP BY COALESCE(v.firstSource, 'direct')
     ON DUPLICATE KEY UPDATE revenue = VALUES(revenue)`,
    day,
    day
  );

  // ---- agg_daily_perf (Web Vitals from web_vital events) ----
  await prisma.$executeRawUnsafe(`DELETE FROM agg_daily_perf WHERE day = ?`, day);
  await prisma.$executeRawUnsafe(
    `INSERT INTO agg_daily_perf (day, metric, rating, samples, sumValue)
     SELECT ?,
            UPPER(JSON_UNQUOTE(JSON_EXTRACT(props,'$.name'))),
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(props,'$.rating')),'unknown'),
            COUNT(*),
            SUM(CAST(JSON_EXTRACT(props,'$.value') AS DECIMAL(16,4)))
       FROM analytics_events
      WHERE created_day = ? AND eventName = ?
        AND JSON_EXTRACT(props,'$.name') IS NOT NULL
      GROUP BY UPPER(JSON_UNQUOTE(JSON_EXTRACT(props,'$.name'))),
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(props,'$.rating')),'unknown')`,
    day,
    day,
    EVENTS.WEB_VITAL
  );

  // ---- agg_search_terms (from search events; term + results in props) ----
  await prisma.$executeRawUnsafe(`DELETE FROM agg_search_terms WHERE day = ?`, day);
  await prisma.$executeRawUnsafe(
    `INSERT INTO agg_search_terms (day, term, searches, zeroResult, clicks)
     SELECT ?, LOWER(LEFT(JSON_UNQUOTE(JSON_EXTRACT(e.props,'$.term')),120)) AS term,
            COUNT(*),
            SUM(CAST(JSON_EXTRACT(e.props,'$.results') AS UNSIGNED) = 0),
            0
       FROM analytics_events e
      WHERE e.created_day = ?
        AND e.eventName = ?
        AND JSON_EXTRACT(e.props,'$.term') IS NOT NULL
      GROUP BY term
     HAVING term <> ''`,
    day,
    day,
    EVENTS.SEARCH
  );
}

/** Near-real-time pass (cron: every 5 min). */
export async function rollupRecent(): Promise<void> {
  for (const day of recentDays()) await rollupDay(day);
  await prisma.siteSetting.upsert({
    where: { key: "analytics:lastRollupAt" },
    create: { key: "analytics:lastRollupAt", value: new Date().toISOString() },
    update: { value: new Date().toISOString() },
  });
}

/** Nightly reconcile: re-run yesterday once it can no longer change. */
export async function reconcileYesterday(): Promise<void> {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  await rollupDay(dayStr(y));
}

/** Keep the firehose partitioned ahead of "now": ensure a partition exists
    for the current month + the next 3, by splitting the catch-all `pmax`.
    Idempotent — existing partitions are skipped, so it's safe to run monthly
    (or on every boot). Retention/drop of old partitions is intentionally left
    manual for now (archive before dropping). */
export async function partitionMaintenance(): Promise<void> {
  const existing = await prisma.$queryRawUnsafe<{ p: string }[]>(
    `SELECT PARTITION_NAME AS p FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'analytics_events'
        AND PARTITION_NAME IS NOT NULL`
  );
  const names = new Set(existing.map((e) => e.p));

  const toAdd: { name: string; lessThan: string }[] = [];
  const base = new Date();
  base.setDate(1);
  for (let i = 0; i <= 3; i++) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    const name = `p${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (names.has(name)) continue;
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    toAdd.push({ name, lessThan: dayStr(next) });
  }
  if (toAdd.length === 0) return;

  const defs = toAdd
    .map((p) => `PARTITION ${p.name} VALUES LESS THAN (TO_DAYS('${p.lessThan}'))`)
    .join(", ");
  // REORGANIZE splits the open-ended pmax into the new month partitions + a
  // fresh pmax, without moving any existing rows that already sit in pmax.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE analytics_events REORGANIZE PARTITION pmax INTO (${defs}, PARTITION pmax VALUES LESS THAN MAXVALUE)`
  );
}

/** Close sessions idle for >30 min: stamp endedAt + duration. The next
    rollup of that day then sees final duration/bounce. */
export async function closeSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - SESSION_IDLE_MS);
  await prisma.$executeRawUnsafe(
    `UPDATE analytics_sessions
        SET endedAt = lastSeenAt,
            durationSec = TIMESTAMPDIFF(SECOND, startedAt, lastSeenAt)
      WHERE endedAt IS NULL AND lastSeenAt < ?`,
    cutoff
  );
}
