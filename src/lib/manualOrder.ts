import { prisma } from "./prisma";

/* Central config for the offline-first manual order flow. Stored as one
   SiteSetting row (key "manual_order") so it is editable from the admin
   Settings UI without a deploy. Anything missing falls back to these
   defaults, so the storefront never renders blank. */

export const MANUAL_ORDER_KEY = "manual_order";

export interface ManualOrderConfig {
  /** WhatsApp Business number in wa.me form: country code, digits only, no "+". */
  whatsappNumber: string;
  /** UPI id customers pay to after approval. */
  upiId: string;
  /** Display name shown alongside the UPI id. */
  upiName: string;
  /** Visible response-window promise on the product page. */
  responseWindow: string;
  /** The "not automatically reserved" customer notice. */
  notice: string;
  /** Short reassurance line shown site-wide near request CTAs. */
  confirmationNotice: string;
}

export const DEFAULT_MANUAL_ORDER_CONFIG: ManualOrderConfig = {
  whatsappNumber: "916350695920",
  upiId: "avcreation@ybl",
  upiName: "AV Creation",
  responseWindow: "We respond within 2 hours, Mon–Sat 10am–7pm",
  notice:
    "This product is not automatically reserved. Our team will first verify availability. You will receive payment instructions only after approval.",
  confirmationNotice:
    "Orders are confirmed only after admin approval and payment verification.",
};

/** Coerce a stored JSON blob into a complete config, filling gaps with defaults. */
export function normalizeManualOrderConfig(value: unknown): ManualOrderConfig {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const str = (k: keyof ManualOrderConfig) =>
    typeof v[k] === "string" && (v[k] as string).trim()
      ? (v[k] as string).trim()
      : DEFAULT_MANUAL_ORDER_CONFIG[k];
  return {
    // Keep only digits in the WhatsApp number so wa.me links never break.
    whatsappNumber:
      typeof v.whatsappNumber === "string" && v.whatsappNumber.replace(/\D/g, "")
        ? v.whatsappNumber.replace(/\D/g, "")
        : DEFAULT_MANUAL_ORDER_CONFIG.whatsappNumber,
    upiId: str("upiId"),
    upiName: str("upiName"),
    responseWindow: str("responseWindow"),
    notice: str("notice"),
    confirmationNotice: str("confirmationNotice"),
  };
}

/** Read the live config (defaults if the row was never written). */
export async function getManualOrderConfig(): Promise<ManualOrderConfig> {
  const row = await prisma.siteSetting.findUnique({ where: { key: MANUAL_ORDER_KEY } });
  return normalizeManualOrderConfig(row?.value ?? null);
}

/** Build a wa.me deep link with a prefilled message (free, manual — no API). */
export function waLink(number: string, text: string): string {
  const digits = number.replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
