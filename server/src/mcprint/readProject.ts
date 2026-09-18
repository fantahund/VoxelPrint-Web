import { McPrintError, readEntries, readJsonEntry, requirePlainFileName } from "./archive.js";
import { readStructure } from "./structure.js";
import {
  blockModelsSchema,
  blockShapesSchema,
  blockSummarySchema,
  manifestSchema,
  normaliseManifest,
  type BlockModels,
  type BlockSummary,
  type Manifest,
} from "./schema.js";

/** One axis-aligned box: minX, minY, minZ, maxX, maxY, maxZ. */
export type ShapeBox = readonly [number, number, number, number, number, number];

const ENTRY_MANIFEST = "manifest.json";
const ENTRY_BLOCK_SUMMARY = "block-summary.json";

/**
 * The structure without its block indices.
 *
 * <p>The indices are kept out on purpose: a million of them belong in a binary
 * file, not in a JSON document that gets read and written as text.
 */
export interface StructureInfo {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly palette: readonly string[];
  /** How wide one index is in the binary file: 1, 2 or 4 bytes. */
  readonly bytesPerIndex: 1 | 2 | 4;
  /**
   * The solid shape of each palette entry, or null when the export has none.
   *
   * <p>Small enough to keep with the project document rather than in a file of
   * its own: it grows with the palette, not with the number of blocks.
   */
  readonly shapes: ReadonlyArray<readonly ShapeBox[]> | null;
  /**
   * Whether the export carries real models, fetched separately.
   *
   * <p>Only the flag lives here. The models themselves are far larger than the
   * shapes -- twelve coordinates per face against six per whole block -- and
   * have their own endpoint for the same reason the indices do.
   */
  readonly modelled: boolean;
  /** How the indices are laid out, spelled out so no reader has to guess. */
  readonly order: "x + z * width + y * width * depth";
}

/** What the site knows about an uploaded project. */
export interface ProjectContents {
  readonly manifest: Manifest;
  /** Absent when the export was made with the block summary switched off. */
  readonly blockSummary: BlockSummary | null;
  readonly structure: StructureInfo;
}

/** How large each entry may be once unpacked. */
export interface ProjectLimits {
  readonly manifestBytes: number;
  readonly blockSummaryBytes: number;
  readonly structureBytes: number;
  readonly shapesBytes: number;
  readonly modelsBytes: number;
}

export interface ReadProject {
  readonly contents: ProjectContents;
  /** Packed indices, ready to be written to disk and served as they are. */
  readonly indices: Uint8Array;
  /** The real models, or null when the export carries none. */
  readonly models: BlockModels | null;
}

/**
 * Reads an uploaded {@code .mcprint} completely.
 *
 * <p>Two passes over the archive on purpose: the first reads only the manifest,
 * because the manifest is what names the structure file. Trusting a file name
 * before validating the document that contains it would be the wrong order.
 */
export function readProject(data: Uint8Array, limits: ProjectLimits): ReadProject {
  const head = readEntries(data, { [ENTRY_MANIFEST]: limits.manifestBytes });
  const parsed = manifestSchema.safeParse(readJsonEntry(head, ENTRY_MANIFEST));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") ?? "manifest";
    throw new McPrintError(`manifest.json is not valid: ${where}: ${first?.message ?? "unknown problem"}`);
  }

  const manifest = normaliseManifest(parsed.data);
  const structureFile = requirePlainFileName(manifest.structureFile, "structureFile");

  const shapesFile =
    manifest.shapesFile === undefined
      ? null
      : requirePlainFileName(manifest.shapesFile, "shapesFile");
  const modelsFile =
    manifest.modelsFile === undefined
      ? null
      : requirePlainFileName(manifest.modelsFile, "modelsFile");

  const rest = readEntries(data, {
    [ENTRY_BLOCK_SUMMARY]: limits.blockSummaryBytes,
    [structureFile]: limits.structureBytes,
    ...(shapesFile === null ? {} : { [shapesFile]: limits.shapesBytes }),
    ...(modelsFile === null ? {} : { [modelsFile]: limits.modelsBytes }),
  });

  const structureBytes = rest.get(structureFile);
  if (structureBytes === undefined) {
    throw new McPrintError(`The manifest names ${structureFile}, but the archive has no such entry.`);
  }

  const structure = readStructure(structureBytes, manifest);

  let blockSummary: BlockSummary | null = null;
  if (rest.has(ENTRY_BLOCK_SUMMARY)) {
    const summary = blockSummarySchema.safeParse(readJsonEntry(rest, ENTRY_BLOCK_SUMMARY));
    if (!summary.success) {
      throw new McPrintError("block-summary.json is not valid.");
    }
    blockSummary = summary.data;

    if (blockSummary.volume !== manifest.volume) {
      throw new McPrintError("block-summary.json and manifest.json disagree about the volume.");
    }
  }

  const shapes = readShapes(rest, shapesFile, structure.palette.length);
  const models = readModels(rest, modelsFile, structure.palette.length);
  const bytesPerIndex = widthFor(structure.palette.length);
  return {
    contents: {
      manifest,
      blockSummary,
      structure: {
        width: structure.width,
        height: structure.height,
        depth: structure.depth,
        palette: structure.palette,
        bytesPerIndex,
        shapes,
        modelled: models !== null,
        order: "x + z * width + y * width * depth",
      },
    },
    indices: pack(structure.indices, bytesPerIndex),
    models,
  };
}

/**
 * Reads the model file, when the manifest names one.
 *
 * <p>Like the shapes, the models have to line up with the palette one for one.
 * A file where they do not describes a different structure than the one it
 * ships with, and drawing it would put the wrong model on every block after the
 * mismatch.
 */
function readModels(
  entries: Map<string, Uint8Array>,
  modelsFile: string | null,
  paletteSize: number,
): BlockModels | null {
  if (modelsFile === null) {
    return null;
  }
  if (!entries.has(modelsFile)) {
    throw new McPrintError(`The manifest names ${modelsFile}, but the archive has no such entry.`);
  }

  const parsed = blockModelsSchema.safeParse(readJsonEntry(entries, modelsFile));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new McPrintError(`${modelsFile} is not valid: ${first?.message ?? "unknown problem"}`);
  }

  if (parsed.data.models.length !== paletteSize) {
    throw new McPrintError(
      `${modelsFile} holds ${parsed.data.models.length} models for a palette of ${paletteSize}.`,
    );
  }
  return parsed.data;
}

/**
 * Reads the shape file, when the manifest names one.
 *
 * <p>The shapes have to line up with the palette one for one. A file where they
 * do not is describing a different structure than the one it ships with, and
 * drawing it would put the wrong shape on every block after the mismatch.
 */
function readShapes(
  entries: Map<string, Uint8Array>,
  shapesFile: string | null,
  paletteSize: number,
): ReadonlyArray<readonly ShapeBox[]> | null {
  if (shapesFile === null) {
    return null;
  }
  if (!entries.has(shapesFile)) {
    throw new McPrintError(`The manifest names ${shapesFile}, but the archive has no such entry.`);
  }

  const parsed = blockShapesSchema.safeParse(readJsonEntry(entries, shapesFile));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new McPrintError(`${shapesFile} is not valid: ${first?.message ?? "unknown problem"}`);
  }

  if (parsed.data.shapes.length !== paletteSize) {
    throw new McPrintError(
      `${shapesFile} holds ${parsed.data.shapes.length} shapes for a palette of ${paletteSize}.`,
    );
  }
  return parsed.data.shapes;
}

/**
 * Picks the narrowest index that still fits the palette.
 *
 * <p>Almost every build stays below 256 distinct block states, so one byte per
 * block is the normal case. A million block selection is then a megabyte rather
 * than four.
 */
function widthFor(paletteSize: number): 1 | 2 | 4 {
  if (paletteSize <= 0x100) {
    return 1;
  }
  return paletteSize <= 0x10000 ? 2 : 4;
}

/** Packs the indices little-endian, which is what a browser reads natively. */
function pack(indices: Uint32Array, bytesPerIndex: 1 | 2 | 4): Uint8Array {
  if (bytesPerIndex === 1) {
    return Uint8Array.from(indices);
  }
  const packed = new Uint8Array(indices.length * bytesPerIndex);
  const view = new DataView(packed.buffer);
  for (let i = 0; i < indices.length; i++) {
    const value = indices[i] as number;
    if (bytesPerIndex === 2) {
      view.setUint16(i * 2, value, true);
    } else {
      view.setUint32(i * 4, value, true);
    }
  }
  return packed;
}
