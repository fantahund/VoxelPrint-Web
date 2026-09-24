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
          return library;
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

const placed = new WeakMap<LibraryBrand, readonly Placed[]>();

function placeOf(brand: LibraryBrand): readonly Placed[] {
  const known = placed.get(brand);
  if (known !== undefined) {
    return known;
  }
  // Worked out once per maker and kept: a picker that sorts thirteen thousand
  // colours on every keystroke would do this again each time.
  const next = brand.colours.map((colour) => ({ colour, at: toOklab(colourOf(colour)) }));
  placed.set(brand, next);
  return next;
}

/**
 * The maker's colours, nearest to a given one first.
 *
 * <p>In Oklab, which is where a colour's distance from another means what the
 * eye means by it. The same measure the palette itself is worked out in, so
 * "the nearest spool to this" agrees with "the colour this build wanted".
 */
export function nearest(
  brand: LibraryBrand,
  colour: number,
  limit = Infinity,
): readonly LibraryColour[] {
  const want = toOklab(colour);
  return [...placeOf(brand)]
    .sort((a, b) => oklabDistance(a.at, want) - oklabDistance(b.at, want))
    .slice(0, limit)
    .map((entry) => entry.colour);
}

/** The one nearest spool, or null for a maker with nothing in it. */
export function closest(brand: LibraryBrand, colour: number): LibraryColour | null {
  return nearest(brand, colour, 1)[0] ?? null;
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

/** Colours of a maker whose name, product or material contains the words. */
export function search(brand: LibraryBrand, query: string): readonly LibraryColour[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) {
    return brand.colours;
  }
  return brand.colours.filter((colour) => {
    const haystack = `${colour.name} ${colour.product} ${colour.material}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
