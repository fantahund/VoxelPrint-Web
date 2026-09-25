import type { BlockLibrary } from "../blocks/library.js";
import { resolve, type How } from "../blocks/match.js";
import type { ProjectContents, ShapeBox, StructureInfo } from "../mcprint/readProject.js";
import type { BlockModels, Manifest } from "../mcprint/schema.js";
import type { SchematicRead } from "./types.js";

/**
 * A schematic, dressed in what the library remembers, as a project.
 *
 * <p>What comes out is shaped exactly like a read {@code .mcprint}, because
 * everything downstream already works and none of it should have to learn that
 * schematics exist. The viewer, the exporter, the splitter, the booklet and the
 * printability check all take this and cannot tell.
 *
 * <p>The report is the honest part. Every block is accounted for: known
 * outright, recognised as a mod's copy of a known block, borrowed from a
 * relative, or guessed at as a cube. A person importing a build deserves to be
 * told which of those their building is mostly made of, because an import that
 * is ninety per cent guesses is a box of cubes and they should find that out
 * before they spend four hours printing it.
 */

export interface DressReport {
  readonly states: number;
  readonly counted: Readonly<Record<How, number>>;
  /** How many of the placed blocks, rather than of the palette, were guessed. */
  readonly guessedBlocks: number;
  readonly blocks: number;
  /** A few of the worst, to show rather than only count. */
  readonly examples: ReadonlyArray<{ state: string; how: How; from: string | null }>;
}

export interface Dressed {
  readonly contents: ProjectContents;
  readonly indices: Uint8Array;
  readonly models: BlockModels;
  readonly report: DressReport;
}

const widthFor = (size: number): 1 | 2 | 4 => (size <= 0xff ? 1 : size <= 0xffff ? 2 : 4);

export function dress(read: SchematicRead, library: BlockLibrary, fileName: string): Dressed {
  const counted: Record<How, number> = {
    exact: 0, namespace: 0, family: 0, dressed: 0, guessed: 0,
  };
  const examples: Array<{ state: string; how: How; from: string | null }> = [];

  const shapes: ShapeBox[][] = [];
  const materials: BlockModels["materials"] = [];
  const models: BlockModels["models"] = [];
  // One material per colour: a schematic has no textures, so a colour is all
  // there is, and repeating it once per face would make the file enormous.
  const colours = new Map<number, number>();
  const materialFor = (colour: number): number => {
    const seen = colours.get(colour);
    if (seen !== undefined) {
      return seen;
    }
    const at = materials.length;
    materials.push({ texture: "imported", colour });
    colours.set(colour, at);
    return at;
  };

  const guessedStates = new Set<number>();
  read.palette.forEach((state, index) => {
    if (index === 0) {
      // Air takes up no space and is drawn by nothing.
      shapes.push([]);
      models.push([]);
      return;
    }
    const got = resolve(library, state);
    counted[got.how]++;
    if (got.how === "guessed") {
      guessedStates.add(index);
    }
    if (got.how !== "exact" && examples.length < 12) {
      examples.push({ state, how: got.how, from: got.shapeFrom });
    }
    shapes.push(got.shape.map((box) => [...box] as unknown as ShapeBox));
    models.push(
      got.quads.map((quad) => ({
        material: materialFor(quad.colour),
        ...(quad.direction === null ? {} : { direction: quad.direction }),
        vertices: [...quad.vertices],
      })),
    );
  });

  // Blocks, not palette entries: one guessed state used a thousand times
  // matters far more than nine known ones used once.
  let blocks = 0;
  let guessedBlocks = 0;
  const perState = new Uint32Array(read.palette.length);
  for (const index of read.indices) {
    perState[index] = (perState[index] as number) + 1;
    if (index !== 0) {
      blocks++;
      if (guessedStates.has(index)) {
        guessedBlocks++;
      }
    }
  }

  const bytesPerIndex = widthFor(read.palette.length);
  const packed = new Uint8Array(read.indices.length * bytesPerIndex);
  for (let at = 0; at < read.indices.length; at++) {
    const value = read.indices[at] as number;
    if (bytesPerIndex === 1) {
      packed[at] = value;
    } else if (bytesPerIndex === 2) {
      packed[at * 2] = value & 0xff;
      packed[at * 2 + 1] = (value >> 8) & 0xff;
    } else {
      packed[at * 4] = value & 0xff;
      packed[at * 4 + 1] = (value >> 8) & 0xff;
      packed[at * 4 + 2] = (value >> 16) & 0xff;
      packed[at * 4 + 3] = (value >> 24) & 0xff;
    }
  }

  const volume = read.width * read.height * read.depth;
  const manifest: Manifest = {
    format: "mcprint",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    generator: {
      name: "VoxelPrint schematic import",
      version: read.format,
      modLoader: "none",
    },
    minecraftVersion: "unknown",
    dataVersion: 0,
    dimension: "minecraft:overworld",
    origin: { x: 0, y: 0, z: 0 },
    size: { width: read.width, height: read.height, depth: read.depth },
    volume,
    nonAirBlockCount: blocks,
    includeAir: true,
    blockEntitiesIncluded: false,
    entitiesIncluded: false,
    structureFormat: read.format,
    structureFile: fileName,
    paletteSize: read.palette.length,
  };

  const types = new Map<string, number>();
  read.palette.forEach((state, index) => {
    if (index === 0) {
      return;
    }
    const id = state.split("[")[0] as string;
    types.set(id, (types.get(id) ?? 0) + (perState[index] as number));
  });

  const structure: StructureInfo = {
    width: read.width,
    height: read.height,
    depth: read.depth,
    palette: read.palette,
    bytesPerIndex,
    shapes,
    modelled: materials.length > 0,
    order: "x + z * width + y * width * depth",
  };

  return {
    contents: {
      manifest,
      blockSummary: {
        includeAir: true,
        volume,
        nonAirBlockCount: blocks,
        uniqueBlockTypes: types.size,
        uniqueBlockStates: read.palette.length - 1,
        blocks: read.palette.slice(1).map((state, at) => ({
          id: state.split("[")[0] as string,
          state,
          count: perState[at + 1] as number,
        })),
      },
      structure,
    },
    indices: packed,
    models: { formatVersion: 1, materials, models },
    report: {
      states: read.palette.length - 1,
      counted,
      guessedBlocks,
      blocks,
      examples,
    },
  };
}
