/* Social feed settings (#DrapedInAV) — admin-managed reels + posts surfaced on
   the storefront homepage, mirroring the hero-image override pattern. Stored as
   a single SiteSetting row under `social`. */
import { prisma } from "./prisma";

export const SOCIAL_KEY = "social";

export type SocialReel = {
  id: string;
  /** Poster image URL (Cloudinary or any absolute/site-relative URL). */
  poster: string;
  /** Optional vertical video URL. Absent → the poster stands in. */
  video?: string;
  caption?: string;
  views?: string;
  /** Optional product slug surfaced as a "Shop this look" CTA. */
  productSlug?: string;
};

export type SocialPost = {
  id: string;
  /** One or more image URLs paged through in the lightbox. */
  images: string[];
  caption?: string;
  productSlug?: string;
};

export type SocialSettings = { reels: SocialReel[]; posts: SocialPost[] };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const optStr = (v: unknown): string | undefined => str(v) || undefined;

/** Coerce an arbitrary stored/submitted value into a safe SocialSettings. Drops
    reels without a poster and posts without any image, so the storefront never
    has to defend against half-filled rows. */
export function normalizeSocialSettings(raw: unknown): SocialSettings {
  const obj = (raw && typeof raw === "object" ? raw : {}) as {
    reels?: unknown;
    posts?: unknown;
  };
  const reelsRaw = Array.isArray(obj.reels) ? obj.reels : [];
  const postsRaw = Array.isArray(obj.posts) ? obj.posts : [];

  const reels = reelsRaw
    .slice(0, 24)
    .map((r: unknown, i: number): SocialReel | null => {
      const row = (r ?? {}) as Record<string, unknown>;
      const poster = str(row.poster);
      if (!poster) return null;
      return {
        id: str(row.id) || `reel-${i}`,
        poster,
        video: optStr(row.video),
        caption: optStr(row.caption),
        views: optStr(row.views),
        productSlug: optStr(row.productSlug),
      };
    })
    .filter((r): r is SocialReel => r !== null);

  const posts = postsRaw
    .slice(0, 24)
    .map((p: unknown, i: number): SocialPost | null => {
      const row = (p ?? {}) as Record<string, unknown>;
      const images = (Array.isArray(row.images) ? row.images : [])
        .map(str)
        .filter(Boolean)
        .slice(0, 10);
      if (!images.length) return null;
      return {
        id: str(row.id) || `post-${i}`,
        images,
        caption: optStr(row.caption),
        productSlug: optStr(row.productSlug),
      };
    })
    .filter((p): p is SocialPost => p !== null);

  return { reels, posts };
}

/** Read the stored social settings (normalised). Empty arrays = use defaults. */
export async function getSocialSettings(): Promise<SocialSettings> {
  const setting = await prisma.siteSetting.findUnique({ where: { key: SOCIAL_KEY } });
  return normalizeSocialSettings(setting?.value ?? null);
}
