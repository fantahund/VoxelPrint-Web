/**
 * Colour maths, in one place because two parts of the app need it for
 * different reasons: the renderer needs linear light, and matching a block to a
 * filament needs a space where distance means what a person would call
 * similarity.
 */

/** One channel from sRGB to linear light. */
export function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/**
 * Converts a packed sRGB colour to Oklab.
 *
 * <p>Oklab is built so that equal distances look like equal differences. That
 * is exactly the question being asked when a block is matched to a filament,
 * and it is the question RGB answers badly: in RGB a dark blue and a dark brown
 * sit suspiciously close together, and light wood comes out nearer to gold than
 * to brown.
 *
 * <p>Coefficients from Björn Ottosson's definition of the space.
 */
export function toOklab(colour: number): Oklab {
  const r = srgbToLinear(((colour >> 16) & 0xff) / 255);
  const g = srgbToLinear(((colour >> 8) & 0xff) / 255);
  const b = srgbToLinear((colour & 0xff) / 255);

  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    l: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  };
}

/** One channel from linear light back to sRGB. */
export function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

/**
 * Converts an Oklab colour back to a packed sRGB one.
 *
 * <p>The way back from the space colours are compared in. Averaging colours has
 * to happen in Oklab -- the midpoint of two colours in RGB is not the colour a
 * person would call halfway between them -- so anything worked out there needs
 * this to become a colour again.
 *
 * <p>Oklab can describe colours no screen and no filament can show, so each
 * channel is clamped. A colour derived from real ones is never far outside, and
 * clamping is the honest answer for the little that is.
 */
export function fromOklab(colour: Oklab): number {
  const long = (colour.l + 0.3963377774 * colour.a + 0.2158037573 * colour.b) ** 3;
  const medium = (colour.l - 0.1055613458 * colour.a - 0.0638541728 * colour.b) ** 3;
  const short = (colour.l - 0.0894841775 * colour.a - 1.291485548 * colour.b) ** 3;

  const r = 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short;
  const g = -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short;
  const b = -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short;

  return (channel(r) << 16) | (channel(g) << 8) | channel(b);
}

function channel(linear: number): number {
  const value = Math.round(linearToSrgb(linear) * 255);
  return Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0));
}

/** Perceived difference between two colours. Smaller is more alike. */
export function oklabDistance(a: Oklab, b: Oklab): number {
  const dl = a.l - b.l;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

/**
 * Which of a set of colours is nearest, as an index into it.
 *
 * <p>The places are passed already converted, because the question is asked of
 * tens of thousands of faces against the same handful of filaments and
 * converting those again each time is the whole cost.
 */
export function nearestOf(colour: number, places: readonly Oklab[]): number {
  const want = toOklab(colour);
  let best = 0;
  let closest = Infinity;
  for (let i = 0; i < places.length; i++) {
    const gap = oklabDistance(places[i] as Oklab, want);
    if (gap < closest) {
      closest = gap;
      best = i;
    }
  }
  return best;
}
