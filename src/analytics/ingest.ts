import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../lib/prisma";
import { publish } from "../lib/realtime";
import { lookupGeo, GeoResult } from "../lib/geo";
import { parseUa, UaResult } from "../lib/ua";
import { resolveAttribution, isKnownEvent, EVENTS, Attribution } from "./events";

/* ============================================================
   Event ingestion.
   ------------------------------------------------------------
   The collector hands us one batch from one browser tab: same IP,
   same UA, same session. We enrich ONCE (geo + device + source),
   stamp every event with it, bulk-insert the firehose rows, then
   upsert the session and visitor entities. Everything is best-effort:
   a malformed event is skipped, never fatal — the collector has
   already returned 204 to the browser.
   ============================================================ */

/** One event as it arrives from the client SDK. */
export interface RawClientEvent {
  name: string;
  path?: string | null;
  productId?: number | null;
  categoryId?: number | null;
  props?: Record<string, unknown> | null;
  ts?: number; // client ms epoch (advisory)
}

export interface TrackBatch {
  visitorId: string;
  sessionId: string;
  /** @deprecated Ignored by the server. Identity is resolved from the auth
      cookie (IngestContext.authUserId); a client-supplied value is never used. */
  userId?: number | null;
  isNewVisitor?: boolean;
  isNewSession?: boolean;
  utm?: {
    source?: string | null;
    medium?: string | null;
    campaign?: string | null;
    content?: string | null;
  } | null;
  referrer?: string | null;
  events: RawClientEvent[];
}

export interface IngestContext {
  ip: string | null;
  userAgent: string | undefined;
  selfHost: string | null;
  /** Authenticated user id resolved server-side from the auth cookie. The
      client-supplied batch.userId is NEVER trusted — this is the only source
      of identity, so events can't be forged onto another user. Null = guest. */
  authUserId: number | null;
}

// RFC-4122 UUID: 8-4-4-4-12 hex with a valid version (1-5) and variant (8-b)
// nibble. Stricter than a bare length/charset check so a forged or malformed
// id (e.g. 36 dashes) is rejected, while every id the client SDK generates
// (crypto.randomUUID v4 + the v4 fallback) still validates.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Defensive cap on firehose rows per batch. The client SDK flushes at 30
// (MAX_QUEUE); anything beyond this is a malformed or hostile payload, so we
// drop the overflow rather than letting one request amplify into the firehose.
const MAX_EVENTS_PER_BATCH = 50;

/* ---- live ring buffer (active users "now") ---- */
const LIVE_WINDOW_MS = 5 * 60_000;
interface LiveHit {
  visitorId: string;
  sessionId: string;
  userId: number | null;
  at: number;
  path: string | null;
  country: string | null;
  city: string | null;
  source: string;
  device: string | null;
  event: string;
}
const live: LiveHit[] = [];

function trim(now: number) {
  while (live.length && now - live[0].at > LIVE_WINDOW_MS) live.shift();
}

/** Events that belong in the live activity feed (browsing/commerce signals).
    Order/auth/stock events reach the feed via the existing activity:new SSE
    channel, so they're deliberately excluded here to avoid duplicates. */
const FEED_EVENTS = new Set<string>([
  EVENTS.PRODUCT_VIEW,
  EVENTS.ADD_TO_CART,
  EVENTS.WISHLIST_ADD,
  EVENTS.CHECKOUT_STARTED,
  EVENTS.REQUEST_SUBMITTED,
  EVENTS.ORDER_PLACED, // legacy alias of request_submitted
  EVENTS.SEARCH,
  EVENTS.SOCIAL_CLICK,
]);

/* Token bucket so a traffic burst can't flood the admin SSE with feed rows. */
let feedTokens = 25;
let feedWindow = Date.now();
function feedAllowed(): boolean {
  const now = Date.now();
  if (now - feedWindow >= 1000) {
    feedTokens = 25;
    feedWindow = now;
  }
  if (feedTokens <= 0) return false;
  feedTokens -= 1;
  return true;
}

let feedSeq = 0;

/** Publish a server-originated commerce event to the admin live feed (e.g.
    order_confirmed when an admin confirms a request). Unlike client events
    these are low-volume admin actions, so they bypass the visitor token bucket.
    No firehose row is written — confirmed-order counts/revenue come from the
    authoritative orders table in the rollups. */
export function publishCommerceEvent(e: {
  name: string;
  productName?: string | null;
  source?: string | null;
  value?: number | null;
  loggedIn?: boolean;
}): void {
  publish({
    event: "analytics:event",
    data: {
      id: `${Date.now()}-${feedSeq++}`,
      name: e.name,
      productName: e.productName ?? null,
      source: e.source ?? "direct",
      country: null,
      city: null,
      device: null,
      loggedIn: e.loggedIn ?? true,
      value: typeof e.value === "number" ? e.value : null,
      at: new Date().toISOString(),
    },
  });
}

/** Traffic snapshot from the in-memory buffer (no DB). Distinct-visitor
    counts over the last 5 minutes, split by login state, geo, source, device,
    plus the pages being viewed and rolling cart/checkout counts. */
export function liveTraffic() {
  const now = Date.now();
  trim(now);

  const visitors = new Set<string>();
  const sessions = new Set<string>();
  const loggedIn = new Set<string>();
  const byCountry = new Map<string, Set<string>>();
  const byCity = new Map<string, Set<string>>();
  const bySource = new Map<string, Set<string>>();
  const byDevice = new Map<string, Set<string>>();
  const byPath = new Map<string, number>();
  let addToCart = 0;
  let checkout = 0;

  const bump = (m: Map<string, Set<string>>, key: string | null, v: string) => {
    const k = key || "unknown";
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(v);
  };

  for (const e of live) {
    visitors.add(e.visitorId);
    sessions.add(e.sessionId);
    if (e.userId != null) loggedIn.add(e.visitorId);
    bump(byCountry, e.country, e.visitorId);
    bump(byCity, e.city, e.visitorId);
    bump(bySource, e.source, e.visitorId);
    bump(byDevice, e.device, e.visitorId);
    if (e.event === EVENTS.PAGE_VIEW && e.path) byPath.set(e.path, (byPath.get(e.path) ?? 0) + 1);
    if (e.event === EVENTS.ADD_TO_CART) addToCart += 1;
    if (e.event === EVENTS.CHECKOUT_STARTED) checkout += 1;
  }

  const topSet = (m: Map<string, Set<string>>, limit = 8) =>
    [...m.entries()]
      .map(([label, set]) => ({ label, count: set.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

  return {
    activeUsers: visitors.size,
    loggedIn: loggedIn.size,
    guests: visitors.size - loggedIn.size,
    sessions: sessions.size,
    byCountry: topSet(byCountry),
    byCity: topSet(byCity),
    bySource: topSet(bySource),
    byDevice: topSet(byDevice),
    topPaths: [...byPath.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ path, count })),
    window: { addToCart, checkout },
  };
}

/** Back-compat alias (older callers). */
export function activeNow() {
  const t = liveTraffic();
  return { activeUsers: t.activeUsers, topPaths: t.topPaths };
}

/** Validate + enrich + persist one batch. Resolves once persisted (or skipped). */
export async function ingestBatch(batch: TrackBatch, ctx: IngestContext): Promise<void> {
  if (!batch || !UUID.test(batch.visitorId ?? "") || !UUID.test(batch.sessionId ?? "")) return;
  const events = Array.isArray(batch.events)
    ? batch.events.filter((e) => isKnownEvent(e?.name)).slice(0, MAX_EVENTS_PER_BATCH)
    : [];
  if (events.length === 0) return;

  const geo: GeoResult = lookupGeo(ctx.ip);
  const ua: UaResult = parseUa(ctx.userAgent);
  const attr: Attribution = resolveAttribution({
    utmSource: batch.utm?.source,
    utmMedium: batch.utm?.medium,
    utmCampaign: batch.utm?.campaign,
    utmContent: batch.utm?.content,
    referrer: batch.referrer,
    selfHost: ctx.selfHost,
  });

  // Identity comes ONLY from the server-verified auth cookie, never from the
  // payload — batch.userId is ignored so events can't be attributed to an
  // arbitrary user by a forged request.
  const userId = Number.isInteger(ctx.authUserId) ? Number(ctx.authUserId) : null;
  const now = new Date();

  const nowMs = Date.now();
  const rows: Prisma.AnalyticsEventCreateManyInput[] = events.map((e) => {
    // Feed the in-memory live buffer with full context for the live dashboard.
    live.push({
      visitorId: batch.visitorId,
      sessionId: batch.sessionId,
      userId,
      at: nowMs,
      path: e.path ?? null,
      country: geo.country,
      city: geo.city,
      source: attr.source,
      device: ua.device,
      event: e.name,
    });
    // Publish a compact row to the admin live feed for commerce/browsing events.
    if (FEED_EVENTS.has(e.name) && feedAllowed()) {
      publish({
        event: "analytics:event",
        data: {
          id: `${nowMs}-${feedSeq++}`,
          name: e.name,
          productName:
            (e.props?.name as string | undefined) ?? (e.props?.term as string | undefined) ?? null,
          source: attr.source,
          country: geo.country,
          city: geo.city,
          device: ua.device,
          loggedIn: userId != null,
          value: typeof e.props?.value === "number" ? (e.props.value as number) : null,
          at: new Date(nowMs).toISOString(),
        },
      });
    }
    return {
      eventName: e.name,
      visitorId: batch.visitorId,
      sessionId: batch.sessionId,
      userId,
      source: attr.source,
      medium: attr.medium,
      campaign: attr.campaign,
      content: attr.content,
      referrer: batch.referrer?.slice(0, 255) ?? null,
      path: typeof e.path === "string" ? e.path.slice(0, 255) : null,
      productId: Number.isInteger(e.productId) ? Number(e.productId) : null,
      categoryId: Number.isInteger(e.categoryId) ? Number(e.categoryId) : null,
      device: ua.device,
      browser: ua.browser,
      os: ua.os,
      country: geo.country,
      state: geo.state,
      city: geo.city,
      props: (e.props ?? undefined) as Prisma.InputJsonValue | undefined,
    };
  });

  trim(nowMs); // keep the live buffer bounded even if the metrics tick is off

  // Firehose write — bulk, no per-row round-trips.
  await prisma.analyticsEvent.createMany({ data: rows });

  await upsertSessionAndVisitor(batch, events, attr, geo, ua, userId, now);
}

async function upsertSessionAndVisitor(
  batch: TrackBatch,
  events: RawClientEvent[],
  attr: Attribution,
  geo: GeoResult,
  ua: UaResult,
  userId: number | null,
  now: Date
): Promise<void> {
  const pageviews = events.filter((e) => e.name === EVENTS.PAGE_VIEW).length;
  const lastPath = [...events].reverse().find((e) => e.path)?.path?.slice(0, 255) ?? null;
  // Anything beyond a single landing pageview counts as engagement → not a bounce.
  const engaged =
    pageviews > 1 || events.some((e) => e.name !== EVENTS.PAGE_VIEW && e.name !== EVENTS.SESSION_START);
  const converted = events.some(
    (e) =>
      e.name === EVENTS.REQUEST_SUBMITTED ||
      e.name === EVENTS.ORDER_PLACED || // legacy alias
      e.name === EVENTS.PAYMENT_COMPLETED
  );
  const firstPath = events.find((e) => e.path)?.path?.slice(0, 255) ?? null;

  // Session: create on first batch, otherwise accumulate.
  await prisma.analyticsSession.upsert({
    where: { id: batch.sessionId },
    create: {
      id: batch.sessionId,
      visitorId: batch.visitorId,
      userId,
      source: attr.source,
      medium: attr.medium,
      campaign: attr.campaign,
      device: ua.device,
      browser: ua.browser,
      os: ua.os,
      country: geo.country,
      state: geo.state,
      city: geo.city,
      startedAt: now,
      lastSeenAt: now,
      pageviews: pageviews || 1,
      isBounce: !engaged,
      entryPath: firstPath,
      exitPath: lastPath,
      converted,
    },
    update: {
      lastSeenAt: now,
      userId: userId ?? undefined, // stitch anon → known once we learn it
      pageviews: { increment: pageviews },
      ...(engaged ? { isBounce: false } : {}),
      ...(converted ? { converted: true } : {}),
      ...(lastPath ? { exitPath: lastPath } : {}),
    },
  });

  // Visitor: first-touch attribution captured on create; only counters move after.
  await prisma.analyticsVisitor.upsert({
    where: { id: batch.visitorId },
    create: {
      id: batch.visitorId,
      userId,
      firstSeenAt: now,
      lastSeenAt: now,
      firstSource: attr.source,
      firstMedium: attr.medium,
      firstCampaign: attr.campaign,
      sessionCount: 1,
    },
    update: {
      lastSeenAt: now,
      userId: userId ?? undefined,
      ...(batch.isNewSession ? { sessionCount: { increment: 1 } } : {}),
    },
  });
}
