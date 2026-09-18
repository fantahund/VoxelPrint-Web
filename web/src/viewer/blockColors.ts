/**
 * Approximate colours for common Minecraft blocks.
 *
 * <p>Hand picked, not extracted from the game. The export carries block ids and
 * nothing else -- no textures, no colours -- so anything shown here is this
 * table's opinion of what a block looks like. Good enough to recognise a build,
 * wrong in the details.
 *
 * <p>Anything not listed is drawn grey, which is the same thing the plan calls
 * for when a schematic contains blocks the site does not know. Grey means "no
 * information", not "this block is grey", and that distinction is kept visible
 * in the interface.
 *
 * <p>Only the fallback now. An export that carries real models carries the
 * measured colour of every texture with it, and those are used instead; this
 * table is what is left for exports made without them, and for the handful of
 * blocks the game draws itself rather than from a model.
 */
const COLOURS: Readonly<Record<string, number>> = {
  // Stone and its family
  "minecraft:stone": 0x7d7d7d,
  "minecraft:cobblestone": 0x7a7a7a,
  "minecraft:mossy_cobblestone": 0x6b7a5e,
  "minecraft:cobblestone_stairs": 0x7a7a7a,
  "minecraft:cobblestone_slab": 0x7a7a7a,
  "minecraft:cobblestone_wall": 0x7a7a7a,
  "minecraft:smooth_stone": 0x9e9e9e,
  "minecraft:stone_bricks": 0x7a7a75,
  "minecraft:andesite": 0x8a8a8a,
  "minecraft:granite": 0x9a6b5a,
  "minecraft:diorite": 0xbdbdbd,
  "minecraft:deepslate": 0x4d4d52,
  "minecraft:bedrock": 0x565656,

  // Ground
  "minecraft:dirt": 0x8b5a2b,
  "minecraft:coarse_dirt": 0x7e5228,
  "minecraft:rooted_dirt": 0x8f6a45,
  "minecraft:dirt_path": 0x9c7f43,
  "minecraft:farmland": 0x6b452b,
  "minecraft:grass_block": 0x6a9c3e,
  "minecraft:podzol": 0x5c3f1c,
  "minecraft:sand": 0xdbd3a0,
  "minecraft:red_sand": 0xbf6b34,
  "minecraft:gravel": 0x8a8686,
  "minecraft:clay": 0xa0a7b4,

  // Wood
  "minecraft:oak_log": 0x9c7a4a,
  "minecraft:stripped_oak_log": 0xb89158,
  "minecraft:oak_planks": 0xb08a4e,
  "minecraft:oak_stairs": 0xb08a4e,
  "minecraft:oak_slab": 0xb08a4e,
  "minecraft:oak_fence": 0xb08a4e,
  "minecraft:oak_door": 0xa07c46,
  "minecraft:oak_trapdoor": 0xa07c46,
  "minecraft:spruce_log": 0x6b4a28,
  "minecraft:spruce_planks": 0x7a5a33,
  "minecraft:birch_log": 0xd7cfb0,
  "minecraft:birch_planks": 0xc4b48a,
  "minecraft:dark_oak_planks": 0x4a3219,

  // Plants
  "minecraft:oak_leaves": 0x4a7a2a,
  "minecraft:spruce_leaves": 0x3f5c33,
  "minecraft:birch_leaves": 0x5f8a3a,
  "minecraft:short_grass": 0x6a9c3e,
  "minecraft:tall_grass": 0x6a9c3e,
  "minecraft:fern": 0x5f8a3a,

  // Built
  "minecraft:bricks": 0x976153,
  "minecraft:glass": 0xc8e4e8,
  "minecraft:glass_pane": 0xc8e4e8,
  "minecraft:white_wool": 0xe9ecec,
  "minecraft:bookshelf": 0x9c7a4a,
  "minecraft:crafting_table": 0x8a6234,
  "minecraft:furnace": 0x6b6b6b,
  "minecraft:blast_furnace": 0x5c5c5c,
  "minecraft:smoker": 0x5f4a35,
  "minecraft:composter": 0x7a5a33,
  "minecraft:bell": 0xd0a44c,
  "minecraft:hay_block": 0xb8941f,

  // Light
  "minecraft:torch": 0xffd37f,
  "minecraft:wall_torch": 0xffd37f,
  "minecraft:lantern": 0xe8b25a,
  "minecraft:glowstone": 0xf0d08a,

  // Liquids
  "minecraft:water": 0x3a6bd8,
  "minecraft:lava": 0xd4601a,
  "minecraft:ice": 0xa6c7f0,
  "minecraft:snow_block": 0xf0f5f5,
};

/** Drawn for every block the table has no colour for. */
export const UNKNOWN_COLOUR = 0x9a9a9a;

export interface ResolvedColour {
  readonly colour: number;
  /** False when the colour is the grey fallback rather than a real guess. */
  readonly known: boolean;
}

/**
 * Looks up a colour for a full block state.
 *
 * <p>The properties are cut off first: {@code minecraft:oak_stairs[facing=north]}
 * and {@code minecraft:oak_stairs[facing=south]} are the same wood.
 */
export function colourFor(blockState: string): ResolvedColour {
  const bracket = blockState.indexOf("[");
  const id = bracket === -1 ? blockState : blockState.slice(0, bracket);
  const colour = COLOURS[id];
  return colour === undefined ? { colour: UNKNOWN_COLOUR, known: false } : { colour, known: true };
}

export function isAir(blockState: string): boolean {
  return (
    blockState === "minecraft:air" ||
    blockState === "minecraft:cave_air" ||
    blockState === "minecraft:void_air"
  );
}
