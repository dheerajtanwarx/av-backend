# Analytics & BI pipeline (Phase 1)

First-party event analytics. No third-party scripts; geo/device are enriched
server-side from IP + user-agent, and the raw IP is never persisted.

## Layers

```
browser SDK ──POST /api/track──▶ ingest ──▶ analytics_events (firehose, partitioned)
 (frontend/app/(store)/lib/analytics.ts)        │
                                                ├─▶ analytics_sessions  (1/session)
                                                └─▶ analytics_visitors  (1/visitor)

cron (scheduler.ts) ── every 5m ──▶ rollup.ts ──▶ agg_daily_traffic
                    ── every 10m ─▶ closeSessions       agg_daily_product
                    ── nightly ───▶ reconcileYesterday  agg_daily_funnel
                                                          agg_search_terms
```

The dashboard (Phase 2) reads **only** the `agg_*` tables, so report latency is
independent of firehose size.

## Files

| File | Role |
|---|---|
| `events.ts` | Event-name vocabulary + referrer→source classification. Add events here. |
| `ingest.ts` | Validate + enrich + persist a batch; in-memory "active now" ring buffer. |
| `rollup.ts` | Firehose → `agg_*` transform (recomputes today+yesterday, idempotent). |
| `scheduler.ts` | node-cron wiring. Disable with `ANALYTICS_JOBS=off`. |
| `../routes/track.ts` | `POST /api/track` public collector (204 fast). |
| `../routes/go.ts` | `GET /go/:code` marketing QR / short-link redirector. |
| `../lib/geo.ts`, `../lib/ua.ts` | IP→geo and UA→device enrichment. |

## Applying the migration (shared prod DB — DO NOT use `migrate dev`)

```bash
cd backend
npx prisma db execute \
  --file prisma/migrations/20260619231829_analytics_pipeline/migration.sql \
  --schema prisma
npx prisma migrate resolve \
  --applied 20260619231829_analytics_pipeline --schema prisma
```

The SQL is idempotent (`IF NOT EXISTS`). `analytics_events` is partitioned
monthly; the nightly `partitionMaintenance` job (Phase 3) splits `pmax` forward
and drops partitions past retention.

## Notes / gotchas

- **Marketing QR while the storefront is gated:** `frontend/proxy.ts` redirects
  the store to `/social-links` and strips the query string. So set
  `ShortLink.target = "/social-links"` for now — `/social-links?utm_source=qr`
  is served directly (no redirect, UTM preserved). Switch targets to real store
  paths once the proxy funnel is removed.
- **Day buckets** use `DATE(createdAt)` in the DB session timezone — run MySQL
  in IST for correct boundaries.
- **Revenue-by-source** attribution (joining orders→session source) is Phase 2;
  product purchases/revenue already come from the authoritative `order_items`.
