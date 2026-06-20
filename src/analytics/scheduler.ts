import cron from "node-cron";
import {
  rollupRecent,
  reconcileYesterday,
  closeSessions,
  partitionMaintenance,
} from "./rollup";

/* ============================================================
   Analytics background jobs.
   ------------------------------------------------------------
   Runs in-process today (matches the single-instance Render deploy,
   same call as the SSE hub in lib/realtime.ts). Each job is wrapped
   so a failure logs and is skipped — a bad pass never crashes the API
   process or blocks the next tick. To scale out, lift these three
   calls into a dedicated worker.ts; the job bodies don't change.

   A per-job in-process lock prevents a job from overlapping itself if a pass
   runs long, while still letting unrelated jobs run concurrently (e.g. a long
   rollup no longer blocks closeSessions).
   ============================================================ */

const running = new Set<string>();

async function runExclusive(name: string, fn: () => Promise<void>): Promise<void> {
  if (running.has(name)) {
    console.warn(`[analytics] skip ${name}: previous ${name} still running`);
    return;
  }
  running.add(name);
  const t0 = Date.now();
  try {
    await fn();
    console.log(`[analytics] ${name} ok (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`[analytics] ${name} failed`, err);
  } finally {
    running.delete(name);
  }
}

export function startAnalyticsJobs(): void {
  if (process.env.ANALYTICS_JOBS === "off") {
    console.log("[analytics] background jobs disabled (ANALYTICS_JOBS=off)");
    return;
  }

  // Every 5 minutes: roll up today + yesterday.
  cron.schedule("*/5 * * * *", () => runExclusive("rollupRecent", rollupRecent));

  // Every 10 minutes: close idle sessions.
  cron.schedule("*/10 * * * *", () => runExclusive("closeSessions", closeSessions));

  // Nightly 02:15: final reconcile of yesterday.
  cron.schedule("15 2 * * *", () => runExclusive("reconcileYesterday", reconcileYesterday));

  // Monthly (1st, 03:00) + on boot: keep firehose partitions ahead of now.
  cron.schedule("0 3 1 * *", () => runExclusive("partitionMaintenance", partitionMaintenance));

  // Warm pass on boot so a freshly started server has fresh rollups. Chained
  // (not parallel) so partitions exist before the first rollup reads them.
  runExclusive("partitionMaintenance (boot)", partitionMaintenance).then(() =>
    runExclusive("rollupRecent (boot)", rollupRecent)
  );

  console.log("[analytics] background jobs scheduled");
}
