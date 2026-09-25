import type { ShapeBox, StructureInfo } from "../types";
import type { VoxelModel } from "../viewer/buildVoxels";
import { solidsBySlot, type GeometryOptions } from "./geometry";
import { isAir } from "../viewer/blockColors";

/**
 * What is wrong with a build before anybody spends four hours finding out.
 *
 * <p>Three questions, and all three are answered from what the exporter already
 * knows rather than from the printer:
 *
 * <ul>
 *   <li>is it one thing? A build with a lantern hanging in mid air arrives as
 *       a lantern and a build, in a bag, and the slicer will not say so -- it
 *       prints loose parts perfectly happily;
 *   <li>is any of it too fine to print? A chain at ten millimetres a block is a
 *       chain; at three it is a line the nozzle cannot draw;
 *   <li>and how much of it hangs over nothing, which is what supports are for
 *       and what the underside of a print looks like afterwards.
 * </ul>
 *
 * <p>None of this refuses an export. It is a thing to read before pressing the
 * button, in the same place the button is.
 */

/** A default only: 0.4 is what nearly every printer has in it. */
export const NOZZLE = 0.4;

export interface Findings {
  /** How many blocks the whole build has, air and removed ones left out. */
  readonly blocks: number;
  /** Connected pieces, biggest first, as block counts. */
  readonly pieces: readonly number[];
  /** Blocks in anything but the biggest piece. */
  readonly loose: number;
  /** How many of the printed bodies have a side thinner than the nozzle. */
  readonly thin: number;
  readonly bodies: number;
  /** The thinnest side of any of them, in millimetres. */
  readonly thinnest: number;
  /** Blocks with nothing under them, which somebody's supports will have to hold. */
  readonly overhanging: number;
  /** How large it comes out, in millimetres, the plate included. */
  readonly size: readonly [number, number, number];
}

const FULL: ShapeBox = [0, 0, 0, 1, 1, 1];
const NEAR = 1e-6;

/**
 * Whether two neighbouring cells actually touch.
 *
 * <p>Sharing a face of the grid is not the same as touching: a torch stands in
 * the middle of its cell and a wall beside it never reaches it. So the shapes
 * are asked -- one has to come up to the shared plane, the other has to start
 * at it, and the two have to overlap across it with some area rather than
 * meeting along a line.
 *
 * @param axis which way the second cell lies from the first
 */
function touching(a: readonly ShapeBox[], b: readonly ShapeBox[], axis: number): boolean {
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  for (const one of a) {
    if ((one[axis + 3] as number) < 1 - NEAR) {
      continue;
    }
    for (const other of b) {
      if ((other[axis] as number) > NEAR) {
        continue;
      }
      const overlaps =
        Math.min(one[u + 3] as number, other[u + 3] as number) -
          Math.max(one[u] as number, other[u] as number) >
          NEAR &&
        Math.min(one[v + 3] as number, other[v + 3] as number) -
          Math.max(one[v] as number, other[v] as number) >
          NEAR;
      if (overlaps) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The connected pieces of a build, biggest first.
 *
 * <p>Walked cell by cell over the selection, with the shapes deciding what
 * counts as a join. Blocks that meet only along an edge or at a corner are two
 * pieces, because that is what they are once printed: a staircase of single
 * blocks set corner to corner is a pile of blocks.
 */
export function piecesOf(
  structure: StructureInfo,
  indices: Uint32Array,
  removed: ReadonlySet<number> = new Set(),
): number[] {
  const { width, height, depth, palette } = structure;
  const air = palette.map(isAir);
  const shapes: ReadonlyArray<readonly ShapeBox[]> =
    structure.shapes ?? palette.map(() => [FULL]);
  const shapeOf = (entry: number): readonly ShapeBox[] => {
    const boxes = shapes[entry];
    return boxes === undefined || boxes.length === 0 ? [FULL] : boxes;
  };

  const at = (x: number, y: number, z: number): number => x + z * width + y * width * depth;
  const there = (where: number): boolean =>
    !removed.has(where) && !(air[indices[where] as number] ?? true);

  const seen = new Uint8Array(width * height * depth);
  const found: number[] = [];
  const queue = new Int32Array(width * height * depth);

  for (let start = 0; start < indices.length; start++) {
    if (seen[start] === 1 || !there(start)) {
      continue;
    }
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let size = 0;

    while (head < tail) {
      const where = queue[head++] as number;
      size++;
      const x = where % width;
      const z = Math.floor(where / width) % depth;
      const y = Math.floor(where / (width * depth));
      const mine = shapeOf(indices[where] as number);

      for (let axis = 0; axis < 3; axis++) {
        for (const step of [-1, 1]) {
          const nx = axis === 0 ? x + step : x;
          const ny = axis === 1 ? y + step : y;
          const nz = axis === 2 ? z + step : z;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= width || ny >= height || nz >= depth) {
            continue;
          }
          const next = at(nx, ny, nz);
          if (seen[next] === 1 || !there(next)) {
            continue;
          }
          const theirs = shapeOf(indices[next] as number);
          // Which of the two reaches up to the shared plane depends on which
          // way the neighbour lies.
          const joined =
            step === 1 ? touching(mine, theirs, axis) : touching(theirs, mine, axis);
          if (joined) {
            seen[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    found.push(size);
  }

  return found.sort((a, b) => b - a);
}

/**
 * Blocks standing on nothing.
 *
 * <p>Counted rather than judged: a build is allowed to have leaves and
 * lanterns, and supports exist. It is worth knowing how much of it there is
 * before the printer is asked to hold it up.
 */
export function overhangsOf(
  structure: StructureInfo,
  indices: Uint32Array,
  removed: ReadonlySet<number> = new Set(),
): number {
  const { width, height, depth, palette } = structure;
  const air = palette.map(isAir);
  const shapes: ReadonlyArray<readonly ShapeBox[]> =
    structure.shapes ?? palette.map(() => [FULL]);
  const shapeOf = (entry: number): readonly ShapeBox[] => {
    const boxes = shapes[entry];
    return boxes === undefined || boxes.length === 0 ? [FULL] : boxes;
  };
  const there = (where: number): boolean =>
    !removed.has(where) && !(air[indices[where] as number] ?? true);

  let hanging = 0;
  for (let y = 1; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const where = x + z * width + y * width * depth;
        if (!there(where)) {
          continue;
        }
        const under = x + z * width + (y - 1) * width * depth;
        if (!there(under) || !touching(shapeOf(indices[under] as number), shapeOf(indices[where] as number), 1)) {
          hanging++;
        }
      }
    }
  }
  // The bottom layer stands on the bed and is nobody's overhang.
  return hanging;
}

/**
 * Everything worth saying about a build before it is printed.
 *
 * <p>The bodies are the ones the writers would actually produce, so the
 * thinness is the thinness of the print rather than of the model: a face with
 * no thickness at all becomes a wall, and that wall is what is measured.
 */
export function inspect(
  model: VoxelModel,
  structure: StructureInfo,
  indices: Uint32Array,
  removed: ReadonlySet<number>,
  options: GeometryOptions,
  nozzle: number = NOZZLE,
): Findings {
  const pieces = piecesOf(structure, indices, removed);
  const blocks = pieces.reduce((sum, piece) => sum + piece, 0);

  // One group, and no colour per face: which filament a body prints in has
  // nothing to do with whether it can be printed at all. Leaving the face
  // matching on would also cut every box into a body and its colour skins, and
  // report those skins -- fused to the body, never printed on their own -- as
  // walls too thin for the nozzle.
  const bodies =
    solidsBySlot(model, {}, 1, { ...options, perFace: false, slotColours: undefined })[0] ?? [];
  let thin = 0;
  let thinnest = Infinity;
  const low = [0, 0, 0];
  const high = [0, 0, 0];
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

  for (const body of bodies) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Infinity;
      high[axis] = -Infinity;
    }
    for (const corner of body) {
      for (let axis = 0; axis < 3; axis++) {
        const value = corner[axis] as number;
        low[axis] = Math.min(low[axis] as number, value);
        high[axis] = Math.max(high[axis] as number, value);
        bounds[axis] = Math.min(bounds[axis] as number, value);
        bounds[axis + 3] = Math.max(bounds[axis + 3] as number, value);
      }
    }
    const smallest = Math.min(
      (high[0] as number) - (low[0] as number),
      (high[1] as number) - (low[1] as number),
      (high[2] as number) - (low[2] as number),
    );
    thinnest = Math.min(thinnest, smallest);
    if (smallest < nozzle) {
      thin++;
    }
  }

  return {
    blocks,
    pieces,
    loose: blocks - (pieces[0] ?? 0),
    thin,
    bodies: bodies.length,
    thinnest: Number.isFinite(thinnest) ? thinnest : 0,
    overhanging: overhangsOf(structure, indices, removed),
    size: [0, 1, 2].map((axis) =>
      Number.isFinite(bounds[axis] as number)
        ? Math.round(((bounds[axis + 3] as number) - (bounds[axis] as number)) * 100) / 100
        : 0,
    ) as [number, number, number],
  };
}
