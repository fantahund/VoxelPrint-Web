import type { ShapeBox } from "../mcprint/readProject.js";
import type { BlockLibrary, LibraryEntry, LibraryQuad } from "./library.js";
import { familyOf, parseState, shapesTheBlock } from "./state.js";
import { isStill, turnBetween, turnBox, turnQuad, type Turn } from "./transform.js";

/**
 * Dressing a block state the library has never seen.
 *
 * <p>A schematic is a list of names. Half of them the library knows outright,
 * because somebody once exported a build containing them. The rest have to be
 * guessed at, and the guess this makes is the one a person would: a stone slab
 * is shaped like an oak slab and coloured like stone.
 *
 * <p>So shape and colour are looked up separately and then put together. That
 * separation is the whole idea. A shape is a geometric fact about a family --
 * every bottom slab in the game is the same box, whatever it is made of -- and
 * a colour is a fact about a material. Asking for both at once finds nothing;
 * asking for each on its own nearly always finds something.
 *
 * <p>A borrowed shape is turned before it is used, so a top slab can stand in
 * for a bottom one and a stair facing south for a stair facing east. That is
 * what makes a single exported stair worth every stair in the game.
 *
 * <p>It is also what carries mods. A mod's {@code create:andesite_stairs} is
 * not in anybody's table of block shapes, but it ends in {@code _stairs} and it
 * faces east, and that is enough to borrow from an oak stair facing east. No
 * mod has to be known in advance and none is hard coded.
 */

export type How =
  /** The library had this exact state. */
  | "exact"
  /** The same block from another namespace: a mod's copy of a known block. */
  | "namespace"
  /** A relative of the same family, turned the same way. */
  | "family"
  /** A shape was borrowed and a colour found separately. */
  | "dressed"
  /** Nothing related was known: a plain cube in a guessed colour. */
  | "guessed";

export interface Resolved {
  readonly shape: readonly ShapeBox[];
  readonly quads: readonly LibraryQuad[];
  readonly colour: number;
  readonly how: How;
  /** Which state lent its shape, when it was not this one. */
  readonly shapeFrom: string | null;
  /** Which state lent its colour, when it was not this one. */
  readonly colourFrom: string | null;
}

const CUBE: readonly ShapeBox[] = [[0, 0, 0, 1, 1, 1]];

/** A borrowed shape, turned, or a cube when the donor carried no boxes. */
function turned(shape: readonly ShapeBox[], turn: Turn): readonly ShapeBox[] {
  if (shape.length === 0) {
    return CUBE;
  }
  return isStill(turn) ? shape : shape.map((box) => turnBox(box, turn));
}
const GREY = 0x9a9a9a;

/**
 * How good a relative a candidate is.
 *
 * <p>Properties are what decide it, because within a family they are the only
 * thing that differs: two stairs are the same shape exactly when they face the
 * same way, sit in the same half and turn the same corner. A property the
 * candidate simply does not have costs nothing -- a mod is allowed to leave one
 * out -- but one it has and disagrees on is a wrong shape, and is punished
 * harder than an agreement is rewarded.
 */
/**
 * Properties where disagreeing is a near miss rather than a different block.
 *
 * <p>A straight stair standing in for an inner corner is a stair with a notch
 * in the wrong place, which is worth having. A half slab standing in for a
 * double one is half a block, which is not. Everything not listed here is read
 * as the second kind, because guessing too eagerly is the failure that reaches
 * the printer.
 */
const SURVIVABLE: ReadonlySet<string> = new Set([
  "shape",
  "north",
  "east",
  "south",
  "west",
  "up",
  "down",
]);

/** Whether a quarter turn or a flip could make these two agree. */
function turnable(property: string, wanted: string, theirs: string): boolean {
  if (property === "facing") {
    return ["north", "east", "south", "west"].includes(wanted)
      && ["north", "east", "south", "west"].includes(theirs);
  }
  if (property === "half" || property === "type") {
    // A double slab is a whole block and no amount of turning makes it a half.
    return ["top", "bottom"].includes(wanted) && ["top", "bottom"].includes(theirs);
  }
  return false;
}

function score(
  wanted: ReadonlyMap<string, string>,
  candidate: LibraryEntry,
  sameName: boolean,
  sameNamespace: boolean,
): number {
  let points = (sameName ? 8 : 0) + (sameNamespace ? 1 : 0);
  for (const [property, value] of wanted) {
    if (!shapesTheBlock(property)) {
      continue;
    }
    const theirs = candidate.properties.get(property);
    if (theirs === undefined) {
      continue;
    }
    if (theirs === value) {
      points += 4;
    } else if (turnable(property, value, theirs)) {
      // Not a worse shape, only a shape pointing elsewhere. Still slightly
      // behind one that already points the right way, because turning is
      // arithmetic and arithmetic can be wrong.
      points += 3;
    } else if (SURVIVABLE.has(property)) {
      points -= 6;
    } else {
      // A different block rather than a different pose: a double slab is not a
      // slab, the upper half of a door is not the lower one. Put far enough
      // below the floor that no amount of agreeing elsewhere rescues it.
      points -= 100;
    }
  }
  // A candidate carrying properties the wanted state never mentioned is a
  // slightly more specific block than was asked for.
  for (const [property] of candidate.properties) {
    if (shapesTheBlock(property) && !wanted.has(property)) {
      points -= 1;
    }
  }
  return points;
}

/** The best of a list, or null when the list is empty or all of it is bad. */
function best(
  wanted: ReadonlyMap<string, string>,
  candidates: readonly LibraryEntry[],
  name: string,
  namespace: string,
  floor: number,
): LibraryEntry | null {
  let chosen: LibraryEntry | null = null;
  let most = floor;
  for (const candidate of candidates) {
    if (candidate.shape.length === 0 && candidate.quads.length === 0) {
      continue;
    }
    const points = score(wanted, candidate, candidate.name === name, candidate.namespace === namespace);
    if (points > most) {
      most = points;
      chosen = candidate;
    }
  }
  return chosen;
}

/**
 * Lays one block's colours over another block's shape.
 *
 * <p>Matched by direction, because that is how a block is textured: grass is
 * green on top, earthy underneath and striped down the sides, and a slab
 * borrowed from oak has to take the stone version of each of those rather than
 * one stone colour smeared over all six. Where the donor has nothing facing
 * that way, its average stands in.
 */
function dress(quads: readonly LibraryQuad[], donor: LibraryEntry): LibraryQuad[] {
  const byDirection = new Map<string, number>();
  for (const quad of donor.quads) {
    if (quad.direction !== null && !byDirection.has(quad.direction)) {
      byDirection.set(quad.direction, quad.colour);
    }
  }
  return quads.map((quad) => ({
    direction: quad.direction,
    vertices: quad.vertices,
    colour: (quad.direction === null ? undefined : byDirection.get(quad.direction)) ?? donor.colour,
  }));
}

/**
 * A block to take the colour of a material from.
 *
 * <p>The material a family name leaves behind is rarely the name of a block.
 * A slab of oak leaves {@code oak}, and the block is {@code oak_planks}; stone
 * brick stairs leave {@code stone_brick} and the block is {@code stone_bricks};
 * a grass slab would leave {@code grass} against a {@code grass_block}. So the
 * obvious endings are tried after the bare name.
 *
 * <p>Anything of the same material counts too, and usually answers first: a
 * library that has seen any oak stair has seen oak, whatever else it lacks.
 */
function colourDonor(library: BlockLibrary, material: string): LibraryEntry | null {
  const sameMaterial = library.ofMaterial(material);
  const itself = sameMaterial.find((entry) => entry.name === material);
  if (itself !== undefined) {
    return itself;
  }
  for (const ending of ["", "s", "_block", "_planks", "_bricks", "_blocks", "_wood"]) {
    const named = library.ofName(`${material}${ending}`);
    // A whole block has all six faces coloured; a fence has almost none.
    const whole = named.find((entry) => entry.quads.length >= 6);
    if (whole !== undefined) {
      return whole;
    }
    if (named.length > 0) {
      return named[0] as LibraryEntry;
    }
  }
  return sameMaterial[0] ?? null;
}

/**
 * Works out what a block state looks like, borrowing where it must.
 *
 * <p>In order: the state itself; the same block from another namespace; a
 * relative of the same family turned the same way, wearing the colour of
 * whatever the block is made of; and failing all of that a plain cube.
 */
export function resolve(library: BlockLibrary, state: string): Resolved {
  const known = library.look(state);
  if (known !== undefined && (known.shape.length > 0 || known.quads.length > 0)) {
    return {
      shape: known.shape.length > 0 ? known.shape : CUBE,
      quads: known.quads,
      colour: known.colour,
      how: "exact",
      shapeFrom: null,
      colourFrom: null,
    };
  }

  const parsed = parseState(state);
  const { family, material } = familyOf(parsed.name);

  // The same block, written by a mod or by an older version of the game. Its
  // shape and its colour are both right; nothing has to be borrowed.
  const twin = best(parsed.properties, library.ofName(parsed.name), parsed.name, parsed.namespace, 0);
  if (twin !== null) {
    const turn = turnBetween(twin.properties, parsed.properties);
    return {
      shape: turned(twin.shape, turn),
      quads: twin.quads.map((quad) => turnQuad(quad, turn)),
      colour: twin.colour,
      how: "namespace",
      shapeFrom: twin.state,
      colourFrom: twin.state,
    };
  }

  // A relative: the same family, turned the same way, made of something else.
  const relative = best(parsed.properties, library.ofFamily(family), parsed.name, parsed.namespace, -8);

  // And the colour of what this one is actually made of, looked for on its own.
  // A stone slab wants stone's colour, and stone is a block somebody has almost
  // certainly exported even if no stone slab ever was.
  const madeOf = colourDonor(library, material);

  if (relative !== null) {
    const donor = madeOf ?? relative;
    const turn = turnBetween(relative.properties, parsed.properties);
    const quads = madeOf === null ? relative.quads : dress(relative.quads, madeOf);
    return {
      shape: turned(relative.shape, turn),
      quads: quads.map((quad) => turnQuad(quad, turn)),
      colour: donor.colour,
      how: madeOf === null || madeOf.state === relative.state ? "family" : "dressed",
      shapeFrom: relative.state,
      colourFrom: donor.state,
    };
  }

  // Nothing of the family is known. A cube is still printable, and if the
  // material is known the cube is at least the right colour.
  return {
    shape: CUBE,
    quads: madeOf?.quads ?? [],
    colour: madeOf?.colour ?? GREY,
    how: "guessed",
    shapeFrom: null,
    colourFrom: madeOf?.state ?? null,
  };
}
