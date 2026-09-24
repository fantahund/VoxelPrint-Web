import { oklabDistance, toOklab, type Oklab } from "../colour";

/**
 * The filaments people can actually buy.
 *
 * <p>Everything the site has chosen a colour with so far has been a colour it
 * worked out itself, which is the right answer to "what would this build look
 * like" and the wrong one to "what can I load into the printer". This is the
 * other half: a hundred and fifty makers and some thirteen thousand colours,
 * every one of them a spool with a name.
 *
 * <p>Fetched rather than bundled, and fetched once. The server keeps the list
 * fresh and answers with an ETag, so the second visit costs a round trip and
 * nothing else; the static snapshot that shipped with the site is what answers
 * if the server has no route for it, which is what makes this work against a
 * plain file server as well.
 */

export interface LibraryColour {
  readonly name: string;
  /** RRGGBB, without the hash. */
  readonly hex: string;
  readonly product: string;
  readonly material: string;
  /** Grams per cubic centimetre. */
  readonly density?: number;
  /** No longer sold, which does not mean nobody has one. */
  readonly discontinued?: boolean;
}

export interface LibraryBrand {
  readonly name: string;
  readonly website: string | null;
  readonly colours: readonly LibraryColour[];
}

export interface Library {
  readonly source: string;
  readonly url: string;
  readonly licence: string;
  readonly version: string;
  readonly fetched: string;
  readonly brands: readonly LibraryBrand[];
}

/** Started once and shared: every picker wants the same list. */
let pending: Promise<Library> | null = null;

export function loadLibrary(): Promise<Library> {
  pending ??= (async () => {
    // The server's copy first, because it is the fresh one. The file that
    // shipped is the fallback, so a site served by anything at all still has a
    // library.
    for (const where of ["/api/filaments", "/filaments.json"]) {
      try {
        const response = await fetch(where);
        if (!response.ok) {
          continue;
        }
        const library = (await response.json()) as Library;
        if (Array.isArray(library.brands) && library.brands.length > 0) {
          // Sorted here rather than trusted to arrive sorted. The file that
          // ships is in this order already, but a server that has not been
          // rebuilt is not, and neither is whatever the database decides to do
          // next: this is a list somebody looks their own maker up in, and
          // where it came from is not their problem.
          return {
            ...library,
            brands: [...library.brands].sort((a, b) =>
              // Case is not a sort order: eSUN belongs under E and colorFabb
              // under C, not in a clump of their own after Z.
              a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
            ),
          };
        }
      } catch {
        // The next one, or the throw below.
      }
    }
    throw new Error("The filament library could not be loaded.");
  })();
  return pending;
}

export function colourOf(colour: LibraryColour): number {
  return Number.parseInt(colour.hex, 16) & 0xffffff;
}

/** A colour with its place in Oklab worked out, which is where they are compared. */
interface Placed {
  readonly colour: LibraryColour;
  readonly at: Oklab;
}

const placed = new WeakMap<readonly LibraryColour[], readonly Placed[]>();

function placeOf(colours: readonly LibraryColour[]): readonly Placed[] {
  const known = placed.get(colours);
  if (known !== undefined) {
    return known;
  }
  // Worked out once per list and kept: a picker that sorts thousands of colours
  // on every keystroke would do this again each time.
  const next = colours.map((colour) => ({ colour, at: toOklab(colourOf(colour)) }));
  placed.set(colours, next);
  return next;
}

/**
 * Colours nearest to a given one first.
 *
 * <p>In Oklab, which is where a colour's distance from another means what the
 * eye means by it. The same measure the palette itself is worked out in, so
 * "the nearest spool to this" agrees with "the colour this build wanted".
 *
 * <p>Takes a list rather than a maker so that a filtered list -- one material,
 * say -- is matched against just as easily as the whole catalogue.
 */
export function nearest(
  colours: readonly LibraryColour[],
  colour: number,
  limit = Infinity,
): readonly LibraryColour[] {
  const want = toOklab(colour);
  return [...placeOf(colours)]
    .sort((a, b) => oklabDistance(a.at, want) - oklabDistance(b.at, want))
    .slice(0, limit)
    .map((entry) => entry.colour);
}

/** The one nearest spool, or null for an empty list. */
export function closest(
  colours: readonly LibraryColour[],
  colour: number,
): LibraryColour | null {
  return nearest(colours, colour, 1)[0] ?? null;
}

/**
 * What a maker sells and how much of each, the widest range first.
 *
 * <p>Worth choosing before a colour, because a print is one material: PLA and
 * PETG want different temperatures and barely stick to each other, so a build
 * that mixes them is a build that comes apart. The picker asks for a material
 * first and matches within it.
 */
export function materialsOf(brand: LibraryBrand): ReadonlyArray<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const colour of brand.colours) {
    counts.set(colour.material, (counts.get(colour.material) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Only the colours of one material, or all of them when none is named. */
export function ofMaterial(
  brand: LibraryBrand,
  material: string | null,
): readonly LibraryColour[] {
  return material === null
    ? brand.colours
    : brand.colours.filter((colour) => colour.material === material);
}

/**
 * How far off the nearest spool is, as a share of the width of the space.
 *
 * <p>Shown beside a match so somebody can see when a build wanted a colour the
 * maker does not sell. Under about four hundredths is a difference nobody
 * notices; a tenth is a visibly different colour.
 */
export function distance(colour: LibraryColour, want: number): number {
  return oklabDistance(toOklab(colourOf(colour)), toOklab(want));
}

/** Colours whose name, product or material contains the words. */
export function search(
  colours: readonly LibraryColour[],
  query: string,
): readonly LibraryColour[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    return colours;
  }
  return colours.filter((colour) => {
    const haystack = `${colour.name} ${colour.product} ${colour.material}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
