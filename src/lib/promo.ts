/* Promo banner settings — full-width, admin-uploaded posters on the homepage.
   There are two independent slots ("signature" and "bridal") that replaced the
   former editorial sections; each is stored as its own SiteSetting row
   `promo:<slot>`. Same pattern as the hero images and social feeds. */
import { prisma } from "./prisma";

export const PROMO_SLOTS = ["signature", "bridal"] as const;
export type PromoSlot = (typeof PROMO_SLOTS)[number];

export function isPromoSlot(s: unknown): s is PromoSlot {
  return typeof s === "string" && (PROMO_SLOTS as readonly string[]).includes(s);
}

const keyFor = (slot: PromoSlot) => `promo:${slot}`;

export type PromoBanner = {
  /** Poster image URL (Cloudinary or any absolute URL). null = use the default. */
  image: string | null;
  /** Where the banner links on click. null = the slot's default. */
  href: string | null;
  /** Accessible label / alt text for the poster. */
  alt: string | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function normalizePromo(raw: unknown): PromoBanner {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    image: str(obj.image) || null,
    href: str(obj.href) || null,
    alt: str(obj.alt) || null,
  };
}

export async function getPromoBanner(slot: PromoSlot): Promise<PromoBanner> {
  const setting = await prisma.siteSetting.findUnique({ where: { key: keyFor(slot) } });
  return normalizePromo(setting?.value ?? null);
}

export async function setPromoBanner(slot: PromoSlot, promo: PromoBanner): Promise<void> {
  await prisma.siteSetting.upsert({
    where: { key: keyFor(slot) },
    create: { key: keyFor(slot), value: promo },
    update: { value: promo },
  });
}
