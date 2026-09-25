/**
 * Checks the block library and the guessing that dresses a schematic.
 *
 * <p>Run with {@code npx tsx tools/check-blocks.mts} from the repository root.
 *
 * <p>A schematic is a list of block names and nothing else, so every shape and
 * every colour in an imported build is either remembered from an upload or
 * guessed at. Both halves fail quietly: a slab borrowed from the wrong end of
 * the block prints upside down and looks fine in a preview, and a colour taken
 * from the donor rather than the material prints a stone wall in oak. So the
 * turning is held against the game's own geometry, measured as solids rather
 * than compared as box lists -- the same shape can be cut into boxes more than
 * one way, and an early version of this check failed a hundred times over
 * exactly that.
 */
import { BlockLibrary } from "../server/src/blocks/library.js";
import { resolve } from "../server/src/blocks/match.js";
import { turnBetween, turnBox } from "../server/src/blocks/transform.js";
import { parseState } from "../server/src/blocks/state.js";
import type { ShapeBox } from "../server/src/mcprint/readProject.js";
import type { BlockModels } from "../server/src/mcprint/schema.js";

let problems = 0;
const fail = (m: string): void => { problems++; console.log("  FAIL " + m); };
const ok = (m: string): void => console.log("  ok   " + m);

/**
 * Straight stairs as the game really draws them, in all eight orientations.
 *
 * <p>Measured out of real exports rather than written from memory.
 */
const STAIRS: Readonly<Record<string, ShapeBox[]>> = {
  "north,bottom": [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 1, 1, 0.5]],
  "east,bottom":  [[0, 0, 0, 1, 0.5, 1], [0.5, 0.5, 0, 1, 1, 1]],
  "south,bottom": [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0.5, 1, 1, 1]],
  "west,bottom":  [[0, 0, 0, 1, 0.5, 1], [0, 0.5, 0, 0.5, 1, 1]],
  "north,top":    [[0, 0, 0, 1, 1, 0.5], [0, 0.5, 0.5, 1, 1, 1]],
  "east,top":     [[0.5, 0, 0, 1, 1, 1], [0, 0.5, 0, 0.5, 1, 1]],
  "south,top":    [[0, 0, 0.5, 1, 1, 1], [0, 0.5, 0, 1, 1, 0.5]],
  "west,top":     [[0, 0, 0, 0.5, 1, 1], [0.5, 0.5, 0, 1, 1, 1]],
};

const stairState = (block: string, where: string): string => {
  const [facing, half] = where.split(",");
  return `${block}[facing=${facing},half=${half},shape=straight,waterlogged=false]`;
};

/** A shape as occupied sixteenths, which is the resolution the game models in. */
const N = 16;
function solid(boxes: readonly (readonly number[])[]): string {
  const cells = new Uint8Array(N * N * N);
  for (const box of boxes) {
    const lo = [0, 1, 2].map((a) => Math.max(0, Math.round((box[a] as number) * N)));
    const hi = [0, 1, 2].map((a) => Math.min(N, Math.round((box[a + 3] as number) * N)));
    for (let x = lo[0] as number; x < (hi[0] as number); x++) {
      for (let y = lo[1] as number; y < (hi[1] as number); y++) {
        for (let z = lo[2] as number; z < (hi[2] as number); z++) {
          cells[x + y * N + z * N * N] = 1;
        }
      }
    }
  }
  return cells.join("");
}

/** Six faces of a cube, so a learned block has colours to lend. */
const SIDES = ["down", "up", "north", "south", "west", "east"] as const;
function cubeModel(colours: Readonly<Record<string, number>>): {
  materials: BlockModels["materials"];
  quads: BlockModels["models"][number];
} {
  const materials: BlockModels["materials"] = [];
  const quads: BlockModels["models"][number] = [];
  for (const side of SIDES) {
    materials.push({ texture: `stub/${side}`, colour: colours[side] ?? 0x808080 });
    quads.push({
      material: materials.length - 1,
      direction: side,
      vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
    });
  }
  return { materials, quads };
}

/** A library holding exactly what a test wants it to hold. */
function libraryOf(
  blocks: ReadonlyArray<{ state: string; shape: ShapeBox[]; colours?: Record<string, number> }>,
): BlockLibrary {
  const library = new BlockLibrary("/dev/null");
  const materials: BlockModels["materials"] = [];
  const models: BlockModels["models"] = [];
  for (const block of blocks) {
    const built = cubeModel(block.colours ?? {});
    const base = materials.length;
    materials.push(...built.materials);
    models.push(built.quads.map((quad) => ({ ...quad, material: quad.material + base })));
  }
  library.learn(
    blocks.map((block) => block.state),
    blocks.map((block) => block.shape),
    { formatVersion: 1, materials, models },
  );
  return library;
}

// --- one stair teaches every stair -------------------------------------------
{
  // The whole promise of turning a borrowed shape: a build containing a single
  // stair, facing one way, in one half, is enough to print every stair in the
  // game. Each of the eight is taught on its own and the other seven derived.
  let wrong = 0;
  let checked = 0;
  for (const taught of Object.keys(STAIRS)) {
    const library = libraryOf([
      { state: stairState("minecraft:oak_stairs", taught), shape: STAIRS[taught] as ShapeBox[] },
    ]);
    for (const wanted of Object.keys(STAIRS)) {
      if (wanted === taught) {
        continue;
      }
      checked++;
      const got = resolve(library, stairState("minecraft:stone_stairs", wanted));
      if (solid(got.shape) !== solid(STAIRS[wanted] as ShapeBox[])) {
        wrong++;
        if (wrong <= 2) {
          fail(`a stair taught ${taught} derived ${wanted} wrongly`);
        }
      }
    }
  }
  if (wrong === 0) {
    ok(`one stair teaches the other seven, in all ${checked} pairs, solid for solid`);
  } else {
    fail(`${wrong} of ${checked} derived stairs are the wrong shape`);
  }
}

// --- the slab that started this ----------------------------------------------
{
  // "eine Slab unten aus Holz gibt es, aber die aus Stein nicht, also soll er
  // das Modell von der aus Holz nehmen." And the wrong end of the block is a
  // slab printed on the ceiling, so the half has to be put right on the way.
  const library = libraryOf([
    { state: "minecraft:oak_slab[type=top,waterlogged=false]", shape: [[0, 0.5, 0, 1, 1, 1]] },
    { state: "minecraft:stone", shape: [[0, 0, 0, 1, 1, 1]], colours: { up: 0x7a7a7a, down: 0x7a7a7a, north: 0x7a7a7a, south: 0x7a7a7a, east: 0x7a7a7a, west: 0x7a7a7a } },
  ]);
  const bottom = resolve(library, "minecraft:stone_slab[type=bottom,waterlogged=false]");
  const top = resolve(library, "minecraft:stone_slab[type=top,waterlogged=false]");
  const wantBottom = solid([[0, 0, 0, 1, 0.5, 1]]);
  const wantTop = solid([[0, 0.5, 0, 1, 1, 1]]);
  if (solid(bottom.shape) === wantBottom && solid(top.shape) === wantTop) {
    ok(`a stone slab borrows the oak slab's shape and stands at the right end of the block`);
  } else {
    fail(`stone slab bottom/top came out ${JSON.stringify(bottom.shape)} / ${JSON.stringify(top.shape)}`);
  }
  if (bottom.colourFrom === "minecraft:stone" && bottom.colour === 0x7a7a7a) {
    ok("and it is the colour of stone, not the colour of oak");
  } else {
    fail(`stone slab took colour #${bottom.colour.toString(16)} from ${bottom.colourFrom}`);
  }
}

// --- a double slab is not a slab ---------------------------------------------
{
  // type=double is a whole block. No turning makes a half into a whole, so it
  // must not quietly borrow one.
  const library = libraryOf([
    { state: "minecraft:oak_slab[type=bottom,waterlogged=false]", shape: [[0, 0, 0, 1, 0.5, 1]] },
  ]);
  const got = resolve(library, "minecraft:stone_slab[type=double,waterlogged=false]");
  if (solid(got.shape) === solid([[0, 0, 0, 1, 1, 1]])) {
    ok("a double slab stays a whole block rather than borrowing half of one");
  } else {
    fail(`a double slab came out as ${JSON.stringify(got.shape)}`);
  }
}

// --- a mod nobody has ever heard of ------------------------------------------
{
  const library = libraryOf([
    { state: stairState("minecraft:oak_stairs", "north,bottom"), shape: STAIRS["north,bottom"] as ShapeBox[] },
  ]);
  const modded = resolve(library, stairState("create:andesite_stairs", "west,top"));
  if (solid(modded.shape) === solid(STAIRS["west,top"] as ShapeBox[]) && modded.how !== "guessed") {
    ok("a mod's stair nobody has exported borrows a vanilla stair and is turned to face right");
  } else {
    fail(`a modded stair resolved as ${modded.how}, shape ${JSON.stringify(modded.shape)}`);
  }
}

// --- the same block from another namespace -----------------------------------
{
  const library = libraryOf([
    { state: stairState("minecraft:oak_stairs", "east,bottom"), shape: STAIRS["east,bottom"] as ShapeBox[] },
  ]);
  const copy = resolve(library, stairState("somemod:oak_stairs", "east,bottom"));
  if (copy.how === "namespace" && solid(copy.shape) === solid(STAIRS["east,bottom"] as ShapeBox[])) {
    ok("a mod's copy of a vanilla block is recognised as that block, shape and colour both");
  } else {
    fail(`somemod:oak_stairs resolved as ${copy.how}`);
  }
}

// --- a colour per direction ---------------------------------------------------
{
  // Grass is green on top and earthy underneath. A slab borrowing grass's
  // colours has to take the green for its top face and not smear one average
  // over the whole thing.
  const library = libraryOf([
    { state: "minecraft:oak_slab[type=bottom,waterlogged=false]", shape: [[0, 0, 0, 1, 0.5, 1]] },
    {
      state: "minecraft:grass_block[snowy=false]",
      shape: [[0, 0, 0, 1, 1, 1]],
      colours: { up: 0x5c9a3c, down: 0x866043, north: 0x7a7a4a, south: 0x7a7a4a, east: 0x7a7a4a, west: 0x7a7a4a },
    },
  ]);
  const got = resolve(library, "minecraft:grass_slab[type=bottom,waterlogged=false]");
  const up = got.quads.find((quad) => quad.direction === "up");
  const down = got.quads.find((quad) => quad.direction === "down");
  if (got.how === "dressed" && up?.colour === 0x5c9a3c && down?.colour === 0x866043) {
    ok("a borrowed shape wears the right colour on each face, green on top and earth below");
  } else {
    fail(`grass slab: how ${got.how}, up #${up?.colour.toString(16)}, down #${down?.colour.toString(16)}`);
  }
}

// --- nothing known at all -----------------------------------------------------
{
  const library = libraryOf([
    { state: "minecraft:stone", shape: [[0, 0, 0, 1, 1, 1]] },
  ]);
  const got = resolve(library, "somemod:reactor_core[active=true]");
  if (got.how === "guessed" && solid(got.shape) === solid([[0, 0, 0, 1, 1, 1]])) {
    ok("a block related to nothing at all still prints, as a cube");
  } else {
    fail(`an unrelated block resolved as ${got.how} with ${JSON.stringify(got.shape)}`);
  }
}

// --- turning is reversible ----------------------------------------------------
{
  // Four quarter turns is where you started. An arithmetic slip that survived
  // one turn would not survive four.
  let wrong = 0;
  for (const where of Object.keys(STAIRS)) {
    const boxes = STAIRS[where] as ShapeBox[];
    const quarter = turnBetween(
      parseState(stairState("x:y", "north,bottom")).properties,
      parseState(stairState("x:y", "east,bottom")).properties,
    );
    let turned = boxes;
    for (let round = 0; round < 4; round++) {
      turned = turned.map((box) => turnBox(box, quarter));
    }
    if (solid(turned) !== solid(boxes)) {
      wrong++;
    }
  }
  if (wrong === 0) {
    ok("four quarter turns bring every stair back exactly where it started");
  } else {
    fail(`${wrong} shapes did not survive four quarter turns`);
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
