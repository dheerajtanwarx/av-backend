-- ============================================================
--  Analytics Phase 3 — revenue-by-source column + performance rollup.
--
--  Apply (shared prod DB — NOT `migrate dev`):
--    npx prisma db execute --file \
--      prisma/migrations/20260620001251_analytics_phase3/migration.sql --schema prisma
--    npx prisma migrate resolve --applied 20260620001251_analytics_phase3 --schema prisma
--
--  MySQL 8 has no ADD COLUMN IF NOT EXISTS; this ALTER runs once. If re-run it
--  errors with "Duplicate column" — safe to ignore.
-- ============================================================

ALTER TABLE `agg_daily_funnel`
  ADD COLUMN `revenue` DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS `agg_daily_perf` (
  `day`      CHAR(10) NOT NULL,
  `metric`   VARCHAR(20) NOT NULL,
  `rating`   VARCHAR(20) NOT NULL,
  `samples`  INT NOT NULL DEFAULT 0,
  `sumValue` DOUBLE NOT NULL DEFAULT 0,
  PRIMARY KEY (`day`,`metric`,`rating`),
  INDEX `adperf_day` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
