/**
 * Checks that cutting a build up loses nothing and invents nothing.
 *
 * <p>Run with {@code npx tsx tools/check-split.mts} from the repository root.
 *
 * <p>A cut is arithmetic with an obvious failure nobody sees: a tile that keeps
 * a box its neighbour also keeps prints the same wall twice, and a tile that
 * keeps neither leaves a hole along a seam. Neither throws, and neither is
 * visible in a preview -- they are visible when six printed tiles will not go
 * together. So the volume is added back up, and the pieces are held against the
 * build they came from.
 */
import { pieces } from "../web/src/export/split.js";
import { solidsBySlot, type GeometryOptions, type Solid } from "../web/src/export/geometry.js";
import { instructions } from "../web/src/export/instructions.js";
import type { VoxelModel } from "../web/src/viewer/buildVoxels.js";

let problems = 0;
const fail = (m: string): void => { problems++; console.log("  FAIL " + m); };
const ok = (m: string): void => console.log("  ok   " + m);

/** A wall of blocks, four by one by three, each a solid cube. */
const WIDE = 4;
const TALL = 1;
const DEEP = 3;
const positions: number[] = [];
const scales: number[] = [];
const drawn: number[] = [];
const blocks: number[] = [];
for (let y = 0; y < TALL; y++) {
  for (let z = 0; z < DEEP; z++) {
    for (let x = 0; x < WIDE; x++) {
      positions.push(x - WIDE / 2 + 0.5, y - TALL / 2 + 0.5, z - DEEP / 2 + 0.5);
      scales.push(1, 1, 1);
      // Two block types, so splitting by colour has something to split.
      drawn.push(x < 2 ? 1 : 2);
      blocks.push(x + z * WIDE + y * WIDE * DEEP);
    }
  }
}
const model = {
  positions: Float32Array.from(positions),
  scales: Float32Array.from(scales),
  paletteIndices: Uint32Array.from(drawn),
  boxes: drawn.length,
  solids: drawn.length,
  meshes: [], quads: 0, visible: drawn.length, solid: drawn.length,
  shaped: false, modelled: false, trueColour: false,
  size: { width: WIDE, height: TALL, depth: DEEP },
  blockIds: ["minecraft:air", "minecraft:stone", "minecraft:dirt"],
  minecraftColours: [0, 0x808080, 0x8b5a2b],
  blockTypeColours: { "minecraft:stone": 0x808080, "minecraft:dirt": 0x8b5a2b },
  typeCounts: [["minecraft:stone", 6], ["minecraft:dirt", 6]],
  solidBlocks: Uint32Array.from(blocks),
  blockStates: ["minecraft:air", "minecraft:stone", "minecraft:dirt"],
  removed: 0,
} as unknown as VoxelModel;

const assignment = { "minecraft:stone": 0, "minecraft:dirt": 1 };
const names = ["Grey", "Brown"];
const base: GeometryOptions = { millimetresPerBlock: 10, geometry: "shell", wallMillimetres: 1.2 };

const volumeOf = (solids: readonly (readonly Solid[])[]): number => {
  let total = 0;
  for (const group of solids) {
    for (const solid of group) {
      const low = [Infinity, Infinity, Infinity];
      const high = [-Infinity, -Infinity, -Infinity];
      for (const corner of solid) {
        for (let axis = 0; axis < 3; axis++) {
          low[axis] = Math.min(low[axis]!, corner[axis]!);
          high[axis] = Math.max(high[axis]!, corner[axis]!);
        }
      }
      total += (high[0]! - low[0]!) * (high[1]! - low[1]!) * (high[2]! - low[2]!);
    }
  }
  return total;
};

const whole = solidsBySlot(model, assignment, 2, base);
const wholeVolume = volumeOf(whole);
console.log(`a wall of ${WIDE} by ${TALL} by ${DEEP}: ${volumeOf(whole).toFixed(0)} mm³ in ${whole.flat().length} bodies\n`);

// --- not cutting it at all ---------------------------------------------------
{
  const parts = pieces(model, assignment, 2, names, { ...base, split: "off", bed: [256, 256, 256] });
  if (parts.length === 1 && Math.abs(volumeOf(parts[0]!.solids) - wholeVolume) < 1e-6) {
    ok("not cutting it gives one piece with all of it in");
  } else {
    fail(`not cutting gave ${parts.length} pieces, ${volumeOf(parts[0]?.solids ?? []).toFixed(2)} mm³`);
  }
}

// --- by colour ---------------------------------------------------------------
{
  const parts = pieces(model, assignment, 2, names, { ...base, split: "colour", bed: [256, 256, 256] });
  const total = parts.reduce((sum, piece) => sum + volumeOf(piece.solids), 0);
  if (parts.length === 2 && Math.abs(total - wholeVolume) < 1e-6) {
    ok(`by colour: ${parts.length} files, ${total.toFixed(0)} mm³ between them, which is all of it`);
  } else {
    fail(`by colour gave ${parts.length} files coming to ${total.toFixed(2)} of ${wholeVolume.toFixed(2)}`);
  }
  // Each file has to hold one colour and nothing else, or gluing is guesswork.
  const mixed = parts.filter((piece) => piece.solids.filter((group) => group.length > 0).length !== 1);
  if (mixed.length === 0) {
    ok("and each file holds exactly one filament");
  } else {
    fail(`${mixed.length} files hold more than one filament`);
  }
}

// --- to fit a bed ------------------------------------------------------------
{
  // Across the bed, into it, and up off it -- the printer's axes, not the
  // game's. The wall comes out 40 across, 30 deep and 10 tall.
  for (const bed of [
    [15, 256, 256],
    [256, 15, 256],
    [15, 15, 256],
    [256, 256, 256],
  ] as const) {
    const parts = pieces(model, assignment, 2, names, {
      ...base, split: "bed", bed: bed as [number, number, number],
    });
    const total = parts.reduce((sum, piece) => sum + volumeOf(piece.solids), 0);
    const fits = parts.every((piece) => piece.size.every((side, axis) => side <= (bed[axis] as number) + 1e-6));
    if (Math.abs(total - wholeVolume) < 1e-6 && fits) {
      ok(
        `a ${bed.join(" x ")} mm bed: ${parts.length} tiles [${parts.map((p) => p.name).join(", ")}], ` +
          `${total.toFixed(0)} mm³, every one of them fits`,
      );
    } else {
      fail(
        `a ${bed.join(" x ")} bed gave ${parts.length} tiles coming to ${total.toFixed(2)} of ` +
          `${wholeVolume.toFixed(2)}, all fitting: ${fits}`,
      );
    }
  }
}

// --- and the sheet that comes with them --------------------------------------
{
  const parts = pieces(model, assignment, 2, names, { ...base, split: "bed", bed: [15, 256, 15] });
  const pdf = instructions("Wall", "bed", parts, [
    { name: "Grey", colour: 0x808080 },
    { name: "Brown", colour: 0x8b5a2b },
  ], 10);
  const text = new TextDecoder("latin1").decode(pdf);
  const header = text.startsWith("%PDF-1.4");
  const ends = text.trimEnd().endsWith("%%EOF");
  const named = parts.every((piece) => text.includes(`(${piece.name})`));
  const offsets = [...text.matchAll(/\n(\d+) 0 obj/g)].length;
  // The cross reference has to point at something that is actually there.
  const start = Number(/startxref\s+(\d+)/.exec(text)?.[1] ?? "-1");
  const pointsAtXref = text.slice(start, start + 4) === "xref";
  if (header && ends && named && offsets === 6 && pointsAtXref) {
    ok(`the sheet is a PDF of ${pdf.length} bytes naming all ${parts.length} tiles`);
  } else {
    fail(
      `the sheet: header ${header}, end ${ends}, all named ${named}, ` +
        `${offsets} objects, xref points at "${text.slice(start, start + 4)}"`,
    );
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
