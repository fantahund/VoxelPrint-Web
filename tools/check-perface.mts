/**
 * Checks a colour per face: that it changes the colours and nothing else.
 *
 * <p>Run with {@code npx tsx tools/check-perface.mts} from the repository root.
 *
 * <p>The whole promise is that turning it on changes which filament each part
 * of a block prints in and leaves the shape exactly where it was. A body pulled
 * in by a wall with a skin laid back on it is easy to get wrong by a wall's
 * width, and a print a millimetre too small or too large does not look wrong
 * until it is next to one that is right. So the boxes are added back up.
 */
import { solidsBySlot, type GeometryOptions } from "../web/src/export/geometry.js";
import type { VoxelModel } from "../web/src/viewer/buildVoxels.js";

let problems = 0;
const fail = (m: string): void => { problems++; console.log("  FAIL " + m); };
const ok = (m: string): void => console.log("  ok   " + m);

/** The six faces of a unit cube, wound outwards, as the exporter writes them. */
const CUBE: ReadonlyArray<readonly [number[], string]> = [
  [[0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], "down"],
  [[0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0], "up"],
  [[0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0], "north"],
  [[1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1], "south"],
  [[0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0], "west"],
  [[1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1], "east"],
];

/** One grass-like block: green on top, brown everywhere else. */
function grassBlock(top: number, rest: number): VoxelModel {
  const quads = new Float32Array(CUBE.length * 12);
  const faceColours = new Uint32Array(CUBE.length);
  CUBE.forEach(([vertices, side], index) => {
    quads.set(vertices, index * 12);
    faceColours[index] = side === "up" ? top : rest;
  });

  return {
    positions: Float32Array.from([0, 0, 0]),
    scales: Float32Array.from([1, 1, 1]),
    paletteIndices: Uint32Array.from([1]),
    boxes: 0,
    solids: 1,
    meshes: [
      {
        paletteIndex: 1,
        positions: new Float32Array(0),
        quads,
        normals: new Float32Array(0),
        colours: new Float32Array(0),
        faceColours,
        offsets: Float32Array.from([-0.5, -0.5, -0.5]),
        blockIndices: Uint32Array.from([0]),
        blocks: 1,
      },
    ],
    quads: CUBE.length,
    visible: 1,
    solid: 1,
    shaped: true,
    modelled: true,
    trueColour: true,
    size: { width: 1, height: 1, depth: 1 },
    blockIds: ["minecraft:air", "minecraft:grass_block"],
    minecraftColours: [0, rest],
    blockTypeColours: { "minecraft:grass_block": rest },
    typeCounts: [["minecraft:grass_block", 1]],
    solidBlocks: Uint32Array.from([0]),
    blockStates: ["minecraft:air", "minecraft:grass_block"],
    removed: 0,
  } as unknown as VoxelModel;
}

const GREEN = 0x6a9c3e;
const BROWN = 0x8b5a2b;
const model = grassBlock(GREEN, BROWN);
const slots = [BROWN, GREEN];
const options = (perFace: boolean): GeometryOptions => ({
  millimetresPerBlock: 10,
  geometry: "shell",
  wallMillimetres: 1.2,
  perFace,
  slotColours: slots,
});

const measure = (perFace: boolean) => {
  const grouped = solidsBySlot(model, { "minecraft:grass_block": 0 }, slots.length, options(perFace));
  const bodies: Array<{ slot: number; low: number[]; high: number[] }> = [];
  const all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let volume = 0;
  grouped.forEach((group, slot) => {
    for (const solid of group) {
      const low = [Infinity, Infinity, Infinity];
      const high = [-Infinity, -Infinity, -Infinity];
      for (const corner of solid) {
        for (let axis = 0; axis < 3; axis++) {
          low[axis] = Math.min(low[axis]!, corner[axis]!);
          high[axis] = Math.max(high[axis]!, corner[axis]!);
          all[axis] = Math.min(all[axis]!, corner[axis]!);
          all[axis + 3] = Math.max(all[axis + 3]!, corner[axis]!);
        }
      }
      volume += (high[0]! - low[0]!) * (high[1]! - low[1]!) * (high[2]! - low[2]!);
      bodies.push({ slot, low, high });
    }
  });
  return { bodies, all, volume };
};

const off = measure(false);
const on = measure(true);

// --- off: one block, one filament -------------------------------------------
if (off.bodies.length === 1 && off.bodies[0]?.slot === 0) {
  ok("with it off a grass block is one body in the filament its type is assigned to");
} else {
  fail(`with it off: ${off.bodies.length} bodies, slots ${off.bodies.map((b) => b.slot).join(",")}`);
}

// --- on: a body and a skin, in the two filaments -----------------------------
{
  const slotsUsed = [...new Set(on.bodies.map((body) => body.slot))].sort();
  if (on.bodies.length === 2 && slotsUsed.join(",") === "0,1") {
    ok("with it on it is two bodies, one per filament: earth and the green on top");
  } else {
    fail(`with it on: ${on.bodies.length} bodies in filaments ${slotsUsed.join(",")}`);
  }

  // The green must be the top, a wall thick, across the whole face.
  const green = on.bodies.find((body) => body.slot === 1);
  if (green === undefined) {
    fail("no body in the green filament at all");
  } else {
    const thick = green.high[2]! - green.low[2]!;
    const onTop = Math.abs(green.high[2]! - off.all[5]!) < 1e-6;
    const full =
      Math.abs(green.high[0]! - green.low[0]! - 10) < 1e-6 &&
      Math.abs(green.high[1]! - green.low[1]! - 10) < 1e-6;
    if (Math.abs(thick - 1.2) < 1e-6 && onTop && full) {
      ok("the green is the whole top of it, 1.2 mm thick, flush with where the block ends");
    } else {
      fail(`the green is ${thick.toFixed(2)} mm thick, on top: ${onTop}, full width: ${full}`);
    }
  }
}

// --- and the block is the same block -----------------------------------------
{
  const same = [0, 1, 2, 3, 4, 5].every((i) => Math.abs((off.all[i] as number) - (on.all[i] as number)) < 1e-6);
  if (same) {
    ok(`the block is the same size either way: ${[0,1,2].map((a) => (off.all[a + 3]! - off.all[a]!).toFixed(1)).join(" x ")} mm`);
  } else {
    fail(`off ${off.all.map((v) => v.toFixed(2)).join(",")} against on ${on.all.map((v) => v.toFixed(2)).join(",")}`);
  }
  // The skin and the body tile the block: no overlap, no gap.
  if (Math.abs(off.volume - on.volume) < 1e-6) {
    ok(`and the same amount of plastic: ${off.volume.toFixed(0)} mm³ in one body or in two`);
  } else {
    fail(`off is ${off.volume.toFixed(2)} mm³ and on is ${on.volume.toFixed(2)}`);
  }
}

// --- a type put in a filament by hand stays there ----------------------------
{
  const grouped = solidsBySlot(model, { "minecraft:grass_block": 0 }, slots.length, {
    ...options(true),
    spokenFor: new Set(["minecraft:grass_block"]),
  });
  const bodies = grouped.flatMap((group, slot) => group.map(() => slot));
  if (bodies.length === 1 && bodies[0] === 0) {
    ok("a type somebody put in a filament by hand prints in it throughout, faces and all");
  } else {
    fail(`spoken for, it still came out as ${bodies.length} bodies in filaments ${bodies.join(",")}`);
  }
}

// --- a block of one colour does not move -------------------------------------
{
  // Brown all over, but assigned to the green filament: it has to stay there.
  // Turning this on gives a block more colours; it does not re-decide a block
  // that has only ever had one.
  const plain = grassBlock(BROWN, BROWN);
  const slotOf = (grouped: ReturnType<typeof solidsBySlot>): number[] =>
    grouped.flatMap((group, slot) => group.map(() => slot));
  const off = slotOf(solidsBySlot(plain, { "minecraft:grass_block": 1 }, slots.length, options(false)));
  const on = slotOf(solidsBySlot(plain, { "minecraft:grass_block": 1 }, slots.length, options(true)));
  if (off.join(",") === "1" && on.join(",") === "1") {
    ok("a block of one colour stays in the filament its type is assigned to, either way");
  } else {
    fail(`one colour block: off went to [${off.join(",")}], on to [${on.join(",")}], wanted 1 both times`);
  }
}

// --- asking for fewer groups than there are colours --------------------------
{
  // The printability check asks for one group, because what a body prints in
  // has nothing to do with whether it can be printed. The colours it is handed
  // are still the build's four or eight, and a green top matched against them
  // lands on slot 1 -- a group that, in a call for one group, does not exist.
  // That threw, and it threw on the default setting, so the button that says
  // what is wrong with a build was the one thing that could not be pressed.
  let thrown: string | null = null;
  let groups = -1;
  let solids = 0;
  let volume = 0;
  try {
    const grouped = solidsBySlot(model, {}, 1, options(true));
    groups = grouped.length;
    for (const group of grouped) {
      for (const solid of group) {
        solids++;
        const low = [Infinity, Infinity, Infinity];
        const high = [-Infinity, -Infinity, -Infinity];
        for (const corner of solid) {
          for (let axis = 0; axis < 3; axis++) {
            low[axis] = Math.min(low[axis]!, corner[axis]!);
            high[axis] = Math.max(high[axis]!, corner[axis]!);
          }
        }
        volume += (high[0]! - low[0]!) * (high[1]! - low[1]!) * (high[2]! - low[2]!);
      }
    }
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  if (thrown !== null) {
    fail(`one group with two colours threw: ${thrown}`);
  } else if (groups === 1 && Math.abs(volume - 1000) < 1e-6) {
    ok(`one group with two colours holds the whole block: ${solids} bodies, ${volume.toFixed(0)} mm3`);
  } else {
    fail(`one group with two colours gave ${groups} groups and ${volume.toFixed(1)} mm3, wanted 1 and 1000`);
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
