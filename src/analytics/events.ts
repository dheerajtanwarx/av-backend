/* ============================================================
   Analytics event vocabulary.
   ------------------------------------------------------------
   Mirrors the ACTIONS pattern in src/lib/notify.ts: a namespaced,
   typed catalogue of event names — NOT a DB enum — so adding an
   event is a code change, not a migration. The raw analytics_events
   table stores the name as a string and the payload in `props` (JSON),
   so a new feature's analytics never touches the schema.
   ============================================================ */

export const EVENTS = {
  PAGE_VIEW: "page_view",
  SESSION_START: "session_start",
  SESSION_END: "session_end",

  // Auth (client-side mirror; canonical record stays in ActivityLog server-side)
  LOGIN: "login",
  SIGNUP: "signup",
  LOGOUT: "logout",

  // Catalogue & journey
  PRODUCT_VIEW: "product_view",
  VARIANT_SELECT: "variant_select",
  CATEGORY_VIEW: "category_view",
  CATEGORY_CLICK: "category_click",
  SEARCH: "search",
  BANNER_CLICK: "banner_click",
  SOCIAL_CLICK: "social_click",

  // Cart & checkout
  ADD_TO_CART: "add_to_cart",
  REMOVE_FROM_CART: "remove_from_cart",
  WISHLIST_ADD: "wishlist_add",
  CHECKOUT_STARTED: "checkout_started",
  // Commerce lifecycle. A "request" is the customer submitting an order request
  // (intent — no stock taken); "confirmed" is the admin-approved, stock-deducted
  // sale that spawns a real Order. ORDER_PLACED is the legacy name for a request
  // submission, kept in the vocabulary so historical rows still roll up.
  REQUEST_SUBMITTED: "request_submitted",
  ORDER_PLACED: "order_placed", // legacy alias of REQUEST_SUBMITTED
  ORDER_CONFIRMED: "order_confirmed",
  PAYMENT_COMPLETED: "payment_completed",

  // Attribution
  QR_VISIT: "qr_visit",

  // Performance (Phase 3)
  WEB_VITAL: "web_vital",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Event names that represent "an order request was submitted" — the new
    canonical name plus its legacy alias. The funnel's request stage counts
    either so historical data stays valid across the rename. */
export const REQUEST_EVENTS = [EVENTS.REQUEST_SUBMITTED, EVENTS.ORDER_PLACED] as const;

const VALID = new Set<string>(Object.values(EVENTS));

/** Reject unknown event names at the collector boundary so the firehose
    only ever holds vocabulary we report on. */
export function isKnownEvent(name: unknown): name is EventName {
  return typeof name === "string" && VALID.has(name);
}

/* ------------------------------------------------------------------
   Traffic-source classification.

   A visitor's `source` is whatever utm_source they arrived with; when
   there's no UTM we infer it from the referrer host. This is the single
   place that maps real-world domains to the source buckets the dashboard
   reports ("instagram", "google", "whatsapp", ...). Extend the table to
   recognise a new channel — no other code changes.
   ------------------------------------------------------------------ */
const REFERRER_SOURCE: { test: RegExp; source: string; medium: string }[] = [
  { test: /instagram\./i, source: "instagram", medium: "social" },
  { test: /(facebook|fb)\./i, source: "facebook", medium: "social" },
  { test: /threads\./i, source: "threads", medium: "social" },
  { test: /(wa\.me|whatsapp)/i, source: "whatsapp", medium: "social" },
  { test: /(youtube|youtu\.be)/i, source: "youtube", medium: "social" },
  { test: /(t\.co|twitter|x\.com)/i, source: "twitter", medium: "social" },
  { test: /(pinterest)\./i, source: "pinterest", medium: "social" },
  { test: /google\./i, source: "google", medium: "organic" },
  { test: /bing\./i, source: "bing", medium: "organic" },
  { test: /(duckduckgo|yahoo)\./i, source: "search", medium: "organic" },
];

export interface Attribution {
  source: string;
  medium: string;
  campaign: string | null;
  content: string | null;
}

/** Resolve final attribution from explicit UTM + referrer. UTM always wins;
    otherwise classify the referrer; otherwise "direct". */
export function resolveAttribution(input: {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  referrer?: string | null;
  selfHost?: string | null;
}): Attribution {
  const clean = (v?: string | null, max = 60) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max).toLowerCase() : null;

  const utmSource = clean(input.utmSource);
  if (utmSource) {
    return {
      source: utmSource,
      medium: clean(input.utmMedium) ?? "referral",
      campaign: clean(input.utmCampaign, 120),
      content: clean(input.utmContent, 120),
    };
  }

  const ref = input.referrer?.trim();
  if (ref) {
    let host = "";
    try {
      host = new URL(ref).host;
    } catch {
      host = ref;
    }
    // A referrer from our own host is internal navigation, not a new source.
    if (input.selfHost && host.includes(input.selfHost)) {
      return { source: "direct", medium: "none", campaign: null, content: null };
    }
    for (const r of REFERRER_SOURCE) {
      if (r.test.test(host)) {
        return { source: r.source, medium: r.medium, campaign: null, content: null };
      }
    }
    return { source: host.replace(/^www\./, "").slice(0, 60), medium: "referral", campaign: null, content: null };
  }

  return { source: "direct", medium: "none", campaign: null, content: null };
}
