/**
 * Numbers, turned back into block states.
 *
 * <p>Before 1.13 a block was an id and four bits of "data", and what those four
 * bits meant was different for every block. The mapping was deleted from the
 * game when the ids were, so it lives here, and it is the reason a {@code
 * .schematic} can never be as good as the other two formats: the file says
 * {@code 53, 6} and a person has to know that this is an oak stair facing south
 * and standing on its head.
 *
 * <p>Two ways out are taken before this table is reached. Schematica and a few
 * other writers put their own id-to-name mapping in the file, which is the only
 * thing that can carry a modded block through this format at all, and it is
 * preferred whenever it is there. Failing that, the ids below are the ones
 * people build with; an id that is not here becomes stone rather than nothing,
 * because a wrong block that prints is easier to spot and fix than a hole.
 */

const DYES = [
  "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
  "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
];
const WOODS = ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak"];
/** Stair data: the low two bits are the way it faces, the third stands it up. */
const STAIR_FACING = ["east", "west", "south", "north"];
const AXES = ["y", "x", "z"];

const stairs = (wood: string) => (meta: number): string =>
  `minecraft:${wood}_stairs[facing=${STAIR_FACING[meta & 3]},half=${(meta & 4) === 0 ? "bottom" : "top"},shape=straight,waterlogged=false]`;

const slab = (kinds: readonly string[]) => (meta: number): string => {
  const kind = kinds[meta & 7] ?? kinds[0] ?? "stone";
  return `minecraft:${kind}_slab[type=${(meta & 8) === 0 ? "bottom" : "top"},waterlogged=false]`;
};

const log = (woods: readonly string[]) => (meta: number): string =>
  `minecraft:${woods[meta & 3] ?? woods[0] ?? "oak"}_log[axis=${AXES[(meta >> 2) & 3] ?? "y"}]`;

const pick = (names: readonly string[], fallback = 0) => (meta: number): string =>
  `minecraft:${names[meta] ?? names[fallback] ?? "stone"}`;

type Rule = string | ((meta: number) => string);

const BLOCKS: Readonly<Record<number, Rule>> = {
  0: "minecraft:air",
  1: pick(["stone", "granite", "polished_granite", "diorite", "polished_diorite", "andesite", "polished_andesite"]),
  2: "minecraft:grass_block[snowy=false]",
  3: pick(["dirt", "coarse_dirt", "podzol"]),
  4: "minecraft:cobblestone",
  5: (meta) => `minecraft:${WOODS[meta & 7] ?? "oak"}_planks`,
  7: "minecraft:bedrock",
  12: pick(["sand", "red_sand"]),
  13: "minecraft:gravel",
  14: "minecraft:gold_ore",
  15: "minecraft:iron_ore",
  16: "minecraft:coal_ore",
  17: log(["oak", "spruce", "birch", "jungle"]),
  18: (meta) => `minecraft:${WOODS[meta & 3] ?? "oak"}_leaves[distance=7,persistent=true,waterlogged=false]`,
  19: "minecraft:sponge",
  20: "minecraft:glass",
  22: "minecraft:lapis_block",
  24: pick(["sandstone", "chiseled_sandstone", "cut_sandstone"]),
  30: "minecraft:cobweb",
  31: pick(["dead_bush", "short_grass", "fern"], 1),
  35: (meta) => `minecraft:${DYES[meta & 15] ?? "white"}_wool`,
  41: "minecraft:gold_block",
  42: "minecraft:iron_block",
  43: "minecraft:smooth_stone",
  44: slab(["stone", "sandstone", "oak", "cobblestone", "brick", "stone_brick", "nether_brick", "quartz"]),
  45: "minecraft:bricks",
  47: "minecraft:bookshelf",
  48: "minecraft:mossy_cobblestone",
  49: "minecraft:obsidian",
  50: "minecraft:torch",
  53: stairs("oak"),
  57: "minecraft:diamond_block",
  58: "minecraft:crafting_table",
  67: stairs("cobblestone"),
  79: "minecraft:ice",
  80: "minecraft:snow_block",
  81: "minecraft:cactus[age=0]",
  82: "minecraft:clay",
  85: "minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]",
  86: "minecraft:carved_pumpkin[facing=north]",
  87: "minecraft:netherrack",
  88: "minecraft:soul_sand",
  89: "minecraft:glowstone",
  91: "minecraft:jack_o_lantern[facing=north]",
  95: (meta) => `minecraft:${DYES[meta & 15] ?? "white"}_stained_glass`,
  98: pick(["stone_bricks", "mossy_stone_bricks", "cracked_stone_bricks", "chiseled_stone_bricks"]),
  101: "minecraft:iron_bars[east=false,north=false,south=false,waterlogged=false,west=false]",
  102: "minecraft:glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]",
  108: stairs("brick"),
  109: stairs("stone_brick"),
  112: "minecraft:nether_bricks",
  114: stairs("nether_brick"),
  121: "minecraft:end_stone",
  125: (meta) => `minecraft:${WOODS[meta & 7] ?? "oak"}_slab[type=bottom,waterlogged=false]`,
  126: (meta) => `minecraft:${WOODS[meta & 7] ?? "oak"}_slab[type=${(meta & 8) === 0 ? "bottom" : "top"},waterlogged=false]`,
  128: stairs("sandstone"),
  133: "minecraft:emerald_block",
  134: stairs("spruce"),
  135: stairs("birch"),
  136: stairs("jungle"),
  155: pick(["quartz_block", "chiseled_quartz_block", "quartz_pillar"]),
  156: stairs("quartz"),
  159: (meta) => `minecraft:${DYES[meta & 15] ?? "white"}_terracotta`,
  160: (meta) => `minecraft:${DYES[meta & 15] ?? "white"}_stained_glass_pane[east=false,north=false,south=false,waterlogged=false,west=false]`,
  161: (meta) => `minecraft:${(meta & 1) === 0 ? "acacia" : "dark_oak"}_leaves[distance=7,persistent=true,waterlogged=false]`,
  162: log(["acacia", "dark_oak"]),
  163: stairs("acacia"),
  164: stairs("dark_oak"),
  165: "minecraft:slime_block",
  168: pick(["prismarine", "prismarine_bricks", "dark_prismarine"]),
  169: "minecraft:sea_lantern",
  172: "minecraft:terracotta",
  173: "minecraft:coal_block",
  174: "minecraft:packed_ice",
  179: pick(["red_sandstone", "chiseled_red_sandstone", "cut_red_sandstone"]),
  180: stairs("red_sandstone"),
  182: slab(["red_sandstone"]),
  201: "minecraft:purpur_block",
  202: "minecraft:purpur_pillar[axis=y]",
  203: stairs("purpur"),
  205: slab(["purpur"]),
  206: "minecraft:end_stone_bricks",
  251: (meta) => `minecraft:${DYES[meta & 15] ?? "white"}_concrete`,
  252: (meta) => `minecraft:${DYES[meta & 15] ?? "white"}_concrete_powder`,
};

/** How many of the ids in a file this table actually knows. */
export function knownOf(ids: Iterable<number>): { known: number; total: number } {
  let known = 0;
  let total = 0;
  for (const id of ids) {
    total++;
    if (BLOCKS[id] !== undefined) {
      known++;
    }
  }
  return { known, total };
}

export function legacyState(id: number, meta: number): string {
  const rule = BLOCKS[id];
  if (rule === undefined) {
    return "minecraft:stone";
  }
  return typeof rule === "string" ? rule : rule(meta);
}

export const knowsLegacy = (id: number): boolean => BLOCKS[id] !== undefined;
