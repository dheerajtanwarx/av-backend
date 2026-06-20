/* ============================================================
   Analytics export model + section builders.
   ------------------------------------------------------------
   Gathers the same numbers the read API serves (routes/analytics.ts)
   into a serializer-agnostic ReportDoc, which renderers in
   report-render.ts turn into CSV / Excel / PDF. Scope can be a single
   widget (one table), one section (a tab), or the whole dashboard.
   ============================================================ */

import { prisma } from "../lib/prisma";

/* ----------------------------- model ----------------------------- */

export type CellFormat = "text" | "number" | "money" | "percent" | "date";
export interface ReportColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  format?: CellFormat;
}
export interface ReportTable {
  /** Globally-unique widget id, e.g. "products:performance". */
  id: string;
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}
export interface ReportKpi {
  label: string;
  value: string; // pre-formatted
}
export interface ReportSection {
  id: string; // matches a dashboard tab
  title: string;
  subtitle?: string;
  kpis?: ReportKpi[];
  tables: ReportTable[];
}
export interface ReportDoc {
  title: string;
  rangeLabel: string;
  generatedAt: string;
  sections: ReportSection[];
}

/* ----------------------------- manifest ----------------------------- */
/* The static catalogue of what can be exported. The frontend reads this to
   build its scope picker; builders below produce tables with matching ids. */

export interface ManifestWidget {
  id: string;
  title: string;
}
export interface ManifestSection {
  id: string;
  title: string;
  widgets: ManifestWidget[];
}

export const EXPORT_MANIFEST: ManifestSection[] = [
  {
    id: "overview",
    title: "Overview",
    widgets: [{ id: "overview:trend", title: "Daily trend" }],
  },
  {
    id: "activity",
    title: "Active Users",
    widgets: [{ id: "activity:trend", title: "Daily active users" }],
  },
  {
    id: "traffic",
    title: "Traffic",
    widgets: [
      { id: "traffic:pages", title: "Top pages" },
      { id: "traffic:devices", title: "By device" },
      { id: "traffic:countries", title: "By country" },
      { id: "traffic:cities", title: "By city" },
    ],
  },
  {
    id: "sources",
    title: "Sources",
    widgets: [
      { id: "sources:performance", title: "Source performance" },
      { id: "sources:campaigns", title: "UTM campaigns" },
      { id: "sources:referrers", title: "Top referrers" },
    ],
  },
  {
    id: "products",
    title: "Products",
    widgets: [{ id: "products:performance", title: "Product performance" }],
  },
  {
    id: "customers",
    title: "Customers",
    widgets: [
      { id: "customers:top", title: "Top customers" },
      { id: "customers:monthly", title: "New vs returning (monthly)" },
    ],
  },
  {
    id: "funnel",
    title: "Funnel",
    widgets: [{ id: "funnel:stages", title: "Conversion funnel" }],
  },
  {
    id: "search",
    title: "Search",
    widgets: [
      { id: "search:terms", title: "Most searched terms" },
      { id: "search:zero", title: "No-result searches" },
    ],
  },
];

/* ----------------------------- helpers ----------------------------- */

const REVENUE_SQL = "'PLACED','CONFIRMED','PROCESSING','SHIPPED','DELIVERED'";
const RANGE_DAYS: Record<string, number> = { "7": 7, "30": 30, "90": 90, "365": 365 };
const n = (v: unknown): number => (v == null ? 0 : Number(v));

/** $queryRaw returns DATE columns as a UTC-midnight JS Date; normalize back to
    the "YYYY-MM-DD" string the dense day-series loops key on. */
const toDayKey = (v: unknown): string =>
  v instanceof Date
    ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`
    : String(v).slice(0, 10);
const RANGE_LABEL: Record<string, string> = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
  "365": "Last 12 months",
};

function dayStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveRange(raw: unknown) {
  const key = typeof raw === "string" && raw in RANGE_DAYS ? raw : "30";
  const days = RANGE_DAYS[key];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const today = new Date();
  return { key, days, startDay: dayStr(start), today: dayStr(today) };
}

type Range = ReturnType<typeof resolveRange>;

/* Channel bucketing — mirrors routes/analytics.ts session-composition. */
function channelOf(src: string | null | undefined): "Organic" | "Direct" | "Social" | "Referral" {
  const s = (src || "").toLowerCase().trim();
  if (!s || s === "direct" || s === "(direct)" || s === "none") return "Direct";
  if (/instagram|facebook|\bfb\b|whatsapp|twitter|^x$|youtube|tiktok|pinterest|linkedin|snapchat|reddit|telegram|threads|social/.test(s))
    return "Social";
  if (/google|bing|yahoo|duckduckgo|ecosia|baidu|yandex|organic|\bseo\b|search/.test(s)) return "Organic";
  return "Referral";
}

async function revenueBetween(s: string, e: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ rev: unknown }[]>(
    `SELECT COALESCE(SUM(finalAmount),0) AS rev FROM orders
      WHERE status IN (${REVENUE_SQL}) AND DATE(placedAt) BETWEEN ? AND ?`,
    s,
    e
  );
  return n(rows[0]?.rev);
}
async function ordersBetween(s: string, e: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ c: unknown }[]>(
    `SELECT COUNT(*) AS c FROM orders
      WHERE status IN (${REVENUE_SQL}) AND DATE(placedAt) BETWEEN ? AND ?`,
    s,
    e
  );
  return n(rows[0]?.c);
}

const kpiMoney = (label: string, v: number): ReportKpi => ({ label, value: inr(v) });
const inr = (a: number) => "₹" + Math.round(a || 0).toLocaleString("en-IN");
const pctStr = (a: number) => `${((a || 0) * 100).toFixed(1)}%`;

/* ----------------------------- section builders ----------------------------- */

async function buildOverview(r: Range): Promise<ReportSection> {
  const [rev, ord] = await Promise.all([
    revenueBetween(r.startDay, r.today),
    ordersBetween(r.startDay, r.today),
  ]);
  const visRows = await prisma.$queryRawUnsafe<{ day: string; visitors: unknown; sessions: unknown }[]>(
    `SELECT DATE(startedAt) AS day, COUNT(DISTINCT visitorId) AS visitors, COUNT(*) AS sessions
       FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ? GROUP BY DATE(startedAt)`,
    r.startDay,
    r.today
  );
  const visByDay = new Map(visRows.map((row) => [toDayKey(row.day), row]));
  const visitors = visRows.reduce((s, row) => s + n(row.visitors), 0);
  const sessions = visRows.reduce((s, row) => s + n(row.sessions), 0);

  const revByDay = await prisma.$queryRawUnsafe<{ day: string; rev: unknown; ord: unknown }[]>(
    `SELECT DATE(placedAt) AS day, COALESCE(SUM(finalAmount),0) AS rev, COUNT(*) AS ord
       FROM orders WHERE status IN (${REVENUE_SQL}) AND DATE(placedAt) BETWEEN ? AND ?
      GROUP BY DATE(placedAt)`,
    r.startDay,
    r.today
  );
  const revMap = new Map(revByDay.map((row) => [toDayKey(row.day), row]));

  const rows: Record<string, unknown>[] = [];
  const cursor = new Date(r.startDay + "T00:00:00");
  const end = new Date(r.today + "T00:00:00");
  while (cursor <= end) {
    const key = dayStr(cursor);
    rows.push({
      day: key,
      revenue: n(revMap.get(key)?.rev),
      orders: n(revMap.get(key)?.ord),
      visitors: n(visByDay.get(key)?.visitors),
      sessions: n(visByDay.get(key)?.sessions),
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    id: "overview",
    title: "Overview",
    kpis: [
      kpiMoney("Revenue", rev),
      { label: "Orders", value: String(ord) },
      { label: "Visitors", value: String(visitors) },
      { label: "Sessions", value: String(sessions) },
      kpiMoney("Avg order value", ord > 0 ? rev / ord : 0),
      { label: "Conversion", value: pctStr(sessions > 0 ? ord / sessions : 0) },
    ],
    tables: [
      {
        id: "overview:trend",
        title: "Daily trend",
        columns: [
          { key: "day", label: "Date", format: "date" },
          { key: "revenue", label: "Revenue", align: "right", format: "money" },
          { key: "orders", label: "Orders", align: "right", format: "number" },
          { key: "visitors", label: "Visitors", align: "right", format: "number" },
          { key: "sessions", label: "Sessions", align: "right", format: "number" },
        ],
        rows,
      },
    ],
  };
}

const durStr = (s: number): string => {
  const m = Math.floor((s || 0) / 60);
  const sec = Math.round((s || 0) % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

async function buildActivity(r: Range): Promise<ReportSection> {
  // Mirrors the /active-users endpoint: DAU = avg distinct actives/day over the
  // range; WAU/MAU = trailing 7/30-day distinct visitors clamped to range start.
  const clampStart = (back: number): string => {
    const d = new Date(r.today + "T00:00:00");
    d.setDate(d.getDate() - back);
    const s = dayStr(d);
    return s < r.startDay ? r.startDay : s;
  };
  const distinctUsers = async (s: string, e: string): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<{ c: unknown }[]>(
      `SELECT COUNT(DISTINCT visitorId) AS c FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?`,
      s,
      e
    );
    return n(rows[0]?.c);
  };

  const [perDay, newPerDay, totalsRows, newInRangeRows, wau, mau] = await Promise.all([
    prisma.$queryRawUnsafe<
      { day: string; activeUsers: unknown; sessions: unknown; loggedIn: unknown; guest: unknown }[]
    >(
      `SELECT DATE(startedAt) AS day,
              COUNT(DISTINCT visitorId) AS activeUsers, COUNT(*) AS sessions,
              COUNT(DISTINCT CASE WHEN userId IS NOT NULL THEN visitorId END) AS loggedIn,
              COUNT(DISTINCT CASE WHEN userId IS NULL THEN visitorId END) AS guest
         FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ? GROUP BY DATE(startedAt)`,
      r.startDay,
      r.today
    ),
    prisma.$queryRawUnsafe<{ day: string; newUsers: unknown }[]>(
      `SELECT f.day AS day, COUNT(*) AS newUsers FROM (
         SELECT visitorId, DATE(MIN(startedAt)) AS day FROM analytics_sessions GROUP BY visitorId
       ) f WHERE f.day BETWEEN ? AND ? GROUP BY f.day`,
      r.startDay,
      r.today
    ),
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
    distinctUsers(clampStart(6), r.today),
    distinctUsers(clampStart(29), r.today),
  ]);

  const dayMap = new Map(perDay.map((row) => [toDayKey(row.day), row]));
  const newMap = new Map(newPerDay.map((row) => [toDayKey(row.day), n(row.newUsers)]));

  const rows: Record<string, unknown>[] = [];
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
    rows.push({
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
  const dauLabel = avgDau >= 10 ? String(Math.round(avgDau)) : avgDau > 0 ? avgDau.toFixed(1) : "0";

  return {
    id: "activity",
    title: "Active Users",
    kpis: [
      { label: "Daily active users (avg)", value: dauLabel },
      { label: "Weekly active users", value: String(wau) },
      { label: "Monthly active users", value: String(mau) },
      { label: "Stickiness (DAU/MAU)", value: pctStr(mau > 0 ? avgDau / mau : 0) },
      { label: "Avg session duration", value: durStr(sessions > 0 ? n(t.dur) / sessions : 0) },
      { label: "Sessions / user", value: (users > 0 ? sessions / users : 0).toFixed(2) },
      { label: "Bounce rate", value: pctStr(sessions > 0 ? n(t.bounces) / sessions : 0) },
      { label: "Returning user rate", value: pctStr(users > 0 ? (users - newInRange) / users : 0) },
    ],
    tables: [
      {
        id: "activity:trend",
        title: "Daily active users",
        columns: [
          { key: "day", label: "Date", format: "date" },
          { key: "activeUsers", label: "Active users", align: "right", format: "number" },
          { key: "newUsers", label: "New", align: "right", format: "number" },
          { key: "returningUsers", label: "Returning", align: "right", format: "number" },
          { key: "loggedIn", label: "Logged in", align: "right", format: "number" },
          { key: "guest", label: "Guest", align: "right", format: "number" },
          { key: "sessions", label: "Sessions", align: "right", format: "number" },
          { key: "cumulativeSessions", label: "Cumulative sessions", align: "right", format: "number" },
        ],
        rows,
      },
    ],
  };
}

async function buildTraffic(r: Range): Promise<ReportSection> {
  const totalsRows = await prisma.$queryRawUnsafe<
    { sessions: unknown; visitors: unknown; pageviews: unknown; bounces: unknown; dur: unknown }[]
  >(
    `SELECT COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS visitors, SUM(pageviews) AS pageviews,
            SUM(isBounce) AS bounces, SUM(COALESCE(durationSec,0)) AS dur
       FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?`,
    r.startDay,
    r.today
  );
  const t = totalsRows[0] ?? {};
  const sessions = n(t.sessions);

  const grouped = (col: string) =>
    prisma.$queryRawUnsafe<{ k: string | null; sessions: unknown; visitors: unknown }[]>(
      `SELECT ${col} AS k, COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS visitors
         FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ?
        GROUP BY ${col} ORDER BY sessions DESC LIMIT 25`,
      r.startDay,
      r.today
    );
  const [byDevice, byCountry] = await Promise.all([grouped("device"), grouped("country")]);

  const topPages = await prisma.$queryRawUnsafe<{ path: string | null; views: unknown }[]>(
    `SELECT path, COUNT(*) AS views FROM analytics_events
      WHERE eventName='page_view' AND created_day BETWEEN ? AND ? AND path IS NOT NULL
      GROUP BY path ORDER BY views DESC LIMIT 25`,
    r.startDay,
    r.today
  );
  const cities = await prisma.$queryRawUnsafe<
    { city: string | null; country: string | null; sessions: unknown; visitors: unknown }[]
  >(
    `SELECT city, MIN(country) AS country, COUNT(*) AS sessions, COUNT(DISTINCT visitorId) AS visitors
       FROM analytics_sessions WHERE DATE(startedAt) BETWEEN ? AND ? AND city IS NOT NULL AND city <> ''
      GROUP BY city ORDER BY sessions DESC LIMIT 25`,
    r.startDay,
    r.today
  );

  const kv = (rows: { k: string | null; sessions: unknown; visitors: unknown }[]) =>
    rows.map((row) => ({ label: row.k || "unknown", sessions: n(row.sessions), visitors: n(row.visitors) }));

  return {
    id: "traffic",
    title: "Traffic",
    kpis: [
      { label: "Sessions", value: String(sessions) },
      { label: "Visitors", value: String(n(t.visitors)) },
      { label: "Pageviews", value: String(n(t.pageviews)) },
      { label: "Bounce rate", value: pctStr(sessions > 0 ? n(t.bounces) / sessions : 0) },
      { label: "Avg session (s)", value: String(Math.round(sessions > 0 ? n(t.dur) / sessions : 0)) },
      { label: "Pages / session", value: (sessions > 0 ? n(t.pageviews) / sessions : 0).toFixed(1) },
    ],
    tables: [
      {
        id: "traffic:pages",
        title: "Top pages",
        columns: [
          { key: "path", label: "Path" },
          { key: "views", label: "Views", align: "right", format: "number" },
        ],
        rows: topPages.map((p) => ({ path: p.path, views: n(p.views) })),
      },
      {
        id: "traffic:devices",
        title: "By device",
        columns: [
          { key: "label", label: "Device" },
          { key: "sessions", label: "Sessions", align: "right", format: "number" },
          { key: "visitors", label: "Visitors", align: "right", format: "number" },
        ],
        rows: kv(byDevice),
      },
      {
        id: "traffic:countries",
        title: "By country",
        columns: [
          { key: "label", label: "Country" },
          { key: "sessions", label: "Sessions", align: "right", format: "number" },
          { key: "visitors", label: "Visitors", align: "right", format: "number" },
        ],
        rows: kv(byCountry),
      },
      {
        id: "traffic:cities",
        title: "By city",
        columns: [
          { key: "city", label: "City" },
          { key: "country", label: "Country" },
          { key: "sessions", label: "Sessions", align: "right", format: "number" },
          { key: "visitors", label: "Visitors", align: "right", format: "number" },
        ],
        rows: cities.map((row) => ({
          city: row.city || "unknown",
          country: row.country || "",
          sessions: n(row.sessions),
          visitors: n(row.visitors),
        })),
      },
    ],
  };
}

async function buildSources(r: Range): Promise<ReportSection> {
  const srcRows = await prisma.$queryRawUnsafe<
    { source: string; visitors: unknown; productViews: unknown; addToCart: unknown; orders: unknown; revenue: unknown }[]
  >(
    `SELECT source, SUM(visitors) AS visitors, SUM(productViews) AS productViews,
            SUM(addToCart) AS addToCart, SUM(orders) AS orders, SUM(revenue) AS revenue
       FROM agg_daily_funnel WHERE day BETWEEN ? AND ?
      GROUP BY source ORDER BY revenue DESC, visitors DESC`,
    r.startDay,
    r.today
  );
  const engagement = await prisma.$queryRawUnsafe<
    { campaign: string; source: string; sessions: unknown; visitors: unknown }[]
  >(
    `SELECT campaign, MIN(source) AS source, SUM(sessions) AS sessions, SUM(visitors) AS visitors
       FROM agg_daily_traffic WHERE day BETWEEN ? AND ? AND campaign <> ''
      GROUP BY campaign ORDER BY sessions DESC LIMIT 50`,
    r.startDay,
    r.today
  );
  const sales = await prisma.$queryRawUnsafe<{ campaign: string; orders: unknown; revenue: unknown }[]>(
    `SELECT v.firstCampaign AS campaign, COUNT(*) AS orders, COALESCE(SUM(o.finalAmount),0) AS revenue
       FROM orders o JOIN analytics_visitors v ON v.userId = o.userId
      WHERE o.status IN (${REVENUE_SQL}) AND DATE(o.placedAt) BETWEEN ? AND ?
        AND v.firstCampaign IS NOT NULL AND v.firstCampaign <> '' GROUP BY v.firstCampaign`,
    r.startDay,
    r.today
  );
  const salesBy = new Map(sales.map((s) => [s.campaign, s]));
  const referrers = await prisma.$queryRawUnsafe<{ referrer: string | null; sessions: unknown; visitors: unknown }[]>(
    `SELECT referrer, COUNT(DISTINCT sessionId) AS sessions, COUNT(DISTINCT visitorId) AS visitors
       FROM analytics_events WHERE created_day BETWEEN ? AND ? AND referrer IS NOT NULL AND referrer <> ''
      GROUP BY referrer ORDER BY sessions DESC LIMIT 25`,
    r.startDay,
    r.today
  );

  return {
    id: "sources",
    title: "Sources",
    tables: [
      {
        id: "sources:performance",
        title: "Source performance",
        columns: [
          { key: "source", label: "Source" },
          { key: "visitors", label: "Visitors", align: "right", format: "number" },
          { key: "productViews", label: "Product views", align: "right", format: "number" },
          { key: "addToCart", label: "Add to cart", align: "right", format: "number" },
          { key: "requests", label: "Requests", align: "right", format: "number" },
          { key: "revenue", label: "Revenue", align: "right", format: "money" },
          { key: "conversionRate", label: "Req %", align: "right", format: "percent" },
        ],
        rows: srcRows.map((row) => {
          const visitors = n(row.visitors);
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
      },
      {
        id: "sources:campaigns",
        title: "UTM campaigns",
        columns: [
          { key: "campaign", label: "Campaign" },
          { key: "source", label: "Source" },
          { key: "sessions", label: "Sessions", align: "right", format: "number" },
          { key: "visitors", label: "Visitors", align: "right", format: "number" },
          { key: "orders", label: "Orders", align: "right", format: "number" },
          { key: "revenue", label: "Revenue", align: "right", format: "money" },
          { key: "conversionRate", label: "Conv %", align: "right", format: "percent" },
        ],
        rows: engagement.map((row) => {
          const sale = salesBy.get(row.campaign);
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
      },
      {
        id: "sources:referrers",
        title: "Top referrers",
        columns: [
          { key: "referrer", label: "Referrer" },
          { key: "sessions", label: "Sessions", align: "right", format: "number" },
          { key: "visitors", label: "Visitors", align: "right", format: "number" },
        ],
        rows: referrers.map((row) => ({
          referrer: row.referrer || "unknown",
          sessions: n(row.sessions),
          visitors: n(row.visitors),
        })),
      },
    ],
  };
}

async function buildProducts(r: Range): Promise<ReportSection> {
  const rows = await prisma.$queryRawUnsafe<
    { name: string; views: unknown; addToCart: unknown; purchases: unknown; qtySold: unknown; revenue: unknown }[]
  >(
    `SELECT p.name, SUM(ap.views) AS views, SUM(ap.addToCart) AS addToCart, SUM(ap.purchases) AS purchases,
            SUM(ap.qtySold) AS qtySold, SUM(ap.revenue) AS revenue
       FROM agg_daily_product ap JOIN products p ON p.id = ap.productId
      WHERE ap.day BETWEEN ? AND ? GROUP BY p.name ORDER BY revenue DESC, views DESC LIMIT 200`,
    r.startDay,
    r.today
  );
  return {
    id: "products",
    title: "Products",
    tables: [
      {
        id: "products:performance",
        title: "Product performance",
        columns: [
          { key: "name", label: "Product" },
          { key: "views", label: "Views", align: "right", format: "number" },
          { key: "addToCart", label: "Add to cart", align: "right", format: "number" },
          { key: "purchases", label: "Sold", align: "right", format: "number" },
          { key: "qtySold", label: "Qty", align: "right", format: "number" },
          { key: "revenue", label: "Revenue", align: "right", format: "money" },
          { key: "conversionRate", label: "Conv %", align: "right", format: "percent" },
        ],
        rows: rows.map((row) => {
          const views = n(row.views);
          const purchases = n(row.purchases);
          return {
            name: row.name,
            views,
            addToCart: n(row.addToCart),
            purchases,
            qtySold: n(row.qtySold),
            revenue: n(row.revenue),
            conversionRate: views > 0 ? purchases / views : 0,
          };
        }),
      },
    ],
  };
}

async function buildCustomers(r: Range): Promise<ReportSection> {
  const CUST = `SELECT userId, COUNT(*) AS orders, SUM(finalAmount) AS ltv, MAX(placedAt) AS lastOrder
                  FROM orders WHERE status IN (${REVENUE_SQL}) GROUP BY userId`;
  const [totalRows, revRows, top, monthly] = await Promise.all([
    prisma.$queryRawUnsafe<{ c: unknown }[]>(`SELECT COUNT(DISTINCT userId) AS c FROM orders WHERE status IN (${REVENUE_SQL})`),
    prisma.$queryRawUnsafe<{ rev: unknown }[]>(`SELECT COALESCE(SUM(finalAmount),0) AS rev FROM orders WHERE status IN (${REVENUE_SQL})`),
    prisma.$queryRawUnsafe<{ name: string | null; email: string | null; orders: unknown; ltv: unknown; last: Date }[]>(
      `SELECT u.name, u.email, c.orders, c.ltv, c.lastOrder AS last
         FROM ( ${CUST} ) c JOIN \`User\` u ON u.id = c.userId ORDER BY c.ltv DESC LIMIT 50`
    ),
    prisma.$queryRawUnsafe<{ ym: string; customers: unknown; newC: unknown }[]>(
      `SELECT DATE_FORMAT(o.placedAt,'%Y-%m') AS ym, COUNT(DISTINCT o.userId) AS customers,
              COUNT(DISTINCT CASE WHEN DATE_FORMAT(f.f,'%Y-%m') = DATE_FORMAT(o.placedAt,'%Y-%m') THEN o.userId END) AS newC
         FROM orders o JOIN (SELECT userId, MIN(placedAt) AS f FROM orders WHERE status IN (${REVENUE_SQL}) GROUP BY userId) f
           ON f.userId = o.userId
        WHERE o.status IN (${REVENUE_SQL}) AND DATE(o.placedAt) BETWEEN ? AND ? GROUP BY ym ORDER BY ym`,
      r.startDay,
      r.today
    ),
  ]);
  const totalCustomers = n(totalRows[0]?.c);
  const lifetimeRevenue = n(revRows[0]?.rev);

  return {
    id: "customers",
    title: "Customers",
    kpis: [
      { label: "Customers", value: String(totalCustomers) },
      kpiMoney("Lifetime revenue", lifetimeRevenue),
      kpiMoney("Avg lifetime value", totalCustomers > 0 ? lifetimeRevenue / totalCustomers : 0),
    ],
    tables: [
      {
        id: "customers:top",
        title: "Top customers",
        columns: [
          { key: "name", label: "Customer" },
          { key: "orders", label: "Orders", align: "right", format: "number" },
          { key: "ltv", label: "LTV", align: "right", format: "money" },
          { key: "lastOrder", label: "Last order", align: "right", format: "date" },
        ],
        rows: top.map((row) => ({
          name: row.name || row.email || "Customer",
          orders: n(row.orders),
          ltv: n(row.ltv),
          lastOrder: row.last ? dayStr(new Date(row.last)) : "",
        })),
      },
      {
        id: "customers:monthly",
        title: "New vs returning (monthly)",
        columns: [
          { key: "month", label: "Month" },
          { key: "newCustomers", label: "New", align: "right", format: "number" },
          { key: "returningCustomers", label: "Returning", align: "right", format: "number" },
        ],
        rows: monthly.map((m) => {
          const customers = n(m.customers);
          const newC = n(m.newC);
          return { month: m.ym, newCustomers: newC, returningCustomers: customers - newC };
        }),
      },
    ],
  };
}

async function buildFunnel(r: Range): Promise<ReportSection> {
  const sessRows = await prisma.$queryRawUnsafe<{ s: unknown }[]>(
    `SELECT COALESCE(SUM(sessions),0) AS s FROM agg_daily_traffic WHERE day BETWEEN ? AND ?`,
    r.startDay,
    r.today
  );
  const rows = await prisma.$queryRawUnsafe<
    { productViews: unknown; addToCart: unknown; checkoutStarted: unknown; orders: unknown }[]
  >(
    `SELECT SUM(productViews) AS productViews, SUM(addToCart) AS addToCart,
            SUM(checkoutStarted) AS checkoutStarted, SUM(orders) AS orders
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

  return {
    id: "funnel",
    title: "Funnel",
    tables: [
      {
        id: "funnel:stages",
        title: "Conversion funnel",
        columns: [
          { key: "name", label: "Stage" },
          { key: "count", label: "Count", align: "right", format: "number" },
          { key: "pctOfTop", label: "% of sessions", align: "right", format: "percent" },
          { key: "pctOfPrev", label: "% of previous", align: "right", format: "percent" },
        ],
        rows: raw.map((s, i) => ({
          name: s.name,
          count: s.count,
          pctOfTop: Math.min(1, s.count / top),
          pctOfPrev: i === 0 ? 1 : raw[i - 1].count > 0 ? Math.min(1, s.count / raw[i - 1].count) : 0,
        })),
      },
    ],
  };
}

async function buildSearch(r: Range): Promise<ReportSection> {
  const [top, zero, totals] = await Promise.all([
    prisma.$queryRawUnsafe<{ term: string; searches: unknown }[]>(
      `SELECT term, SUM(searches) AS searches FROM agg_search_terms WHERE day BETWEEN ? AND ?
        GROUP BY term ORDER BY searches DESC LIMIT 50`,
      r.startDay,
      r.today
    ),
    prisma.$queryRawUnsafe<{ term: string; zeroResult: unknown }[]>(
      `SELECT term, SUM(zeroResult) AS zeroResult FROM agg_search_terms WHERE day BETWEEN ? AND ?
        GROUP BY term HAVING SUM(zeroResult) > 0 ORDER BY zeroResult DESC LIMIT 50`,
      r.startDay,
      r.today
    ),
    prisma.$queryRawUnsafe<{ searches: unknown; zero: unknown; terms: unknown }[]>(
      `SELECT COALESCE(SUM(searches),0) AS searches, COALESCE(SUM(zeroResult),0) AS zero, COUNT(DISTINCT term) AS terms
         FROM agg_search_terms WHERE day BETWEEN ? AND ?`,
      r.startDay,
      r.today
    ),
  ]);
  const totalSearches = n(totals[0]?.searches);

  return {
    id: "search",
    title: "Search",
    kpis: [
      { label: "Total searches", value: String(totalSearches) },
      { label: "Unique terms", value: String(n(totals[0]?.terms)) },
      { label: "No-result rate", value: pctStr(totalSearches > 0 ? n(totals[0]?.zero) / totalSearches : 0) },
    ],
    tables: [
      {
        id: "search:terms",
        title: "Most searched terms",
        columns: [
          { key: "term", label: "Term" },
          { key: "searches", label: "Searches", align: "right", format: "number" },
        ],
        rows: top.map((t) => ({ term: t.term, searches: n(t.searches) })),
      },
      {
        id: "search:zero",
        title: "No-result searches",
        columns: [
          { key: "term", label: "Term" },
          { key: "count", label: "Count", align: "right", format: "number" },
        ],
        rows: zero.map((t) => ({ term: t.term, count: n(t.zeroResult) })),
      },
    ],
  };
}

/* ----------------------------- assembly ----------------------------- */

const BUILDERS: Record<string, (r: Range) => Promise<ReportSection>> = {
  overview: buildOverview,
  activity: buildActivity,
  traffic: buildTraffic,
  sources: buildSources,
  products: buildProducts,
  customers: buildCustomers,
  funnel: buildFunnel,
  search: buildSearch,
};

export type ExportScope = "dashboard" | "section" | "widget";

/** Build a ReportDoc for the requested scope. Returns null when the requested
    section/widget id is unknown. */
export async function buildReport(opts: {
  range: unknown;
  scope: ExportScope;
  section?: string;
  widget?: string;
}): Promise<ReportDoc | null> {
  const r = resolveRange(opts.range);
  const base = {
    title: "AV Creation — Analytics",
    rangeLabel: RANGE_LABEL[r.key] ?? `Last ${r.days} days`,
    generatedAt: new Date().toISOString(),
  };

  if (opts.scope === "dashboard") {
    const sections = await Promise.all(EXPORT_MANIFEST.map((m) => BUILDERS[m.id](r)));
    return { ...base, sections };
  }

  if (opts.scope === "section") {
    const builder = opts.section ? BUILDERS[opts.section] : undefined;
    if (!builder) return null;
    return { ...base, sections: [await builder(r)] };
  }

  // widget — resolve which section owns it, build that section, keep one table.
  const widgetId = opts.widget ?? "";
  const owner = EXPORT_MANIFEST.find((m) => m.widgets.some((w) => w.id === widgetId));
  if (!owner) return null;
  const section = await BUILDERS[owner.id](r);
  const table = section.tables.find((t) => t.id === widgetId);
  if (!table) return null;
  return {
    ...base,
    title: `${base.title} — ${table.title}`,
    sections: [{ id: section.id, title: section.title, tables: [table] }],
  };
}

/** A short, filesystem-safe slug for the download filename. */
export function reportSlug(scope: ExportScope, section?: string, widget?: string, range?: string): string {
  const parts = ["av-analytics"];
  if (scope === "dashboard") parts.push("dashboard");
  else if (scope === "section") parts.push(section || "section");
  else parts.push((widget || "widget").replace(/:/g, "-"));
  if (range) parts.push(`${range}d`);
  return parts.join("-").replace(/[^a-zA-Z0-9_-]/g, "-");
}
