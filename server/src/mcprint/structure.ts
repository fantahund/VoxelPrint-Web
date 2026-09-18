import { gunzipSync } from "node:zlib";
import { McPrintError } from "./archive.js";
import { isByteArray, isCompound, isNumber, readNbt, require as requireTag } from "./nbt.js";
import type { Manifest } from "./schema.js";

/**
 * A structure in the one shape the rest of the site works with, whichever
 * format it arrived in.
 *
 * <p>Indices are ordered {@code x + z * width + y * width * depth}, the order
 * both source formats already use.
 */
export interface Structure {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** Block state strings; the index into this array is what a voxel stores. */
  readonly palette: readonly string[];
  readonly indices: Uint32Array;
}

const SPONGE_V3 = "sponge-schematic-v3";
const INTERNAL_V1 = "internal-v1";

export function readStructure(bytes: Uint8Array, manifest: Manifest): Structure {
  const structure = parse(bytes, manifest);
  verify(structure, manifest);
  return structure;
}

function parse(bytes: Uint8Array, manifest: Manifest): Structure {
  switch (manifest.structureFormat) {
    case SPONGE_V3:
      return readSpongeV3(bytes);
    case INTERNAL_V1:
      return readInternalV1(bytes);
    default:
      throw new McPrintError(
        `Unknown structure format ${manifest.structureFormat}. This file was made by a newer VoxelPrint.`,
      );
  }
}

/**
 * Checks the structure against the manifest.
 *
 * <p>Two documents in one archive describing the same thing is an invitation
 * for them to disagree. If they do, the file is wrong and saying so beats
 * rendering something that silently does not match its own description.
 */
function verify(structure: Structure, manifest: Manifest): void {
  const { width, height, depth } = manifest.size;
  if (structure.width !== width || structure.height !== height || structure.depth !== depth) {
    throw new McPrintError("The structure and the manifest disagree about the size.");
  }

  const expected = width * height * depth;
  if (structure.indices.length !== expected) {
    throw new McPrintError(
      `The structure holds ${structure.indices.length} blocks, but its size says ${expected}.`,
    );
  }

  for (const index of structure.indices) {
    if (index >= structure.palette.length) {
      throw new McPrintError("The structure refers to a palette entry that does not exist.");
    }
  }
}

/** Sponge Schematic Version 3: GZip compressed NBT. */
function readSpongeV3(bytes: Uint8Array): Structure {
  let plain: Uint8Array;
  try {
    plain = gunzipSync(bytes);
  } catch {
    throw new McPrintError("The schematic is not valid GZip data.");
  }

  const root = readNbt(plain).value;
  const schematic = requireTag(root, "Schematic", isCompound, "a compound");

  const version = requireTag(schematic, "Version", isNumber, "a number");
  if (version !== 3) {
    throw new McPrintError(`The schematic is version ${version}; only version 3 is read.`);
  }

  // Width, Height and Length are unsigned shorts, but NBT only has a signed
  // one. Anything past 32767 therefore arrives negative and has to be folded
  // back into range.
  const width = unsignedShort(requireTag(schematic, "Width", isNumber, "a number"));
  const height = unsignedShort(requireTag(schematic, "Height", isNumber, "a number"));
  const depth = unsignedShort(requireTag(schematic, "Length", isNumber, "a number"));

  const blocks = requireTag(schematic, "Blocks", isCompound, "a compound");
  const paletteTag = requireTag(blocks, "Palette", isCompound, "a compound");
  const data = requireTag(blocks, "Data", isByteArray, "a byte array");

  const palette = orderPalette(paletteTag);
  return { width, height, depth, palette, indices: readVarInts(data, width * height * depth) };
}

function unsignedShort(value: number): number {
  return value & 0xffff;
}

/**
 * Turns the palette compound into an array.
 *
 * <p>A Sponge palette maps a block state to its index, which is the opposite of
 * what a reader wants. The indices need not be contiguous in the file, so the
 * array is sized by the largest one rather than by how many entries there are.
 */
function orderPalette(tag: Record<string, unknown>): string[] {
  const entries = Object.entries(tag);
  let highest = -1;
  for (const [state, index] of entries) {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 1_000_000) {
      throw new McPrintError(`The palette entry ${state} has no usable index.`);
    }
    highest = Math.max(highest, index);
  }

  const palette = new Array<string>(highest + 1).fill("minecraft:air");
  for (const [state, index] of entries) {
    palette[index as number] = state;
  }
  return palette;
}

/** Unpacks the concatenated VarInts of a Sponge schematic. */
function readVarInts(data: Uint8Array, expected: number): Uint32Array {
  const values = new Uint32Array(expected);
  let read = 0;
  let offset = 0;

  while (offset < data.length) {
    if (read === expected) {
      throw new McPrintError("The schematic holds more blocks than its size allows.");
    }
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= data.length) {
        throw new McPrintError("The schematic ends in the middle of a block index.");
      }
      const byte = data[offset++] as number;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
      if (shift > 28) {
        throw new McPrintError("The schematic contains an oversized block index.");
      }
    }
    values[read++] = value >>> 0;
  }

  if (read !== expected) {
    throw new McPrintError(`The schematic holds ${read} blocks, but its size says ${expected}.`);
  }
  return values;
}

/** VoxelPrint's own plain JSON structure. */
function readInternalV1(bytes: Uint8Array): Structure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new McPrintError("structure.json is not valid JSON.");
  }

  const document = parsed as {
    size?: { width?: unknown; height?: unknown; depth?: unknown };
    palette?: unknown;
    blocks?: unknown;
  };

  const width = positiveInteger(document.size?.width, "size.width");
  const height = positiveInteger(document.size?.height, "size.height");
  const depth = positiveInteger(document.size?.depth, "size.depth");

  if (!Array.isArray(document.palette) || document.palette.some((entry) => typeof entry !== "string")) {
    throw new McPrintError("structure.json has no usable palette.");
  }
  if (!Array.isArray(document.blocks)) {
    throw new McPrintError("structure.json has no block array.");
  }

  const indices = new Uint32Array(document.blocks.length);
  for (let i = 0; i < document.blocks.length; i++) {
    const value = document.blocks[i];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new McPrintError("structure.json contains a block index that is not a whole number.");
    }
    indices[i] = value;
  }

  return { width, height, depth, palette: document.palette as string[], indices };
}

function positiveInteger(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new McPrintError(`structure.json has no usable ${what}.`);
  }
  return value;
}
