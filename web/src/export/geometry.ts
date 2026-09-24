import { nearestOf, toOklab, type Oklab } from "../colour";
import type { VoxelModel } from "../viewer/buildVoxels";
import { plateOf, type PlateOptions, type PlatePart } from "./plate";

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
  /** The slab to stand the build on, where there is one. */
  readonly plate?: PlateOptions;
  /**
   * What colour each filament prints in, for matching a face to the nearest.
   *
   * <p>Without it a block prints in one filament throughout, which is what this
   * did before there was a choice.
   */
  readonly slotColours?: readonly number[];
  /**
   * Whether a face may print in a different filament from the rest of its
   * block.
   *
   * <p>A grass block is green on top and earth down the sides, and printed in
   * one filament it is a lie either way. With this on, each face goes to the
   * filament nearest its own measured colour, and a block whose faces disagree
   * is printed as a body in the commonest of them with the others laid over it
   * a wall thick. The outside is the same shape either way; what changes is how
   * many colours it is in.
   */
  readonly perFace?: boolean;
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
  const plate = options.plate === undefined ? [] : plateOf(model, scale, options.plate);
  // The build stands on the plate, so the plate is what stands on the bed.
  const under = plate.length === 0 ? 0 : -model.size.height / 2 - (plate[0]?.box[1] as number);
  const lift = (model.size.height / 2 + under) * scale;
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

  // A shell gives a box its six sides as walls like everything else, so a block
  // the game draws by hand -- a chest, a statue -- comes out hollow rather than
  // as a lump of plastic in the middle of a hollow build. Solid mode keeps them
  // solid, which is what it is for.
  const shelled: Facet[] = [];
  /** The wall thickness in blocks, for the parts of a model measured that way. */
  const wallInBlocks = Math.max(options.wallMillimetres, TOO_THIN) / scale;
  /**
   * Where each filament sits in Oklab, or null when faces are not matched.
   *
   * <p>Worked out once: a village asks this of tens of thousands of faces.
   */
  const slotPlaces =
    options.perFace === true && options.slotColours !== undefined && options.slotColours.length > 0
      ? options.slotColours.map(toOklab)
      : null;
  /** Solid boxes per filament, joined across shapes once they are all in. */
  const volumes: Point[][][] = Array.from({ length: slotCount }, () => []);
  const boxCount = options.geometry === "shell" ? model.boxes : model.solids;
  for (let i = 0; i < boxCount; i++) {
    const slot = slotOf(model.paletteIndices[i] as number);
    const cx = model.positions[i * 3] as number;
    const cy = model.positions[i * 3 + 1] as number;
    const cz = model.positions[i * 3 + 2] as number;
    const sx = model.scales[i * 3] as number;
    const sy = model.scales[i * 3 + 1] as number;
    const sz = model.scales[i * 3 + 2] as number;

    const box = CORNERS.map((corner) =>
      place(
        corner[0] === 0 ? cx - sx / 2 : cx + sx / 2,
        corner[1] === 0 ? cy - sy / 2 : cy + sy / 2,
        corner[2] === 0 ? cz - sz / 2 : cz + sz / 2,
      ),
    );
    if (options.geometry === "shell") {
      (volumes[slot] as Point[][]).push(box);
    } else {
      (grouped[slot] as Solid[]).push(box);
    }

    if (options.geometry === "shell") {
      // A block the game draws by hand -- a chest, a statue -- has no model to
      // shell, so its box is what there is, and a box is printed solid for the
      // same reason every other box is: walls inside it would be walls nobody
      // sees, and a solid is what infill can go into. Its sides still hide what
      // presses against them and print nothing themselves.
      for (const face of FACES) {
        const corners = face.map((corner) => box[corner] as Point);
        const normal = normalOf(corners);
        if (normal !== null) {
          shelled.push({ slot, corners, normal, owner: `box:${i}`, blocker: true });
        }
      }
    }
  }

  if (options.geometry !== "shell") {
    addPlate(grouped, plate, slotCount, place);
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
  const surface = new Map<string, Facet>();
  // A block whose model is exactly the unit cube has nothing on its surface
  // that a shell would show and a solid box would not. Printed as a box it
  // gives the slicer a volume, which is the only thing that can hold infill: a
  // 1.2 mm wall is thinner than the three perimeters a printer profile asks
  // for, so a shell is filled with perimeters and never with infill. Measured
  // on two builds, 44 % and 22 % of the drawn blocks are such cubes.
  const shapes = shapesPerEntry(model);
  // Worked out once per state and read twice: here, and again below to decide
  // which meshes are left to shell.
  const asShape = new Map<number, Box[] | null>();
  for (const mesh of model.meshes) {
    asShape.set(mesh.paletteIndex, solidShapeOf(mesh.quads, shapes.get(mesh.paletteIndex) ?? []));
  }
  const boxed = new Map<
    string,
    {
      slot: number;
      /** A filament per side where they disagree, or null where they do not. */
      sides: number[] | null;
      shape: Box[];
      cells: Array<[number, number, number]>;
    }
  >();
  for (const mesh of model.meshes) {
    const shape = asShape.get(mesh.paletteIndex) ?? null;
    if (shape === null) {
      continue;
    }
    const slot = slotOf(mesh.paletteIndex);
    const sides = slotPlaces === null ? null : sidesOfMesh(mesh, slotPlaces, slot);
    // Grouped by shape and by what each side wants as well as by filament:
    // blocks of one shape sit on the grid the same way, which is what lets them
    // be merged as whole cells, and two that want different sides cannot be one
    // box however alike their shape.
    const key = `${slot}|${sides?.join(",") ?? ""}|${shape.map((box) => box.join(",")).join(";")}`;
    const group = boxed.get(key) ?? { slot, sides, shape, cells: [] };
    for (let block = 0; block < mesh.blocks; block++) {
      group.cells.push([
        Math.round((mesh.offsets[block * 3] as number) + model.size.width / 2),
        Math.round((mesh.offsets[block * 3 + 1] as number) + model.size.height / 2),
        Math.round((mesh.offsets[block * 3 + 2] as number) + model.size.depth / 2),
      ]);
    }
    boxed.set(key, group);
  }

  for (const { slot, sides, shape, cells } of boxed.values()) {
    // Each box of the shape is joined on its own terms. A stair's lower slab
    // runs the whole width of its cell and joins with the one beside it; its
    // step does not run the whole depth and does not.
    for (const part of shape) {
      // Only an axis a part fills from end to end may be joined along. A dirt
      // path fills its cell across but stops a sixteenth short of the top, and
      // stacking two would close a gap that ought to be there.
      const whole: [boolean, boolean, boolean] = [0, 1, 2].map(
        (axis) =>
          Math.abs(part[axis] as number) < 1e-6 && Math.abs((part[axis + 3] as number) - 1) < 1e-6,
      ) as [boolean, boolean, boolean];

      for (const box of mergeBoxes(cells, whole)) {
        const [x0, y0, z0, x1, y1, z1] = box;
        const low: [number, number, number] = [
          (x0 + (part[0] as number)) - model.size.width / 2,
          (y0 + (part[1] as number)) - model.size.height / 2,
          (z0 + (part[2] as number)) - model.size.depth / 2,
        ];
        const high: [number, number, number] = [
          (x1 - 1 + (part[3] as number)) - model.size.width / 2,
          (y1 - 1 + (part[4] as number)) - model.size.height / 2,
          (z1 - 1 + (part[5] as number)) - model.size.depth / 2,
        ];
        const whole: [number, number, number, number, number, number] = [
          low[0], low[1], low[2], high[0], high[1], high[2],
        ];
        // One body, or a body with the sides that want another filament laid
        // over it a wall thick. Either way the outside is the same box.
        const bodies =
          sides === null
            ? [{ slot, box: whole }]
            : skinned(whole, sides, wallInBlocks);

        for (const body of bodies) {
          const corners = CORNERS.map((corner) =>
            place(
              corner[0] === 0 ? body.box[0] : body.box[3],
              corner[1] === 0 ? body.box[1] : body.box[4],
              corner[2] === 0 ? body.box[2] : body.box[5],
            ),
          );
          (volumes[body.slot] as Point[][]).push(corners);
        }

        // The sides of the whole box still hide what presses against them, but
        // print nothing of their own: they are inside the solid already.
        const outside = CORNERS.map((corner) =>
          place(
            corner[0] === 0 ? whole[0] : whole[3],
            corner[1] === 0 ? whole[1] : whole[4],
            corner[2] === 0 ? whole[2] : whole[5],
          ),
        );
        for (const face of FACES) {
          const side = face.map((corner) => outside[corner] as Point);
          const normal = normalOf(side);
          if (normal !== null) {
            shelled.push({
              slot,
              corners: side,
              normal,
              owner: `box:${part.join(",")}:${box.join(",")}`,
              blocker: true,
            });
          }
        }
      }
    }
  }

  for (const mesh of model.meshes) {
    if (asShape.get(mesh.paletteIndex) != null) {
      // Printed as a box above; its faces would only duplicate the box's sides.
      continue;
    }
    const slot = slotOf(mesh.paletteIndex);
    const faces = mesh.quads.length / 12;
    /** Which filament each face goes to, where faces are matched one by one. */
    const faceSlots =
      slotPlaces === null
        ? null
        : Array.from({ length: faces }, (_, face) =>
            nearestOf(mesh.faceColours[face] ?? 0x9a9a9a, slotPlaces),
          );

    // What the block is not, it may still be made of: the boxes of its own
    // model, printed solid, with only what is left over walled. Worked out once
    // for the state and then placed at every block of it, because the geometry
    // is block-local and identical at each.
    const { boxes: parts, covers } = boxesOfQuads(mesh.quads);
    const solidParts = joinLocalBoxes(parts, wallInBlocks);
    const accounted = (face: number): boolean => {
      const flat = tileOfQuad(mesh.quads, face);
      if (flat === null) {
        return false;
      }
      const under = covers.get(planeKey(flat.axis, flat.sign, flat.at));
      return under !== undefined && area(uncovered(flat.tile, under)) <= SLIVER;
    };
    const consumed: boolean[] = [];
    for (let face = 0; face < faces; face++) {
      consumed.push(solidParts.length > 0 && accounted(face));
    }

    for (let block = 0; block < mesh.blocks; block++) {
      const ox = mesh.offsets[block * 3] as number;
      const oy = mesh.offsets[block * 3 + 1] as number;
      const oz = mesh.offsets[block * 3 + 2] as number;
      const owner = `${ox},${oy},${oz}`;

      for (const part of solidParts) {
        // A part of a model, printed solid: one filament, the block's own. A
        // chest's lid is a lid, not six differently coloured faces.
        const corners = CORNERS.map((corner) =>
          place(
            ox + (corner[0] === 0 ? (part[0] as number) : (part[3] as number)),
            oy + (corner[1] === 0 ? (part[1] as number) : (part[4] as number)),
            oz + (corner[2] === 0 ? (part[2] as number) : (part[5] as number)),
          ),
        );
        (grouped[slot] as Solid[]).push(corners);
        // Its sides still hide what presses against them, but print nothing of
        // their own: they are inside the solid already.
        for (const face of FACES) {
          const side = face.map((corner) => corners[corner] as Point);
          const normal = normalOf(side);
          if (normal !== null) {
            shelled.push({ slot, corners: side, normal, owner, blocker: true });
          }
        }
      }

      for (let face = 0; face < faces; face++) {
        if (consumed[face] === true) {
          continue;
        }
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
        const mine = faceSlots?.[face] ?? slot;

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
        surface.set(key, { slot: mine, corners, normal, owner });
      }
    }
  }

  // Shapes were joined among their own kind; this joins what is left across
  // them. Earth beside a dirt path is two shapes and, on one filament, has no
  // business being two bodies: a slicer walls every body it is given, and the
  // wall between them is inside the ground. Different filaments stay apart --
  // that boundary is the colour, not an accident.
  for (let slot = 0; slot < slotCount; slot++) {
    for (const box of joinSolids(volumes[slot] ?? [])) {
      (grouped[slot] as Solid[]).push(box);
    }
  }

  const wall = Math.max(options.wallMillimetres, TOO_THIN);
  const faces = [...shelled, ...surface.values()];
  for (const { slot, corners, normal } of mergeCoplanar(hideBackToBack(faces))) {
    (grouped[slot] as Solid[]).push(thicken(corners, normal, wall));
  }
  addPlate(grouped, plate, slotCount, place);
  return grouped;
}

/**
 * Puts the plate and its letters in with the rest.
 *
 * <p>Whole boxes rather than faces given walls: a plate is a solid thing, and a
 * letter three quarters of a millimetre proud has nothing to be hollow about.
 */
function addPlate(
  grouped: Solid[][],
  plate: readonly PlatePart[],
  slotCount: number,
  place: (x: number, y: number, z: number) => Point,
): void {
  for (const part of plate) {
    const slot = Math.min(Math.max(part.slot, 0), slotCount - 1);
    const box = part.box;
    (grouped[slot] as Solid[]).push(
      CORNERS.map((corner) =>
        place(
          corner[0] === 0 ? box[0] : box[3],
          corner[1] === 0 ? box[1] : box[4],
          corner[2] === 0 ? box[2] : box[5],
        ),
      ),
    );
  }
}

/** Which of the six sides of a cube a face points at, or null for anything else. */
function sideOf(normal: Point): number | null {
  for (let axis = 0; axis < 3; axis++) {
    const along = normal[axis] as number;
    if (Math.abs(Math.abs(along) - 1) < 1e-6) {
      return axis * 2 + (along > 0 ? 1 : 0);
    }
  }
  return null;
}

/**
 * Which filament each side of a block wants, where they do not all agree.
 *
 * <p>Read off the model's own faces: every face that lies flat against a side
 * of the cube votes with its area for the filament nearest its colour, and the
 * side takes the winner. A face that is not flat against any side -- a stair's
 * step, a torch's tilt -- has no vote, because it is not what anybody sees
 * when they look at that side.
 *
 * @return six filaments, one per side in the order of {@link FACES}, or null
 *         when every side wants the same one and there is nothing to do
 */
function sidesOfMesh(
  mesh: VoxelModel["meshes"][number],
  slots: readonly Oklab[],
  fallback: number,
): number[] | null {
  const votes = Array.from({ length: 6 }, () => new Map<number, number>());
  const faces = mesh.quads.length / 12;

  for (let face = 0; face < faces; face++) {
    const corners: Point[] = [];
    for (let corner = 0; corner < 4; corner++) {
      const at = face * 12 + corner * 3;
      corners.push([
        mesh.quads[at] as number,
        mesh.quads[at + 1] as number,
        mesh.quads[at + 2] as number,
      ]);
    }
    const normal = normalOf(corners);
    if (normal === null) {
      continue;
    }
    const side = sideOf(normal);
    if (side === null) {
      continue;
    }
    // Only a face actually on the cube's surface speaks for that surface: the
    // top of a stair's lower slab points up, but it is inside the block.
    const axis = side >> 1;
    const at = corners[0]?.[axis] ?? 0;
    if (Math.abs(at - (side % 2 === 1 ? 1 : 0)) > 1e-6) {
      continue;
    }

    const [u, v] = others(axis);
    const us = corners.map((corner) => corner[u] as number);
    const vs = corners.map((corner) => corner[v] as number);
    const area =
      (Math.max(...us) - Math.min(...us)) * (Math.max(...vs) - Math.min(...vs));
    if (area <= 0) {
      continue;
    }
    const slot = nearestOf(mesh.faceColours[face] ?? 0x9a9a9a, slots);
    const tally = votes[side] as Map<number, number>;
    tally.set(slot, (tally.get(slot) ?? 0) + area);
  }

  const sides = votes.map((tally) => {
    let best = fallback;
    let most = 0;
    for (const [slot, area] of tally) {
      if (area > most) {
        most = area;
        best = slot;
      }
    }
    return best;
  });
  return sides.every((slot) => slot === sides[0]) ? null : sides;
}

/**
 * A box in the commonest of its sides' filaments, with the others laid over it.
 *
 * <p>The body is pulled in by a wall wherever a side wants a different filament,
 * and that side gets a slab of exactly that thickness laid on it. So the outside
 * is where it always was, to the last decimal, and the colour of it is the
 * colour the model had there.
 *
 * <p>Not overlapped, pulled in: two bodies of different filaments sharing the
 * same space is a question with no answer, and a slicer will pick one of them
 * without saying which.
 */
function skinned(
  box: readonly [number, number, number, number, number, number],
  sides: readonly number[],
  wall: number,
): Array<{ slot: number; box: [number, number, number, number, number, number] }> {
  // The commonest side wins the body, so the fewest slabs are needed.
  const tally = new Map<number, number>();
  for (const slot of sides) {
    tally.set(slot, (tally.get(slot) ?? 0) + 1);
  }
  let body = sides[0] as number;
  let most = 0;
  for (const [slot, count] of tally) {
    if (count > most) {
      most = count;
      body = slot;
    }
  }

  const inner = [...box] as [number, number, number, number, number, number];
  const parts: Array<{ slot: number; box: [number, number, number, number, number, number] }> = [];

  for (let side = 0; side < 6; side++) {
    if (sides[side] === body) {
      continue;
    }
    const axis = side >> 1;
    const far = side % 2 === 1;
    const thick = Math.min(wall, ((box[axis + 3] as number) - (box[axis] as number)) / 2);
    const skin = [...box] as [number, number, number, number, number, number];
    if (far) {
      skin[axis] = (box[axis + 3] as number) - thick;
      inner[axis + 3] = Math.min(inner[axis + 3] as number, skin[axis] as number);
    } else {
      skin[axis + 3] = (box[axis] as number) + thick;
      inner[axis] = Math.max(inner[axis] as number, skin[axis + 3] as number);
    }
    parts.push({ slot: sides[side] as number, box: skin });
  }

  // A body pulled in to nothing is a box made entirely of its own skin.
  if (
    (inner[3] as number) - (inner[0] as number) > SLIVER &&
    (inner[4] as number) - (inner[1] as number) > SLIVER &&
    (inner[5] as number) - (inner[2] as number) > SLIVER
  ) {
    parts.push({ slot: body, box: inner });
  }
  return parts;
}

/** A face on its way to becoming a wall. */
interface Facet {
  slot: number;
  corners: Point[];
  normal: Point;
  /** Where the block it came from stands, or "" once faces have been joined. */
  owner: string;
  /**
   * Set on a face that only hides others and is never printed itself.
   *
   * <p>The sides of a block that is printed as a solid: what presses against
   * them is still hidden, but the face itself is inside the solid already.
   */
  blocker?: boolean;
}

/**
 * Area below which a leftover is not a gap.
 *
 * <p>A block's face is a sixteenth of a block at the smallest, which at any
 * printable size is far above this. What lands under it is the last bit of a
 * float, not a hole.
 */
const SLIVER = 1e-6;

/** A block's box in its own cell: x0, y0, z0, x1, y1, z1, each 0 to 1. */
export type Box = [number, number, number, number, number, number];

/** An axis aligned rectangle, in the plane it lies in. */
interface Tile {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** A tile that still knows where it came from and which way it looks. */
interface Placed extends Tile {
  axis: number;
  at: number;
  sign: number;
  slot: number;
  owner: string;
  blocker: boolean;
}

/**
 * Takes away the parts of a face that another face is pressed against.
 *
 * <p>The rule further up drops two faces only when they cover each other
 * exactly. That is most of them, but a floor is full of blocks whose sides do
 * not match: a dirt path is fifteen sixteenths tall, so the earth beside it
 * meets it with a taller face than its own, and neither is an exact match for
 * the other. Both were kept, and both were printed -- inside the floor, where
 * the slicer then drew a perimeter around each. Measured on a village: a
 * quarter of all the surface that survived was pressed against another face,
 * seven hundred and twenty five faces of it hidden completely.
 *
 * <p>So the overlap is subtracted rather than the whole face dropped. What is
 * left of each face is cut along every edge its blockers bring, and the cells
 * that nothing covers are kept; {@link mergeCoplanar} then joins them back into
 * as few rectangles as it can.
 *
 * <p>Faces of one block never hide each other, which is what keeps a sheet with
 * no thickness -- a chain, a blade of grass -- from cancelling itself out.
 */
function hideBackToBack(faces: readonly Facet[]): Facet[] {
  const kept: Facet[] = [];
  const planes = new Map<string, Placed[]>();

  for (const face of faces) {
    const flat = asTile(face);
    if (flat === null) {
      // Not a rectangle in a plane: a tilted face has nothing to be pressed
      // against squarely, so it is left alone.
      if (face.blocker !== true) {
        kept.push(face);
      }
      continue;
    }
    const placed: Placed = {
      ...flat.tile,
      axis: flat.axis,
      at: flat.at,
      sign: flat.sign,
      slot: face.slot,
      owner: face.owner,
      blocker: face.blocker === true,
    };
    const key = `${flat.axis}|${flat.at}`;
    const plane = planes.get(key);
    if (plane === undefined) {
      planes.set(key, [placed]);
    } else {
      plane.push(placed);
    }
  }

  for (const plane of planes.values()) {
    for (const tile of plane) {
      const blockers = plane.filter(
        (other) =>
          other.sign !== tile.sign &&
          other.owner !== tile.owner &&
          other.u0 < tile.u1 &&
          other.u1 > tile.u0 &&
          other.v0 < tile.v1 &&
          other.v1 > tile.v0,
      );
      if (tile.blocker) {
        // It hid what it had to; it is inside a solid and prints nothing.
        continue;
      }
      for (const piece of uncovered(tile, blockers)) {
        kept.push(facetOf(tile.axis, tile.sign, tile.at, tile.slot, piece));
      }
    }
  }
  return kept;
}

/**
 * What is left of a rectangle once the blockers are taken out of it.
 *
 * <p>Cut along every edge the blockers bring and keep the cells none of them
 * covers. That leaves more pieces than necessary -- a rectangle with a bite out
 * of one corner comes back as several -- and joining them again is exactly what
 * the merge afterwards is for.
 */
function uncovered(tile: Tile, blockers: readonly Tile[]): Tile[] {
  if (blockers.length === 0) {
    return [{ u0: tile.u0, v0: tile.v0, u1: tile.u1, v1: tile.v1 }];
  }

  const us = cuts(tile.u0, tile.u1, blockers.flatMap((b) => [b.u0, b.u1]));
  const vs = cuts(tile.v0, tile.v1, blockers.flatMap((b) => [b.v0, b.v1]));

  const pieces: Tile[] = [];
  for (let i = 0; i + 1 < us.length; i++) {
    for (let j = 0; j + 1 < vs.length; j++) {
      const u0 = us[i] as number;
      const u1 = us[i + 1] as number;
      const v0 = vs[j] as number;
      const v1 = vs[j + 1] as number;
      const midU = (u0 + u1) / 2;
      const midV = (v0 + v1) / 2;
      const covered = blockers.some(
        (b) => b.u0 <= midU && midU <= b.u1 && b.v0 <= midV && midV <= b.v1,
      );
      if (!covered) {
        pieces.push({ u0, v0, u1, v1 });
      }
    }
  }
  return pieces;
}

/** The cut lines across one side, the ends included and duplicates gone. */
function cuts(from: number, to: number, inside: readonly number[]): number[] {
  const all = new Set<number>([from, to]);
  for (const value of inside) {
    if (value > from && value < to) {
      all.add(value);
    }
  }
  return [...all].sort((a, b) => a - b);
}

/**
 * Joins faces that lie flat against each other into single larger ones.
 *
 * <p>Without this a floor is a hundred separate slabs that touch along their
 * edges, and a slicer draws a perimeter around every one of them: the print
 * comes out as a grid of walled cells with infill in each, wasting plastic and
 * time on walls buried inside a solid surface. The note this file used to carry
 * -- that a slicer unions overlapping solids, so the walls between them cost
 * only file size -- is true of solids that overlap and false of solids that
 * merely touch, which is what a wall of blocks is.
 *
 * <p>Only exact merges are made: same filament, same plane, same way up, and
 * the two rectangles must share a whole edge so their union is a rectangle
 * again. The printed surface is therefore identical to the last decimal; what
 * changes is how many pieces it is made of.
 *
 * <p>Anything that is not an axis aligned rectangle -- a torch's tilted
 * rectangles, a chain turned forty-five degrees -- is passed through untouched.
 * Those are the minority, and merging them would mean general polygon union for
 * very little gain.
 */
function mergeCoplanar(faces: readonly Facet[]): Facet[] {
  /** Rectangles waiting to be merged, gathered by the plane they sit in. */
  const planes = new Map<string, { axis: number; sign: number; at: number; slot: number; tiles: Tile[] }>();
  const passed: Facet[] = [];

  for (const face of faces) {
    const flat = asTile(face);
    if (flat === null) {
      passed.push(face);
      continue;
    }
    const { axis, sign, at, tile } = flat;
    const key = `${face.slot}|${axis}|${sign}|${at}`;
    const plane = planes.get(key);
    if (plane === undefined) {
      planes.set(key, { axis, sign, at, slot: face.slot, tiles: [tile] });
    } else {
      plane.tiles.push(tile);
    }
  }

  const merged: Facet[] = [...passed];
  for (const plane of planes.values()) {
    for (const tile of joinTiles(plane.tiles)) {
      merged.push(facetOf(plane.axis, plane.sign, plane.at, plane.slot, tile));
    }
  }
  return merged;
}

/**
 * Reads a face as a rectangle in an axis aligned plane, or null.
 *
 * <p>A face qualifies when all four corners share one coordinate -- that is the
 * plane -- and the other two take exactly two values each, which makes the
 * outline a rectangle rather than a slanted or degenerate quad.
 */
function asTile(
  face: Facet,
): { axis: number; sign: number; at: number; tile: Tile } | null {
  for (let axis = 0; axis < 3; axis++) {
    const at = face.corners[0]?.[axis];
    if (at === undefined || !face.corners.every((corner) => corner[axis] === at)) {
      continue;
    }
    // The face lies in this plane; the normal has to point along it too, or the
    // quad is wound in a way this cannot reproduce.
    const along = face.normal[axis] as number;
    if (Math.abs(Math.abs(along) - 1) > 1e-6) {
      return null;
    }

    const [u, v] = others(axis);
    const us = [...new Set(face.corners.map((corner) => corner[u] as number))].sort((a, b) => a - b);
    const vs = [...new Set(face.corners.map((corner) => corner[v] as number))].sort((a, b) => a - b);
    if (us.length !== 2 || vs.length !== 2) {
      return null;
    }
    return {
      axis,
      sign: along > 0 ? 1 : -1,
      at,
      tile: { u0: us[0] as number, v0: vs[0] as number, u1: us[1] as number, v1: vs[1] as number },
    };
  }
  return null;
}

/** The two axes that are not this one, in ascending order. */
function others(axis: number): [number, number] {
  return axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
}

/**
 * Greedily joins rectangles that share a whole edge.
 *
 * <p>Two passes repeated until nothing more joins: side by side along u, then
 * stacked along v. Only whole edges, so the union is always a rectangle and the
 * covered area never changes -- which is what keeps the surface identical.
 */
function joinTiles(tiles: readonly Tile[]): Tile[] {
  let current = [...tiles];

  for (let pass = 0; pass < 64; pass++) {
    const before = current.length;
    current = joinAlong(current, true);
    current = joinAlong(current, false);
    if (current.length === before) {
      break;
    }
  }
  return current;
}

/**
 * One joining pass.
 *
 * @param alongU whether to join neighbours side by side rather than stacked
 */
function joinAlong(tiles: readonly Tile[], alongU: boolean): Tile[] {
  // Rectangles can only join when the edge they would share is the whole of
  // both their sides, so they are grouped by that side first.
  const rows = new Map<string, Tile[]>();
  for (const tile of tiles) {
    const key = alongU ? `${tile.v0}|${tile.v1}` : `${tile.u0}|${tile.u1}`;
    const row = rows.get(key);
    if (row === undefined) {
      rows.set(key, [tile]);
    } else {
      row.push(tile);
    }
  }

  const joined: Tile[] = [];
  for (const row of rows.values()) {
    row.sort((a, b) => (alongU ? a.u0 - b.u0 : a.v0 - b.v0));
    let open: Tile | null = null;
    for (const tile of row) {
      if (open === null) {
        open = { ...tile };
        continue;
      }
      const touches = alongU ? open.u1 === tile.u0 : open.v1 === tile.v0;
      if (touches) {
        if (alongU) {
          open.u1 = tile.u1;
        } else {
          open.v1 = tile.v1;
        }
      } else {
        joined.push(open);
        open = { ...tile };
      }
    }
    if (open !== null) {
      joined.push(open);
    }
  }
  return joined;
}

/**
 * Turns a rectangle back into a face wound the way its normal asks for.
 *
 * <p>The winding is checked rather than worked out: the corner order that faces
 * one way for a plane of X is the reverse for a plane of Y, and reasoning about
 * which is which per axis is exactly the kind of thing that comes out inside
 * out. Building one order and turning it round when it disagrees cannot.
 */
function facetOf(axis: number, sign: number, at: number, slot: number, tile: Tile): Facet {
  const [u, v] = others(axis);
  const corner = (cu: number, cv: number): Point => {
    const point = [0, 0, 0];
    point[axis] = at;
    point[u] = cu;
    point[v] = cv;
    return point as unknown as Point;
  };

  let corners = [
    corner(tile.u0, tile.v0),
    corner(tile.u1, tile.v0),
    corner(tile.u1, tile.v1),
    corner(tile.u0, tile.v1),
  ];
  const normal: Point = [0, 0, 0].map((_, i) => (i === axis ? sign : 0)) as unknown as Point;
  const made = normalOf(corners);
  if (made === null || (made[axis] as number) * sign < 0) {
    corners = [...corners].reverse();
  }
  return { slot, corners, normal, owner: "" };
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

/**
 * Whether a model's faces are exactly the surface of the unit cube.
 *
 * <p>Every corner has to sit on the cube, every face has to lie in one of its
 * six sides, and each side has to be covered exactly once. A block that passes
 * looks the same printed solid as printed as a shell, which is what makes the
 * swap safe; anything else -- a stair, a slab, a torch -- does not and keeps
 * its shell.
 */
export function solidShapeOf(quads: Float32Array, shape: readonly Box[]): Box[] | null {
  if (quads.length === 0 || shape.length === 0) {
    return null;
  }
  for (const box of shape) {
    for (let axis = 0; axis < 3; axis++) {
      if ((box[axis + 3] as number) - (box[axis] as number) < 1e-3) {
        // A shape with no thickness is not something to print solid.
        return null;
      }
    }
  }

  // What the shape shows to the outside: each side of each box, less the parts
  // another box of the same shape is pressed against.
  const outside = new Map<string, Tile[]>();
  for (const box of shape) {
    for (let axis = 0; axis < 3; axis++) {
      const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
      for (const far of [false, true]) {
        const at = far ? (box[axis + 3] as number) : (box[axis] as number);
        const side: Tile = {
          u0: box[u] as number,
          v0: box[v] as number,
          u1: box[u + 3] as number,
          v1: box[v + 3] as number,
        };
        const behind = shape.filter((other) => {
          if (other === box) {
            return false;
          }
          const lo = other[axis] as number;
          const hi = other[axis + 3] as number;
          const touches = far ? lo <= at + 1e-6 && hi > at + 1e-6 : hi >= at - 1e-6 && lo < at - 1e-6;
          return (
            touches &&
            (other[u] as number) < side.u1 - 1e-6 &&
            (other[u + 3] as number) > side.u0 + 1e-6 &&
            (other[v] as number) < side.v1 - 1e-6 &&
            (other[v + 3] as number) > side.v0 + 1e-6
          );
        });
        const blockers = behind.map((other) => ({
          u0: other[u] as number,
          v0: other[v] as number,
          u1: other[u + 3] as number,
          v1: other[v + 3] as number,
        }));
        const key = `${axis}|${round(at)}`;
        const known = outside.get(key) ?? [];
        known.push(...uncovered(side, blockers));
        outside.set(key, known);
      }
    }
  }

  // What the model draws, in the same terms.
  const drawn = new Map<string, { axis: number; at: number; tiles: Tile[] }>();
  for (let face = 0; face < quads.length / 12; face++) {
    const at = face * 12;
    let placed = false;
    for (let axis = 0; axis < 3 && !placed; axis++) {
      const first = quads[at + axis] as number;
      let flat = true;
      for (let corner = 1; corner < 4; corner++) {
        if (Math.abs((quads[at + corner * 3 + axis] as number) - first) > 1e-6) {
          flat = false;
          break;
        }
      }
      if (!flat) {
        continue;
      }
      const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
      const us: number[] = [];
      const vs: number[] = [];
      for (let corner = 0; corner < 4; corner++) {
        us.push(quads[at + corner * 3 + u] as number);
        vs.push(quads[at + corner * 3 + v] as number);
      }
      const key = `${axis}|${round(first)}`;
      const known = drawn.get(key) ?? { axis, at: first, tiles: [] };
      known.tiles.push({
        u0: Math.min(...us),
        v0: Math.min(...vs),
        u1: Math.max(...us),
        v1: Math.max(...vs),
      });
      drawn.set(key, known);
      placed = true;
    }
    if (!placed) {
      // A tilted face: the model is not the surface of its boxes.
      return null;
    }
  }

  // Two conditions, and which way round they go matters. Neither is about the
  // faces lining up with the sides of the boxes, which was the first attempt
  // and was wrong in both directions.
  //
  //   - nothing the model draws may lie outside the boxes, or printing the
  //     boxes would not be printing this model;
  //   - everything the shape shows has to be drawn, or the model is smaller
  //     than the boxes and printing them would make it bigger than it looks.
  //
  // A face inside the boxes breaks neither and is no reason to refuse. There
  // are a great many of them, because Minecraft culls a face against a
  // neighbouring block and never against another part of the same model: a
  // stair draws the whole top of its lower slab even though its step stands on
  // half of it. Demanding that every drawn face sit on a side of a box turned
  // every upside down stair into a shell -- its slab is the full height of the
  // block, so the face where its step begins is inside the solid and on the
  // side of nothing. Measured on a village: thirteen of them.
  //
  // The second condition is what keeps this honest. A cauldron's shape is the
  // whole cube and its model is a basin; the basin's walls are all inside the
  // cube, so the first condition passes, and the second refuses it because the
  // cube's top is drawn only as a rim.
  for (const { axis, at, tiles } of drawn.values()) {
    const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    // Every box the plane passes through, including the ones it only touches:
    // a face on a box's side and a face buried in its middle are both inside.
    const inside = shape
      .filter((box) => (box[axis] as number) - 1e-6 <= at && at <= (box[axis + 3] as number) + 1e-6)
      .map((box) => ({
        u0: box[u] as number,
        v0: box[v] as number,
        u1: box[u + 3] as number,
        v1: box[v + 3] as number,
      }));
    for (const tile of tiles) {
      if (area(uncovered(tile, inside)) > SLIVER) {
        return null;
      }
    }
  }
  for (const [key, tiles] of outside) {
    const shown = drawn.get(key)?.tiles ?? [];
    for (const tile of tiles) {
      if (area(uncovered(tile, shown)) > SLIVER) {
        return null;
      }
    }
  }
  return shape.map((box) => [...box] as Box);
}

/**
 * The closed boxes a model is built out of, in block-local coordinates.
 *
 * <p>{@link solidShapeOf} asks whether a whole block is its shape, which is the
 * best case and the common one. This is for everything else: a chest is a base
 * and a lid, a fence is a post and two arms, a door is one slab. Each of those
 * is a closed box the game drew six sides of, and printing it as a box rather
 * than as six walls is the difference between a lump the slicer can fill and a
 * hollow shell it cannot. Measured on a village before this existed: a chest
 * printed as a 1.2 mm shell with nothing inside it, which is what the ask "the
 * chest is still hollow inside" was about.
 *
 * <p>Faces arrive cut into patches, because a face follows its texture -- a
 * stair's side comes over as a dozen strips. So the patches are joined back
 * into whole rectangles first, per plane and per direction, and the boxes are
 * looked for among those. Joining before looking also catches two elements that
 * sit side by side: their shared faces cancel into one rectangle and the pair
 * is found as the single box it is.
 *
 * <p>Nothing is guessed. A box is only taken when all six of its sides are
 * there as whole rectangles facing outwards, which is what a Minecraft element
 * always is and what a sheet, a tilted face or a rotated element never is.
 * Those keep their walls exactly as before.
 *
 * @return the boxes, and the rectangles their sides cover so the caller can
 *         tell which faces they have already accounted for
 */
export function boxesOfQuads(quads: Float32Array): {
  boxes: Box[];
  covers: Map<string, Tile[]>;
} {
  const planes = new Map<string, { axis: number; sign: number; at: number; tiles: Tile[] }>();

  for (let face = 0; face < quads.length / 12; face++) {
    const flat = tileOfQuad(quads, face);
    if (flat === null) {
      continue;
    }
    const key = planeKey(flat.axis, flat.sign, flat.at);
    const plane = planes.get(key);
    if (plane === undefined) {
      planes.set(key, { axis: flat.axis, sign: flat.sign, at: flat.at, tiles: [flat.tile] });
    } else {
      plane.tiles.push(flat.tile);
    }
  }

  /** Whole rectangles per plane, and which of them are still free. */
  const whole = new Map<string, { axis: number; sign: number; at: number; tiles: Tile[] }>();
  for (const [key, plane] of planes) {
    whole.set(key, { ...plane, tiles: joinTiles(plane.tiles) });
  }

  const taken = new Set<string>();
  const nameOf = (key: string, tile: Tile): string => `${key}|${tile.u0},${tile.v0},${tile.u1},${tile.v1}`;
  const find = (axis: number, sign: number, at: number, tile: Tile): Tile | null => {
    const plane = whole.get(planeKey(axis, sign, at));
    if (plane === undefined) {
      return null;
    }
    const match = plane.tiles.find(
      (other) =>
        other.u0 === tile.u0 && other.v0 === tile.v0 && other.u1 === tile.u1 && other.v1 === tile.v1,
    );
    if (match === undefined || taken.has(nameOf(planeKey(axis, sign, at), match))) {
      return null;
    }
    return match;
  };

  // Every height a lid could be at, so the nearest one is tried first: two
  // boxes standing on the same footprint would otherwise be read as one tall
  // box with the lower lid buried in it.
  const lids = [...whole.values()]
    .filter((plane) => plane.axis === 1 && plane.sign === 1)
    .map((plane) => plane.at)
    .sort((a, b) => a - b);

  const boxes: Box[] = [];
  const covers = new Map<string, Tile[]>();
  const cover = (axis: number, sign: number, at: number, tile: Tile): void => {
    const key = planeKey(axis, sign, at);
    taken.add(nameOf(key, tile));
    const known = covers.get(key);
    if (known === undefined) {
      covers.set(key, [tile]);
    } else {
      known.push(tile);
    }
  };

  for (const plane of whole.values()) {
    if (plane.axis !== 1 || plane.sign !== -1) {
      continue;
    }
    for (const floor of plane.tiles) {
      if (taken.has(nameOf(planeKey(1, -1, plane.at), floor))) {
        continue;
      }
      const x0 = floor.u0;
      const z0 = floor.v0;
      const x1 = floor.u1;
      const z1 = floor.v1;
      const y0 = plane.at;

      for (const y1 of lids) {
        if (y1 <= y0) {
          continue;
        }
        const sides: Array<[number, number, number, Tile]> = [
          [1, 1, y1, { u0: x0, v0: z0, u1: x1, v1: z1 }],
          [0, -1, x0, { u0: y0, v0: z0, u1: y1, v1: z1 }],
          [0, 1, x1, { u0: y0, v0: z0, u1: y1, v1: z1 }],
          [2, -1, z0, { u0: x0, v0: y0, u1: x1, v1: y1 }],
          [2, 1, z1, { u0: x0, v0: y0, u1: x1, v1: y1 }],
        ];
        const found = sides.map(([axis, sign, at, tile]) => find(axis, sign, at, tile));
        if (found.some((tile) => tile === null)) {
          continue;
        }
        boxes.push([x0, y0, z0, x1, y1, z1]);
        cover(1, -1, y0, floor);
        sides.forEach(([axis, sign, at], i) => cover(axis, sign, at, found[i] as Tile));
        break;
      }
    }
  }
  return { boxes, covers };
}

function planeKey(axis: number, sign: number, at: number): string {
  return `${axis}|${sign}|${at}`;
}

/**
 * Reads one quad of a model as a rectangle in an axis aligned plane, or null.
 *
 * <p>The same question {@link asTile} answers for a face that has already been
 * placed in the build, asked of the raw block-local numbers instead.
 */
function tileOfQuad(
  quads: Float32Array,
  face: number,
): { axis: number; sign: number; at: number; tile: Tile } | null {
  const start = face * 12;
  const corners: Point[] = [];
  for (let corner = 0; corner < 4; corner++) {
    corners.push([
      quads[start + corner * 3] as number,
      quads[start + corner * 3 + 1] as number,
      quads[start + corner * 3 + 2] as number,
    ]);
  }
  const normal = normalOf(corners);
  if (normal === null) {
    return null;
  }
  return asTile({ slot: 0, corners, normal, owner: "" });
}

/**
 * The solid shape of each palette entry, in block-local coordinates.
 *
 * <p>The export carries a block's shape as boxes, and the preview keeps them
 * past the ones it draws. Recovering them here means the printable side can ask
 * "is this model just its shape?" without the shapes being passed down again.
 */
export function shapesPerEntry(model: VoxelModel): Map<number, Box[]> {
  const shapes = new Map<number, Box[]>();
  const { width, depth } = model.size;

  for (let i = model.boxes; i < model.solids; i++) {
    const entry = model.paletteIndices[i] as number;
    const block = model.solidBlocks[i] as number;
    const x = block % width;
    const y = Math.floor(block / (width * depth));
    const z = Math.floor(block / width) % depth;

    const cx = model.positions[i * 3] as number;
    const cy = model.positions[i * 3 + 1] as number;
    const cz = model.positions[i * 3 + 2] as number;
    const sx = model.scales[i * 3] as number;
    const sy = model.scales[i * 3 + 1] as number;
    const sz = model.scales[i * 3 + 2] as number;

    // Not rounded: these are the same dyadic numbers the model's corners are,
    // and rounding a sixteenth to a thousandth makes the box a whisker larger
    // than the faces meant to describe it, which then fail to cover it.
    const local: Box = [
      cx - sx / 2 - (x - width / 2),
      cy - sy / 2 - (y - model.size.height / 2),
      cz - sz / 2 - (z - depth / 2),
      cx + sx / 2 - (x - width / 2),
      cy + sy / 2 - (y - model.size.height / 2),
      cz + sz / 2 - (z - depth / 2),
    ];
    const known = shapes.get(entry);
    if (known === undefined) {
      shapes.set(entry, [local]);
    } else if (!known.some((box) => box.every((value, k) => Math.abs(value - (local[k] as number)) < 1e-6))) {
      known.push(local);
    }
  }
  return shapes;
}

/**
 * Joins unit cubes into as few boxes as it can.
 *
 * <p>Greedy in three passes: a run along x, then as many whole runs stacked
 * along z as match it, then as many whole slabs along y. The same reason as for
 * flat faces -- boxes that only touch are two bodies to a slicer, and it draws
 * a perimeter around each.
 *
 * @param cells block positions on the selection's own grid
 * @param whole which axes the shape fills from end to end, and so may be joined
 *              along; a slab joined upwards would fill the air above it
 * @return boxes as x0, y0, z0, x1, y1, z1 in the same grid
 */
function mergeBoxes(
  cells: ReadonlyArray<readonly [number, number, number]>,
  whole: readonly [boolean, boolean, boolean],
): Array<[number, number, number, number, number, number]> {
  const left = new Set(cells.map((cell) => cell.join(",")));
  const has = (x: number, y: number, z: number): boolean => left.has(`${x},${y},${z}`);
  const boxes: Array<[number, number, number, number, number, number]> = [];

  // Sorted so the greedy walk starts at a corner and grows away from it, which
  // is what keeps the boxes long rather than scattered.
  const order = [...cells].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);

  for (const [x, y, z] of order) {
    if (!has(x, y, z)) {
      continue;
    }

    let width = 1;
    while (whole[0] && has(x + width, y, z)) {
      width++;
    }

    let depth = 1;
    grow: while (whole[2]) {
      for (let i = 0; i < width; i++) {
        if (!has(x + i, y, z + depth)) {
          break grow;
        }
      }
      depth++;
    }

    let height = 1;
    stack: while (whole[1]) {
      for (let i = 0; i < width; i++) {
        for (let j = 0; j < depth; j++) {
          if (!has(x + i, y + height, z + j)) {
            break stack;
          }
        }
      }
      height++;
    }

    for (let i = 0; i < width; i++) {
      for (let j = 0; j < depth; j++) {
        for (let k = 0; k < height; k++) {
          left.delete(`${x + i},${y + k},${z + j}`);
        }
      }
    }
    boxes.push([x, y, z, x + width, y + height, z + depth]);
  }
  return boxes;
}

/**
 * Joins the boxes of one model where they overlap or touch.
 *
 * <p>A chest's base and lid overlap by a sixteenth, a fence's arms run into its
 * post. Left as they are, the slicer sees several bodies and draws a perimeter
 * around each where they meet -- walls inside a solid, which is the thing this
 * whole file is trying to be rid of. Worked out once per block state, in the
 * block's own coordinates, and then placed at every block of it.
 *
 * <p>A box thinner than a wall is grown to a wall first. The wall setting is
 * the thinnest thing the printer is being asked to make, and it applied to
 * these boxes before they were boxes: a sign's board is a sixteenth and a bit
 * thick, and the two walls its faces used to become each reached a full wall
 * inwards, met in the middle and came out the other side. That made the board
 * nearly twice as thick as it is. Growing to exactly one wall keeps the
 * promise and drops the overshoot.
 *
 * @param thinnest the wall thickness, in blocks
 */
function joinLocalBoxes(boxes: readonly Box[], thinnest: number): Box[] {
  const grown = boxes.map((box) => {
    const out = [...box] as Box;
    for (let axis = 0; axis < 3; axis++) {
      const short = thinnest - ((box[axis + 3] as number) - (box[axis] as number));
      if (short > 0) {
        out[axis] = (box[axis] as number) - short / 2;
        out[axis + 3] = (box[axis + 3] as number) + short / 2;
      }
    }
    return out;
  });

  if (grown.length < 2) {
    return grown;
  }

  const joined = joinSolids(
    grown.map((box) =>
      CORNERS.map(
        (corner) =>
          [
            corner[0] === 0 ? box[0] : box[3],
            corner[1] === 0 ? box[1] : box[4],
            corner[2] === 0 ? box[2] : box[5],
          ] as unknown as Point,
      ),
    ),
  );

  return joined.map((solid) => {
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (const corner of solid) {
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis] as number, corner[axis] as number);
        high[axis] = Math.max(high[axis] as number, corner[axis] as number);
      }
    }
    return [low[0], low[1], low[2], high[0], high[1], high[2]] as Box;
  });
}

/** How much a heap of rectangles adds up to, overlaps counted twice. */
function area(tiles: readonly Tile[]): number {
  let total = 0;
  for (const tile of tiles) {
    total += (tile.u1 - tile.u0) * (tile.v1 - tile.v0);
  }
  return total;
}

/**
 * Joins axis aligned solids of one filament into as few boxes as it can.
 *
 * <p>The shape by shape join cannot see across kinds: earth is a cube and a
 * dirt path is a cube a sixteenth short, so the two never met even standing
 * side by side on the same filament. This one works on the finished boxes, so
 * it does not care what they came from.
 *
 * <p>The corners of every box are taken as the cut lines of a grid, which makes
 * the boxes whole cells of it; the cells anything covers are then joined back
 * greedily. The union is preserved exactly -- a cell is covered or it is not --
 * so the printed shape cannot change. Where two boxes overlapped, the overlap
 * is now counted once, which is what it always was.
 */
function joinSolids(boxes: readonly Point[][]): Point[][] {
  if (boxes.length < 2) {
    return [...boxes];
  }

  const spans = boxes.map((box) => {
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (const corner of box) {
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis] as number, corner[axis] as number);
        high[axis] = Math.max(high[axis] as number, corner[axis] as number);
      }
    }
    return { low, high };
  });

  const lines = [0, 1, 2].map((axis) =>
    [...new Set(spans.flatMap((span) => [span.low[axis] as number, span.high[axis] as number]))].sort(
      (a, b) => a - b,
    ),
  );
  const counts = lines.map((line) => Math.max(line.length - 1, 0));
  // A build with very many different edges would make a grid too large to be
  // worth walking; those keep the boxes they have.
  const [cx, cy, cz] = counts as [number, number, number];
  if (cx === 0 || cy === 0 || cz === 0 || cx * cy * cz > 4_000_000) {
    return [...boxes];
  }

  const [nx, ny, nz] = [cx, cy, cz];
  const filled = new Uint8Array(nx * ny * nz);
  const cell = (x: number, y: number, z: number): number => (x * ny + y) * nz + z;
  const from = (axis: number, value: number): number => {
    const line = lines[axis] as number[];
    let i = 0;
    while (i + 1 < line.length && (line[i + 1] as number) <= value + 1e-9) {
      i++;
    }
    return i;
  };

  for (const span of spans) {
    for (let x = from(0, span.low[0] as number); x < from(0, span.high[0] as number); x++) {
      for (let y = from(1, span.low[1] as number); y < from(1, span.high[1] as number); y++) {
        for (let z = from(2, span.low[2] as number); z < from(2, span.high[2] as number); z++) {
          filled[cell(x, y, z)] = 1;
        }
      }
    }
  }

  const joined: Point[][] = [];
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (filled[cell(x, y, z)] !== 1) {
          continue;
        }
        let dz = 1;
        while (z + dz < nz && filled[cell(x, y, z + dz)] === 1) {
          dz++;
        }
        let dy = 1;
        grow: while (y + dy < ny) {
          for (let k = 0; k < dz; k++) {
            if (filled[cell(x, y + dy, z + k)] !== 1) {
              break grow;
            }
          }
          dy++;
        }
        let dx = 1;
        stack: while (x + dx < nx) {
          for (let j = 0; j < dy; j++) {
            for (let k = 0; k < dz; k++) {
              if (filled[cell(x + dx, y + j, z + k)] !== 1) {
                break stack;
              }
            }
          }
          dx++;
        }

        for (let i = 0; i < dx; i++) {
          for (let j = 0; j < dy; j++) {
            for (let k = 0; k < dz; k++) {
              filled[cell(x + i, y + j, z + k)] = 0;
            }
          }
        }

        const low = [
          (lines[0] as number[])[x] as number,
          (lines[1] as number[])[y] as number,
          (lines[2] as number[])[z] as number,
        ];
        const high = [
          (lines[0] as number[])[x + dx] as number,
          (lines[1] as number[])[y + dy] as number,
          (lines[2] as number[])[z + dz] as number,
        ];
        joined.push(
          CORNERS.map(
            (corner) =>
              [
                corner[0] === 0 ? low[0] : high[0],
                corner[1] === 0 ? low[1] : high[1],
                corner[2] === 0 ? low[2] : high[2],
              ] as unknown as Point,
          ),
        );
      }
    }
  }
  return joined;
}
