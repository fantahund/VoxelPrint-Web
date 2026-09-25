/**
 * Checks the stand a build is put on.
 *
 * <p>Run with {@code npx tsx tools/check-plate.mts} from the repository root.
 *
 * <p>Two things go wrong quietly here. A plate under the build pushes the build
 * up, and forgetting to lift it leaves the whole thing hanging below the bed --
 * which a slicer will happily accept and then refuse to print. And letters made
 * of boxes are letters until somebody reads them: mirrored, upside down, or
 * running off the back of the plate, they still measure right.
 */
import {
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  glyph,
  plateOf,
  labelFit,
  readable,
  type PlateOptions,
} from "../web/src/export/plate.js";
import { solidsBySlot, type GeometryOptions } from "../web/src/export/geometry.js";
import type { VoxelModel } from "../web/src/viewer/buildVoxels.js";

let problems = 0;
const fail = (m: string): void => { problems++; console.log("  FAIL " + m); };
const ok = (m: string): void => console.log("  ok   " + m);

/**
 * A selection four by three by two with one block in it, down on its own floor.
 *
 * <p>On the floor on purpose: the question here is where the bottom of the
 * whole thing ends up, and a block floating in the middle of its selection
 * would answer a different one.
 */
const model = {
  positions: Float32Array.from([0, -1, 0]),
  scales: Float32Array.from([1, 1, 1]),
  paletteIndices: Uint32Array.from([1]),
  boxes: 1,
  solids: 1,
  meshes: [],
  quads: 0,
  visible: 1,
  solid: 1,
  shaped: false,
  modelled: false,
  trueColour: false,
  size: { width: 4, height: 3, depth: 2 },
  blockIds: ["minecraft:air", "minecraft:stone"],
  minecraftColours: [0, 0x808080],
  blockTypeColours: { "minecraft:stone": 0x808080 },
  typeCounts: [["minecraft:stone", 1]],
  solidBlocks: Uint32Array.from([0]),
  blockStates: ["minecraft:air", "minecraft:stone"],
  removed: 0,
} as unknown as VoxelModel;

const plate = (over: Partial<PlateOptions> = {}): PlateOptions => ({
  plate: "labelled",
  plateMillimetres: 2,
  plateMargin: 2,
  label: "Steve",
  labelMillimetres: 6,
  plateSlot: 0,
  labelSlot: 1,
  ...over,
});

// --- what it is made of -----------------------------------------------------
{
  if (plateOf(model, 10, plate({ plate: "off" })).length === 0) {
    ok("no stand asked for, no boxes made");
  } else {
    fail("a stand was made where none was asked for");
  }

  const plain = plateOf(model, 10, plate({ plate: "plain" }));
  if (plain.length === 1) {
    ok("a plain plate is one slab");
  } else {
    fail(`a plain plate came to ${plain.length} boxes`);
  }

  const slab = plain[0]!.box;
  // Four blocks wide at ten millimetres, with two millimetres either side.
  if (Math.abs((slab[3] - slab[0]) * 10 - 44) < 1e-6 && Math.abs((slab[5] - slab[2]) * 10 - 24) < 1e-6) {
    ok("it reaches the overhang past the build on every side: 44 by 24 mm");
  } else {
    fail(`the slab is ${(slab[3] - slab[0]) * 10} by ${(slab[5] - slab[2]) * 10} mm, wanted 44 by 24`);
  }
  if (Math.abs((slab[4] - slab[1]) * 10 - 2) < 1e-6 && Math.abs(slab[4] + model.size.height / 2) < 1e-6) {
    ok("it is two millimetres thick and sits directly under the build");
  } else {
    fail(`the slab runs y ${slab[1]} to ${slab[4]}, wanted 2 mm ending at ${-model.size.height / 2}`);
  }

  const labelled = plateOf(model, 10, plate());
  if (labelled.length > 1) {
    ok(`"STEVE" is written as ${labelled.length - 1} bars`);
  } else {
    fail("the label made no boxes at all");
  }
  // The lip grows the plate forwards only, which is where somebody reads it.
  const lipped = labelled[0]!.box;
  if (lipped[2] === slab[2] && lipped[5] > slab[5]) {
    ok("the lip for the writing grows the plate forwards, not backwards");
  } else {
    fail(`the labelled plate runs z ${lipped[2]} to ${lipped[5]}, the plain one ${slab[2]} to ${slab[5]}`);
  }
  // Every letter stands on the plate and inside it.
  let outside = 0;
  for (const part of labelled.slice(1)) {
    const b = part.box;
    if (b[1] !== slab[4] || b[0] < lipped[0] || b[3] > lipped[3] || b[2] < lipped[2] || b[5] > lipped[5]) {
      outside++;
    }
  }
  if (outside === 0) {
    ok("every bar of the writing stands on the top of the plate and inside its edges");
  } else {
    fail(`${outside} bars of the writing are off the plate`);
  }
}

// --- what is written --------------------------------------------------------
{
  if (readable("Steve's village #2") === "STEVE'S VILLAGE #2") {
    ok("the label is read as upper case, punctuation kept where there is a letter for it");
  } else {
    fail(`"Steve's village #2" reads as "${readable("Steve's village #2")}"`);
  }
  if (readable("Dorf äöü") === "DORF") {
    ok("letters with no glyph are left out rather than drawn wrong");
  } else {
    fail(`"Dorf äöü" reads as "${readable("Dorf äöü")}"`);
  }

  // The letter itself, rebuilt off the boxes and held against its own
  // definition. Not how wide each row came out: an E is the same widths upside
  // down, and widths cannot see a left to right mirror at all, which is how a
  // mirrored plate got past this the first time.
  //
  // Read the way somebody standing at the shelf reads it. The writing lies flat
  // and faces up, so their left to right is the build's x rising, and the top
  // of a letter is the edge furthest from them, which is z falling.
  for (const letter of ["L", "F", "R", "2"]) {
    const boxes = plateOf(model, 10, plate({ label: letter, labelMillimetres: 7 })).slice(1);
    const pixel = 7 / 7 / 10;
    const grid = Array.from({ length: GLYPH_HEIGHT }, () => Array(GLYPH_WIDTH).fill("0"));
    const left = Math.min(...boxes.map((part) => part.box[0]));
    const far = Math.min(...boxes.map((part) => part.box[2]));
    let stray = 0;
    for (const part of boxes) {
      const from = Math.round((part.box[0] - left) / pixel);
      const to = Math.round((part.box[3] - left) / pixel);
      const row = Math.round((part.box[2] - far) / pixel);
      for (let column = from; column < to; column++) {
        if (row < 0 || row >= GLYPH_HEIGHT || column < 0 || column >= GLYPH_WIDTH) {
          stray++;
          continue;
        }
        (grid[row] as string[])[column] = "1";
      }
    }
    const drawn = grid.map((row) => row.join(""));
    const wanted = glyph(letter) as readonly string[];
    if (stray === 0 && drawn.join("/") === wanted.join("/")) {
      ok(`a ${letter} on the plate is the ${letter} it is defined as, read from the front`);
    } else {
      fail(
        `a ${letter} came out as ${drawn.join("/")}, wanted ${wanted.join("/")}` +
          (stray > 0 ? ` (${stray} pixels outside the letter)` : ""),
      );
    }
  }
}

// --- a name longer than the plate -------------------------------------------
{
  const long = plateOf(model, 10, plate({ label: "VoxelPrint 2026", labelMillimetres: 8 }));
  const slab = long[0]!.box;
  // Four blocks at ten millimetres with two either side: the plate is the size
  // the build and the overhang make it, and the writing does not get a say.
  if (Math.abs((slab[3] - slab[0]) * 10 - 44) < 1e-6) {
    ok("a name too long for the plate does not widen it: still 44 mm");
  } else {
    fail(`a long name made the plate ${(slab[3] - slab[0]) * 10} mm wide, wanted 44`);
  }
  let outside = 0;
  for (const part of long.slice(1)) {
    if (part.box[0] < slab[0] || part.box[3] > slab[3]) outside++;
  }
  if (outside === 0) {
    ok("and every bar of it is still on the plate: the letters shrink to fit");
  } else {
    fail(`${outside} bars of a long name run off the plate`);
  }
  // Shorter than asked for, or it would not have fitted.
  const tall = Math.max(...long.slice(1).map((part) => part.box[5] - part.box[2])) * 10;
  if (tall > 0 && tall < 8 / 7 + 1e-6) {
    ok(`the letters came down to ${tall.toFixed(2)} mm a pixel to do it`);
  } else {
    fail(`the letters are ${tall} mm a pixel, which is not smaller than asked`);
  }
}

// --- where it ends up -------------------------------------------------------
{
  const options: GeometryOptions = {
    millimetresPerBlock: 10,
    geometry: "shell",
    wallMillimetres: 1.2,
    plate: plate(),
  };
  const grouped = solidsBySlot(model, { "minecraft:stone": 0 }, 4, options);
  let lowest = Infinity;
  let highest = -Infinity;
  for (const mine of grouped) {
    for (const solid of mine) {
      for (const corner of solid) {
        lowest = Math.min(lowest, corner[2] as number);
        highest = Math.max(highest, corner[2] as number);
      }
    }
  }
  if (Math.abs(lowest) < 1e-6) {
    ok("with a plate under it the whole thing still stands on the bed, at z = 0");
  } else {
    fail(`the lowest point is at z = ${lowest}, not on the bed`);
  }
  // One block of build, ten millimetres, on two millimetres of plate.
  if (Math.abs(highest - 12) < 1e-6) {
    ok("and reaches 12 mm: a block of build on two millimetres of plate");
  } else {
    fail(`it reaches ${highest} mm, wanted 12`);
  }
  const bare = solidsBySlot(model, { "minecraft:stone": 0 }, 4, { ...options, plate: undefined });
  let bareLow = Infinity;
  for (const mine of bare) for (const solid of mine) for (const corner of solid) {
    bareLow = Math.min(bareLow, corner[2] as number);
  }
  if (Math.abs(bareLow) < 1e-6) {
    ok("and without a plate it stands on the bed exactly as it did before");
  } else {
    fail(`without a plate the lowest point is ${bareLow}`);
  }
}

// --- a stand grows with the blocks it stands under ----------------------------
{
  // The sizes are in millimetres and the plate works in blocks, so doubling the
  // block size while leaving the millimetres alone makes the stand relatively
  // half as thick: a three millimetre lip under a two hundred millimetre castle
  // is a shadow, not a stand. The interface scales the three sizes with the
  // block, and this is what that has to come out as -- the same stand, twice as
  // large, everywhere, not merely thicker.
  const SHARE = { thickness: 0.2, margin: 0.2, label: 0.6 };
  const at = (millimetres: number) =>
    plateOf(model, millimetres, plate({
      label: "VOXEL",
      plateMillimetres: millimetres * SHARE.thickness,
      plateMargin: millimetres * SHARE.margin,
      labelMillimetres: millimetres * SHARE.label,
    }));

  const small = at(10);
  const large = at(20);

  if (small.length !== large.length) {
    fail(`ten millimetre blocks gave ${small.length} parts and twenty gave ${large.length}`);
  } else {
    // In millimetres, not in blocks: the whole point is the printed size.
    let worst = 0;
    for (let part = 0; part < small.length; part++) {
      const a = small[part]?.box as readonly number[];
      const b = large[part]?.box as readonly number[];
      for (let corner = 0; corner < 6; corner++) {
        const want = (a[corner] as number) * 10 * 2;
        const got = (b[corner] as number) * 20;
        worst = Math.max(worst, Math.abs(want - got));
      }
    }
    if (worst < 1e-6) {
      ok(`a stand at twice the block size is exactly twice the stand, all ${small.length} parts of it`);
    } else {
      fail(`a stand at twice the block size is out by ${worst.toFixed(4)} mm`);
    }
  }

  // And the letters really are twice as tall, rather than the plate growing
  // around writing that stayed where it was.
  const smallFit = labelFit(model, 10, plate({
    label: "VOXEL", plateMargin: 2, labelMillimetres: 6,
  }));
  const largeFit = labelFit(model, 20, plate({
    label: "VOXEL", plateMargin: 4, labelMillimetres: 12,
  }));
  if (Math.abs(largeFit.height - smallFit.height * 2) < 1e-6) {
    ok(`and its name grows with it: ${smallFit.height.toFixed(1)} mm to ${largeFit.height.toFixed(1)} mm`);
  } else {
    fail(`letters went from ${smallFit.height} mm to ${largeFit.height} mm, wanted double`);
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
