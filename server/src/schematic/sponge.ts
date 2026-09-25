import { isCompound, type NbtCompound, type NbtValue } from "../mcprint/nbt.js";
import { normalise, reorder, SchematicError, type SchematicRead } from "./types.js";

/**
 * Sponge's {@code .schem}, which is what WorldEdit writes.
 *
 * <p>The friendliest of the three: the palette is already a map from a full
 * block state string to a number, which is exactly what the library wants to be
 * asked. Nothing has to be guessed about what a block is -- only, later, about
 * what it looks like.
 *
 * <p>Versions 1 and 2 keep the blocks at the root; version 3 moved them into a
 * {@code Blocks} compound and renamed {@code BlockData} to {@code Data}. Both
 * are read, because files of both are in circulation and a person with a file
 * does not know or care which they have.
 */

/** A tag that may be absent, read as a compound or not at all. */
const compound = (value: NbtValue | undefined): NbtCompound | null =>
  value !== undefined && isCompound(value) ? value : null;

/** Blocks are indices written as LEB128, one per block, smallest first. */
function varints(data: Uint8Array, expected: number): Uint32Array {
  const out = new Uint32Array(expected);
  let at = 0;
  let written = 0;
  while (at < data.length && written < expected) {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= data.length) {
        throw new SchematicError("the block data stops in the middle of a block");
      }
      const byte = data[at++] as number;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
      if (shift > 28) {
        throw new SchematicError("a block index is absurdly large");
      }
    }
    out[written++] = value >>> 0;
  }
  if (written !== expected) {
    throw new SchematicError(`the file holds ${written} blocks, but says it is ${expected}`);
  }
  return out;
}

const short = (value: NbtValue | undefined, what: string): number => {
  if (typeof value !== "number") {
    throw new SchematicError(`${what} is missing`);
  }
  // Written as a signed short, so anything past 32767 arrives negative.
  return value < 0 ? value + 65536 : value;
};

export function readSponge(root: NbtCompound): SchematicRead {
  // Version 3 wraps everything once more, and some writers wrap version 2 too.
  const outer = compound(root.Schematic) ?? root;
  const blocks = compound(outer.Blocks) ?? outer;

  const width = short(outer.Width, "Width");
  const height = short(outer.Height, "Height");
  const depth = short(outer.Length, "Length");
  if (width * height * depth === 0) {
    throw new SchematicError("the schematic is empty");
  }

  const rawPalette = compound(blocks.Palette);
  if (rawPalette === null) {
    throw new SchematicError("the schematic has no block palette");
  }
  const palette: string[] = [];
  for (const [state, index] of Object.entries(rawPalette)) {
    if (typeof index !== "number") {
      continue;
    }
    palette[index] = state;
  }
  for (let at = 0; at < palette.length; at++) {
    palette[at] ??= "minecraft:air";
  }

  const data = blocks.Data ?? blocks.BlockData;
  if (!(data instanceof Uint8Array)) {
    throw new SchematicError("the schematic has no block data");
  }

  const laid = varints(data, width * height * depth);
  const tidy = normalise(palette, reorder(laid, width, height, depth));

  const metadata = compound(outer.Metadata);
  const named = metadata?.Name;

  return {
    format: "sponge",
    width,
    height,
    depth,
    palette: tidy.palette,
    indices: tidy.indices,
    name: typeof named === "string" && named.length > 0 ? named : null,
    notes: [],
  };
}
