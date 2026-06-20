import geoip from "geoip-lite";

/* ============================================================
   Geo-IP enrichment (first-party, no external calls).
   ------------------------------------------------------------
   geoip-lite ships a bundled MaxMind-derived DB, so lookups are
   in-process and free. We resolve country/region/city, then the
   caller discards the raw IP (we never persist it) — only the
   coarse geo survives, which keeps the firehose privacy-friendly.
   ============================================================ */

export interface GeoResult {
  country: string | null;
  state: string | null;
  city: string | null;
}

const EMPTY: GeoResult = { country: null, state: null, city: null };

/** Pull the real client IP from Express. Requires app.set('trust proxy', ...)
    so X-Forwarded-For from Render/Vercel is honoured; req.ip already reflects
    that once trust proxy is set. */
export function clientIp(forwardedFor: string | undefined, reqIp: string | undefined): string | null {
  const xff = forwardedFor?.split(",")[0]?.trim();
  const ip = xff || reqIp || "";
  // Strip IPv6-mapped IPv4 prefix and loopback noise.
  const norm = ip.replace(/^::ffff:/, "");
  if (!norm || norm === "::1" || norm === "127.0.0.1") return null;
  return norm;
}

export function lookupGeo(ip: string | null): GeoResult {
  if (!ip) return EMPTY;
  const r = geoip.lookup(ip);
  if (!r) return EMPTY;
  return {
    country: r.country || null,
    state: r.region || null,
    city: r.city || null,
  };
}
