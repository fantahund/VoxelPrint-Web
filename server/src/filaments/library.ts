/**
 * The filament library: which colours people can actually buy.
 *
 * <p>Two things at once, because neither alone is right. A snapshot is
 * committed to the repository, so the picker works the moment the page loads,
 * works offline, works behind a filter, and works on the day the database moves
 * house. And the server refreshes it from the database in the background, so
 * the colours are as new as the database is.
 *
 * <p>The refreshing is the server's job and not the browser's, and that is a
 * measurement rather than a preference. The database's whole export is fourteen
 * megabytes, three over the wire; what is left after the trimming below is a
 * hundred and ten kilobytes. Asking every visitor to fetch three megabytes to
 * draw a colour picker, for data that changes by a handful of entries a month,
 * is twenty-eight times the traffic for nothing. The server fetches it once,
 * trims it once, and hands everybody the small version -- and because the
 * database answers conditional requests, checking costs nothing at all when
 * nothing has changed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

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
export interface All {
  version: string;
  generated_at: string;
  brands: Brand[];
  materials: Material[];
  filaments: Filament[];
  variants: Variant[];
}

/** One colour somebody can buy, as little of it as is worth keeping. */
export interface Colour {
  /** The colour's name, as the maker sells it. */
  readonly name: string;
  /** RRGGBB, without the hash: it is written once per colour and there are many. */
  readonly hex: string;
  /** The product it belongs to, so "PLA Basic" can be told from "PLA Silk". */
  readonly product: string;
  readonly material: string;
  /** Grams per cubic centimetre, which is what turns a volume into a weight. */
  readonly density?: number;
  /** True for a spool that is no longer sold but may well be on a shelf. */
  readonly discontinued?: boolean;
}

export interface Library {
  readonly source: string;
  readonly url: string;
  readonly licence: string;
  /** The database's own version, so it is always clear how old this is. */
  readonly version: string;
  readonly fetched: string;
  readonly brands: ReadonlyArray<{
    readonly name: string;
    readonly website: string | null;
    readonly colours: readonly Colour[];
  }>;
}

const HEX = /^#([0-9A-Fa-f]{6})$/;

/**
 * Cuts the database down to what a colour picker needs.
 *
 * <p>What is cut is the part nobody here reads: ids, uuids, spool sizes, where
 * to buy it, barcodes, the stores. That is fourteen megabytes down to about
 * one, and none of it is a judgement about filament -- it is a judgement about
 * this program.
 *
 * <p>What is kept is everything that is: every colour of every product,
 * including the ones no longer sold. Two earlier attempts cut more and both
 * were wrong. Dropping discontinued spools loses the spool somebody already
 * has on the shelf, which is the very thing they want to pick. And keeping one
 * entry per colour per maker loses the difference between a matte black and a
 * silk black of the same hex, which is a difference anybody printing can see.
 * They are marked instead, and the picker can decide.
 *
 * <p>Density is kept, alone among the numbers, because it is what turns a
 * volume into a weight.
 */
export function trim(all: All): Library {
  const materials = new Map(all.materials.map((material) => [material.id, material]));
  const filaments = new Map(all.filaments.map((filament) => [filament.id, filament]));
  const brands = new Map(all.brands.map((brand) => [brand.id, brand]));

  const byBrand = new Map<string, { website: string | null; colours: Map<string, Colour> }>();

  for (const variant of all.variants) {
    const match = HEX.exec(variant.color_hex ?? "");
    if (match === null) {
      continue;
    }
    const filament = filaments.get(variant.filament_id);
    const material = filament === undefined ? undefined : materials.get(filament.material_id);
    const brand = material === undefined ? undefined : brands.get(material.brand_id);
    if (filament === undefined || material === undefined || brand === undefined) {
      continue;
    }
    const hex = (match[1] as string).toUpperCase();
    const known = byBrand.get(brand.name) ?? {
      website: brand.website ?? null,
      colours: new Map<string, Colour>(),
    };
    // Keyed by the product as well as the colour, so the same black in matte
    // and in silk stays two things. Only an exact repeat is dropped.
    known.colours.set(`${filament.name}|${hex}`, {
      name: variant.name,
      hex,
      product: filament.name,
      material: material.material,
      ...(typeof filament.density === "number" ? { density: filament.density } : {}),
      ...(variant.discontinued === true || filament.discontinued === true
        ? { discontinued: true }
        : {}),
    });
    byBrand.set(brand.name, known);
  }

  return {
    source: "Open Filament Database",
    url: "https://openfilamentdatabase.org/",
    licence: "MIT",
    version: all.version,
    fetched: new Date().toISOString().slice(0, 10),
    brands: [...byBrand.entries()]
      .map(([name, { website, colours }]) => ({
        name,
        website,
        colours: [...colours.values()].sort(
          (a, b) =>
            Number(a.discontinued ?? false) - Number(b.discontinued ?? false) ||
            a.product.localeCompare(b.product) ||
            a.name.localeCompare(b.name),
        ),
      }))
      .filter((brand) => brand.colours.length > 0)
      .sort((a, b) => b.colours.length - a.colours.length || a.name.localeCompare(b.name)),
  };
}

export const SOURCE = "https://api.openfilamentdatabase.org/json/all.json";

/** How much of an answer to take from somewhere this server does not control. */
const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/**
 * Holds the library and keeps it fresh.
 *
 * <p>Never throws and never blocks. Whatever happens to the database, the
 * snapshot that shipped with the site is still there and still answers.
 */
export class FilamentLibrary {
  private body: string;
  private etag: string;
  /** The database's ETag for what is held, so a check can be conditional. */
  private upstream: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  private constructor(library: Library) {
    this.body = JSON.stringify(library);
    this.etag = `"${library.version}-${library.brands.length}"`;
  }

  /**
   * Reads the snapshot that shipped with the site.
   *
   * <p>Looked for where the built frontend is, and beside the sources when
   * there is no build yet, so development and production both find it.
   */
  static async load(webRoot: string, log: (message: string) => void): Promise<FilamentLibrary> {
    const places = [
      path.join(webRoot, "filaments.json"),
      path.resolve("../web/public/filaments.json"),
      path.resolve("web/public/filaments.json"),
    ];
    for (const place of places) {
      try {
        const library = JSON.parse(await readFile(place, "utf8")) as Library;
        log(`filament library: ${library.brands.length} brands from ${place}`);
        return new FilamentLibrary(library);
      } catch {
        // The next place, or the empty one below.
      }
    }
    log("filament library: no snapshot found, starting empty");
    return new FilamentLibrary({
      source: "Open Filament Database",
      url: "https://openfilamentdatabase.org/",
      licence: "MIT",
      version: "none",
      fetched: new Date().toISOString().slice(0, 10),
      brands: [],
    });
  }

  current(): { body: string; etag: string } {
    return { body: this.body, etag: this.etag };
  }

  /**
   * Checks the database now, and then every so often.
   *
   * @param every how long to wait between checks, in milliseconds
   */
  keepFresh(every: number, log: (message: string) => void): void {
    const check = (): void => {
      void this.refresh(log);
    };
    check();
    this.timer = setInterval(check, every);
    // Never the reason a process stays alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh(log: (message: string) => void): Promise<void> {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.upstream !== null) {
        // Nothing has changed is the usual answer, and it costs one round trip
        // and no body at all.
        headers["If-None-Match"] = this.upstream;
      }
      const response = await fetch(SOURCE, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status === 304) {
        return;
      }
      if (!response.ok) {
        log(`filament library: the database answered ${response.status}, keeping what we have`);
        return;
      }
      const length = Number(response.headers.get("content-length") ?? "0");
      if (length > MAX_BYTES) {
        log(`filament library: the database offered ${length} bytes, which is more than expected`);
        return;
      }

      const all = (await response.json()) as All;
      if (!Array.isArray(all.variants) || all.variants.length === 0) {
        log("filament library: the database answered without any colours, keeping what we have");
        return;
      }
      const library = trim(all);
      this.body = JSON.stringify(library);
      this.etag = `"${library.version}-${library.brands.length}"`;
      this.upstream = response.headers.get("etag");
      const colours = library.brands.reduce((sum, brand) => sum + brand.colours.length, 0);
      log(`filament library: refreshed to ${library.version}, ${library.brands.length} brands, ${colours} colours`);
    } catch (error) {
      // A database that cannot be reached is not a reason for anything to stop
      // working: the snapshot is still there.
      log(`filament library: could not be refreshed (${String(error)}), keeping what we have`);
    }
  }
}
