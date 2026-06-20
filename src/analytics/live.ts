import { prisma } from "../lib/prisma";
import { publish } from "../lib/realtime";
import { liveTraffic } from "./ingest";

/* ============================================================
   Live metrics — the SSE-driven heartbeat for the live dashboard.
   ------------------------------------------------------------
   Combines the in-memory traffic buffer (active visitors, geo,
   source, device, pages) with authoritative same-day orders +
   revenue from the orders table, and publishes the whole snapshot
   to admins via the existing SSE hub (event "analytics:metrics").
   The /realtime REST endpoint serves the same snapshot for first
   paint; SSE pushes keep it live with no polling.
   ============================================================ */

const REVENUE_SQL = "'PLACED','CONFIRMED','PROCESSING','SHIPPED','DELIVERED'";
const TICK_MS = 10_000;

const n = (v: unknown): number => (v == null ? 0 : Number(v));

function startOfTodayLocal(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // MySQL-friendly 'YYYY-MM-DD HH:MM:SS'
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`;
}

/** Today's authoritative orders + revenue (paid statuses). Cheap, indexed. */
async function todayOrders(): Promise<{ orders: number; revenue: number }> {
  const rows = await prisma.$queryRawUnsafe<{ c: unknown; rev: unknown }[]>(
    `SELECT COUNT(*) AS c, COALESCE(SUM(finalAmount),0) AS rev
       FROM orders WHERE status IN (${REVENUE_SQL}) AND placedAt >= ?`,
    startOfTodayLocal()
  );
  return { orders: n(rows[0]?.c), revenue: n(rows[0]?.rev) };
}

export interface LiveSnapshot extends ReturnType<typeof liveTraffic> {
  at: string;
  today: { orders: number; revenue: number };
}

/** Full snapshot used by both the SSE tick and the REST endpoint. */
export async function buildLiveSnapshot(): Promise<LiveSnapshot> {
  const [today, traffic] = await Promise.all([todayOrders(), Promise.resolve(liveTraffic())]);
  return { at: new Date().toISOString(), today, ...traffic };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic metrics push. Idempotent; disabled with ANALYTICS_JOBS=off. */
export function startLiveMetrics(): void {
  if (timer || process.env.ANALYTICS_JOBS === "off") return;
  const tick = async () => {
    try {
      const snap = await buildLiveSnapshot();
      publish({ event: "analytics:metrics", data: snap });
    } catch (err) {
      console.error("[analytics] live metrics tick failed", err);
    }
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  void tick(); // immediate first push
  console.log("[analytics] live metrics started");
}
