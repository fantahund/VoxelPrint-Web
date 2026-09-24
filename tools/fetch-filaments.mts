/**
 * Builds the filament library the site ships with.
 *
 * <p>Run with {@code npx tsx tools/fetch-filaments.mts} from the repository
 * root. It writes {@code web/public/filaments.json}, which is committed.
 *
 * <p>That snapshot is the floor rather than the whole story: the server keeps
 * a fresher copy in memory and hands that out instead, see
 * {@link FilamentLibrary}. The committed file is what answers before the first
 * refresh has finished, on a machine with no way out to the internet, and on
 * the day the database moves house. Refreshing it now and then keeps that floor
 * from going stale, and is the only reason this script exists.
 *
 * <p>The source is the Open Filament Database, which is MIT licensed -- code
 * and data both -- and is the only database found that covers this many makers
 * with a colour for every single entry: 171 brands, 2099 products, 14600
 * colours, and not one of them missing a well formed hex.
 *
 * <p>The alternative worth knowing about is filamentcolors.xyz, whose colours
 * are measured off a printed swatch with a colorimeter rather than taken from
 * the maker's marketing. Better numbers, a quarter of the coverage, and its
 * data is CC-BY rather than MIT. Worth folding in later where the two overlap;
 * not worth the attribution rules for a first version.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SOURCE, trim, type All } from "../server/src/filaments/library.js";

const OUT = "web/public/filaments.json";

console.log(`reading ${SOURCE}`);
const response = await fetch(SOURCE, { headers: { Accept: "application/json" } });
if (!response.ok) {
  throw new Error(`The database answered ${response.status}.`);
}
const all = (await response.json()) as All;
console.log(
  `  version ${all.version}, ${all.brands.length} brands, ` +
    `${all.filaments.length} products, ${all.variants.length} colours`,
);

const library = trim(all);
const brands = library.brands;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(library));

const total = brands.reduce((sum, brand) => sum + brand.colours.length, 0);
console.log(`wrote ${OUT}: ${brands.length} brands, ${total} colours`);
// The file is alphabetical, which is the order a picker wants; this is just
// the summary, and the widest ranges are what is interesting about a refresh.
const widest = [...brands].sort((a, b) => b.colours.length - a.colours.length);
console.log("  the ten widest ranges:");
for (const brand of widest.slice(0, 10)) {
  console.log(`    ${brand.name.padEnd(24)} ${brand.colours.length}`);
}
