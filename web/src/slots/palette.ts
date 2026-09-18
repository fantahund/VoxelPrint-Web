import { fromOklab, oklabDistance, toOklab, type Oklab } from "../colour";
import type { FilamentSlot } from "./filament";

/** A block type, what it looks like, and how much of the build it is. */
export interface WeightedBlock {
  readonly id: string;
  /** What the block looks like in Minecraft, as 0xRRGGBB. */
  readonly colour: number;
  /** How many blocks of this type there are. */
  readonly count: number;
}

/** How many rounds of refinement. Far more than these ever change anything. */
const ROUNDS = 40;

/**
 * Works out which colours to print a build in.
 *
 * <p>A fixed set of filament colours is the wrong starting point for this. Ask
 * which of white, black, brown and green is nearest to each block of a village
 * house and the honest answer is brown for almost all of them: Minecraft is
 * built out of greys, browns and greens of middling lightness, and a palette
 * that does not cover those collapses the whole build onto one spool. Nearest
 * colour is not the bug there -- the palette is.
 *
 * <p>So the palette is derived from the build instead. The block colours are
 * clustered in Oklab, weighted by how many blocks carry them, and each cluster's
 * centre becomes one filament. That is the same question a printer owner asks
 * before loading spools: given this build and this many slots, which colours?
 *
 * <p>Deterministic on purpose: the same build gives the same palette every time.
 * A palette that shifted between two looks at one project would make the
 * preview untrustworthy, which matters more here than the small gain a random
 * restart would sometimes bring.
 *
 * <p>Returns fewer slots than asked for when the build has fewer distinct
 * colours than that, because an unused filament is exactly what this is meant
 * to stop.
 */
export function derivePalette(blocks: readonly WeightedBlock[], slots: number): FilamentSlot[] {
  const points = blocks
    .filter((block) => block.count > 0)
    .map((block) => ({ ...block, oklab: toOklab(block.colour) }));
  if (points.length === 0 || slots < 1) {
    return [];
  }

  const wanted = Math.min(slots, distinctColours(points));
  let centres = seed(points, wanted);

  for (let round = 0; round < ROUNDS; round++) {
    const next = recentre(points, centres);
    if (next.every((centre, i) => oklabDistance(centre, centres[i] as Oklab) < 1e-9)) {
      centres = next;
      break;
    }
    centres = next;
  }

  const members = group(points, centres);
  const palette: FilamentSlot[] = [];
  for (let i = 0; i < centres.length; i++) {
    const cluster = members[i] as typeof points;
    // A cluster nothing landed in would be a spool loaded for no reason.
    if (cluster.length === 0) {
      continue;
    }
    palette.push({
      name: nameOf(cluster),
      colour: fromOklab(centres[i] as Oklab),
    });
  }
  return palette;
}

function distinctColours(points: ReadonlyArray<{ colour: number }>): number {
  return new Set(points.map((point) => point.colour)).size;
}

/**
 * Picks the starting colours.
 *
 * <p>The most common block first, then repeatedly whichever block is furthest
 * from everything picked so far, counted by how much of the build it is. That
 * is k-means++ with the draw replaced by the best candidate, which costs the
 * randomness and buys the repeatability.
 */
function seed(
  points: ReadonlyArray<{ readonly count: number; readonly oklab: Oklab }>,
  wanted: number,
): Oklab[] {
  const heaviest = points.reduce((a, b) => (b.count > a.count ? b : a));
  const centres: Oklab[] = [heaviest.oklab];

  while (centres.length < wanted) {
    let best: Oklab | null = null;
    let bestScore = -1;
    for (const point of points) {
      const nearest = Math.min(...centres.map((centre) => oklabDistance(point.oklab, centre)));
      const score = nearest * point.count;
      if (score > bestScore) {
        bestScore = score;
        best = point.oklab;
      }
    }
    if (best === null || bestScore <= 0) {
      // Every remaining block already sits on a chosen colour.
      break;
    }
    centres.push(best);
  }
  return centres;
}

/** Moves every centre to the weighted middle of the blocks nearest to it. */
function recentre(
  points: ReadonlyArray<{ readonly count: number; readonly oklab: Oklab }>,
  centres: readonly Oklab[],
): Oklab[] {
  const sums = centres.map(() => ({ l: 0, a: 0, b: 0, weight: 0 }));
  for (const point of points) {
    const sum = sums[nearestOf(point.oklab, centres)] as (typeof sums)[number];
    sum.l += point.oklab.l * point.count;
    sum.a += point.oklab.a * point.count;
    sum.b += point.oklab.b * point.count;
    sum.weight += point.count;
  }

  return centres.map((centre, i) => {
    const sum = sums[i] as (typeof sums)[number];
    if (sum.weight === 0) {
      return centre;
    }
    return { l: sum.l / sum.weight, a: sum.a / sum.weight, b: sum.b / sum.weight };
  });
}

function group<T extends { readonly oklab: Oklab }>(
  points: readonly T[],
  centres: readonly Oklab[],
): T[][] {
  const members: T[][] = centres.map(() => []);
  for (const point of points) {
    (members[nearestOf(point.oklab, centres)] as T[]).push(point);
  }
  return members;
}

function nearestOf(colour: Oklab, centres: readonly Oklab[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centres.length; i++) {
    const distance = oklabDistance(colour, centres[i] as Oklab);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Names a filament after the block it is mostly there for.
 *
 * <p>"Cobblestone" says far more than "Filament 1" when the next thing to do is
 * decide what each block prints in.
 */
function nameOf(cluster: ReadonlyArray<{ readonly id: string; readonly count: number }>): string {
  const heaviest = cluster.reduce((a, b) => (b.count > a.count ? b : a));
  const id = heaviest.id.includes(":") ? heaviest.id.split(":")[1] ?? heaviest.id : heaviest.id;
  const words = id.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
