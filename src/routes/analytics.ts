import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "../lib/http";
import { toNumber } from "../lib/money";
import { requireAdmin } from "../middleware/authMiddleware";
import { buildLiveSnapshot } from "../analytics/live";
import {
  buildReport,
  reportSlug,
  EXPORT_MANIFEST,
  type ExportScope,
} from "../analytics/report";
import { renderCsv, renderXlsx, renderPdf, type ExportFormat } from "../analytics/report-render";

/* ============================================================
   Admin analytics read API.  GET /api/admin/analytics/*
   ------------------------------------------------------------
   Headline totals + trends come from the session/visitor entities
   (accurate distinct counts); dimensioned breakdowns and the funnel
   come from the agg_* rollups. Revenue is always from the
   authoritative business tables (orders / order_items), matching the
   definitions in reports.ts.
   ============================================================ */

const router = Router();
router.use(asyncHandler(requireAdmin));

/** Revenue-bearing statuses (mirrors reports.ts / the dashboard). */
const REVENUE_SQL = "'PLACED','CONFIRMED','PROCESSING','SHIPPED','DELIVERED'";

const RANGE_DAYS: Record<string, number> = { "7": 7, "30": 30, "90": 90, "365": 365 };

function dayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Resolve ?range= into { days, startDay, today, yesterday }. Default 30. */
function resolveRange(raw: unknown) {
  const key = typeof raw === "string" && raw in RANGE_DAYS ? raw : "30";
  const days = RANGE_DAYS[key];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const today = new Date();
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  return { key, days, startDay: dayStr(start), today: dayStr(today), yesterday: dayStr(yest) };
}

/** COUNT()/SUM() come back from MySQL as BigInt or string via $queryRaw. */
const n = (v: unknown): number => (v == null ? 0 : Number(v));

/** Grouped integer formatting for insight copy (e.g. 1,234). */
const num = (v: number): string => new Intl.NumberFormat("en-IN").format(v || 0);

/** $queryRaw returns DATE columns as a UTC-midnight JS Date; normalize back to
    the "YYYY-MM-DD" string the dense day-series loops key on. */
const toDayKey = (v: unknown): string =>
  v instanceof Date
    ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`
    : String(v).slice(0, 10);

/** Sum of finalAmount for revenue-bearing orders in [start, end] day window. */
async function revenueBetween(startDay: string, endDay: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ rev: unknown }[]>(
    `SELECT COALESCE(SUM(finalAmount),0) AS rev
       FROM orders
      WHERE status IN (${REVENUE_SQL})
        AND DATE(placedAt) BETWEEN ? AND ?`,
    startDay,
    endDay
  );
  return n(rows[0]?.rev);
}

async function ordersBetween(startDay: string, endDay: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ c: unknown }[]>(
    `SELECT COUNT(*) AS c FROM orders
      WHERE status IN (${REVENUE_SQL}) AND DATE(placedAt) BETWEEN ? AND ?`,
    startDay,
    endDay
  );
  return n(rows[0]?.c);
}

/* ----------------------------- OVERVIEW ----------------------------- */
router.get(
  "/overview",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    const [revToday, revYest, revRange, ordToday, ordYest, ordRange] = await Promise.all([
      revenueBetween(r.today, r.today),
      revenueBetween(r.yesterday, r.yesterday),
      revenueBetween(r.startDay, r.today),
      ordersBetween(r.today, r.today),
      ordersBetween(r.yesterday, r.yesterday),
      ordersBetween(r.startDay, r.today),
    ]);

    // Visitors/sessions (distinct) from the session entity — accurate totals.
    const visRows = await prisma.$queryRawUnsafe<{ day: string; visitors: unknown; sessions: unknown }[]>(
      `SELECT DATE(startedAt) AS day,
              COUNT(DISTINCT visitorId) AS visitors,
              COUNT(*) AS sessions
         FROM analytics_sessions
        WHERE DATE(startedAt) BETWEEN ? AND ?
        GROUP BY DATE(startedAt)`,
      r.startDay,
      r.today
    );
    const visByDay = new Map(visRows.map((row) => [toDayKey(row.day), row]));
    const visitorsRange = visRows.reduce((s, row) => s + n(row.visitors), 0);
    const sessionsRange = visRows.reduce((s, row) => s + n(row.sessions), 0);
    const visToday = n(visByDay.get(r.today)?.visitors);
    const visYest = n(visByDay.get(r.yesterday)?.visitors);

    // Daily trend (revenue + orders joined onto the visitor day series).
    const revByDay = await prisma.$queryRawUnsafe<{ day: string; rev: unknown; ord: unknown }[]>(
      `SELECT DATE(placedAt) AS day, COALESCE(SUM(finalAmount),0) AS rev, COUNT(*) AS ord
         FROM orders
        WHERE status IN (${REVENUE_SQL}) AND DATE(placedAt) BETWEEN ? AND ?
        GROUP BY DATE(placedAt)`,
      r.startDay,
      r.today
    );
    const revMap = new Map(revByDay.map((row) => [toDayKey(row.day), row]));

    // Build a dense day series so the chart has no gaps.
    const trend: {
      day: string;
      revenue: number;
      orders: number;
      visitors: number;
      sessions: number;
    }[] = [];
    const cursor = new Date(r.startDay + "T00:00:00");
    const end = new Date(r.today + "T00:00:00");
    while (cursor <= end) {
      const key = dayStr(cursor);
      trend.push({
        day: key,
        revenue: n(revMap.get(key)?.rev),
        orders: n(revMap.get(key)?.ord),
        visitors: n(visByDay.get(key)?.visitors),
        sessions: n(visByDay.get(key)?.sessions),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    res.json({
      range: r.key,
      kpis: {
        revenue: { today: revToday, yesterday: revYest, range: revRange },
        orders: { today: ordToday, yesterday: ordYest, range: ordRange },
        visitors: { today: visToday, yesterday: visYest, range: visitorsRange },
        sessions: { range: sessionsRange },
        aov: ordRange > 0 ? revRange / ordRange : 0,
        conversionRate: sessionsRange > 0 ? ordRange / sessionsRange : 0,
      },
      trend,
    });
  })
);

/* ----------------------------- TRAFFIC ----------------------------- */
router.get(
  "/traffic",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    const sessionAgg = await prisma.$queryRawUnsafe<
      { sessions: unknown; visitors: unknown; pageviews: unknown; bounces: unknown; dur: unknown }[]
    >(
      `SELECT COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS visitors,
              SUM(pageviews) AS pageviews, SUM(isBounce) AS bounces,
              SUM(COALESCE(durationSec,0)) AS dur
         FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?`,
      r.startDay,
      r.today
    );
    const a = sessionAgg[0] ?? {};
    const sessions = n(a.sessions);

    const grouped = async (col: string) =>
      prisma.$queryRawUnsafe<{ k: string | null; sessions: unknown; visitors: unknown }[]>(
        `SELECT ${col} AS k, COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS visitors
           FROM analytics_sessions
          WHERE DATE(startedAt) BETWEEN ? AND ?
          GROUP BY ${col} ORDER BY sessions DESC LIMIT 20`,
        r.startDay,
        r.today
      );
    const [byDevice, byBrowser, byOs, byCountry] = await Promise.all([
      grouped("device"),
      grouped("browser"),
      grouped("os"),
      grouped("country"),
    ]);

    const topPages = await prisma.$queryRawUnsafe<{ path: string | null; views: unknown }[]>(
      // Filter on created_day (the partition key) so MySQL prunes to the range's
      // partitions instead of scanning the whole firehose.
      `SELECT path, COUNT(*) AS views FROM analytics_events
        WHERE eventName='page_view' AND created_day BETWEEN ? AND ? AND path IS NOT NULL
        GROUP BY path ORDER BY views DESC LIMIT 15`,
      r.startDay,
      r.today
    );
    const exitPages = await prisma.$queryRawUnsafe<{ path: string | null; c: unknown }[]>(
      `SELECT exitPath AS path, COUNT(*) AS c FROM analytics_sessions
        WHERE DATE(startedAt) BETWEEN ? AND ? AND exitPath IS NOT NULL
        GROUP BY exitPath ORDER BY c DESC LIMIT 15`,
      r.startDay,
      r.today
    );

    const mapKV = (rows: { k: string | null; sessions: unknown; visitors: unknown }[]) =>
      rows.map((row) => ({
        label: row.k || "unknown",
        sessions: n(row.sessions),
        visitors: n(row.visitors),
      }));

    res.json({
      range: r.key,
      totals: {
        sessions,
        visitors: n(a.visitors),
        pageviews: n(a.pageviews),
        bounceRate: sessions > 0 ? n(a.bounces) / sessions : 0,
        avgDurationSec: sessions > 0 ? n(a.dur) / sessions : 0,
        pagesPerSession: sessions > 0 ? n(a.pageviews) / sessions : 0,
      },
      byDevice: mapKV(byDevice),
      byBrowser: mapKV(byBrowser),
      byOs: mapKV(byOs),
      byCountry: mapKV(byCountry),
      topPages: topPages.map((p) => ({ path: p.path, views: n(p.views) })),
      exitPages: exitPages.map((p) => ({ path: p.path, count: n(p.c) })),
    });
  })
);

/* ----------------------- SESSION COMPOSITION ----------------------- */
/** Bucket a raw session `source` into a channel grouping. */
function channelOf(src: string | null | undefined): "Organic" | "Direct" | "Social" | "Referral" {
  const s = (src || "").toLowerCase().trim();
  if (!s || s === "direct" || s === "(direct)" || s === "none") return "Direct";
  if (/instagram|facebook|\bfb\b|whatsapp|twitter|^x$|youtube|tiktok|pinterest|linkedin|snapchat|reddit|telegram|threads|social/.test(s))
    return "Social";
  if (/google|bing|yahoo|duckduckgo|ecosia|baidu|yandex|organic|\bseo\b|search/.test(s))
    return "Organic";
  return "Referral";
}

router.get(
  "/session-composition",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);
    const between = [r.startDay, r.today] as const;

    const [nvr, gvl, devRows, srcRows, entryRows, exitRows] = await Promise.all([
      // New vs returning: ROW_NUMBER over ALL of a visitor's sessions, then
      // filter to the range — so rn=1 means the visitor's first session EVER.
      prisma.$queryRawUnsafe<{ newS: unknown; retS: unknown }[]>(
        `SELECT SUM(rn = 1) AS newS, SUM(rn > 1) AS retS
           FROM (
             SELECT startedAt,
                    ROW_NUMBER() OVER (PARTITION BY visitorId ORDER BY startedAt ASC) AS rn
               FROM analytics_sessions
           ) t
          WHERE DATE(t.startedAt) BETWEEN ? AND ?`,
        ...between
      ),
      prisma.$queryRawUnsafe<{ guest: unknown; loggedIn: unknown }[]>(
        `SELECT SUM(userId IS NULL) AS guest, SUM(userId IS NOT NULL) AS loggedIn
           FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?`,
        ...between
      ),
      prisma.$queryRawUnsafe<{ k: string | null; c: unknown }[]>(
        `SELECT device AS k, COUNT(*) AS c FROM analytics_sessions
          WHERE DATE(startedAt) BETWEEN ? AND ? GROUP BY device`,
        ...between
      ),
      prisma.$queryRawUnsafe<{ k: string | null; c: unknown }[]>(
        `SELECT source AS k, COUNT(*) AS c FROM analytics_sessions
          WHERE DATE(startedAt) BETWEEN ? AND ? GROUP BY source`,
        ...between
      ),
      prisma.$queryRawUnsafe<{ path: string | null; c: unknown }[]>(
        `SELECT entryPath AS path, COUNT(*) AS c FROM analytics_sessions
          WHERE DATE(startedAt) BETWEEN ? AND ? AND entryPath IS NOT NULL
          GROUP BY entryPath ORDER BY c DESC LIMIT 12`,
        ...between
      ),
      prisma.$queryRawUnsafe<{ path: string | null; c: unknown }[]>(
        `SELECT exitPath AS path, COUNT(*) AS c FROM analytics_sessions
          WHERE DATE(startedAt) BETWEEN ? AND ? AND exitPath IS NOT NULL
          GROUP BY exitPath ORDER BY c DESC LIMIT 12`,
        ...between
      ),
    ]);

    const newS = n(nvr[0]?.newS);
    const retS = n(nvr[0]?.retS);

    // Device — keep the canonical three, fold the rest into "Other".
    const devCounts: Record<string, number> = { Mobile: 0, Desktop: 0, Tablet: 0, Other: 0 };
    for (const row of devRows) {
      const d = (row.k || "").toLowerCase();
      const key = d === "mobile" ? "Mobile" : d === "desktop" ? "Desktop" : d === "tablet" ? "Tablet" : "Other";
      devCounts[key] += n(row.c);
    }
    const byDevice = (["Mobile", "Desktop", "Tablet", "Other"] as const)
      .map((label) => ({ label, value: devCounts[label] }))
      .filter((d) => d.value > 0);

    // Channel — bucket every raw source into the four marketing channels.
    const chCounts: Record<string, number> = { Organic: 0, Direct: 0, Social: 0, Referral: 0 };
    for (const row of srcRows) chCounts[channelOf(row.k)] += n(row.c);
    const byChannel = (["Organic", "Direct", "Social", "Referral"] as const)
      .map((label) => ({ label, value: chCounts[label] }))
      .filter((d) => d.value > 0);

    res.json({
      range: r.key,
      totalSessions: newS + retS,
      newVsReturning: [
        { label: "New", value: newS },
        { label: "Returning", value: retS },
      ],
      guestVsLoggedIn: [
        { label: "Logged in", value: n(gvl[0]?.loggedIn) },
        { label: "Guest", value: n(gvl[0]?.guest) },
      ],
      byDevice,
      byChannel,
      entryPages: entryRows.map((p) => ({ path: p.path, count: n(p.c) })),
      exitPages: exitRows.map((p) => ({ path: p.path, count: n(p.c) })),
    });
  })
);

/* ----------------------- ACTIVE USERS (DAU/WAU/MAU) ----------------------- */
// Enterprise activity metrics. "Active user" = a distinct visitor with a
// session that day. DAU/WAU/MAU windows are anchored at the end of the range
// and clamped to its start, so everything respects the selected date range.
// Stickiness = avg DAU / MAU (the textbook "share of monthly users present on
// an average day"). "New" = a visitor whose first-ever session is in range.
router.get(
  "/active-users",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    // Trailing window starts, clamped to the range start.
    const clampStart = (back: number): string => {
      const d = new Date(r.today + "T00:00:00");
      d.setDate(d.getDate() - back);
      const s = dayStr(d);
      return s < r.startDay ? r.startDay : s;
    };
    const wauStart = clampStart(6);
    const mauStart = clampStart(29);

    const distinctUsers = async (s: string, e: string): Promise<number> => {
      const rows = await prisma.$queryRawUnsafe<{ c: unknown }[]>(
        `SELECT COUNT(DISTINCT visitorId) AS c FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?`,
        s,
        e
      );
      return n(rows[0]?.c);
    };

    const [perDay, newPerDay, totalsRows, newInRangeRows, wau, mau] = await Promise.all([
      // Per-day actives, sessions and auth split.
      prisma.$queryRawUnsafe<
        { day: string; activeUsers: unknown; sessions: unknown; loggedIn: unknown; guest: unknown }[]
      >(
        `SELECT DATE(startedAt) AS day,
                COUNT(DISTINCT visitorId) AS activeUsers,
                COUNT(*) AS sessions,
                COUNT(DISTINCT CASE WHEN userId IS NOT NULL THEN visitorId END) AS loggedIn,
                COUNT(DISTINCT CASE WHEN userId IS NULL THEN visitorId END) AS guest
           FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?
          GROUP BY DATE(startedAt)`,
        r.startDay,
        r.today
      ),
      // New users per day = visitors whose first-ever session lands that day.
      prisma.$queryRawUnsafe<{ day: string; newUsers: unknown }[]>(
        `SELECT f.day AS day, COUNT(*) AS newUsers FROM (
           SELECT visitorId, DATE(MIN(startedAt)) AS day FROM analytics_sessions GROUP BY visitorId
         ) f WHERE f.day BETWEEN ? AND ? GROUP BY f.day`,
        r.startDay,
        r.today
      ),
      // Range totals for the engagement KPIs.
      prisma.$queryRawUnsafe<{ sessions: unknown; users: unknown; bounces: unknown; dur: unknown }[]>(
        `SELECT COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS users,
                SUM(isBounce) AS bounces, SUM(COALESCE(durationSec,0)) AS dur
           FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?`,
        r.startDay,
        r.today
      ),
      prisma.$queryRawUnsafe<{ c: unknown }[]>(
        `SELECT COUNT(*) AS c FROM (
           SELECT visitorId, DATE(MIN(startedAt)) AS f FROM analytics_sessions GROUP BY visitorId
         ) t WHERE t.f BETWEEN ? AND ?`,
        r.startDay,
        r.today
      ),
      distinctUsers(wauStart, r.today),
      distinctUsers(mauStart, r.today),
    ]);

    const dayMap = new Map(perDay.map((row) => [toDayKey(row.day), row]));
    const newMap = new Map(newPerDay.map((row) => [toDayKey(row.day), n(row.newUsers)]));

    // Dense day series so the charts have no gaps; cumulative sessions = growth.
    const trend: {
      day: string;
      activeUsers: number;
      newUsers: number;
      returningUsers: number;
      loggedIn: number;
      guest: number;
      sessions: number;
      cumulativeSessions: number;
    }[] = [];
    let cumulative = 0;
    let activeSum = 0;
    const cursor = new Date(r.startDay + "T00:00:00");
    const end = new Date(r.today + "T00:00:00");
    while (cursor <= end) {
      const key = dayStr(cursor);
      const row = dayMap.get(key);
      const activeUsers = n(row?.activeUsers);
      const newUsers = Math.min(activeUsers, newMap.get(key) ?? 0);
      const sessions = n(row?.sessions);
      cumulative += sessions;
      activeSum += activeUsers;
      trend.push({
        day: key,
        activeUsers,
        newUsers,
        returningUsers: Math.max(0, activeUsers - newUsers),
        loggedIn: n(row?.loggedIn),
        guest: n(row?.guest),
        sessions,
        cumulativeSessions: cumulative,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    const t = totalsRows[0] ?? {};
    const sessions = n(t.sessions);
    const users = n(t.users);
    const newInRange = n(newInRangeRows[0]?.c);
    const avgDau = r.days > 0 ? activeSum / r.days : 0;

    res.json({
      range: r.key,
      kpis: {
        dau: avgDau, // average distinct actives / day across the range
        wau,
        mau,
        stickiness: mau > 0 ? avgDau / mau : 0,
        avgSessionDuration: sessions > 0 ? n(t.dur) / sessions : 0,
        sessionsPerUser: users > 0 ? sessions / users : 0,
        bounceRate: sessions > 0 ? n(t.bounces) / sessions : 0,
        returningUserRate: users > 0 ? (users - newInRange) / users : 0,
      },
      trend,
    });
  })
);

/* ------------------------- MARKETING ATTRIBUTION ------------------------- */
/** The marketing channels we report, in display order. */
const CHANNELS = [
  "Organic Search",
  "Direct",
  "Instagram",
  "Facebook",
  "YouTube",
  "Google Ads",
  "Referral",
  "Email",
  "QR Code",
  "Other Campaigns",
] as const;
type Channel = (typeof CHANNELS)[number];

const AD_SPEND_KEY = "analytics:adSpend";
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Saved spend is date-bound: { "YYYY-MM": { channel: amount>0 } }. Read it
    back cleaned, skipping non-month keys (also drops the old flat format). */
function readMonthlySpend(value: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [month, channels] of Object.entries(value as Record<string, unknown>)) {
    if (!MONTH_RE.test(month) || !channels || typeof channels !== "object" || Array.isArray(channels)) continue;
    const clean: Record<string, number> = {};
    for (const [ch, v] of Object.entries(channels as Record<string, unknown>)) {
      const amt = Number(v);
      if (Number.isFinite(amt) && amt > 0) clean[ch] = amt;
    }
    if (Object.keys(clean).length) out[month] = clean;
  }
  return out;
}

const daysInMonth = (year: number, month1: number) => new Date(year, month1, 0).getDate();

/** Prorate each month's per-channel budget by the share of that month's days
    that fall inside [startDay, endDay] (inclusive), so ROAS scales with the
    selected range — e.g. a 7-day window gets 7/30 of that month's budget. */
function spendForRange(
  monthly: Record<string, Record<string, number>>,
  startDay: string,
  endDay: string
): Record<string, number> {
  const overlap: Record<string, number> = {};
  const cur = new Date(startDay + "T00:00:00");
  const end = new Date(endDay + "T00:00:00");
  while (cur <= end) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
    overlap[key] = (overlap[key] ?? 0) + 1;
    cur.setDate(cur.getDate() + 1);
  }
  const out: Record<string, number> = {};
  for (const [month, channels] of Object.entries(monthly)) {
    const ov = overlap[month];
    if (!ov) continue;
    const [y, m] = month.split("-").map(Number);
    const frac = ov / daysInMonth(y, m);
    for (const [ch, amt] of Object.entries(channels)) out[ch] = (out[ch] ?? 0) + amt * frac;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}

/** Bucket a (source, medium, campaign) tuple into one marketing channel.
    Order matters: paid/social/email/qr are detected before generic search. */
function attributionChannel(source?: string | null, medium?: string | null, campaign?: string | null): Channel {
  const s = (source || "").toLowerCase().trim();
  const m = (medium || "").toLowerCase().trim();
  const ca = (campaign || "").toLowerCase().trim();
  const inS = (...w: string[]) => w.some((x) => s.includes(x));

  if (inS("instagram") || s === "ig") return "Instagram";
  if (inS("facebook", "meta") || s === "fb") return "Facebook";
  if (inS("youtube") || s === "yt") return "YouTube";
  if (m === "email" || inS("email", "newsletter", "mailchimp", "klaviyo", "sendgrid")) return "Email";
  if (m === "qr" || inS("qr") || ca.includes("qr")) return "QR Code";
  if (["cpc", "ppc", "paid", "paidsearch", "paid_search", "sem", "adwords"].includes(m) || inS("google_ads", "googleads", "gads", "adwords"))
    return "Google Ads";
  if (m === "organic" || inS("google", "bing", "yahoo", "duckduckgo", "ecosia", "baidu", "yandex", "search", "seo", "organic"))
    return "Organic Search";
  if (!s || s === "direct" || s === "(direct)" || s === "none") return ca ? "Other Campaigns" : "Direct";
  if (m === "referral") return "Referral";
  if (ca) return "Other Campaigns";
  return "Referral";
}

router.get(
  "/attribution",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    // Sessions + users by the session's own source (acquisition).
    const sessRows = await prisma.$queryRawUnsafe<
      { s: string | null; m: string | null; ca: string | null; sessions: unknown; users: unknown }[]
    >(
      `SELECT source AS s, medium AS m, campaign AS ca,
              COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS users
         FROM analytics_sessions
        WHERE DATE(startedAt) BETWEEN ? AND ?
        GROUP BY source, medium, campaign`,
      r.startDay,
      r.today
    );

    // Orders + revenue, first-touch attributed to the buyer's first visit.
    // Orders by users we never tracked fall back to direct via the LEFT JOIN.
    const ordRows = await prisma.$queryRawUnsafe<
      { s: string | null; m: string | null; ca: string | null; orders: unknown; revenue: unknown }[]
    >(
      `SELECT v.firstSource AS s, v.firstMedium AS m, v.firstCampaign AS ca,
              COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.finalAmount),0) AS revenue
         FROM orders o
         LEFT JOIN analytics_visitors v ON v.userId = o.userId
        WHERE o.status IN (${REVENUE_SQL}) AND DATE(o.placedAt) BETWEEN ? AND ?
        GROUP BY v.firstSource, v.firstMedium, v.firstCampaign`,
      r.startDay,
      r.today
    );

    // Optional ad spend per channel: SiteSetting "analytics:adSpend" holds a
    // JSON map { "Google Ads": 5000, "Instagram": 3000, ... } for the period.
    // ROAS is computed only where spend > 0.
    const spendRow = await prisma.siteSetting.findUnique({ where: { key: AD_SPEND_KEY } });
    const spendMap = spendForRange(readMonthlySpend(spendRow?.value), r.startDay, r.today);

    type Acc = { users: number; sessions: number; orders: number; revenue: number };
    const acc: Record<Channel, Acc> = Object.fromEntries(
      CHANNELS.map((ch) => [ch, { users: 0, sessions: 0, orders: 0, revenue: 0 }])
    ) as Record<Channel, Acc>;

    for (const row of sessRows) {
      const ch = attributionChannel(row.s, row.m, row.ca);
      acc[ch].sessions += n(row.sessions);
      acc[ch].users += n(row.users);
    }
    for (const row of ordRows) {
      const ch = attributionChannel(row.s, row.m, row.ca);
      acc[ch].orders += n(row.orders);
      acc[ch].revenue += n(row.revenue);
    }

    const channels = CHANNELS.map((channel) => {
      const a = acc[channel];
      const spend = spendMap[channel] ?? null;
      return {
        channel,
        users: a.users,
        sessions: a.sessions,
        orders: a.orders,
        revenue: a.revenue,
        conversionRate: a.sessions > 0 ? a.orders / a.sessions : 0,
        aov: a.orders > 0 ? a.revenue / a.orders : 0,
        spend,
        roas: spend && spend > 0 ? a.revenue / spend : null,
      };
    }).filter((c) => c.sessions > 0 || c.revenue > 0 || c.spend != null);

    const totals = channels.reduce(
      (t, c) => {
        t.users += c.users;
        t.sessions += c.sessions;
        t.orders += c.orders;
        t.revenue += c.revenue;
        t.spend += c.spend ?? 0;
        return t;
      },
      { users: 0, sessions: 0, orders: 0, revenue: 0, spend: 0 }
    );

    res.json({
      range: r.key,
      hasSpend: channels.some((c) => c.spend != null),
      channels,
      totals: {
        ...totals,
        conversionRate: totals.sessions > 0 ? totals.orders / totals.sessions : 0,
        aov: totals.orders > 0 ? totals.revenue / totals.orders : 0,
        roas: totals.spend > 0 ? totals.revenue / totals.spend : null,
      },
    });
  })
);

/* ------- Ad spend editor (date-bound monthly budgets; feeds ROAS) ------- */
router.get(
  "/ad-spend",
  asyncHandler(async (_req: Request, res: Response) => {
    const row = await prisma.siteSetting.findUnique({ where: { key: AD_SPEND_KEY } });
    res.json({ channels: CHANNELS, months: readMonthlySpend(row?.value) });
  })
);

router.put(
  "/ad-spend",
  asyncHandler(async (req: Request, res: Response) => {
    // Body: { month: "YYYY-MM", spend: {channel: amount} } — updates only that
    // month, leaving other months' budgets untouched.
    const month = typeof req.body?.month === "string" ? req.body.month : "";
    if (!MONTH_RE.test(month)) {
      res.status(400).json({ error: "month must be 'YYYY-MM'" });
      return;
    }
    const body = (req.body?.spend ?? {}) as Record<string, unknown>;
    const clean: Record<string, number> = {};
    for (const ch of CHANNELS) {
      const amt = Number(body[ch]);
      if (Number.isFinite(amt) && amt > 0) clean[ch] = Math.round(amt);
    }
    const row = await prisma.siteSetting.findUnique({ where: { key: AD_SPEND_KEY } });
    const months = readMonthlySpend(row?.value);
    if (Object.keys(clean).length) months[month] = clean;
    else delete months[month]; // clearing every field removes the month
    await prisma.siteSetting.upsert({
      where: { key: AD_SPEND_KEY },
      create: { key: AD_SPEND_KEY, value: months },
      update: { value: months },
    });
    res.json({ channels: CHANNELS, months });
  })
);

/* ----------------------------- SOURCES ----------------------------- */
router.get(
  "/sources",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);
    // Funnel rollup carries visitors + orders + first-touch revenue per source.
    const rows = await prisma.$queryRawUnsafe<
      {
        source: string;
        visitors: unknown;
        productViews: unknown;
        addToCart: unknown;
        orders: unknown;
        revenue: unknown;
      }[]
    >(
      `SELECT source,
              SUM(visitors) AS visitors,
              SUM(productViews) AS productViews,
              SUM(addToCart) AS addToCart,
              SUM(orders) AS orders,
              SUM(revenue) AS revenue
         FROM agg_daily_funnel
        WHERE day BETWEEN ? AND ?
        GROUP BY source ORDER BY revenue DESC, visitors DESC`,
      r.startDay,
      r.today
    );
    res.json({
      range: r.key,
      sources: rows.map((row) => {
        const visitors = n(row.visitors);
        // agg_daily_funnel.orders holds "requests submitted" (event-based intent);
        // revenue is authoritative confirmed-order revenue (first-touch attributed).
        const requests = n(row.orders);
        return {
          source: row.source,
          visitors,
          productViews: n(row.productViews),
          addToCart: n(row.addToCart),
          requests,
          revenue: n(row.revenue),
          conversionRate: visitors > 0 ? requests / visitors : 0,
        };
      }),
    });
  })
);

/* ----------------------------- FUNNEL ----------------------------- */
// One consistent denominator: every stage is a distinct-session count summed
// over the range (session-days), EXCEPT the final "Orders confirmed" stage,
// which is the authoritative count of confirmed orders from the orders table
// (realized sales). "Requests" = order requests submitted (intent). Ratios are
// clamped to ≤100% because session sets per step aren't strict supersets.
router.get(
  "/funnel",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    // Stage 1 denominator: total sessions (session-days) from the traffic rollup.
    const sessRows = await prisma.$queryRawUnsafe<{ s: unknown }[]>(
      `SELECT COALESCE(SUM(sessions),0) AS s FROM agg_daily_traffic WHERE day BETWEEN ? AND ?`,
      r.startDay,
      r.today
    );
    const rows = await prisma.$queryRawUnsafe<
      { productViews: unknown; addToCart: unknown; checkoutStarted: unknown; orders: unknown }[]
    >(
      `SELECT SUM(productViews) AS productViews,
              SUM(addToCart) AS addToCart, SUM(checkoutStarted) AS checkoutStarted,
              SUM(orders) AS orders
         FROM agg_daily_funnel WHERE day BETWEEN ? AND ?`,
      r.startDay,
      r.today
    );
    const a = rows[0] ?? {};
    const ordersConfirmed = await ordersBetween(r.startDay, r.today);
    const raw = [
      { name: "Sessions", count: n(sessRows[0]?.s) },
      { name: "Product Views", count: n(a.productViews) },
      { name: "Add to Cart", count: n(a.addToCart) },
      { name: "Checkout", count: n(a.checkoutStarted) },
      { name: "Requests", count: n(a.orders) },
      { name: "Orders Confirmed", count: ordersConfirmed },
    ];
    const top = raw[0].count || 1;
    const stages = raw.map((s, i) => ({
      ...s,
      pctOfTop: Math.min(1, s.count / top),
      pctOfPrev: i === 0 ? 1 : raw[i - 1].count > 0 ? Math.min(1, s.count / raw[i - 1].count) : 0,
    }));
    res.json({ range: r.key, denominator: "sessions", stages });
  })
);

/* ----------------------------- PRODUCTS ----------------------------- */
router.get(
  "/products",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);
    const rows = await prisma.$queryRawUnsafe<
      {
        productId: number;
        name: string;
        views: unknown;
        addToCart: unknown;
        purchases: unknown;
        qtySold: unknown;
        revenue: unknown;
      }[]
    >(
      `SELECT ap.productId, p.name,
              SUM(ap.views) AS views, SUM(ap.addToCart) AS addToCart,
              SUM(ap.purchases) AS purchases, SUM(ap.qtySold) AS qtySold,
              SUM(ap.revenue) AS revenue
         FROM agg_daily_product ap
         JOIN products p ON p.id = ap.productId
        WHERE ap.day BETWEEN ? AND ?
        GROUP BY ap.productId, p.name
        ORDER BY revenue DESC, views DESC
        LIMIT 100`,
      r.startDay,
      r.today
    );
    res.json({
      range: r.key,
      products: rows.map((row) => {
        const views = n(row.views);
        const purchases = n(row.purchases);
        return {
          productId: row.productId,
          name: row.name,
          views,
          addToCart: n(row.addToCart),
          purchases,
          qtySold: n(row.qtySold),
          revenue: n(row.revenue),
          conversionRate: views > 0 ? purchases / views : 0,
        };
      }),
    });
  })
);

/* ----------------------------- SEARCH ----------------------------- */
router.get(
  "/search",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    // Previous equal-length window, for trending momentum.
    const prevStartD = new Date(r.startDay + "T00:00:00");
    prevStartD.setDate(prevStartD.getDate() - r.days);
    const prevStart = dayStr(prevStartD);
    const prevEndD = new Date(r.startDay + "T00:00:00");
    prevEndD.setDate(prevEndD.getDate() - 1);
    const prevEnd = dayStr(prevEndD);

    const [top, zero, totals, trend, behaviour] = await Promise.all([
      // 1. Most searched keywords.
      prisma.$queryRawUnsafe<{ term: string; searches: unknown }[]>(
        `SELECT term, SUM(searches) AS searches FROM agg_search_terms
          WHERE day BETWEEN ? AND ? GROUP BY term ORDER BY searches DESC LIMIT 25`,
        r.startDay,
        r.today
      ),
      // 2. Searches with no results.
      prisma.$queryRawUnsafe<{ term: string; zeroResult: unknown }[]>(
        `SELECT term, SUM(zeroResult) AS zeroResult FROM agg_search_terms
          WHERE day BETWEEN ? AND ? GROUP BY term HAVING SUM(zeroResult) > 0
          ORDER BY zeroResult DESC LIMIT 25`,
        r.startDay,
        r.today
      ),
      // KPI denominators.
      prisma.$queryRawUnsafe<{ searches: unknown; zero: unknown; terms: unknown }[]>(
        `SELECT COALESCE(SUM(searches),0) AS searches, COALESCE(SUM(zeroResult),0) AS zero,
                COUNT(DISTINCT term) AS terms
           FROM agg_search_terms WHERE day BETWEEN ? AND ?`,
        r.startDay,
        r.today
      ),
      // 4. Trending: current vs previous equal window (per term).
      prisma.$queryRawUnsafe<{ term: string; cur: unknown; prev: unknown }[]>(
        `SELECT term,
                SUM(CASE WHEN day BETWEEN ? AND ? THEN searches ELSE 0 END) AS cur,
                SUM(CASE WHEN day BETWEEN ? AND ? THEN searches ELSE 0 END) AS prev
           FROM agg_search_terms
          WHERE day BETWEEN ? AND ?
          GROUP BY term HAVING cur > 0
          ORDER BY cur DESC LIMIT 200`,
        r.startDay,
        r.today,
        prevStart,
        prevEnd,
        prevStart,
        r.today
      ),
      // 3 + 5. Session-level: of sessions that searched, how many went on to
      // purchase (search→purchase) and how many engaged afterwards (the rest
      // are abandoned searches). `lastEngageAt > firstSearchAt` = a product
      // view or add-to-cart happened AFTER the first search in that session.
      prisma.$queryRawUnsafe<{ searchSessions: unknown; purchaseSessions: unknown; engagedSessions: unknown }[]>(
        `SELECT COUNT(*) AS searchSessions,
                SUM(t.hasPurchase) AS purchaseSessions,
                SUM(t.lastEngageAt IS NOT NULL AND t.lastEngageAt > t.firstSearchAt) AS engagedSessions
           FROM (
             SELECT e.sessionId,
                    MIN(CASE WHEN e.eventName = 'search' THEN e.createdAt END) AS firstSearchAt,
                    MAX(CASE WHEN e.eventName IN ('product_view','add_to_cart') THEN e.createdAt END) AS lastEngageAt,
                    MAX(e.eventName IN ('request_submitted','order_placed','order_confirmed')) AS hasPurchase
               FROM analytics_events e
              WHERE e.created_day BETWEEN ? AND ?
              GROUP BY e.sessionId
           ) t
          WHERE t.firstSearchAt IS NOT NULL`,
        r.startDay,
        r.today
      ),
    ]);

    const totalSearches = n(totals[0]?.searches);
    const zeroTotal = n(totals[0]?.zero);
    const searchSessions = n(behaviour[0]?.searchSessions);
    const purchaseSessions = n(behaviour[0]?.purchaseSessions);
    const engagedSessions = n(behaviour[0]?.engagedSessions);

    const trending = trend
      .map((row) => {
        const current = n(row.cur);
        const previous = n(row.prev);
        return {
          term: row.term,
          current,
          previous,
          delta: current - previous,
          growth: previous > 0 ? (current - previous) / previous : null, // null = brand-new term
        };
      })
      .filter((t) => t.delta > 0)
      .sort((a, b) => b.delta - a.delta || b.current - a.current)
      .slice(0, 12);

    res.json({
      range: r.key,
      kpis: {
        totalSearches,
        uniqueTerms: n(totals[0]?.terms),
        zeroResultRate: totalSearches > 0 ? zeroTotal / totalSearches : 0,
        searchSessions,
        searchToPurchaseRate: searchSessions > 0 ? purchaseSessions / searchSessions : 0,
        abandonmentRate: searchSessions > 0 ? 1 - engagedSessions / searchSessions : 0,
      },
      top: top.map((t) => ({ term: t.term, searches: n(t.searches) })),
      zeroResult: zero.map((t) => ({ term: t.term, searches: n(t.zeroResult) })),
      trending,
    });
  })
);

/* ----------------------------- CUSTOMERS ----------------------------- */
router.get(
  "/customers",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    // All-time customer base (paid orders only).
    const [totalRows, repeatRows, revRows] = await Promise.all([
      prisma.$queryRawUnsafe<{ c: unknown }[]>(
        `SELECT COUNT(DISTINCT userId) AS c FROM orders WHERE status IN (${REVENUE_SQL})`
      ),
      prisma.$queryRawUnsafe<{ c: unknown }[]>(
        `SELECT COUNT(*) AS c FROM (
           SELECT userId FROM orders WHERE status IN (${REVENUE_SQL})
            GROUP BY userId HAVING COUNT(*) >= 2) t`
      ),
      prisma.$queryRawUnsafe<{ rev: unknown }[]>(
        `SELECT COALESCE(SUM(finalAmount),0) AS rev FROM orders WHERE status IN (${REVENUE_SQL})`
      ),
    ]);
    const totalCustomers = n(totalRows[0]?.c);
    const repeatCustomers = n(repeatRows[0]?.c);
    const lifetimeRevenue = n(revRows[0]?.rev);

    const newInRange = await prisma.$queryRawUnsafe<{ c: unknown }[]>(
      `SELECT COUNT(*) AS c FROM (
         SELECT userId, MIN(DATE(placedAt)) AS f FROM orders WHERE status IN (${REVENUE_SQL})
          GROUP BY userId HAVING f BETWEEN ? AND ?) t`,
      r.startDay,
      r.today
    );

    // Per-customer aggregate (all-time, paid orders) — reused for segmentation
    // and the value/recency lists. Dormancy windows are fixed business rules:
    //   recently active ≤30d · active ≤90d · cooling 91–180d · dormant >180d.
    const CUST = `SELECT userId, COUNT(*) AS orders, SUM(finalAmount) AS ltv,
                         MIN(placedAt) AS firstOrder, MAX(placedAt) AS lastOrder
                    FROM orders WHERE status IN (${REVENUE_SQL}) GROUP BY userId`;

    const custCols = `u.id, u.name, u.email, c.orders, c.ltv, c.lastOrder AS last`;
    type CustRow = { id: number; name: string | null; email: string | null; orders: unknown; ltv: unknown; last: Date };
    const mapCust = (t: CustRow) => ({
      id: t.id,
      name: t.name || t.email || `User #${t.id}`,
      orders: n(t.orders),
      ltv: n(t.ltv),
      lastOrder: t.last,
    });

    const [top, monthly, segRows, dormantList, recentList] = await Promise.all([
      // Top customers by lifetime value.
      prisma.$queryRawUnsafe<CustRow[]>(
        `SELECT ${custCols} FROM ( ${CUST} ) c JOIN \`User\` u ON u.id = c.userId
          ORDER BY c.ltv DESC LIMIT 10`
      ),
      // Monthly new vs returning customers (within range).
      prisma.$queryRawUnsafe<{ ym: string; customers: unknown; newC: unknown }[]>(
        `SELECT DATE_FORMAT(o.placedAt,'%Y-%m') AS ym,
                COUNT(DISTINCT o.userId) AS customers,
                COUNT(DISTINCT CASE WHEN DATE_FORMAT(f.f,'%Y-%m') = DATE_FORMAT(o.placedAt,'%Y-%m')
                                    THEN o.userId END) AS newC
           FROM orders o
           JOIN (SELECT userId, MIN(placedAt) AS f FROM orders WHERE status IN (${REVENUE_SQL})
                  GROUP BY userId) f ON f.userId = o.userId
          WHERE o.status IN (${REVENUE_SQL}) AND DATE(o.placedAt) BETWEEN ? AND ?
          GROUP BY ym ORDER BY ym`,
        r.startDay,
        r.today
      ),
      // Segmentation + averages across the whole base.
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(orders),0) AS totalOrders,
                COALESCE(SUM(ltv),0) AS totalLtv,
                SUM(DATEDIFF(NOW(), lastOrder) <= 30) AS recentlyActive,
                SUM(DATEDIFF(NOW(), lastOrder) <= 90) AS active,
                SUM(DATEDIFF(NOW(), lastOrder) BETWEEN 91 AND 180) AS cooling,
                SUM(DATEDIFF(NOW(), lastOrder) > 180) AS dormant,
                SUM(orders = 1) AS oneTime,
                SUM(orders = 2) AS repeat2,
                SUM(orders BETWEEN 3 AND 4) AS loyal,
                SUM(orders >= 5) AS vip
           FROM ( ${CUST} ) c`
      ),
      // Dormant customers (>180d), most valuable first — re-engagement targets.
      prisma.$queryRawUnsafe<CustRow[]>(
        `SELECT ${custCols} FROM ( ${CUST} ) c JOIN \`User\` u ON u.id = c.userId
          WHERE DATEDIFF(NOW(), c.lastOrder) > 180 ORDER BY c.ltv DESC LIMIT 10`
      ),
      // Recently active (≤30d), most recent first.
      prisma.$queryRawUnsafe<CustRow[]>(
        `SELECT ${custCols} FROM ( ${CUST} ) c JOIN \`User\` u ON u.id = c.userId
          WHERE DATEDIFF(NOW(), c.lastOrder) <= 30 ORDER BY c.lastOrder DESC LIMIT 10`
      ),
    ]);

    const s = segRows[0] ?? {};
    const totalOrders = n(s.totalOrders);
    const segTotal = n(s.total);

    res.json({
      range: r.key,
      kpis: {
        totalCustomers,
        repeatCustomers,
        repeatRate: totalCustomers > 0 ? repeatCustomers / totalCustomers : 0,
        avgLtv: totalCustomers > 0 ? lifetimeRevenue / totalCustomers : 0,
        newInRange: n(newInRange[0]?.c),
        aov: totalOrders > 0 ? n(s.totalLtv) / totalOrders : 0,
        avgOrders: segTotal > 0 ? totalOrders / segTotal : 0,
        vipCustomers: n(s.vip),
        activeCustomers: n(s.active),
        recentlyActive: n(s.recentlyActive),
        dormantCustomers: n(s.dormant),
      },
      segments: {
        lifecycle: [
          { label: "Active (≤90d)", value: n(s.active) },
          { label: "Cooling (91–180d)", value: n(s.cooling) },
          { label: "Dormant (>180d)", value: n(s.dormant) },
        ],
        frequency: [
          { label: "One-time", value: n(s.oneTime) },
          { label: "Repeat (2)", value: n(s.repeat2) },
          { label: "Loyal (3–4)", value: n(s.loyal) },
          { label: "VIP (5+)", value: n(s.vip) },
        ],
      },
      topCustomers: top.map(mapCust),
      dormantCustomers: dormantList.map(mapCust),
      recentCustomers: recentList.map(mapCust),
      monthly: monthly.map((m) => {
        const customers = n(m.customers);
        const newC = n(m.newC);
        return { month: m.ym, newCustomers: newC, returningCustomers: customers - newC };
      }),
    });
  })
);

/* ----------------------------- PERFORMANCE ----------------------------- */
router.get(
  "/performance",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);
    const rows = await prisma.$queryRawUnsafe<
      { metric: string; rating: string; samples: unknown; sumValue: unknown }[]
    >(
      `SELECT metric, rating, SUM(samples) AS samples, SUM(sumValue) AS sumValue
         FROM agg_daily_perf WHERE day BETWEEN ? AND ?
        GROUP BY metric, rating`,
      r.startDay,
      r.today
    );
    // Fold the rating buckets up to one row per metric.
    const byMetric = new Map<
      string,
      { metric: string; samples: number; sum: number; good: number; ni: number; poor: number }
    >();
    for (const row of rows) {
      const m = byMetric.get(row.metric) ?? {
        metric: row.metric,
        samples: 0,
        sum: 0,
        good: 0,
        ni: 0,
        poor: 0,
      };
      const s = n(row.samples);
      m.samples += s;
      m.sum += n(row.sumValue);
      if (row.rating === "good") m.good += s;
      else if (row.rating === "poor") m.poor += s;
      else if (row.rating === "needs-improvement") m.ni += s;
      byMetric.set(row.metric, m);
    }
    res.json({
      range: r.key,
      metrics: [...byMetric.values()].map((m) => ({
        metric: m.metric,
        samples: m.samples,
        avg: m.samples > 0 ? m.sum / m.samples : 0,
        good: m.good,
        needsImprovement: m.ni,
        poor: m.poor,
        goodRate: m.samples > 0 ? m.good / m.samples : 0,
      })),
    });
  })
);

/* ----------------------------- INSIGHTS ----------------------------- */
// Automated "what changed" analysis. Compares the selected range to the
// preceding equal-length window and surfaces notable movements, plus a few
// point-in-time checks (low stock, refund level, traffic spikes). Each insight
// is fully self-contained and pre-classified by severity so the UI just renders
// it — no thresholds or business logic leak into the frontend.

type InsightSeverity = "critical" | "warning" | "positive" | "info";
interface Insight {
  id: string;
  category: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  metric: { value: number; format: "money" | "number" | "percent" } | null;
  deltaPct: number | null;
  priority: number;
}

const LOW_STOCK = 5;
const SEV_WEIGHT: Record<InsightSeverity, number> = {
  critical: 1000,
  warning: 600,
  positive: 300,
  info: 100,
};

/** Compact INR for insight copy — mirrors the frontend's inrCompact(). */
function inrShort(a: number): string {
  if (a >= 1e7) return `₹${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `₹${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${Math.round(a / 1e3)}k`;
  return `₹${Math.round(a || 0)}`;
}
const pctS = (x: number) => `${(x * 100).toFixed(1)}%`;
const round0 = (x: number) => Math.round(x);
const pctChange = (cur: number, prev: number): number | null =>
  prev > 0 ? ((cur - prev) / prev) * 100 : null;

router.get(
  "/insights",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);

    // Preceding equal-length window, ending the day before this range starts.
    const prevEndD = new Date(r.startDay + "T00:00:00");
    prevEndD.setDate(prevEndD.getDate() - 1);
    const prevEnd = dayStr(prevEndD);
    const prevStartD = new Date(prevEndD);
    prevStartD.setDate(prevStartD.getDate() - (r.days - 1));
    const prevStart = dayStr(prevStartD);

    const sessionsBetween = async (s: string, e: string) => {
      const rows = await prisma.$queryRawUnsafe<{ c: unknown }[]>(
        `SELECT COUNT(*) AS c FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?`,
        s,
        e
      );
      return n(rows[0]?.c);
    };
    const funnelBetween = async (s: string, e: string) => {
      const rows = await prisma.$queryRawUnsafe<{ atc: unknown; ord: unknown }[]>(
        `SELECT COALESCE(SUM(addToCart),0) AS atc, COALESCE(SUM(orders),0) AS ord
           FROM agg_daily_funnel WHERE day BETWEEN ? AND ?`,
        s,
        e
      );
      return { addToCart: n(rows[0]?.atc), requests: n(rows[0]?.ord) };
    };
    const returningBetween = async (s: string, e: string) => {
      // rn=1 = the visitor's first session EVER; rn>1 = a return visit.
      const rows = await prisma.$queryRawUnsafe<{ newS: unknown; retS: unknown }[]>(
        `SELECT SUM(rn = 1) AS newS, SUM(rn > 1) AS retS FROM (
           SELECT startedAt, ROW_NUMBER() OVER (PARTITION BY visitorId ORDER BY startedAt ASC) AS rn
             FROM analytics_sessions) t
          WHERE DATE(t.startedAt) BETWEEN ? AND ?`,
        s,
        e
      );
      const newS = n(rows[0]?.newS);
      const retS = n(rows[0]?.retS);
      return { newS, retS, total: newS + retS };
    };
    const newCustomersBetween = async (s: string, e: string) => {
      const rows = await prisma.$queryRawUnsafe<{ c: unknown }[]>(
        `SELECT COUNT(*) AS c FROM (
           SELECT userId, MIN(DATE(placedAt)) AS f FROM orders WHERE status IN (${REVENUE_SQL})
            GROUP BY userId HAVING f BETWEEN ? AND ?) t`,
        s,
        e
      );
      return n(rows[0]?.c);
    };
    const refundsBetween = async (s: string, e: string) => {
      const rows = await prisma.$queryRawUnsafe<{ refunded: unknown; total: unknown }[]>(
        `SELECT SUM(status IN ('CANCELLED','RETURNED')) AS refunded, COUNT(*) AS total
           FROM orders WHERE DATE(placedAt) BETWEEN ? AND ?`,
        s,
        e
      );
      return { refunded: n(rows[0]?.refunded), total: n(rows[0]?.total) };
    };
    const topProductBetween = async (s: string, e: string) => {
      const rows = await prisma.$queryRawUnsafe<{ productId: number; name: string; qty: unknown }[]>(
        `SELECT ap.productId, p.name, SUM(ap.qtySold) AS qty
           FROM agg_daily_product ap JOIN products p ON p.id = ap.productId
          WHERE ap.day BETWEEN ? AND ? GROUP BY ap.productId, p.name
          HAVING qty > 0 ORDER BY qty DESC LIMIT 1`,
        s,
        e
      );
      const row = rows[0];
      return row ? { productId: row.productId, name: row.name, qty: n(row.qty) } : null;
    };

    const [
      revCur,
      revPrev,
      ordCur,
      ordPrev,
      sessCur,
      sessPrev,
      funCur,
      funPrev,
      retCur,
      retPrev,
      newCustCur,
      newCustPrev,
      refCur,
      refPrev,
      topCur,
      topPrev,
      lowStock,
      dailySessions,
      zeroSearch,
    ] = await Promise.all([
      revenueBetween(r.startDay, r.today),
      revenueBetween(prevStart, prevEnd),
      ordersBetween(r.startDay, r.today),
      ordersBetween(prevStart, prevEnd),
      sessionsBetween(r.startDay, r.today),
      sessionsBetween(prevStart, prevEnd),
      funnelBetween(r.startDay, r.today),
      funnelBetween(prevStart, prevEnd),
      returningBetween(r.startDay, r.today),
      returningBetween(prevStart, prevEnd),
      newCustomersBetween(r.startDay, r.today),
      newCustomersBetween(prevStart, prevEnd),
      refundsBetween(r.startDay, r.today),
      refundsBetween(prevStart, prevEnd),
      topProductBetween(r.startDay, r.today),
      topProductBetween(prevStart, prevEnd),
      prisma.$queryRawUnsafe<{ qty: unknown; name: string; color: string }[]>(
        `SELECT pv.stockQty AS qty, p.name AS name, pv.color AS color
           FROM product_variants pv JOIN products p ON p.id = pv.productId
          WHERE p.isActive = 1 AND pv.stockQty <= ? ORDER BY pv.stockQty ASC LIMIT 12`,
        LOW_STOCK
      ),
      prisma.$queryRawUnsafe<{ day: string; c: unknown }[]>(
        `SELECT DATE(startedAt) AS day, COUNT(*) AS c FROM analytics_sessions
          WHERE DATE(startedAt) BETWEEN ? AND ? GROUP BY DATE(startedAt) ORDER BY day`,
        r.startDay,
        r.today
      ),
      prisma.$queryRawUnsafe<{ z: unknown; terms: unknown }[]>(
        `SELECT COALESCE(SUM(zeroResult),0) AS z,
                COUNT(DISTINCT CASE WHEN zeroResult > 0 THEN term END) AS terms
           FROM agg_search_terms WHERE day BETWEEN ? AND ?`,
        r.startDay,
        r.today
      ),
    ]);

    const insights: Insight[] = [];
    const push = (i: Omit<Insight, "priority"> & { priority?: number }) =>
      insights.push({
        ...i,
        priority: i.priority ?? SEV_WEIGHT[i.severity] + (i.deltaPct ? Math.min(Math.abs(i.deltaPct), 100) : 0),
      });

    // --- Revenue ---
    {
      const d = pctChange(revCur, revPrev);
      if (d != null && Math.abs(d) >= 5 && revCur + revPrev > 0) {
        const up = d >= 0;
        push({
          id: "revenue",
          category: "Revenue",
          severity: up ? "positive" : d <= -20 ? "critical" : "warning",
          title: `Revenue ${up ? "increased" : "dropped"} ${round0(Math.abs(d))}%`,
          detail: `${inrShort(revCur)} over the last ${r.days} days, ${up ? "up" : "down"} from ${inrShort(revPrev)} in the prior ${r.days}.`,
          metric: { value: revCur, format: "money" },
          deltaPct: d,
        });
      }
    }

    // --- Orders volume (only when it adds signal beyond revenue) ---
    {
      const d = pctChange(ordCur, ordPrev);
      if (d != null && Math.abs(d) >= 12 && ordCur + ordPrev >= 6) {
        const up = d >= 0;
        push({
          id: "orders",
          category: "Orders",
          severity: up ? "positive" : "warning",
          title: `Orders ${up ? "up" : "down"} ${round0(Math.abs(d))}%`,
          detail: `${num(ordCur)} orders this period vs ${num(ordPrev)} in the previous ${r.days} days.`,
          metric: { value: ordCur, format: "number" },
          deltaPct: d,
        });
      }
    }

    // --- Conversion rate ---
    {
      const convCur = sessCur > 0 ? ordCur / sessCur : 0;
      const convPrev = sessPrev > 0 ? ordPrev / sessPrev : 0;
      const d = pctChange(convCur, convPrev);
      if (d != null && Math.abs(d) >= 10 && sessCur >= 20 && sessPrev >= 20) {
        const up = d >= 0;
        push({
          id: "conversion",
          category: "Conversion",
          severity: up ? "positive" : "warning",
          title: `Conversion rate ${up ? "improved" : "fell"} ${round0(Math.abs(d))}%`,
          detail: `${pctS(convCur)} of sessions convert now, vs ${pctS(convPrev)} before.`,
          metric: { value: convCur, format: "percent" },
          deltaPct: d,
        });
      }
    }

    // --- Cart abandonment (bad when up) ---
    {
      const abandon = (f: { addToCart: number; requests: number }) =>
        f.addToCart > 0 ? Math.max(0, 1 - f.requests / f.addToCart) : null;
      const aCur = abandon(funCur);
      const aPrev = abandon(funPrev);
      if (aCur != null && aPrev != null && funCur.addToCart >= 10 && funPrev.addToCart >= 10) {
        const d = pctChange(aCur, aPrev);
        if (d != null && Math.abs(d) >= 8) {
          const up = d >= 0; // up = worse
          push({
            id: "cart-abandonment",
            category: "Checkout",
            severity: up ? (aCur >= 0.8 ? "critical" : "warning") : "positive",
            title: `Cart abandonment ${up ? "increased" : "improved"} ${round0(Math.abs(d))}%`,
            detail: `${pctS(aCur)} of carts don't reach a request — ${up ? "up" : "down"} from ${pctS(aPrev)} last period.`,
            metric: { value: aCur, format: "percent" },
            deltaPct: d,
          });
        }
      }
    }

    // --- Returning visitors (good when up) ---
    {
      const shareCur = retCur.total > 0 ? retCur.retS / retCur.total : 0;
      const sharePrev = retPrev.total > 0 ? retPrev.retS / retPrev.total : 0;
      const d = pctChange(shareCur, sharePrev);
      if (d != null && Math.abs(d) >= 10 && retCur.total >= 20 && retPrev.total >= 20) {
        const up = d >= 0;
        push({
          id: "returning-visitors",
          category: "Audience",
          severity: up ? "positive" : "warning",
          title: `Returning visitors ${up ? "grew" : "dropped"} ${round0(Math.abs(d))}%`,
          detail: `${pctS(shareCur)} of sessions are repeat visitors now, vs ${pctS(sharePrev)} before.`,
          metric: { value: shareCur, format: "percent" },
          deltaPct: d,
        });
      }
    }

    // --- New customers ---
    {
      const d = pctChange(newCustCur, newCustPrev);
      if (d != null && Math.abs(d) >= 15 && newCustCur + newCustPrev >= 4) {
        const up = d >= 0;
        push({
          id: "new-customers",
          category: "Customers",
          severity: up ? "positive" : "warning",
          title: `New customers ${up ? "up" : "down"} ${round0(Math.abs(d))}%`,
          detail: `${num(newCustCur)} first-time buyers this period vs ${num(newCustPrev)} previously.`,
          metric: { value: newCustCur, format: "number" },
          deltaPct: d,
        });
      }
    }

    // --- Top seller changed ---
    if (topCur && topPrev && topCur.productId !== topPrev.productId) {
      push({
        id: "top-product",
        category: "Products",
        severity: "info",
        title: `Top seller changed to ${topCur.name}`,
        detail: `“${topCur.name}” (${num(topCur.qty)} sold) overtook “${topPrev.name}” as your best seller this period.`,
        metric: { value: topCur.qty, format: "number" },
        deltaPct: null,
        priority: SEV_WEIGHT.info + 60,
      });
    }

    // --- Inventory running low ---
    {
      const low = lowStock.map((row) => ({ qty: n(row.qty), name: row.name, color: row.color }));
      const out = low.filter((v) => v.qty === 0);
      const running = low.filter((v) => v.qty > 0);
      if (low.length > 0) {
        const names = low.slice(0, 3).map((v) => `${v.name} (${v.color})`).join(", ");
        const critical = out.length > 0;
        push({
          id: "inventory",
          category: "Inventory",
          severity: critical ? "critical" : "warning",
          title: critical
            ? `${out.length} variant${out.length > 1 ? "s" : ""} out of stock`
            : `${running.length} variant${running.length > 1 ? "s" : ""} running low`,
          detail: `${names}${low.length > 3 ? ` +${low.length - 3} more` : ""} at or below ${LOW_STOCK} units. Restock to avoid lost sales.`,
          metric: { value: low.length, format: "number" },
          deltaPct: null,
          priority: critical ? SEV_WEIGHT.critical + 80 : SEV_WEIGHT.warning + 40,
        });
      }
    }

    // --- Refund / return rate ---
    {
      const rateCur = refCur.total > 0 ? refCur.refunded / refCur.total : 0;
      const ratePrev = refPrev.total > 0 ? refPrev.refunded / refPrev.total : 0;
      const d = pctChange(rateCur, ratePrev);
      const high = rateCur >= 0.1 && refCur.total >= 5;
      const rising = d != null && d >= 25 && refCur.refunded >= 2;
      if (high || rising) {
        push({
          id: "refunds",
          category: "Refunds",
          severity: rateCur >= 0.2 ? "critical" : "warning",
          title: high ? `High refund rate (${pctS(rateCur)})` : `Refunds rising ${round0(Math.abs(d!))}%`,
          detail: `${num(refCur.refunded)} of ${num(refCur.total)} orders were cancelled or returned this period.`,
          metric: { value: rateCur, format: "percent" },
          deltaPct: d,
        });
      }
    }

    // --- Unusual traffic spike / drop (most recent complete day vs baseline) ---
    {
      const series = dailySessions.map((row) => ({ day: toDayKey(row.day), c: n(row.c) }));
      const yest = series.find((s) => s.day === r.yesterday);
      const baselineDays = series.filter((s) => s.day !== r.yesterday && s.day !== r.today);
      if (yest && baselineDays.length >= 3) {
        const baseline = baselineDays.reduce((s, d) => s + d.c, 0) / baselineDays.length;
        const dev = pctChange(yest.c, baseline);
        if (baseline > 0 && dev != null && yest.c >= 10) {
          if (dev >= 50) {
            push({
              id: "traffic-spike",
              category: "Traffic",
              severity: "info",
              title: `Unusual traffic spike`,
              detail: `${num(yest.c)} sessions yesterday — ${round0(dev)}% above the ${r.days}-day average of ${num(round0(baseline))}.`,
              metric: { value: yest.c, format: "number" },
              deltaPct: dev,
              priority: SEV_WEIGHT.info + Math.min(dev, 120),
            });
          } else if (dev <= -50) {
            push({
              id: "traffic-drop",
              category: "Traffic",
              severity: "warning",
              title: `Traffic dropped sharply`,
              detail: `Only ${num(yest.c)} sessions yesterday — ${round0(Math.abs(dev))}% below the ${r.days}-day average.`,
              metric: { value: yest.c, format: "number" },
              deltaPct: dev,
            });
          }
        }
      }
    }

    // --- Unmet search demand (zero-result searches) ---
    {
      const z = n(zeroSearch[0]?.z);
      const terms = n(zeroSearch[0]?.terms);
      if (z >= 5 && terms > 0) {
        push({
          id: "zero-search",
          category: "Search",
          severity: z >= 25 ? "warning" : "info",
          title: `Unmet search demand`,
          detail: `${num(z)} searches across ${num(terms)} term${terms > 1 ? "s" : ""} returned no results — possible catalogue gaps.`,
          metric: { value: z, format: "number" },
          deltaPct: null,
        });
      }
    }

    insights.sort((a, b) => b.priority - a.priority);
    res.json({
      range: r.key,
      comparedTo: { startDay: prevStart, endDay: prevEnd },
      insights: insights.map(({ priority, ...rest }) => rest),
    });
  })
);

/* ----------------------------- REALTIME ----------------------------- */
router.get(
  "/realtime",
  asyncHandler(async (_req: Request, res: Response) => {
    // First-paint snapshot; SSE "analytics:metrics" keeps it live thereafter.
    res.json(await buildLiveSnapshot());
  })
);

/* ----------------------------- CAMPAIGNS (UTM) ----------------------------- */
// Engagement (sessions/visitors) from the traffic rollup's campaign dimension,
// joined with authoritative orders/revenue attributed to each visitor's
// first-touch campaign. Campaigns with no utm_campaign are excluded.
router.get(
  "/campaigns",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);
    const engagement = await prisma.$queryRawUnsafe<
      { campaign: string; source: string; sessions: unknown; visitors: unknown }[]
    >(
      `SELECT campaign, MIN(source) AS source,
              SUM(sessions) AS sessions, SUM(visitors) AS visitors
         FROM agg_daily_traffic
        WHERE day BETWEEN ? AND ? AND campaign <> ''
        GROUP BY campaign ORDER BY sessions DESC LIMIT 50`,
      r.startDay,
      r.today
    );
    const sales = await prisma.$queryRawUnsafe<{ campaign: string; orders: unknown; revenue: unknown }[]>(
      `SELECT v.firstCampaign AS campaign, COUNT(*) AS orders, COALESCE(SUM(o.finalAmount),0) AS revenue
         FROM orders o JOIN analytics_visitors v ON v.userId = o.userId
        WHERE o.status IN (${REVENUE_SQL}) AND DATE(o.placedAt) BETWEEN ? AND ?
          AND v.firstCampaign IS NOT NULL AND v.firstCampaign <> ''
        GROUP BY v.firstCampaign`,
      r.startDay,
      r.today
    );
    const salesByCampaign = new Map(sales.map((s) => [s.campaign, s]));
    res.json({
      range: r.key,
      campaigns: engagement.map((row) => {
        const sale = salesByCampaign.get(row.campaign);
        const sessions = n(row.sessions);
        const orders = n(sale?.orders);
        return {
          campaign: row.campaign,
          source: row.source || "unknown",
          sessions,
          visitors: n(row.visitors),
          orders,
          revenue: n(sale?.revenue),
          conversionRate: sessions > 0 ? orders / sessions : 0,
        };
      }),
    });
  })
);

/* ----------------------------- REFERRERS ----------------------------- */
// Raw referring URLs (distinct sessions/visitors), partition-pruned on
// created_day. Self/empty referrers are excluded at write time (source=direct).
router.get(
  "/referrers",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);
    const rows = await prisma.$queryRawUnsafe<
      { referrer: string | null; sessions: unknown; visitors: unknown }[]
    >(
      `SELECT referrer, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT visitorId) AS visitors
         FROM analytics_events
        WHERE created_day BETWEEN ? AND ? AND referrer IS NOT NULL AND referrer <> ''
        GROUP BY referrer ORDER BY sessions DESC LIMIT 25`,
      r.startDay,
      r.today
    );
    res.json({
      range: r.key,
      referrers: rows.map((row) => ({
        referrer: row.referrer || "unknown",
        sessions: n(row.sessions),
        visitors: n(row.visitors),
      })),
    });
  })
);

/* ----------------------------- CITIES ----------------------------- */
// Historical city breakdown from the session entity (date-ranged, unlike the
// live tab which only shows the last 5 minutes).
router.get(
  "/cities",
  asyncHandler(async (req: Request, res: Response) => {
    const r = resolveRange(req.query.range);
    const rows = await prisma.$queryRawUnsafe<
      { city: string | null; country: string | null; sessions: unknown; visitors: unknown }[]
    >(
      `SELECT city, MIN(country) AS country,
              COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS visitors
         FROM analytics_sessions
        WHERE DATE(startedAt) BETWEEN ? AND ? AND city IS NOT NULL AND city <> ''
        GROUP BY city ORDER BY sessions DESC LIMIT 25`,
      r.startDay,
      r.today
    );
    res.json({
      range: r.key,
      cities: rows.map((row) => ({
        city: row.city || "unknown",
        country: row.country || "",
        sessions: n(row.sessions),
        visitors: n(row.visitors),
      })),
    });
  })
);

/* ----------------------------- EXPORT ----------------------------- */
// Unified export: CSV / Excel / PDF for a single widget, one section, or the
// whole dashboard. The widget→section catalogue lives in analytics/report.ts
// and is exposed via /export/manifest so the UI can build its scope picker.

/** Static catalogue of exportable sections + widgets. */
router.get(
  "/export/manifest",
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ sections: EXPORT_MANIFEST });
  })
);

const FORMATS = new Set<ExportFormat>(["csv", "xlsx", "pdf"]);
const SCOPES = new Set<ExportScope>(["dashboard", "section", "widget"]);
const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

router.get(
  "/export",
  asyncHandler(async (req: Request, res: Response) => {
    // Legacy callers (?report=products|sources, CSV) → map onto the new scopes.
    const legacy = typeof req.query.report === "string" && !req.query.scope ? String(req.query.report) : null;

    const format = (String(req.query.format ?? "csv") as ExportFormat);
    if (!FORMATS.has(format)) {
      res.status(400).json({ error: "format must be csv, xlsx or pdf" });
      return;
    }
    const scope = (legacy === "sources"
      ? "section"
      : legacy === "products"
        ? "widget"
        : String(req.query.scope ?? "dashboard")) as ExportScope;
    if (!SCOPES.has(scope)) {
      res.status(400).json({ error: "scope must be dashboard, section or widget" });
      return;
    }
    const section = legacy === "sources" ? "sources" : req.query.section ? String(req.query.section) : undefined;
    const widget = legacy === "products" ? "products:performance" : req.query.widget ? String(req.query.widget) : undefined;

    const doc = await buildReport({ range: req.query.range, scope, section, widget });
    if (!doc) {
      res.status(404).json({ error: "unknown section or widget" });
      return;
    }

    const rangeKey = typeof req.query.range === "string" ? req.query.range : "30";
    const filename = `${reportSlug(scope, section, widget, rangeKey)}.${format}`;
    const body =
      format === "csv" ? renderCsv(doc) : format === "xlsx" ? await renderXlsx(doc) : await renderPdf(doc);

    res.setHeader("Content-Type", CONTENT_TYPE[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(body);
  })
);

export default router;
