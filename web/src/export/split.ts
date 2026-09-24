import type { VoxelModel } from "../viewer/buildVoxels";
import { CORNERS, solidsBySlot, type GeometryOptions, type Point, type Solid } from "./geometry";

/**
 * Cutting a build into things that can actually be printed.
 *
 * <p>Two reasons to cut one up, and they have nothing to do with each other.
 *
 * <p>A printer with one extruder can still make a build in eight colours: print
 * the eight colours one at a time and glue them together. That wants the parts
 * sorted by filament, each as its own file, and a sheet saying what goes where.
 * It is also the only way most people reading this own a multi-colour print.
 *
 * <p>And a bed is 256 millimetres across while a village is 1300. That wants
 * the build cut into pieces that fit, each still whole in itself.
 *
 * <p>Both end up the same shape: a list of pieces, each a name and some solids
 * per filament, which the writers can turn into files and the instructions can
 * turn into a page.
 */

export type Split = "off" | "colour" | "bed";

export interface SplitOptions {
  readonly split: Split;
  /** How large the bed is, in millimetres, for cutting a build to fit it. */
  readonly bed: readonly [number, number, number];
}

/** One thing to print on its own. */
export interface Piece {
  readonly name: string;
  /** Solids per filament, in the same order the filaments are in. */
  readonly solids: readonly (readonly Solid[])[];
  /** Where it belongs, for the instructions: column, row, layer, or null. */
  readonly at: readonly [number, number, number] | null;
  /** How large it is, in millimetres. */
  readonly size: readonly [number, number, number];
  readonly bodies: number;
}

function boundsOf(solids: readonly (readonly Solid[])[]): number[] {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const group of solids) {
    for (const solid of group) {
      for (const corner of solid) {
        for (let axis = 0; axis < 3; axis++) {
          bounds[axis] = Math.min(bounds[axis] as number, corner[axis] as number);
          bounds[axis + 3] = Math.max(bounds[axis + 3] as number, corner[axis] as number);
        }
      }
    }
  }
  return bounds;
}

function sizeOf(solids: readonly (readonly Solid[])[]): [number, number, number] {
  const bounds = boundsOf(solids);
  return [0, 1, 2].map((axis) =>
    Number.isFinite(bounds[axis] as number)
      ? Math.round(((bounds[axis + 3] as number) - (bounds[axis] as number)) * 100) / 100
      : 0,
  ) as [number, number, number];
}

function count(solids: readonly (readonly Solid[])[]): number {
  return solids.reduce((sum, group) => sum + group.length, 0);
}

/**
 * Whether a solid is a box standing square to the world.
 *
 * <p>Nearly all of them are, and a box can be cut by a plane exactly. The few
 * that are not -- the wall behind a tilted face -- are kept whole and put in
 * the piece their middle falls in, because cutting a slanted prism properly is
 * a great deal of machinery for a torch.
 */
function boxOf(solid: Solid): [number, number, number, number, number, number] | null {
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const corner of solid) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis] as number, corner[axis] as number);
      bounds[axis + 3] = Math.max(bounds[axis + 3] as number, corner[axis] as number);
    }
  }
  // Every corner has to be a corner of that box, or it is not one.
  for (const corner of solid) {
    for (let axis = 0; axis < 3; axis++) {
      const value = corner[axis] as number;
      if (
        Math.abs(value - (bounds[axis] as number)) > 1e-6 &&
        Math.abs(value - (bounds[axis + 3] as number)) > 1e-6
      ) {
        return null;
      }
    }
  }
  return bounds as [number, number, number, number, number, number];
}

function asSolid(box: readonly number[]): Solid {
  return CORNERS.map(
    (corner) =>
      [
        corner[0] === 0 ? box[0] : box[3],
        corner[1] === 0 ? box[1] : box[4],
        corner[2] === 0 ? box[2] : box[5],
      ] as unknown as Point,
  );
}

/**
 * The build, cut up however it was asked for.
 *
 * <p>One piece, called the whole thing, when it was not asked for at all.
 */
export function pieces(
  model: VoxelModel,
  assignment: Readonly<Record<string, number>>,
  slotCount: number,
  slotNames: readonly string[],
  options: GeometryOptions & SplitOptions,
): Piece[] {
  const grouped = solidsBySlot(model, assignment, slotCount, options);

  if (options.split === "off") {
    return [
      { name: "whole", solids: grouped, at: null, size: sizeOf(grouped), bodies: count(grouped) },
    ];
  }

  if (options.split === "colour") {
    // One file per filament, each with everything of that colour and nothing
    // else. Empty filaments are left out rather than shipped as a file nobody
    // can print.
    return grouped
      .map((group, slot) => ({ group, slot }))
      .filter(({ group }) => group.length > 0)
      .map(({ group, slot }) => {
        const only = grouped.map((_, index) => (index === slot ? group : []));
        return {
          name: `${slot + 1} ${slotNames[slot] ?? `Filament ${slot + 1}`}`,
          solids: only,
          at: null,
          size: sizeOf(only),
          bodies: group.length,
        };
      });
  }

  return tiles(grouped, options.bed);
}

/**
 * The build cut into pieces that fit the bed.
 *
 * <p>Cut on a grid rather than packed: a tile that is a rectangle of the build
 * goes back where it came from without anybody having to work out where, and
 * the seams are straight lines somebody can glue along.
 *
 * <p>The bed is used as it is given, with no margin taken off. A printer's bed
 * is quoted at what it can reach and a slicer takes its own skirt off that; a
 * tile that fits exactly is the caller's business to make smaller if their
 * machine wants room.
 */
function tiles(
  grouped: readonly (readonly Solid[])[],
  bed: readonly [number, number, number],
): Piece[] {
  const bounds = boundsOf(grouped);
  if (!Number.isFinite(bounds[0] as number)) {
    return [];
  }

  const span = [0, 1, 2].map((axis) => (bounds[axis + 3] as number) - (bounds[axis] as number));
  const across = [0, 1, 2].map((axis) =>
    Math.max(1, Math.ceil((span[axis] as number) / Math.max(bed[axis] ?? 1, 1e-6) - 1e-9)),
  );
  // Cut into equal pieces rather than full beds and a sliver: three tiles of
  // ninety millimetres beat two of a hundred and twenty-eight and one of four.
  const step = [0, 1, 2].map((axis) => (span[axis] as number) / (across[axis] as number));

  const which = (value: number, axis: number): number =>
    Math.min(
      (across[axis] as number) - 1,
      Math.max(0, Math.floor((value - (bounds[axis] as number)) / (step[axis] as number) + 1e-9)),
    );

  const made = new Map<string, Array<Solid[]>>();
  const put = (cell: readonly number[], slot: number, solid: Solid): void => {
    const key = cell.join(",");
    const piece = made.get(key) ?? grouped.map(() => [] as Solid[]);
    (piece[slot] as Solid[]).push(solid);
    made.set(key, piece);
  };

  grouped.forEach((group, slot) => {
    for (const solid of group) {
      const box = boxOf(solid);
      if (box === null) {
        // Not square to the world: kept whole, in the tile its middle is in.
        const middle = [0, 1, 2].map(
          (axis) =>
            solid.reduce((sum, corner) => sum + (corner[axis] as number), 0) / solid.length,
        );
        put(middle.map((value, axis) => which(value, axis)), slot, solid);
        continue;
      }
      // Cut on every seam it crosses, so a tile holds exactly its own share.
      for (let x = which(box[0], 0); x <= which(box[3] - 1e-9, 0); x++) {
        for (let y = which(box[1], 1); y <= which(box[4] - 1e-9, 1); y++) {
          for (let z = which(box[2], 2); z <= which(box[5] - 1e-9, 2); z++) {
            const cell = [x, y, z];
            const cut = [0, 1, 2].flatMap((axis) => {
              const from = (bounds[axis] as number) + (cell[axis] as number) * (step[axis] as number);
              const to = from + (step[axis] as number);
              return [Math.max(box[axis] as number, from), Math.min(box[axis + 3] as number, to)];
            });
            const piece = [cut[0], cut[2], cut[4], cut[1], cut[3], cut[5]] as number[];
            if (
              (piece[3] as number) - (piece[0] as number) > 1e-6 &&
              (piece[4] as number) - (piece[1] as number) > 1e-6 &&
              (piece[5] as number) - (piece[2] as number) > 1e-6
            ) {
              put(cell, slot, asSolid(piece));
            }
          }
        }
      }
    }
  });

  return [...made.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true }))
    .map(([key, solids]) => {
      const cell = key.split(",").map(Number) as [number, number, number];
      return {
        // Printed axes, not the game's: across the bed, into the bed, and up
        // off it. So A1 is the near left tile of the ground floor, and a build
        // taller than the bed grows levels rather than letters.
        name: `${String.fromCharCode(65 + cell[0])}${cell[1] + 1}${
          (across[2] as number) > 1 ? ` level ${cell[2] + 1}` : ""
        }`,
        solids,
        at: cell,
        size: sizeOf(solids),
        bodies: count(solids),
      };
    });
}
