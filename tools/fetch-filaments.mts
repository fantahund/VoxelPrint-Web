/**
 * Builds the filament library the site ships with.
 *
 * <p>Run with {@code npx tsx tools/fetch-filaments.mts} from the repository
 * root. It writes {@code web/public/filaments.json}, which is committed: the
 * site reads it as a static file and never calls anybody at run time. A page
 * that fetched somebody else's API to draw a colour picker would break the
 * moment that API moved, be blocked wherever the browser is behind a filter,
 * and tell a third party what everybody is printing. A snapshot in the repo
 * does none of that, and this script is how it gets refreshed.
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

const SOURCE = "https://api.openfilamentdatabase.org/json/all.json";
const OUT = "web/public/filaments.json";

/** What the database hands back, of which this wants very little. */
interface Brand {
  id: string;
  name: string;
  website?: string;
}
interface Material {
  id: string;
  brand_id: string;
  material: string;
}
interface Filament {
  id: string;
  material_id: string;
  name: string;
  density?: number;
  discontinued?: boolean;
}
interface Variant {
  id: string;
  filament_id: string;
  name: string;
  color_hex: string;
  discontinued?: boolean;
}
interface All {
  version: string;
  generated_at: string;
  brands: Brand[];
  materials: Material[];
  filaments: Filament[];
  variants: Variant[];
}

const HEX = /^#([0-9A-Fa-f]{6})$/;

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

const materials = new Map(all.materials.map((material) => [material.id, material]));
const filaments = new Map(all.filaments.map((filament) => [filament.id, filament]));

/** One colour somebody can buy, as little of it as is worth keeping. */
interface Colour {
  /** The colour's name, as the maker sells it. */
  readonly name: string;
  /** RRGGBB, without the hash: it is written once per colour and there are many. */
  readonly hex: string;
  /** The product it belongs to, so "PLA Basic" can be told from "PLA Silk". */
  readonly product: string;
  readonly material: string;
}

const byBrand = new Map<string, { website?: string; colours: Map<string, Colour> }>();
let skipped = 0;
let dropped = 0;

for (const variant of all.variants) {
  const match = HEX.exec(variant.color_hex ?? "");
  if (match === null) {
    skipped++;
    continue;
  }
  const filament = filaments.get(variant.filament_id);
  const material = filament === undefined ? undefined : materials.get(filament.material_id);
  const brand = material === undefined ? undefined : all.brands.find((b) => b.id === material.brand_id);
  if (filament === undefined || material === undefined || brand === undefined) {
    skipped++;
    continue;
  }
  // Discontinued spools are colours nobody can buy any more, and a picker that
  // offers them is a picker that sends somebody looking for a spool that is
  // gone. The product being discontinued counts as well as the colour.
  if (variant.discontinued === true || filament.discontinued === true) {
    dropped++;
    continue;
  }

  const hex = (match[1] as string).toUpperCase();
  const known = byBrand.get(brand.name) ?? { website: brand.website, colours: new Map() };
  // One entry per colour per maker. A maker sells the same black in nine
  // products, and nine identical swatches in a picker is nine ways to choose
  // the same thing. The shortest product name wins, which is the plainest.
  const before = known.colours.get(hex);
  if (before === undefined || filament.name.length < before.product.length) {
    known.colours.set(hex, {
      name: variant.name,
      hex,
      product: filament.name,
      material: material.material,
    });
  }
  byBrand.set(brand.name, known);
}

const brands = [...byBrand.entries()]
  .map(([name, { website, colours }]) => ({
    name,
    website,
    colours: [...colours.values()].sort((a, b) => a.name.localeCompare(b.name)),
  }))
  .filter((brand) => brand.colours.length > 0)
  .sort((a, b) => b.colours.length - a.colours.length || a.name.localeCompare(b.name));

const library = {
  source: "Open Filament Database",
  url: "https://openfilamentdatabase.org/",
  licence: "MIT",
  version: all.version,
  fetched: new Date().toISOString().slice(0, 10),
  brands,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(library));

const total = brands.reduce((sum, brand) => sum + brand.colours.length, 0);
console.log(
  `wrote ${OUT}: ${brands.length} brands, ${total} colours ` +
    `(${dropped} discontinued left out, ${skipped} unreadable)`,
);
console.log("  the ten widest ranges:");
for (const brand of brands.slice(0, 10)) {
  console.log(`    ${brand.name.padEnd(24)} ${brand.colours.length}`);
}
