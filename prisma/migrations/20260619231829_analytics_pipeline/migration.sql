-- ============================================================
--  Analytics pipeline — tables + monthly partitioning.
--
--  DO NOT run `prisma migrate dev` against this (the shared prod DB:
--  see memory "prisma-migrate-drift-workaround" / "shared-db-local-equals-prod").
--  Apply with the safe path instead, from backend/:
--
--    npx prisma db execute --file \
--      prisma/migrations/20260619231829_analytics_pipeline/migration.sql \
--      --schema prisma
--    npx prisma migrate resolve --applied 20260619231829_analytics_pipeline \
--      --schema prisma
--
--  All statements are idempotent (IF NOT EXISTS) so a partial re-run is safe.
-- ============================================================

-- ---------- Firehose (PARTITIONED BY RANGE on a date) ----------
-- MySQL requires every UNIQUE/PK to include the partitioning column, so the
-- PK is (id, created_day) and created_day is a generated DATE mirror of
-- createdAt. Prisma sees only `id` as the @id; the extra column + partitioning
-- live here and are introspection-compatible.
CREATE TABLE IF NOT EXISTS `analytics_events` (
  `id`         BIGINT NOT NULL AUTO_INCREMENT,
  `eventName`  VARCHAR(60)  NOT NULL,
  `visitorId`  CHAR(36)     NOT NULL,
  `sessionId`  CHAR(36)     NOT NULL,
  `userId`     INT NULL,
  `source`     VARCHAR(60)  NULL,
  `medium`     VARCHAR(60)  NULL,
  `campaign`   VARCHAR(120) NULL,
  `content`    VARCHAR(120) NULL,
  `referrer`   VARCHAR(255) NULL,
  `path`       VARCHAR(255) NULL,
  `productId`  INT NULL,
  `categoryId` INT NULL,
  `device`     VARCHAR(20)  NULL,
  `browser`    VARCHAR(40)  NULL,
  `os`         VARCHAR(40)  NULL,
  `country`    VARCHAR(60)  NULL,
  `state`      VARCHAR(80)  NULL,
  `city`       VARCHAR(80)  NULL,
  `props`      JSON NULL,
  `createdAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_day` DATE NOT NULL DEFAULT (DATE(`createdAt`)),
  PRIMARY KEY (`id`, `created_day`),
  INDEX `ae_event_created`   (`eventName`, `createdAt`),
  INDEX `ae_session`         (`sessionId`),
  INDEX `ae_visitor_created` (`visitorId`, `createdAt`),
  INDEX `ae_product_event`   (`productId`, `eventName`, `createdAt`),
  INDEX `ae_created`         (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY RANGE (TO_DAYS(`created_day`)) (
  PARTITION p2026_06 VALUES LESS THAN (TO_DAYS('2026-07-01')),
  PARTITION p2026_07 VALUES LESS THAN (TO_DAYS('2026-08-01')),
  PARTITION p2026_08 VALUES LESS THAN (TO_DAYS('2026-09-01')),
  PARTITION p2026_09 VALUES LESS THAN (TO_DAYS('2026-10-01')),
  PARTITION p2026_10 VALUES LESS THAN (TO_DAYS('2026-11-01')),
  PARTITION p2026_11 VALUES LESS THAN (TO_DAYS('2026-12-01')),
  PARTITION p2026_12 VALUES LESS THAN (TO_DAYS('2027-01-01')),
  PARTITION pmax     VALUES LESS THAN MAXVALUE
);
-- The monthly partitionMaintenance job splits pmax forward each month
-- (REORGANIZE PARTITION pmax INTO (p2027_01 ..., pmax ...)) and drops old ones.

-- ---------- Session / visitor entities ----------
CREATE TABLE IF NOT EXISTS `analytics_sessions` (
  `id`          CHAR(36) NOT NULL,
  `visitorId`   CHAR(36) NOT NULL,
  `userId`      INT NULL,
  `source`      VARCHAR(60) NULL,
  `medium`      VARCHAR(60) NULL,
  `campaign`    VARCHAR(120) NULL,
  `device`      VARCHAR(20) NULL,
  `browser`     VARCHAR(40) NULL,
  `os`          VARCHAR(40) NULL,
  `country`     VARCHAR(60) NULL,
  `state`       VARCHAR(80) NULL,
  `city`        VARCHAR(80) NULL,
  `startedAt`   DATETIME(3) NOT NULL,
  `lastSeenAt`  DATETIME(3) NOT NULL,
  `endedAt`     DATETIME(3) NULL,
  `pageviews`   INT NOT NULL DEFAULT 1,
  `durationSec` INT NULL,
  `isBounce`    TINYINT(1) NOT NULL DEFAULT 1,
  `entryPath`   VARCHAR(255) NULL,
  `exitPath`    VARCHAR(255) NULL,
  `converted`   TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  INDEX `as_visitor` (`visitorId`),
  INDEX `as_started` (`startedAt`),
  INDEX `as_user`    (`userId`),
  INDEX `as_ended`   (`endedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `analytics_visitors` (
  `id`            CHAR(36) NOT NULL,
  `userId`        INT NULL,
  `firstSeenAt`   DATETIME(3) NOT NULL,
  `lastSeenAt`    DATETIME(3) NOT NULL,
  `firstSource`   VARCHAR(60) NULL,
  `firstMedium`   VARCHAR(60) NULL,
  `firstCampaign` VARCHAR(120) NULL,
  `sessionCount`  INT NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `av_user` (`userId`),
  INDEX `av_first_seen` (`firstSeenAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Rollups ----------
CREATE TABLE IF NOT EXISTS `agg_daily_traffic` (
  `day`         CHAR(10) NOT NULL,
  `source`      VARCHAR(60) NOT NULL,
  `medium`      VARCHAR(60) NOT NULL,
  `campaign`    VARCHAR(120) NOT NULL,
  `device`      VARCHAR(20) NOT NULL,
  `country`     VARCHAR(60) NOT NULL,
  `visitors`    INT NOT NULL DEFAULT 0,
  `newVisitors` INT NOT NULL DEFAULT 0,
  `sessions`    INT NOT NULL DEFAULT 0,
  `pageviews`   INT NOT NULL DEFAULT 0,
  `bounces`     INT NOT NULL DEFAULT 0,
  `durationSec` INT NOT NULL DEFAULT 0,
  `orders`      INT NOT NULL DEFAULT 0,
  `revenue`     DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`day`,`source`,`medium`,`campaign`,`device`,`country`),
  INDEX `adt_day` (`day`),
  INDEX `adt_source_day` (`source`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `agg_daily_product` (
  `day`            CHAR(10) NOT NULL,
  `productId`      INT NOT NULL,
  `views`          INT NOT NULL DEFAULT 0,
  `uniqueViewers`  INT NOT NULL DEFAULT 0,
  `addToCart`      INT NOT NULL DEFAULT 0,
  `removeFromCart` INT NOT NULL DEFAULT 0,
  `purchases`      INT NOT NULL DEFAULT 0,
  `qtySold`        INT NOT NULL DEFAULT 0,
  `revenue`        DECIMAL(12,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`day`,`productId`),
  INDEX `adp_day` (`day`),
  INDEX `adp_product_day` (`productId`,`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `agg_daily_funnel` (
  `day`             CHAR(10) NOT NULL,
  `source`          VARCHAR(60) NOT NULL,
  `visitors`        INT NOT NULL DEFAULT 0,
  `productViews`    INT NOT NULL DEFAULT 0,
  `addToCart`       INT NOT NULL DEFAULT 0,
  `checkoutStarted` INT NOT NULL DEFAULT 0,
  `orders`          INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`day`,`source`),
  INDEX `adf_day` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `agg_search_terms` (
  `day`        CHAR(10) NOT NULL,
  `term`       VARCHAR(120) NOT NULL,
  `searches`   INT NOT NULL DEFAULT 0,
  `zeroResult` INT NOT NULL DEFAULT 0,
  `clicks`     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`day`,`term`),
  INDEX `ast_day` (`day`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------- Marketing short links / QR ----------
CREATE TABLE IF NOT EXISTS `short_links` (
  `id`        INT NOT NULL AUTO_INCREMENT,
  `code`      VARCHAR(40) NOT NULL,
  `target`    VARCHAR(500) NOT NULL,
  `source`    VARCHAR(60) NULL,
  `medium`    VARCHAR(60) NULL,
  `campaign`  VARCHAR(120) NULL,
  `content`   VARCHAR(120) NULL,
  `label`     VARCHAR(120) NULL,
  `clicks`    INT NOT NULL DEFAULT 0,
  `active`    TINYINT(1) NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `sl_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
