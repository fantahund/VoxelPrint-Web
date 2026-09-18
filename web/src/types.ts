/** Mirrors what the server returns. Kept in one place so the UI stays honest. */

export interface Manifest {
  format: string;
  formatVersion: number;
  createdAt: string;
  generator: { name: string; version: string; modLoader: string };
  minecraftVersion: string;
  dataVersion: number;
  dimension: string;
  origin: { x: number; y: number; z: number };
  size: { width: number; height: number; depth: number };
  volume: number;
  nonAirBlockCount: number;
  paletteSize: number;
  includeAir: boolean;
  blockEntitiesIncluded: boolean;
  entitiesIncluded: boolean;
  structureFormat: string;
  structureFile: string;
  shapesFile?: string;
  modelsFile?: string;
}

export interface BlockSummaryEntry {
  id: string;
  state: string;
  count: number;
}

export interface BlockSummary {
  includeAir: boolean;
  volume: number;
  nonAirBlockCount: number;
  uniqueBlockTypes: number;
  uniqueBlockStates: number;
  blocks: BlockSummaryEntry[];
}

/** One axis-aligned box: minX, minY, minZ, maxX, maxY, maxZ. */
export type ShapeBox = readonly [number, number, number, number, number, number];

export interface StructureInfo {
  width: number;
  height: number;
  depth: number;
  palette: string[];
  /** Width of one index in indices.bin: 1, 2 or 4 bytes. */
  bytesPerIndex: 1 | 2 | 4;
  /** Shape of each palette entry, or null when the export carries none. */
  shapes: ReadonlyArray<readonly ShapeBox[]> | null;
  /** Whether real models can be fetched for this project. */
  modelled: boolean;
  order: string;
}

/**
 * A texture as the mod measured it.
 *
 * <p>Only a name and a colour: the export never carries the texture itself.
 *
 * @see tint the biome tint already folded into the colour, where there is one
 */
export interface ModelMaterial {
  texture: string;
  tint?: number;
  colour: number;
}

/** One face of a model: four corners of three coordinates, block-local. */
export interface ModelQuad {
  material: number;
  direction?: string;
  vertices: number[];
}

/** Contents of models.json, one entry per palette entry and in its order. */
export interface BlockModels {
  formatVersion: number;
  materials: ModelMaterial[];
  models: ModelQuad[][];
}

export interface FilamentSlotData {
  name: string;
  colour: number;
}

export interface PrintingPlan {
  slots: FilamentSlotData[];
  assignment: Record<string, number>;
  /** Blocks taken out in the preview, as indices into the selection. */
  removed?: number[];
  updatedAt?: string;
}

export interface Project {
  id: string;
  uploadedAt: string;
  fileName: string;
  contents: {
    manifest: Manifest;
    blockSummary: BlockSummary | null;
    structure: StructureInfo;
  };
  /** What was last saved for this project, if anything. */
  printing?: PrintingPlan | null;
}
