/* Removes exactly the demo products created by demo-seed.ts, in one query.
   Reads the recorded ids from `prisma/demo-product-ids.json`. Deleting a
   product cascades to its variants and images. If any demo product has since
   been ordered, OrderItem.variant is onDelete:Restrict and the delete will
   fail loudly — delete the relevant order first, by design.

   Run with: npx tsx prisma/demo-unseed.ts */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { prisma } from "../src/lib/prisma";

const IDS_FILE = join(__dirname, "demo-product-ids.json");

async function main() {
  if (!existsSync(IDS_FILE)) {
    console.error(`No id file at ${IDS_FILE} — nothing to remove.`);
    return;
  }
  const { ids } = JSON.parse(readFileSync(IDS_FILE, "utf8")) as { ids: number[] };
  if (!ids?.length) {
    console.log("Id list is empty — nothing to remove.");
    return;
  }
  const { count } = await prisma.product.deleteMany({ where: { id: { in: ids } } });
  console.log(`✅ Removed ${count} demo products (of ${ids.length} recorded). Variants & images cascaded.`);
}

main()
  .catch((e) => {
    console.error(e);
    (globalThis as { process?: { exit?: (n: number) => void } }).process?.exit?.(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
