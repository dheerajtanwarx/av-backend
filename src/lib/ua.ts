import { UAParser } from "ua-parser-js";

/* ============================================================
   User-agent enrichment. Parsed server-side so the client can't
   spoof device stats and the firehose stays consistent.
   ============================================================ */

export interface UaResult {
  device: "desktop" | "mobile" | "tablet";
  browser: string | null;
  os: string | null;
}

export function parseUa(userAgent: string | undefined): UaResult {
  if (!userAgent) return { device: "desktop", browser: null, os: null };
  const r = UAParser(userAgent);
  // ua-parser leaves device.type undefined for desktops.
  const t = r.device?.type;
  const device = t === "mobile" ? "mobile" : t === "tablet" ? "tablet" : "desktop";
  return {
    device,
    browser: r.browser?.name ? r.browser.name.slice(0, 40) : null,
    os: r.os?.name ? r.os.name.slice(0, 40) : null,
  };
}
