/**
 * Checks that a skin lands on the figure the right way round.
 *
 * <p>Run with {@code npx tsx tools/check-skin.mts} from the repository root.
 *
 * <p>The mapping from a skin's texture to the six boxes of the player model is
 * the kind of thing that is wrong quietly: a side read back to front, a top
 * read upside down, a face reading its neighbour's band. None of that throws,
 * and none of it is obvious until somebody looks at a print of their own face
 * with the eyes on the back of the head.
 *
 * <p>So the skin fed in here is painted with its own coordinates -- each texel
 * carries the u and v it sits at -- and the figure is asked which texel each
 * voxel took its colour from. The answers are then checked against what the
 * skin template says, which is that the four sides are one strip laid out right,
 * front, left, back: walking around the box has to walk along the strip.
 */
import {
  buildSkinVoxels,
  readSkin,
  type PlayerModel,
  type SkinLayers,
} from "../web/src/skin/skin.js";

/** colour = (u << 8) | v, so a voxel says which texel it was read from. */
function coded(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(64 * 64 * 4);
  for (let v = 0; v < 64; v++) {
    for (let u = 0; u < 64; u++) {
      const at = (v * 64 + u) * 4;
      pixels[at] = 0;
      pixels[at + 1] = u;
      pixels[at + 2] = v;
      pixels[at + 3] = 255;
    }
  }
  // One see-through texel, in the corner nothing reads: a skin with no
  // transparency anywhere is read as having no second layer, and these checks
  // are about a skin that has one.
  pixels[(0 * 64 + 0) * 4 + 3] = 0;
  return pixels;
}

/** The six regions the second layer lives in: u0, v0, u1, v1. */
const OUTER: ReadonlyArray<[number, number, number, number]> = [
  [32, 0, 64, 16], // hat
  [16, 32, 40, 48], // jacket
  [40, 32, 64, 48], // right sleeve
  [0, 32, 16, 48], // right trousers
  [0, 48, 16, 64], // left trousers
  [48, 48, 64, 64], // left sleeve
];

function figure(model: PlayerModel, layers: SkinLayers, bareSkin = false) {
  const pixels = coded();
  if (bareSkin) {
    // With the second layer opaque everywhere, the body reads the layer rather
    // than itself, which is right and says nothing about the body's own
    // mapping. Blanked, the body answers for itself.
    for (const [u0, v0, u1, v1] of OUTER) {
      for (let v = v0; v < v1; v++) {
        for (let u = u0; u < u1; u++) {
          pixels[(v * 64 + u) * 4 + 3] = 0;
        }
      }
    }
  }
  const skin = readSkin(pixels, 64, 64);
  const built = buildSkinVoxels(skin, { model, layers });
  const { width, height, depth, palette } = built.structure;
  const colourAt = (x: number, y: number, z: number): [number, number] | null => {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) return null;
    const entry = built.indices[x + z * width + y * width * depth]!;
    if (entry === 0) return null;
    const colour = built.colours[entry]!;
    return [(colour >> 8) & 0xff, colour & 0xff];
  };
  return { built, width, height, depth, palette, colourAt };
}

let problems = 0;
const fail = (message: string): void => {
  problems++;
  console.log("  FAIL " + message);
};
const ok = (message: string): void => console.log("  ok   " + message);

// --- the figure's size ------------------------------------------------------
{
  const flat = figure("classic", "flat");
  // Head 8 deep centred on a body 4 deep, arms 4 either side of a body 8 wide,
  // legs 12 + body 12 + head 8 tall.
  if (flat.width === 16 && flat.height === 32 && flat.depth === 8) {
    ok(`classic, painted on: ${flat.width} x ${flat.height} x ${flat.depth}`);
  } else {
    fail(`classic, painted on: ${flat.width} x ${flat.height} x ${flat.depth}, wanted 16 x 32 x 8`);
  }

  const solid = figure("classic", "solid");
  if (solid.width === 18 && solid.height === 34 && solid.depth === 10) {
    ok(`classic, standing off: ${solid.width} x ${solid.height} x ${solid.depth}`);
  } else {
    fail(`classic, standing off: ${solid.width} x ${solid.height} x ${solid.depth}, wanted 18 x 34 x 10`);
  }

  const slim = figure("slim", "flat");
  if (slim.width === 14) {
    ok(`slim arms take a texel off each side: ${slim.width} wide`);
  } else {
    fail(`slim is ${slim.width} wide, wanted 14`);
  }
}

// --- walking around the head, which is the unwrap the layout is built on -----
{
  const { colourAt } = figure("classic", "flat", true);
  // The head stands at x 4..11, y 24..31, and z 0..7 once the grid's corner is
  // taken off. Corners are left out: a corner voxel is on two faces and can
  // only carry one colour, so it says nothing about either.
  const y = 28;
  const band = (
    what: string,
    samples: Array<[number, number]>,
    from: number,
    to: number,
  ): void => {
    const us: number[] = [];
    for (const [x, z] of samples) {
      const found = colourAt(x, y, z);
      if (found === null) {
        fail(`${what}: no voxel at ${x},${y},${z}`);
        return;
      }
      us.push(found[0]);
    }
    const inside = us.every((u) => u >= from && u < to);
    const rising = us.every((u, i) => i === 0 || u === (us[i - 1] as number) + 1);
    if (inside && rising) {
      ok(`${what} reads u ${us[0]} to ${us[us.length - 1]}, inside its band ${from}..${to - 1}`);
    } else {
      fail(`${what} reads ${us.join(",")}, wanted a rising run inside ${from}..${to - 1}`);
    }
  };

  // Walking around the box one way must walk along the texture strip one way.
  band("the head's right, back to front", [1, 2, 3, 4, 5, 6].map((z) => [4, z] as [number, number]), 0, 8);
  band("the head's front, right to left", [5, 6, 7, 8, 9, 10].map((x) => [x, 7] as [number, number]), 8, 16);
  band("the head's left, front to back", [6, 5, 4, 3, 2, 1].map((z) => [11, z] as [number, number]), 16, 24);
  band("the head's back, left to right", [10, 9, 8, 7, 6, 5].map((x) => [x, 0] as [number, number]), 24, 32);
}

// --- every texel of a face is used once, and no other -----------------------
{
  const { colourAt } = figure("classic", "flat", true);
  // The ring around the edge of the top is on a side face as well, and a side
  // is what somebody looks at, so it takes the side's colour. The inside of
  // the top is the part that answers for the top.
  const seen: Array<[number, number]> = [];
  for (let x = 5; x <= 10; x++) {
    for (let z = 1; z < 7; z++) {
      const found = colourAt(x, 31, z);
      if (found !== null) seen.push(found);
    }
  }
  const inside = seen.filter(([u, v]) => u >= 8 && u < 16 && v >= 0 && v < 8);
  const distinct = new Set(seen.map(([u, v]) => `${u},${v}`));
  if (seen.length === 36 && inside.length === 36 && distinct.size === 36) {
    ok("the top of the head reads its own region, every texel once");
  } else {
    fail(`the top of the head read ${seen.length} texels, ${inside.length} in region, ${distinct.size} distinct`);
  }
  // The row of the top nearest the front is the region's lower row, which is
  // what the template draws: a top seen from above with the face at the bottom.
  const front = colourAt(7, 31, 6);
  const back = colourAt(7, 31, 1);
  if (front?.[1] === 6 && back?.[1] === 1) {
    ok("the top of the head runs front to back down the region, not up it");
  } else {
    fail(`the top reads v ${back?.[1]} at the back and ${front?.[1]} at the front, wanted 1 and 6`);
  }

  const right = colourAt(4, 28, 7);
  const left = colourAt(11, 28, 7);
  if (right?.[0] === 8 && left?.[0] === 15) {
    ok("the front of the head is not mirrored: u 8 at the player's right, 15 at their left");
  } else {
    fail(`the front of the head reads u ${right?.[0]} to ${left?.[0]}, wanted 8 to 15`);
  }
}

// --- the second layer appears only where it is opaque -----------------------
{
  // A skin whose hat is opaque on one side only.
  const pixels = coded();
  for (let v = 0; v < 16; v++) {
    for (let u = 32; u < 64; u++) {
      // The hat region: transparent except the front, (40,8) to (48,16).
      const front = u >= 40 && u < 48 && v >= 8 && v < 16;
      pixels[(v * 64 + u) * 4 + 3] = front ? 255 : 0;
    }
  }
  const skin = readSkin(pixels, 64, 64);
  const built = buildSkinVoxels(skin, { model: "classic", layers: "solid" });
  const { width, height, depth } = built.structure;
  let hatVoxels = 0;
  for (let i = 0; i < built.indices.length; i++) {
    if (built.indices[i] === 0) continue;
    const x = i % width;
    const z = Math.floor(i / width) % depth;
    const y = Math.floor(i / (width * depth));
    // The grid's corner is (-1, -1, -3); the hat's front face stands at z = 9.
    if (z === depth - 1 && y >= 24 && y <= 33) hatVoxels++;
  }
  // The grown head is 10 wide and 10 tall; its front face is one 10 by 10 slab.
  if (hatVoxels === 100) {
    ok("a hat opaque only at the front stands off there and nowhere else: 100 voxels");
  } else {
    fail(`the front of the hat came to ${hatVoxels} voxels, wanted 100`);
  }
  // The hat is the only part of the head's layer that is there, so the head
  // grows forwards and nowhere else; the body, sleeves and trousers are still
  // opaque here and grow all round.
  if (width === 18 && height === 34 && depth === 9) {
    ok(`a layer that is only there in places grows the figure only there: ${width} x ${height} x ${depth}`);
  } else {
    fail(`the figure came out ${width} x ${height} x ${depth}, wanted 18 x 34 x 9`);
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
