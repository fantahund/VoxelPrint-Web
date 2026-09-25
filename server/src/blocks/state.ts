/**
 * Block states, taken apart.
 *
 * <p>A block state is a string the mod writes and a schematic carries:
 * {@code minecraft:oak_stairs[facing=east,half=bottom,shape=straight]}. Every
 * question this package asks -- is this the same block, is it the same shape
 * turned the same way, is it the stone version of a thing we have in oak --
 * is a question about the three parts of that string, so it is taken apart
 * once and passed around in pieces.
 */

export interface BlockState {
  /** {@code minecraft}, or whichever mod the block came from. */
  readonly namespace: string;
  /** {@code oak_stairs}. */
  readonly name: string;
  /** {@code facing -> east}, in the order written. */
  readonly properties: ReadonlyMap<string, string>;
  /** The whole thing again, for keying a map by. */
  readonly key: string;
}

/**
 * The families a block can belong to, longest suffix first.
 *
 * <p>This is the list that lets a stone slab borrow an oak slab's shape. It is
 * matched as a suffix of the block's name, so it costs nothing to be wrong
 * about a mod's naming: a block that matches none of these is its own family
 * and simply finds fewer relatives.
 *
 * <p>Longest first because {@code _fence_gate} has to win over {@code _gate}
 * and {@code _wall_sign} over {@code _sign}, and because {@code _trapdoor}
 * would otherwise be read as a {@code _door}.
 */
const FAMILIES: readonly string[] = [
  "pressure_plate",
  "hanging_sign",
  "fence_gate",
  "wall_sign",
  "wall_torch",
  "trapdoor",
  "stairs",
  "button",
  "carpet",
  "candle",
  "fence",
  "glass_pane",
  "petals",
  "sapling",
  "shulker_box",
  "slab",
  "stem",
  "torch",
  "wall",
  "door",
  "bars",
  "bed",
  "sign",
  "pane",
  "leaves",
  "planks",
  "glass",
  "log",
  "wood",
  "wool",
].slice().sort((a, b) => b.length - a.length);

/** Reads {@code namespace:name[a=b,c=d]} into its pieces. */
export function parseState(state: string): BlockState {
  const bracket = state.indexOf("[");
  const head = bracket === -1 ? state : state.slice(0, bracket);
  const colon = head.indexOf(":");
  const namespace = colon === -1 ? "minecraft" : head.slice(0, colon);
  const name = colon === -1 ? head : head.slice(colon + 1);

  const properties = new Map<string, string>();
  if (bracket !== -1 && state.endsWith("]")) {
    for (const pair of state.slice(bracket + 1, -1).split(",")) {
      const equals = pair.indexOf("=");
      if (equals > 0) {
        properties.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
      }
    }
  }
  return { namespace, name, properties, key: state };
}

/**
 * Which family a block belongs to, and what it is made of.
 *
 * <p>{@code stone_brick_stairs} is the {@code stairs} family made of
 * {@code stone_brick}; {@code stone} is its own family made of itself. The
 * material is what a colour is looked up by when the shape has to be borrowed
 * from a different block, so it matters that it comes out as the plain name of
 * a thing -- {@code stone}, {@code oak} -- and not as the whole block.
 */
export function familyOf(name: string): { family: string; material: string } {
  for (const family of FAMILIES) {
    if (name === family) {
      return { family, material: name };
    }
    if (name.endsWith(`_${family}`)) {
      return { family, material: name.slice(0, -(family.length + 1)) };
    }
  }
  return { family: name, material: name };
}

/**
 * Properties that say nothing about the shape.
 *
 * <p>Water in a fence post does not move the post, and a lamp being lit does
 * not change where it is. Matching on these would rank a candidate lower for a
 * difference that the print cannot show, so they are left out of the score.
 *
 * <p>Deliberately short. A property is only listed here when its not mattering
 * is obvious, because the cost of wrongly ignoring one -- a stair borrowed
 * facing the wrong way -- is far higher than the cost of wrongly keeping one,
 * which is a slightly worse relative.
 */
const COSMETIC: ReadonlySet<string> = new Set([
  "waterlogged",
  "lit",
  "powered",
  "snowy",
  "occupied",
  "signal_fire",
  "persistent",
  "distance",
  "unstable",
  "triggered",
  "has_bottle_0",
  "has_bottle_1",
  "has_bottle_2",
  "has_record",
  "has_book",
  "bloom",
  "tip",
  "berries",
  "crafting",
  "charged",
]);

export const shapesTheBlock = (property: string): boolean => !COSMETIC.has(property);
