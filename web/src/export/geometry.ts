import type { VoxelModel } from "../viewer/buildVoxels";

/**
 * Turns a build into solids a printer can be given.
 *
 * <p>This is everything the 3MF and STL writers have in common, which is all of
 * the shape and none of the file. A 3MF keeps the filaments apart and an STL
 * has nowhere to put them, but both print the same solids in the same place, so
 * the two writers differ only in what they wrap around the result.
 *
 * <p>The decisions recorded here were each paid for once; see
 * {@link thicken} and {@link solidsBySlot} for what was tried before.
 */

/** A face thinner than this in millimetres is left out rather than printed. */
export const TOO_THIN = 1e-4;

/** How the build is turned into something solid. */
export type Geometry = "shell" | "solid";

export type Point = readonly [number, number, number];

/** Eight corners in the order {@link CORNERS} gives them. */
export type Solid = readonly Point[];

/** What both writers need to know before they can make a shape at all. */
export interface GeometryOptions {
  /** How large one Minecraft block comes out, in millimetres. */
  readonly millimetresPerBlock: number;
  /** Whether to follow the models or fall back to each block's solid shape. */
  readonly geometry: Geometry;
  /** How thick a shell's walls are, in millimetres. Ignored when solid. */
  readonly wallMillimetres: number;
}

/**
 * A unit box's corners, and its faces wound to face outwards.
 *
 * <p>Written out rather than generated, and each one checked by hand against
 * the cross product of its own edges: a face wound the wrong way points into
 * the solid, and a slicer reads that as a hole rather than a surface.
 *
 * <p>The same table serves a slab of a model's face, by reading the first four
 * corners as that face and the last four as the same face moved along its
 * normal. Every one of the six windings works out the same way, which is why
 * there is one table and not two.
 */
export const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/** Four corners per face, in order around it, outward facing. */
export const FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 3, 2, 1], // down
  [4, 5, 6, 7], // up
  [0, 1, 5, 4], // front
  [3, 7, 6, 2], // back
  [0, 4, 7, 3], // left
  [1, 2, 6, 5], // right
];

/** The corner of the printed build, grown a point at a time. */
export interface Bounds {
  readonly min: number[];
  readonly max: number[];
}

export function newBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function grow(bounds: Bounds, point: Point): void {
  for (let axis = 0; axis < 3; axis++) {
    const value = point[axis] as number;
    bounds.min[axis] = Math.min(bounds.min[axis] as number, value);
    bounds.max[axis] = Math.max(bounds.max[axis] as number, value);
  }
}

/**
 * How large the build came out, in millimetres.
 *
 * <p>Zero on an axis nothing was ever put on, rather than an infinity that
 * would be shown to somebody.
 */
export function spanOf(bounds: Bounds): [number, number, number] {
  return [0, 1, 2].map((axis) => {
    const min = bounds.min[axis] as number;
    const max = bounds.max[axis] as number;
    return Number.isFinite(min) && Number.isFinite(max) ? round(max - min) : 0;
  }) as [number, number, number];
}

/**
 * Sorts everything printable into the filament its block prints in.
 *
 * <p>Minecraft counts height along Y and a printer counts it along Z, so the
 * axes are turned a quarter turn about X on the way: up becomes up, and south
 * becomes the near side of the bed. The turn negates one axis as well, which
 * keeps the coordinates right handed -- swapping two axes on their own would
 * mirror the build and turn every face inside out.
 *
 * <p>The build is also lifted to stand on the bed, because a model half below
 * the plate is the first thing a slicer complains about.
 *
 * <p>Shaped like this: a shell follows the models and falls back to a block's
 * shape only where there is no model to follow -- a chest, a sign. Solid uses
 * the shapes throughout.
 *
 * <p>A caller with nowhere to put filaments, such as the STL writer, passes a
 * slot count of one and an empty assignment, and everything lands in the single
 * group.
 */
export function solidsBySlot(
  model: VoxelModel,
  assignment: Readonly<Record<string, number>>,
  slotCount: number,
  options: GeometryOptions,
): Solid[][] {
  const scale = options.millimetresPerBlock;
  const lift = (model.size.height / 2) * scale;
  const grouped: Solid[][] = Array.from({ length: slotCount }, () => []);

  const place = (x: number, y: number, z: number): Point => [
    round(x * scale),
    round(-z * scale),
    round(y * scale + lift),
  ];
  const slotOf = (paletteIndex: number): number => {
    const id = model.blockIds[paletteIndex] as string;
    return Math.min(Math.max(assignment[id] ?? 0, 0), slotCount - 1);
  };

  // With a shell, only the blocks that have no model of their own keep a box;
  // those are the first stretch of the array, which is how the preview knows
  // them too.
  const boxCount = options.geometry === "shell" ? model.boxes : model.solids;
  for (let i = 0; i < boxCount; i++) {
    const slot = slotOf(model.paletteIndices[i] as number);
    const cx = model.positions[i * 3] as number;
    const cy = model.positions[i * 3 + 1] as number;
    const cz = model.positions[i * 3 + 2] as number;
    const sx = model.scales[i * 3] as number;
    const sy = model.scales[i * 3 + 1] as number;
    const sz = model.scales[i * 3 + 2] as number;

    (grouped[slot] as Solid[]).push(
      CORNERS.map((corner) =>
        place(
          corner[0] === 0 ? cx - sx / 2 : cx + sx / 2,
          corner[1] === 0 ? cy - sy / 2 : cy + sy / 2,
          corner[2] === 0 ? cz - sz / 2 : cz + sz / 2,
        ),
      ),
    );
  }

  if (options.geometry !== "shell") {
    return grouped;
  }

  // Faces are gathered before they are thickened, so that two faces in the same
  // place can be judged against each other. There are three cases, and telling
  // them apart is worth the bookkeeping, because two of them were bugs:
  //
  //   - facing apart and belonging to two different blocks: the wall where one
  //     block presses against another. Nothing can see it, and walling every
  //     one of them is most of the work in a dense build, so both go.
  //   - facing apart and belonging to the SAME block: not a wall at all but a
  //     sheet with no thickness, drawn from both sides. A hanging sign's chains
  //     are four such sheets, and cross shaped plants are two. Dropping both
  //     sides deleted them outright -- measured on a village: the sign kept its
  //     board and bar and lost all eight chain faces, and short grass lost all
  //     seventy two of its faces and vanished. One side stays and gets the
  //     wall, which is what a sheet should print as.
  //   - facing the same way, one is drawn over the other: the green of a grass
  //     block over its earth, snow over a slab. They are one surface, so one
  //     stays -- the later, being the one drawn on top.
  //
  // Treating the third case as the first was worth a bug too: every grass block
  // lost its sides, and the ground of a build came out with slots along its
  // edges.
  //
  // A block is named by where it stands, which is unique: no two blocks share a
  // position, so faces with the same owner came from one model.
  const surface = new Map<
    string,
    { slot: number; corners: Point[]; normal: Point; owner: string }
  >();
  for (const mesh of model.meshes) {
    const slot = slotOf(mesh.paletteIndex);
    const faces = mesh.quads.length / 12;

    for (let block = 0; block < mesh.blocks; block++) {
      const ox = mesh.offsets[block * 3] as number;
      const oy = mesh.offsets[block * 3 + 1] as number;
      const oz = mesh.offsets[block * 3 + 2] as number;
      const owner = `${ox},${oy},${oz}`;

      for (let face = 0; face < faces; face++) {
        const corners: Point[] = [];
        for (let corner = 0; corner < 4; corner++) {
          const at = face * 12 + corner * 3;
          corners.push(
            place(
              ox + (mesh.quads[at] as number),
              oy + (mesh.quads[at + 1] as number),
              oz + (mesh.quads[at + 2] as number),
            ),
          );
        }

        const normal = normalOf(corners);
        if (normal === null) {
          // No area, so nothing to print and nothing to hide.
          continue;
        }

        // Keyed by where the face is rather than how it is wound, so the two
        // sides of a shared wall meet on the same key.
        const key = corners
          .map((point) => point.join(","))
          .sort()
          .join("|");
        const met = surface.get(key);
        if (met !== undefined && met.owner !== owner && facingApart(met.normal, normal)) {
          surface.delete(key);
          continue;
        }
        // Either nothing was here, or what was here is the other side of one
        // sheet, or a surface this one is drawn over. In all three the later
        // face is the one to keep, and a sheet comes out as a single wall.
        surface.set(key, { slot, corners, normal, owner });
      }
    }
  }

  const wall = Math.max(options.wallMillimetres, TOO_THIN);
  for (const { slot, corners, normal } of surface.values()) {
    (grouped[slot] as Solid[]).push(thicken(corners, normal, wall));
  }
  return grouped;
}

/**
 * Which way a face looks, as a unit vector.
 *
 * <p>From the diagonals rather than two edges: they stay meaningful even where
 * one pair of corners has collapsed together, which happens in a model built
 * of triangles written as four cornered faces.
 *
 * <p>Null for a face too degenerate to have a direction. Those carry no area,
 * so nothing is lost by leaving them out, and a slab built on a normal of
 * length zero would be inside out.
 */
export function normalOf(face: readonly Point[]): Point | null {
  const [a, b, c, d] = face as [Point, Point, Point, Point];
  const px = c[0] - a[0];
  const py = c[1] - a[1];
  const pz = c[2] - a[2];
  const qx = d[0] - b[0];
  const qy = d[1] - b[1];
  const qz = d[2] - b[2];

  const nx = py * qz - pz * qy;
  const ny = pz * qx - px * qz;
  const nz = px * qy - py * qx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length < TOO_THIN) {
    return null;
  }
  return [nx / length, ny / length, nz / length];
}

/**
 * Whether two faces in the same place have their backs to each other.
 *
 * <p>That is what tells the wall between two blocks from a surface drawn over
 * another. The threshold is loose because the two are never near each other:
 * facing apart is a dot product of minus one, facing the same way is plus one.
 */
export function facingApart(one: Point, other: Point): boolean {
  return one[0] * other[0] + one[1] * other[1] + one[2] * other[2] < 0;
}

/**
 * Turns a face into a slab of the given thickness.
 *
 * <p>A model's face has no thickness at all -- grass is two crossed sheets, a
 * torch a few rectangles -- and no printer can lay down nothing, so each face is
 * given a wall to be printed out of.
 *
 * <p>The wall goes inwards, behind the face, and the face itself stays exactly
 * where the model put it. Growing it half a wall each way was the first
 * attempt, and it reads as the even handed thing to do, but it pushes every
 * face half a wall proud of the surface it belongs to. Where two faces meet at
 * a block's edge both of them then stand out past the corner, and the whole
 * build grows a small ridge along every edge -- the thing that made it look
 * built out of bricks rather than carved. Kept behind the face, the outside is
 * the model's own surface to the last decimal, and edges come out sharp.
 *
 * @param normal which way the face looks, already worked out by the caller
 */
export function thicken(face: readonly Point[], normal: Point, wall: number): Solid {
  const [a, b, c, d] = face as [Point, Point, Point, Point];
  const ux = normal[0] * wall;
  const uy = normal[1] * wall;
  const uz = normal[2] * wall;

  const behind = (p: Point): Point => [round(p[0] - ux), round(p[1] - uy), round(p[2] - uz)];
  const front = (p: Point): Point => [round(p[0]), round(p[1]), round(p[2])];
  // The first four corners are the face pushed back, the last four the face
  // where it stands, which is exactly what CORNERS means by bottom and top: the
  // last four are the side the normal points to, and that is the outside.
  return [behind(a), behind(b), behind(c), behind(d), front(a), front(b), front(c), front(d)];
}

/**
 * Rounds to a thousandth of a millimetre.
 *
 * <p>Finer than any printer resolves, and it keeps coordinates that should be
 * the same from differing in the last digit.
 */
export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
