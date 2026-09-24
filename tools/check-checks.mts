/**
 * Checks the thing that checks the build.
 *
 * <p>Run with {@code npx tsx tools/check-checks.mts} from the repository root.
 *
 * <p>Counting connected pieces is the kind of arithmetic that is wrong in one
 * direction without ever looking wrong: a rule that joins too eagerly says one
 * piece about a bag of blocks, and a rule that joins too shyly says eight
 * pieces about a wall. So the cases here are ones where the answer is not a
 * matter of opinion -- a block on its own, two blocks touching, two blocks
 * meeting at a corner, and a torch beside a wall it does not reach.
 */
import { piecesOf, overhangsOf } from "../web/src/export/checks.js";
import type { ShapeBox, StructureInfo } from "../web/src/types.js";

let problems = 0;
const fail = (m: string): void => { problems++; console.log("  FAIL " + m); };
const ok = (m: string): void => console.log("  ok   " + m);

const FULL: ShapeBox = [0, 0, 0, 1, 1, 1];
/** A torch: a thin post up the middle of its cell, touching nothing sideways. */
const POST: ShapeBox = [0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625];
/** A slab: the bottom half, so it touches below and not above. */
const SLAB: ShapeBox = [0, 0, 0, 1, 0.5, 1];

/** A little world, written out as a picture per layer. */
function world(
  layers: readonly (readonly string[])[],
  shapes: Readonly<Record<string, ShapeBox[]>> = {},
): { structure: StructureInfo; indices: Uint32Array } {
  const height = layers.length;
  const depth = layers[0]?.length ?? 0;
  const width = layers[0]?.[0]?.length ?? 0;
  const palette = ["minecraft:air"];
  const boxes: ShapeBox[][] = [[]];
  const seen = new Map<string, number>();
  const indices = new Uint32Array(width * height * depth);

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const mark = (layers[y]?.[z]?.[x] ?? ".") as string;
        if (mark === ".") continue;
        let entry = seen.get(mark);
        if (entry === undefined) {
          entry = palette.length;
          seen.set(mark, entry);
          palette.push(`test:${mark}`);
          boxes.push(shapes[mark] ?? [FULL]);
        }
        indices[x + z * width + y * width * depth] = entry;
      }
    }
  }
  return {
    structure: { width, height, depth, palette, bytesPerIndex: 1, shapes: boxes, modelled: false, order: "x + z * width + y * width * depth" },
    indices,
  };
}

const count = (
  layers: readonly (readonly string[])[],
  shapes?: Readonly<Record<string, ShapeBox[]>>,
): number[] => {
  const { structure, indices } = world(layers, shapes);
  return piecesOf(structure, indices);
};

// --- what is one piece and what is two ---------------------------------------
{
  const cases: Array<[string, readonly (readonly string[])[], number[], Record<string, ShapeBox[]>?]> = [
    ["nothing at all is no pieces", [["..", ".."]], []],
    ["one block is one piece of one", [["#.", ".."]], [1]],
    ["two blocks side by side are one piece", [["##", ".."]], [2]],
    ["two blocks a gap apart are two pieces", [["#.#"]], [1, 1]],
    ["two blocks meeting at a corner are two pieces", [["#.", ".#"]], [1, 1]],
    ["and stacked, one piece", [["#."], ["#."]], [2]],
    ["a wall of nine is one piece", [["###", "###", "###"]], [9]],
    [
      "a torch beside a wall it does not reach is two pieces",
      [["#t"]],
      [1, 1],
      { t: [POST] },
    ],
    [
      "a torch standing on a block is one piece",
      [["#."], ["t."]],
      [2],
      { t: [POST] },
    ],
    [
      "a block on top of a slab is two: the slab stops half way up its cell",
      [["s."], ["#."]],
      [1, 1],
      { s: [SLAB] },
    ],
  ];
  for (const [what, layers, wanted, shapes] of cases) {
    const got = count(layers, shapes);
    if (got.join(",") === wanted.join(",")) {
      ok(`${what}: ${got.length === 0 ? "none" : got.join(", ")}`);
    } else {
      fail(`${what}: got ${got.join(", ") || "none"}, wanted ${wanted.join(", ") || "none"}`);
    }
  }
}

// --- and biggest first, so "loose" means what it says -------------------------
{
  // A wall of four, and two strays.
  const got = count([["####", "....", "#..#"]]);
  if (got.join(",") === "4,1,1") {
    ok("pieces come back biggest first, so what is not in the first is loose: 4, 1, 1");
  } else {
    fail(`pieces came back as ${got.join(", ")}, wanted 4, 1, 1`);
  }
}

// --- what hangs over nothing --------------------------------------------------
{
  const { structure, indices } = world([["##"], ["#."]]);
  if (overhangsOf(structure, indices) === 0) {
    ok("a block standing on another is not an overhang");
  } else {
    fail("a block standing on another was counted as an overhang");
  }

  const { structure: s2, indices: i2 } = world([["#."], [".#"]]);
  if (overhangsOf(s2, i2) === 1) {
    ok("a block over the void is one, and the layer on the bed is nobody's overhang");
  } else {
    fail(`a block over the void counted ${overhangsOf(s2, i2)}, wanted 1`);
  }

  const { structure: s3, indices: i3 } = world([["#."], ["#."]], { "#": [SLAB] });
  if (overhangsOf(s3, i3) === 1) {
    ok("a slab over a slab hangs, because the one below stops half way up its cell");
  } else {
    fail(`a slab over a slab counted ${overhangsOf(s3, i3)}, wanted 1`);
  }
}

// --- removing a block can break a build in two --------------------------------
{
  const { structure, indices } = world([["###"]]);
  const before = piecesOf(structure, indices);
  const after = piecesOf(structure, indices, new Set([1]));
  if (before.join(",") === "3" && after.join(",") === "1,1") {
    ok("taking the middle out of a row of three makes it two pieces, which is the point of asking");
  } else {
    fail(`three in a row went from ${before.join(",")} to ${after.join(",")}`);
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
