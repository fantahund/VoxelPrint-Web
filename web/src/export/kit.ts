import { zipSync } from "fflate";
import type { FilamentSlot } from "../slots/filament";
import type { VoxelModel } from "../viewer/buildVoxels";
import type { GeometryOptions } from "./geometry";
import { fileName, instructions } from "./instructions";
import { pieces, type SplitOptions } from "./split";
import { buildStl } from "./stl";
import { buildThreeMf } from "./threeMf";

/**
 * A build cut into pieces, packed with the sheet that explains them.
 *
 * <p>One file to download, because a folder of eight and a page telling you
 * what they are is one thing and not nine. A zip is what every machine already
 * opens, and fflate is here anyway -- a 3MF is a zip.
 */

export type Kind = "3mf" | "stl";

export interface Kit {
  readonly bytes: Uint8Array;
  readonly pieces: number;
  /** How large the largest piece is, which is what has to fit the bed. */
  readonly largest: readonly [number, number, number];
  readonly triangles: number;
}

export function buildKit(
  model: VoxelModel,
  slots: readonly FilamentSlot[],
  assignment: Readonly<Record<string, number>>,
  kind: Kind,
  name: string,
  options: GeometryOptions & SplitOptions & { carryColours?: boolean },
): Kit {
  const parts = pieces(
    model,
    assignment,
    slots.length,
    slots.map((slot) => slot.name),
    options,
  );
  if (parts.length === 0) {
    throw new Error("There is nothing to print.");
  }

  const files: Record<string, Uint8Array> = {};
  let triangles = 0;
  const largest: [number, number, number] = [0, 0, 0];

  parts.forEach((piece, index) => {
    const base = fileName(piece, index);
    if (kind === "3mf") {
      const built = buildThreeMf(model, slots, assignment, {
        ...options,
        name: `${name} ${piece.name}`,
        grouped: piece.solids,
      });
      files[`${base}.3mf`] = built.bytes;
      triangles += built.triangles;
    } else {
      const built = buildStl(model, slots, assignment, {
        ...options,
        name: `${name} ${piece.name}`,
        grouped: piece.solids,
      });
      files[`${base}.stl`] = built.bytes;
      triangles += built.triangles;
    }
    for (let axis = 0; axis < 3; axis++) {
      largest[axis] = Math.max(largest[axis] as number, piece.size[axis] ?? 0);
    }
  });

  files["how to put it together.pdf"] = instructions(
    name,
    options.split,
    parts,
    slots,
    options.millimetresPerBlock,
  );

  return {
    bytes: zipSync(files, { level: 6 }),
    pieces: parts.length,
    largest,
    triangles,
  };
}
