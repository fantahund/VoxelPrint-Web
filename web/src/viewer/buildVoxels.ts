import { nearestOf, srgbToLinear, toOklab } from "../colour";
import { colourFor, isAir, UNKNOWN_COLOUR } from "./blockColors";
import type { BlockModels, ShapeBox, StructureInfo } from "../types";

/** Stands in for "nothing removed", so the common case allocates nothing. */
const EMPTY: ReadonlySet<number> = new Set<number>();

/** A block with no shape data is drawn as the whole cube. */
const FULL_BLOCK: ShapeBox = [0, 0, 0, 1, 1, 1];

/** Used where a face is so degenerate that it has no direction of its own. */
const FALLBACK_NORMAL: readonly [number, number, number] = [0, 1, 0];

const FACE_NORMALS: Readonly<Record<string, readonly [number, number, number]>> = {
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};

/**
 * The drawable form of one palette entry's model.
 *
 * <p>The geometry is block-local and shared by every block of that state; only
 * the offsets differ. That is what keeps a large build affordable: a thousand
 * torches are one torch and a thousand positions, not a thousand torches.
 */
export interface BlockMesh {
  readonly paletteIndex: number;
  /** Non-indexed triangles, three floats per corner. */
  readonly positions: Float32Array;
  /**
   * The same faces as four cornered quads, twelve floats each.
   *
   * <p>Kept beside the triangles rather than derived from them: the printable
   * export thickens each face into a closed prism, and a prism is built from
   * the face it came from. Recovering quads from a triangle soup would mean
   * relying on the order they happened to be written in.
   */
  readonly quads: Float32Array;
  readonly normals: Float32Array;
  /** Material colour per corner, three linear floats. */
  readonly colours: Float32Array;
  /**
   * The measured colour of each face, one 0xRRGGBB per quad.
   *
   * <p>Kept beside the per corner colours, which are linear and for the screen.
   * These are what a face is matched to a filament by, and matching wants the
   * number the exporter measured rather than one that has been through a
   * colour space and back.
   */
  readonly faceColours: Uint32Array;
  /** Where the blocks of this state stand, three floats each. */
  readonly offsets: Float32Array;
  readonly blocks: number;
  /**
   * Which block of the selection each instance is, as an index into it.
   *
   * <p>What lets a click in the preview name a block. An instance is otherwise
   * anonymous: the offsets say where it stands, and nothing says which block
   * that was, because the preview skips air and everything walled in.
   */
  readonly blockIndices: Uint32Array;
}

export interface VoxelModel {
  /** Box centres, three floats each, centred on the model's own middle. */
  readonly positions: Float32Array;
  /** Box sizes, three floats each, in blocks. */
  readonly scales: Float32Array;
  /** Palette index of each box, for colouring it later. */
  readonly paletteIndices: Uint32Array;
  /**
   * How many boxes the preview draws, which is the first that many of them.
   *
   * <p>Only the blocks with no model of their own. The rest are drawn as
   * meshes, and drawing their boxes as well would put a box inside every torch.
   */
  readonly boxes: number;
  /**
   * How many boxes there are in total, preview and the rest.
   *
   * <p>The ones past {@link #boxes} belong to blocks the preview draws as
   * meshes. They exist for the printable export, which wants a closed solid for
   * every block rather than the open shells a game model is made of: a torch
   * model is two crossed planes with no thickness, and no printer can make
   * that.
   */
  readonly solids: number;
  /**
   * The real models, where the export carries them.
   *
   * <p>Empty when it does not. Blocks whose model came out empty -- chests,
   * signs and everything else the game draws by hand rather than from a model
   * -- are drawn as boxes even here, so they do not go missing.
   */
  readonly meshes: readonly BlockMesh[];
  /** How many faces the meshes hold in total. */
  readonly quads: number;
  /** How many blocks those boxes and meshes belong to. */
  readonly visible: number;
  readonly solid: number;
  /** Whether real shapes were used, or everything fell back to cubes. */
  readonly shaped: boolean;
  /** Whether real models were used. */
  readonly modelled: boolean;
  /**
   * Whether {@link minecraftColours} are measured rather than guessed.
   *
   * <p>True for an export that carries its textures, and for a skin, whose
   * palette is colours to begin with. False where the colours come from the
   * table of opinions in {@code blockColors}, which is worth saying out loud
   * before somebody prints a build in them.
   */
  readonly trueColour: boolean;
  /** How many blocks across, up and deep the selection is. */
  readonly size: { readonly width: number; readonly height: number; readonly depth: number };
  /** Block id per palette index, properties stripped. */
  readonly blockIds: readonly string[];
  /** What each palette entry looks like in Minecraft, as 0xRRGGBB. */
  readonly minecraftColours: readonly number[];
  /** The same per block id, which is the level filaments are assigned at. */
  readonly blockTypeColours: Readonly<Record<string, number>>;
  /** Solid blocks per block id, most common first. */
  readonly typeCounts: ReadonlyArray<readonly [string, number]>;
  /**
   * Which block of the selection each solid belongs to, index for index with
   * {@link #positions}.
   *
   * <p>Several solids share one block, a stair being two and a fence several,
   * so this is not one to one.
   */
  readonly solidBlocks: Uint32Array;
  /** Palette entry per block index, so a click can name what it hit. */
  readonly blockStates: readonly string[];
  /** How many blocks were left out because they were removed by hand. */
  readonly removed: number;
}

function isFullBlock(box: ShapeBox): boolean {
  return box[0] <= 0 && box[1] <= 0 && box[2] <= 0 && box[3] >= 1 && box[4] >= 1 && box[5] >= 1;
}

/** {@code minecraft:oak_stairs[facing=north]} to {@code minecraft:oak_stairs}. */
export function blockIdOf(blockState: string): string {
  const bracket = blockState.indexOf("[");
  return bracket === -1 ? blockState : blockState.slice(0, bracket);
}

/**
 * Turns the packed indices into something drawable.
 *
 * <p>Two reductions happen here, and both matter long before a build gets big:
 *
 * <ul>
 *   <li>air is skipped, which for a typical selection is most of it;
 *   <li>a block fully surrounded by other blocks is skipped too, because
 *       nothing of it can ever be seen.
 * </ul>
 *
 * <p>Only a block that genuinely fills its cube can hide its neighbour. Judging
 * that by "is not air" leaves visible holes: a stair occupies half its cube, so
 * the wall behind it gets culled and you look straight through the stair into
 * nothing. Where an export carries no shapes there is no way to tell, and the
 * old rule stands.
 *
 * <p>How a block is drawn depends on what the export carries. With models it is
 * its real model, so a torch is a stick with a flame. With shapes but no models
 * it is one box per part of its shape: a stair is two, a fence several. With
 * neither it is a full cube.
 */
export function buildVoxels(
  structure: StructureInfo,
  indices: Uint32Array,
  models: BlockModels | null,
  removed: ReadonlySet<number> = EMPTY,
  measured?: readonly number[],
): VoxelModel {
  const { width, height, depth, palette } = structure;

  // Precomputed per palette entry: doing this per block would mean millions of
  // string operations.
  const air = palette.map(isAir);
  const blockIds = palette.map(blockIdOf);
  const shaped = structure.shapes != null;
  const shapes: ReadonlyArray<readonly ShapeBox[]> =
    structure.shapes ?? palette.map(() => [FULL_BLOCK]);

  // A block state has a model only if the export carries one and it is not
  // empty. An empty one means the game draws that block itself -- a chest, a
  // sign, a bed -- and the box from its shape is the best we have.
  const quads = models?.models ?? [];
  const hasModel = palette.map((_, index) => (quads[index]?.length ?? 0) > 0);
  const modelled = models !== null && hasModel.some(Boolean);

  // Given outright where the source knows them exactly, which is what a skin
  // is: its palette is colours, not block names, and there is nothing to look
  // up or average.
  const minecraftColours =
    measured ??
    palette.map((state, index) => averageMaterialColour(models, quads[index]) ?? colourFor(state).colour);

  // Whether a block can hide what is behind it. Without shapes nothing is
  // known, so every solid block counts as opaque exactly as it used to.
  const occludes = palette.map((_, index) => {
    if (air[index]) {
      return false;
    }
    if (!shaped) {
      return true;
    }
    const boxes = shapes[index];
    return boxes !== undefined && boxes.length === 1 && isFullBlock(boxes[0] as ShapeBox);
  });

  const at = (x: number, y: number, z: number): number => x + z * width + y * width * depth;
  const occludedAt = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) {
      // Outside the selection counts as open, so the outer shell is drawn.
      return false;
    }
    const where = at(x, y, z);
    // A block taken out by hand reads as air here as well, so its neighbours
    // get the faces they were hiding behind it. Culling against the block that
    // is no longer there would leave a hole in the wall around the gap.
    if (removed.has(where)) {
      return false;
    }
    return occludes[indices[where] as number] === true;
  };

  // Two groups, joined at the end: first the boxes the preview draws, then the
  // ones only the export needs. Keeping them in that order lets the preview
  // take a prefix instead of carrying a flag per box.
  const positions: number[] = [];
  const scales: number[] = [];
  const drawn: number[] = [];
  const extraPositions: number[] = [];
  const extraScales: number[] = [];
  const extraDrawn: number[] = [];
  /** Block corners per palette entry, for the entries drawn as real models. */
  const offsets = palette.map((): number[] => []);
  /** Which block each mesh instance is, in step with {@code offsets}. */
  const offsetBlocks = palette.map((): number[] => []);
  const solidBlocks: number[] = [];
  const extraSolidBlocks: number[] = [];
  const counts = new Map<string, number>();
  let solid = 0;
  let visible = 0;
  let removedCount = 0;

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const halfDepth = depth / 2;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        const where = at(x, y, z);
        const index = indices[where] as number;
        if (air[index]) {
          continue;
        }
        if (removed.has(where)) {
          // Counted rather than skipped silently, so the interface can say how
          // much was taken out and offer to put it back.
          removedCount++;
          continue;
        }
        solid++;

        const id = blockIds[index] as string;
        counts.set(id, (counts.get(id) ?? 0) + 1);

        const enclosed =
          occludedAt(x - 1, y, z) &&
          occludedAt(x + 1, y, z) &&
          occludedAt(x, y - 1, z) &&
          occludedAt(x, y + 1, z) &&
          occludedAt(x, y, z - 1) &&
          occludedAt(x, y, z + 1);
        if (enclosed) {
          continue;
        }
        visible++;

        // Centred on the model, so orbiting turns around the build rather than
        // around one of its corners. This is the block's own corner: model
        // coordinates run from 0 to 1 away from it.
        const originX = x - halfWidth;
        const originY = y - halfHeight;
        const originZ = z - halfDepth;

        const modelled = hasModel[index] === true;
        if (modelled) {
          (offsets[index] as number[]).push(originX, originY, originZ);
          (offsetBlocks[index] as number[]).push(where);
        }

        // A solid block whose shape came out empty becomes the whole cube
        // rather than a hole where something clearly is.
        const declared = shapes[index];
        const boxes = declared === undefined || declared.length === 0 ? [FULL_BLOCK] : declared;

        for (const box of boxes) {
          const intoPositions = modelled ? extraPositions : positions;
          const intoScales = modelled ? extraScales : scales;
          const intoDrawn = modelled ? extraDrawn : drawn;
          intoPositions.push(
            originX + (box[0] + box[3]) / 2,
            originY + (box[1] + box[4]) / 2,
            originZ + (box[2] + box[5]) / 2,
          );
          intoScales.push(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
          intoDrawn.push(index);
          (modelled ? extraSolidBlocks : solidBlocks).push(where);
        }
      }
    }
  }

  const meshes: BlockMesh[] = [];
  let quadCount = 0;
  for (let index = 0; index < palette.length; index++) {
    const where = offsets[index] as number[];
    const faces = quads[index];
    if (where.length === 0 || faces === undefined || faces.length === 0) {
      continue;
    }
    meshes.push(buildMesh(index, faces, models, where, offsetBlocks[index] as number[]));
    quadCount += faces.length * (where.length / 3);
  }

  const typeCounts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return {
    positions: Float32Array.from([...positions, ...extraPositions]),
    scales: Float32Array.from([...scales, ...extraScales]),
    paletteIndices: Uint32Array.from([...drawn, ...extraDrawn]),
    boxes: drawn.length,
    solids: drawn.length + extraDrawn.length,
    size: { width, height, depth },
    meshes,
    quads: quadCount,
    visible,
    solid,
    shaped,
    modelled,
    trueColour: modelled || measured !== undefined,
    blockIds,
    minecraftColours,
    blockTypeColours: colourPerBlockType(blockIds, minecraftColours, typeCounts),
    typeCounts,
    solidBlocks: Uint32Array.from([...solidBlocks, ...extraSolidBlocks]),
    blockStates: palette,
    removed: removedCount,
  };
}

/**
 * Builds the triangles of one palette entry.
 *
 * <p>Each face becomes two triangles sharing a diagonal, with the corner order
 * the export wrote them in. Nothing is welded or indexed: neighbouring faces of
 * a Minecraft model rarely share both a position and a material, so an index
 * buffer would cost more to build than it saved.
 */
function buildMesh(
  paletteIndex: number,
  faces: BlockModels["models"][number],
  models: BlockModels | null,
  offsets: readonly number[],
  blockIndices: readonly number[],
): BlockMesh {
  const corners = faces.length * 6;
  const positions = new Float32Array(corners * 3);
  const normals = new Float32Array(corners * 3);
  const colours = new Float32Array(corners * 3);
  const faceColours = new Uint32Array(faces.length);
  const quads = new Float32Array(faces.length * 12);

  // Two triangles from four corners, going round the face the way it was wound.
  const order = [0, 1, 2, 0, 2, 3];
  let cursor = 0;

  faces.forEach((face, index) => {
    const v = face.vertices;
    quads.set(v.slice(0, 12), index * 12);
    const normal = normalOf(v, face.direction);
    const colour = models?.materials[face.material]?.colour ?? UNKNOWN_COLOUR;
    faceColours[index] = colour >>> 0;
    const red = srgbToLinear(((colour >> 16) & 0xff) / 255);
    const green = srgbToLinear(((colour >> 8) & 0xff) / 255);
    const blue = srgbToLinear((colour & 0xff) / 255);

    for (const corner of order) {
      positions[cursor] = v[corner * 3] as number;
      positions[cursor + 1] = v[corner * 3 + 1] as number;
      positions[cursor + 2] = v[corner * 3 + 2] as number;
      normals[cursor] = normal[0];
      normals[cursor + 1] = normal[1];
      normals[cursor + 2] = normal[2];
      colours[cursor] = red;
      colours[cursor + 1] = green;
      colours[cursor + 2] = blue;
      cursor += 3;
    }
  });

  return {
    paletteIndex,
    positions,
    quads,
    normals,
    colours,
    faceColours,
    offsets: Float32Array.from(offsets),
    blockIndices: Uint32Array.from(blockIndices),
    blocks: offsets.length / 3,
  };
}

/**
 * Works out which way a face points.
 *
 * <p>From the face's own corners rather than from its direction: a model may
 * tilt a face any way it likes, and the direction it is filed under only says
 * which side of the block it is culled with. The direction is the fallback for
 * a face too degenerate to have a normal of its own.
 */
function normalOf(v: readonly number[], direction: string | undefined): readonly [number, number, number] {
  // The diagonals rather than two edges: they stay meaningful even when one
  // pair of corners has collapsed onto each other.
  const ax = (v[6] as number) - (v[0] as number);
  const ay = (v[7] as number) - (v[1] as number);
  const az = (v[8] as number) - (v[2] as number);
  const bx = (v[9] as number) - (v[3] as number);
  const by = (v[10] as number) - (v[4] as number);
  const bz = (v[11] as number) - (v[5] as number);

  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length > 1e-6) {
    return [x / length, y / length, z / length];
  }
  return (direction === undefined ? undefined : FACE_NORMALS[direction]) ?? FALLBACK_NORMAL;
}

/**
 * The colour of a block state, averaged over the faces of its model.
 *
 * <p>Weighted by nothing but the number of faces, which is rough but honest: a
 * block state has one colour here, and the faces are all there is to go on.
 * Returns null where the export carries no model for it, so the caller can fall
 * back to the table of guesses.
 */
function averageMaterialColour(
  models: BlockModels | null,
  faces: BlockModels["models"][number] | undefined,
): number | null {
  if (models === null || faces === undefined || faces.length === 0) {
    return null;
  }

  let red = 0;
  let green = 0;
  let blue = 0;
  let counted = 0;
  for (const face of faces) {
    const material = models.materials[face.material];
    if (material === undefined) {
      continue;
    }
    red += (material.colour >> 16) & 0xff;
    green += (material.colour >> 8) & 0xff;
    blue += material.colour & 0xff;
    counted++;
  }
  if (counted === 0) {
    return null;
  }
  return (
    (Math.round(red / counted) << 16) |
    (Math.round(green / counted) << 8) |
    Math.round(blue / counted)
  );
}

/**
 * Folds the per state colours down to one per block id.
 *
 * <p>Filaments are assigned per block id, not per state, so this is the level
 * the colours have to be compared at. Weighted by how often each state occurs,
 * so a wall made mostly of one variant is not dragged away by a single odd one.
 */
function colourPerBlockType(
  blockIds: readonly string[],
  colours: readonly number[],
  typeCounts: ReadonlyArray<readonly [string, number]>,
): Record<string, number> {
  const sums = new Map<string, [number, number, number, number]>();
  for (let index = 0; index < blockIds.length; index++) {
    const id = blockIds[index] as string;
    const colour = colours[index] as number;
    const sum = sums.get(id) ?? [0, 0, 0, 0];
    sum[0] += (colour >> 16) & 0xff;
    sum[1] += (colour >> 8) & 0xff;
    sum[2] += colour & 0xff;
    sum[3] += 1;
    sums.set(id, sum);
  }

  const result: Record<string, number> = {};
  for (const [id] of typeCounts) {
    const sum = sums.get(id);
    if (sum === undefined || sum[3] === 0) {
      result[id] = UNKNOWN_COLOUR;
      continue;
    }
    result[id] =
      (Math.round(sum[0] / sum[3]) << 16) |
      (Math.round(sum[1] / sum[3]) << 8) |
      Math.round(sum[2] / sum[3]);
  }
  return result;
}

/** Colours ready for the renderer, in the two forms it needs them. */
export interface SceneColours {
  /** One colour per drawn box, three linear floats. */
  readonly boxes: Float32Array;
  /** One colour per block of each mesh, in the order {@link VoxelModel.meshes} has them. */
  readonly meshes: readonly Float32Array[];
  /**
   * Whether the meshes should show the colours their materials carry.
   *
   * <p>When they should, their per block colour is left white so the material
   * colour comes through unchanged rather than being tinted by it.
   */
  readonly materialColours: boolean;
  /**
   * A colour per corner to draw a mesh with, or null to use its own.
   *
   * <p>What a colour per face looks like: a grass block is one instance and
   * cannot be two colours, so the colour has to come off the corners instead.
   * Null everywhere when every face of a block prints in the same filament,
   * which is the cheaper path and the usual one.
   */
  readonly corners: ReadonlyArray<Float32Array | null>;
}

/**
 * Builds the colour buffers for the current assignment.
 *
 * <p>Cheap on purpose: this runs every time a filament colour changes.
 */
export function colourise(
  model: VoxelModel,
  colourOfPaletteIndex: readonly number[],
  materialColours: boolean,
  /**
   * The filaments, for showing a colour per face rather than per block.
   *
   * <p>Left out to draw every face of a block in the one colour its type is
   * assigned to, which is what the preview did before faces had their own.
   */
  slotColours?: readonly number[],
): SceneColours {
  const boxes = new Float32Array(model.boxes * 3);
  for (let i = 0; i < model.boxes; i++) {
    const colour = colourOfPaletteIndex[model.paletteIndices[i] as number] ?? UNKNOWN_COLOUR;
    boxes[i * 3] = srgbToLinear(((colour >> 16) & 0xff) / 255);
    boxes[i * 3 + 1] = srgbToLinear(((colour >> 8) & 0xff) / 255);
    boxes[i * 3 + 2] = srgbToLinear((colour & 0xff) / 255);
  }

  const meshes = model.meshes.map((mesh) => {
    const colours = new Float32Array(mesh.blocks * 3);
    if (materialColours) {
      colours.fill(1);
      return colours;
    }
    const colour = colourOfPaletteIndex[mesh.paletteIndex] ?? UNKNOWN_COLOUR;
    const red = srgbToLinear(((colour >> 16) & 0xff) / 255);
    const green = srgbToLinear(((colour >> 8) & 0xff) / 255);
    const blue = srgbToLinear((colour & 0xff) / 255);
    for (let i = 0; i < mesh.blocks; i++) {
      colours[i * 3] = red;
      colours[i * 3 + 1] = green;
      colours[i * 3 + 2] = blue;
    }
    return colours;
  });

  // A colour per face, worked out where it is asked for and where a block's
  // faces actually disagree. A mesh whose faces all want the same filament is
  // left alone: one colour on the instance is cheaper than six per face.
  const places =
    materialColours || slotColours === undefined || slotColours.length === 0
      ? null
      : slotColours.map(toOklab);
  const corners: Array<Float32Array | null> = model.meshes.map((mesh) => {
    if (places === null) {
      return null;
    }
    const faces = mesh.faceColours.length;
    const slots = new Uint8Array(faces);
    let differ = false;
    for (let face = 0; face < faces; face++) {
      slots[face] = nearestOf(mesh.faceColours[face] ?? UNKNOWN_COLOUR, places);
      if (slots[face] !== slots[0]) {
        differ = true;
      }
    }
    if (!differ) {
      return null;
    }
    // Six corners a face, in the order buildMesh wound them.
    const tint = new Float32Array(faces * 6 * 3);
    for (let face = 0; face < faces; face++) {
      const colour = (slotColours ?? [])[slots[face] as number] ?? UNKNOWN_COLOUR;
      const red = srgbToLinear(((colour >> 16) & 0xff) / 255);
      const green = srgbToLinear(((colour >> 8) & 0xff) / 255);
      const blue = srgbToLinear((colour & 0xff) / 255);
      for (let corner = 0; corner < 6; corner++) {
        const at = (face * 6 + corner) * 3;
        tint[at] = red;
        tint[at + 1] = green;
        tint[at + 2] = blue;
      }
    }
    return tint;
  });

  // A mesh drawn off its corners must not be tinted by its instance as well.
  corners.forEach((tint, index) => {
    if (tint !== null) {
      (meshes[index] as Float32Array).fill(1);
    }
  });

  return { boxes, meshes, materialColours, corners };
}

/** Unpacks indices.bin according to the width the server chose. */
export function unpackIndices(bytes: ArrayBuffer, bytesPerIndex: 1 | 2 | 4): Uint32Array {
  switch (bytesPerIndex) {
    case 1:
      return Uint32Array.from(new Uint8Array(bytes));
    case 2:
      return Uint32Array.from(new Uint16Array(bytes));
    default:
      return new Uint32Array(bytes);
  }
}
