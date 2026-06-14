/* Demo catalog seed — ADDITIVE-AFTER-WIPE.
   1. Snapshots everything it is about to delete to a timestamped JSON (safety net).
   2. Deletes the existing catalog + its dependent transactional rows
      (payments, order items, reviews, orders, cart, wishlist, images, variants,
       products). Categories, users, promos, etc. are left untouched.
   3. Uploads the local images in `images-av/` to Cloudinary ONCE (cached to
      `prisma/.demo-image-urls.json`), then reuses those URLs across products.
   4. Creates ~32 realistic Jaipuri-ethnicwear products with variants + images.
   5. Records the created product ids to `prisma/demo-product-ids.json` so
      `demo-unseed.ts` can remove exactly these later in one query.

   Run with: npx tsx prisma/demo-seed.ts */

import "dotenv/config";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { prisma } from "../src/lib/prisma";
import { parseINR } from "../src/lib/money";
import { uploadImage, cloudinaryConfigured } from "../src/lib/cloudinary";

const IMAGES_DIR = join(__dirname, "..", "images-av");
const IMAGE_CACHE = join(__dirname, ".demo-image-urls.json");
const IDS_FILE = join(__dirname, "demo-product-ids.json");
const BACKUP_FILE = join(
  __dirname,
  `_pre-demo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
);

/* ---------- colour palette (name + hex) ---------- */
const PALETTE = [
  { name: "Rani Pink", hex: "#bd3c6e" },
  { name: "Deep Maroon", hex: "#6e1f2e" },
  { name: "Emerald", hex: "#1d5042" },
  { name: "Royal Blue", hex: "#27406e" },
  { name: "Mustard Gold", hex: "#c79a3b" },
  { name: "Ivory", hex: "#f3ece0" },
  { name: "Firozi", hex: "#1c8c8c" },
  { name: "Gulabi", hex: "#e58aa8" },
  { name: "Onyx Black", hex: "#1c1c1c" },
  { name: "Sandstone", hex: "#c9a06a" },
];

const GARMENT_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
const FREE_SIZE = ["Free Size"];

/* ---------- product definitions (curated, realistic) ---------- */
type Def = {
  name: string;
  type: string;
  price: number;
  was?: number;
  badge?: string;
  bestseller?: boolean;
  freeSize?: boolean; // odhni / saree / dupatta
};

const CATALOG: Record<string, Def[]> = {
  "jaipuri-odhni": [
    { name: "Gulabi Bandhej Odhni", type: "Bandhej · Pure Georgette", price: 3450, badge: "New", freeSize: true },
    { name: "Leheriya Wave Odhni", type: "Leheriya · Chiffon", price: 2890, was: 3600, freeSize: true },
    { name: "Gota Patti Rani Odhni", type: "Gota Patti · Silk Blend", price: 4750, badge: "Signature", freeSize: true },
    { name: "Sanganeri Block Odhni", type: "Hand-Block · Cotton Mul", price: 2150, freeSize: true },
    { name: "Mothra Bandhani Odhni", type: "Bandhej · Modal Silk", price: 3990, freeSize: true },
    { name: "Kesariya Leheriya Odhni", type: "Leheriya · Pure Silk", price: 5200, badge: "New", freeSize: true },
    { name: "Pila Chunari Odhni", type: "Bandhej · Cotton", price: 1850, freeSize: true },
  ],
  lehenga: [
    { name: "Rani Bagh Bridal Lehenga", type: "Zardozi · Raw Silk", price: 68500, was: 82000, bestseller: true },
    { name: "Mirror Mahal Lehenga", type: "Sheesha · Georgette", price: 16750, badge: "Trending", bestseller: true },
    { name: "Amrai Gota Lehenga", type: "Gota Patti · Silk", price: 24500 },
    { name: "Sheesh Mahal Lehenga", type: "Mirror & Zari · Velvet", price: 39900, badge: "Signature" },
    { name: "Hawa Mahal Chikan Lehenga", type: "Chikankari · Cotton Silk", price: 12900 },
    { name: "Padmini Zardozi Lehenga", type: "Zardozi · Banarasi Silk", price: 54500, was: 62000, bestseller: true },
    { name: "Bagheecha Floral Lehenga", type: "Resham · Organza", price: 18900, badge: "New" },
  ],
  "designer-saree": [
    { name: "Chanderi Gold Tissue Saree", type: "Zari · Chanderi Silk", price: 7600, was: 9200, bestseller: true, freeSize: true },
    { name: "Kota Doria Block Saree", type: "Hand-Block · Kota Cotton", price: 4200, freeSize: true },
    { name: "Banarasi Rani Silk Saree", type: "Zari · Banarasi Silk", price: 14500, freeSize: true },
    { name: "Leheriya Chiffon Saree", type: "Leheriya · Chiffon", price: 5600, freeSize: true },
    { name: "Bandhej Georgette Saree", type: "Bandhej · Georgette", price: 6800, badge: "Trending", freeSize: true },
    { name: "Maheshwari Tissue Saree", type: "Zari · Maheshwari Silk", price: 8900, freeSize: true },
    { name: "Gota Border Organza Saree", type: "Gota Patti · Organza", price: 9900, badge: "New", freeSize: true },
  ],
  "suit-sets": [
    { name: "Sanganeri Cotton Suit Set", type: "Hand-Block · Cotton", price: 4990, bestseller: true },
    { name: "Chikankari Anarkali Suit", type: "Chikankari · Georgette", price: 8900 },
    { name: "Gota Patti Sharara Set", type: "Gota Patti · Cotton Silk", price: 11500, badge: "Signature" },
    { name: "Bandhej Palazzo Suit", type: "Bandhej · Modal", price: 6200 },
    { name: "Mulmul Block Print Suit", type: "Hand-Block · Cotton Mul", price: 3990, badge: "New" },
    { name: "Zari Angrakha Suit Set", type: "Zari · Chanderi", price: 9800 },
  ],
  dupatta: [
    { name: "Gota Patti Net Dupatta", type: "Gota Patti · Net", price: 2450, freeSize: true },
    { name: "Bandhej Pure Silk Dupatta", type: "Bandhej · Pure Silk", price: 3200, badge: "New", freeSize: true },
    { name: "Leheriya Chiffon Dupatta", type: "Leheriya · Chiffon", price: 1990, freeSize: true },
    { name: "Sanganeri Cotton Dupatta", type: "Hand-Block · Cotton", price: 1450, freeSize: true },
    { name: "Zari Organza Dupatta", type: "Zari · Organza", price: 2890, badge: "Trending", freeSize: true },
  ],
};

const slugify = (s: string): string =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const describe = (name: string, type: string, categoryName: string): string => {
  const [craft, fabric] = type.split("·").map((s) => s.trim());
  return (
    `${name} — a handcrafted ${categoryName.toLowerCase()} from our Jaipur atelier, ` +
    `featuring ${craft.toLowerCase()} work on ${fabric.toLowerCase()}. ` +
    `Each piece is finished by hand, so subtle variations are a mark of its artisanal origin. ` +
    `Dry-clean recommended; store folded in the muslin pouch provided.`
  );
};

/* deterministic pseudo-random in [min,max] from an integer seed */
const seededInt = (seed: number, min: number, max: number): number =>
  min + (Math.abs(Math.sin(seed) * 10000) % (max - min + 1) | 0);

/* ---------- image upload (cached) ---------- */
async function getImageUrls(): Promise<string[]> {
  if (existsSync(IMAGE_CACHE)) {
    const cached = JSON.parse(readFileSync(IMAGE_CACHE, "utf8")) as Record<string, string>;
    const urls = Object.values(cached);
    if (urls.length) {
      console.log(`Reusing ${urls.length} cached Cloudinary URLs (${IMAGE_CACHE}).`);
      return urls;
    }
  }
  if (!cloudinaryConfigured) {
    throw new Error(
      "Cloudinary is not configured (set CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET in .env)."
    );
  }
  const files = readdirSync(IMAGES_DIR)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();
  if (!files.length) throw new Error(`No images found in ${IMAGES_DIR}`);

  console.log(`Uploading ${files.length} images to Cloudinary…`);
  const map: Record<string, string> = {};
  for (const f of files) {
    const buf = readFileSync(join(IMAGES_DIR, f));
    const { url } = await uploadImage(buf, "av-creation/products");
    map[f] = url;
    console.log(`  ✓ ${f} → ${url}`);
  }
  writeFileSync(IMAGE_CACHE, JSON.stringify(map, null, 2));
  console.log(`Cached URLs to ${IMAGE_CACHE}`);
  return Object.values(map);
}

/* ---------- backup ---------- */
async function backup() {
  console.log("Backing up catalog + dependent rows before delete…");
  const data = {
    takenAt: new Date().toISOString(),
    products: await prisma.product.findMany(),
    productVariants: await prisma.productVariant.findMany(),
    productImages: await prisma.productImage.findMany(),
    orders: await prisma.order.findMany(),
    orderItems: await prisma.orderItem.findMany(),
    payments: await prisma.payment.findMany(),
    reviews: await prisma.review.findMany(),
    cartItems: await prisma.cartItem.findMany(),
    wishlist: await prisma.wishlistItem.findMany(),
  };
  writeFileSync(
    BACKUP_FILE,
    JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)
  );
  console.log(`  ✓ snapshot → ${BACKUP_FILE}`);
}

/* ---------- wipe ---------- */
async function wipe() {
  console.log("Deleting old catalog + dependent transactional rows…");
  // Order matters: OrderItem.variant is onDelete:Restrict, so order items
  // (and their parent orders/payments) must go before variants/products.
  const r = {
    payments: (await prisma.payment.deleteMany()).count,
    orderItems: (await prisma.orderItem.deleteMany()).count,
    reviews: (await prisma.review.deleteMany()).count,
    orders: (await prisma.order.deleteMany()).count,
    cartItems: (await prisma.cartItem.deleteMany()).count,
    wishlist: (await prisma.wishlistItem.deleteMany()).count,
    productImages: (await prisma.productImage.deleteMany()).count,
    productVariants: (await prisma.productVariant.deleteMany()).count,
    products: (await prisma.product.deleteMany()).count,
  };
  console.log("  deleted:", JSON.stringify(r));
}

/* ---------- seed ---------- */
async function seed(urls: string[]) {
  const categories = await prisma.category.findMany();
  const catBySlug: Record<string, { id: number; name: string }> = {};
  for (const c of categories) catBySlug[c.slug] = { id: c.id, name: c.name };

  const createdIds: number[] = [];
  let idx = 0;

  for (const [catSlug, defs] of Object.entries(CATALOG)) {
    const cat = catBySlug[catSlug];
    if (!cat) {
      console.warn(`  ! category '${catSlug}' missing — skipping ${defs.length} products`);
      continue;
    }
    for (const d of defs) {
      const slug = slugify(d.name);
      const sizes = d.freeSize ? FREE_SIZE : GARMENT_SIZES;

      const product = await prisma.product.create({
        data: {
          categoryId: cat.id,
          name: d.name,
          slug,
          type: d.type,
          description: describe(d.name, d.type, cat.name),
          basePrice: parseINR(d.price),
          comparePrice: d.was ? parseINR(d.was) : null,
          badge: d.badge ?? null,
          rating: 4.3 + (seededInt(idx + 1, 0, 6) / 10),
          reviewCount: seededInt(idx + 7, 24, 180),
          isBestseller: Boolean(d.bestseller),
          isActive: true,
          sizes,
        },
      });
      createdIds.push(product.id);

      // 3–4 colour variants drawn from the palette, rotating by product index.
      const variantCount = 3 + (idx % 2); // 3 or 4
      for (let v = 0; v < variantCount; v++) {
        const color = PALETTE[(idx * 3 + v) % PALETTE.length];
        await prisma.productVariant.create({
          data: {
            productId: product.id,
            color: color.name,
            colorHex: color.hex,
            price: parseINR(d.price),
            stockQty: seededInt(idx * 10 + v, 6, 45),
            sku: `${slug}-${slugify(color.name)}`,
          },
        });
      }

      // 4 images per product, spread across the uploaded pool for variety.
      const n = urls.length;
      const picks = [idx % n, (idx + 5) % n, (idx + 11) % n, (idx + 16) % n];
      const seen = new Set<number>();
      let sort = 0;
      for (const p of picks) {
        if (seen.has(p)) continue;
        seen.add(p);
        await prisma.productImage.create({
          data: {
            productId: product.id,
            imageUrl: urls[p],
            isPrimary: sort === 0,
            sortOrder: sort,
          },
        });
        sort++;
      }

      console.log(`  ✓ [${cat.name}] ${d.name} (id=${product.id})`);
      idx++;
    }
  }

  writeFileSync(IDS_FILE, JSON.stringify({ createdAt: new Date().toISOString(), ids: createdIds }, null, 2));
  console.log(`\nCreated ${createdIds.length} products. Ids recorded to ${IDS_FILE}`);
}

async function main() {
  const urls = await getImageUrls(); // upload first so a Cloudinary failure aborts before any delete
  await backup();
  await wipe();
  await seed(urls);
  console.log("\n✅ Demo catalog ready.");
}

main()
  .catch((e) => {
    console.error(e);
    (globalThis as { process?: { exit?: (n: number) => void } }).process?.exit?.(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
