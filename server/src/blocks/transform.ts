import type { ShapeBox } from "../mcprint/readProject.js";
import type { LibraryQuad } from "./library.js";

/**
 * Turning a borrowed shape the right way round.
 *
 * <p>Half of what makes two blocks different is not that they are different
 * blocks at all: a top slab is a bottom slab upside down, and a stair facing
 * north is a stair facing east turned a quarter. Treating those as bad matches
 * would throw away a perfectly good shape, and taking them as they come would
 * print a slab on the ceiling. So they are taken and turned.
 *
 * <p>This is what makes one exported stair worth four. A build that happens to
 * contain a single oak stair facing south teaches the library every stair in
 * the game, in every direction, at both halves.
 *
 * <p>Everything here works in block-local coordinates, where the block occupies
 * the unit cube and turns about its own centre.
 */

/** Clockwise seen from above, which is the way {@code facing} is written. */
const COMPASS: readonly string[] = ["north", "east", "south", "west"];

/** A quarter turn about Y sends a face to the next one round. */
const TURNED: Readonly<Record<string, string>> = {
  north: "east",
  east: "south",
  south: "west",
  west: "north",
};

export interface Turn {
  /** Quarter turns about the vertical axis, 0 to 3. */
  readonly quarters: number;
  /** Whether the block is also stood on its head. */
  readonly flipped: boolean;
}

export const STILL: Turn = { quarters: 0, flipped: false };
export const isStill = (turn: Turn): boolean => turn.quarters === 0 && !turn.flipped;

/**
 * The turn that takes one block's orientation to another's.
 *
 * <p>Read off the properties rather than from the geometry: the game already
 * says which way a block faces and which half it is in, and believing it is
 * both cheaper and more reliable than trying to see it in the boxes.
 */
export function turnBetween(
  from: ReadonlyMap<string, string>,
  to: ReadonlyMap<string, string>,
): Turn {
  const here = COMPASS.indexOf(from.get("facing") ?? "");
  const there = COMPASS.indexOf(to.get("facing") ?? "");
  const quarters = here === -1 || there === -1 ? 0 : (there - here + 4) % 4;

  // A slab says type, everything else says half, and both spell the two ends
  // of the block the same way.
  const halfOf = (properties: ReadonlyMap<string, string>): string | null => {
    const value = properties.get("half") ?? properties.get("type");
    return value === "top" || value === "bottom" ? value : null;
  };
  const mine = halfOf(from);
  const theirs = halfOf(to);
  return { quarters, flipped: mine !== null && theirs !== null && mine !== theirs };
}

/** One point, turned. */
function point(x: number, y: number, z: number, turn: Turn): [number, number, number] {
  let px = x;
  let pz = z;
  for (let quarter = 0; quarter < turn.quarters; quarter++) {
    // About the block's centre: north goes to east, so (x, z) goes to (1-z, x).
    const wasX = px;
    px = 1 - pz;
    pz = wasX;
  }
  return [px, turn.flipped ? 1 - y : y, pz];
}

/** A box, turned, and put back in low-to-high order afterwards. */
export function turnBox(box: ShapeBox, turn: Turn): ShapeBox {
  if (isStill(turn)) {
    return box;
  }
  const a = point(box[0], box[1], box[2], turn);
  const b = point(box[3], box[4], box[5], turn);
  const round = (value: number): number => Math.round(value * 10000) / 10000;
  return [
    round(Math.min(a[0], b[0])),
    round(Math.min(a[1], b[1])),
    round(Math.min(a[2], b[2])),
    round(Math.max(a[0], b[0])),
    round(Math.max(a[1], b[1])),
    round(Math.max(a[2], b[2])),
  ];
}

/** Which way a face points once the block has been turned. */
export function turnDirection(direction: string | null, turn: Turn): string | null {
  if (direction === null || isStill(turn)) {
    return direction;
  }
  let turned = direction;
  for (let quarter = 0; quarter < turn.quarters; quarter++) {
    turned = TURNED[turned] ?? turned;
  }
  if (turn.flipped) {
    turned = turned === "up" ? "down" : turned === "down" ? "up" : turned;
  }
  return turned;
}

/**
 * A face, turned.
 *
 * <p>Flipping reverses which way a face is wound, and a face wound the wrong
 * way is a hole in the print rather than a surface. So the corners are put back
 * in reverse order whenever the block was stood on its head.
 */
export function turnQuad(quad: LibraryQuad, turn: Turn): LibraryQuad {
  if (isStill(turn)) {
    return quad;
  }
  const corners: number[][] = [];
  for (let corner = 0; corner < 4; corner++) {
    const at = corner * 3;
    corners.push(
      point(
        quad.vertices[at] as number,
        quad.vertices[at + 1] as number,
        quad.vertices[at + 2] as number,
        turn,
      ).map((value) => Math.round(value * 10000) / 10000),
    );
  }
  if (turn.flipped) {
    corners.reverse();
  }
  return {
    direction: turnDirection(quad.direction, turn),
    vertices: corners.flat(),
    colour: quad.colour,
  };
}

/** Properties a turn can put right, so disagreeing on them is not a bad match. */
export const TURNABLE: ReadonlySet<string> = new Set(["facing", "half", "type"]);
