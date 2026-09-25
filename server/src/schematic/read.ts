import { gunzipSync } from "node:zlib";
import { readNbt } from "../mcprint/nbt.js";
import { readLitematic } from "./litematic.js";
import { readMcEdit } from "./mcedit.js";
import { readSponge } from "./sponge.js";
import type { LegacyName } from "./legacyNames.js";
import { SchematicError, type SchematicRead } from "./types.js";

/**
 * Reads whichever schematic somebody uploaded.
 *
 * <p>The format is decided by what is in the file rather than by what the name
 * ends in, because a person who renames a file has not changed it and a person
 * who downloaded one may never have known what it was.
 */

/** All three are gzipped NBT, and some tools write them plain anyway. */
function unwrap(bytes: Uint8Array, limit: number): Uint8Array {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return new Uint8Array(gunzipSync(bytes, { maxOutputLength: limit }));
    } catch (error) {
      throw new SchematicError(
        error instanceof Error && /maxOutputLength/i.test(error.message)
          ? "the schematic is larger unpacked than this site will read"
          : "the schematic is gzipped, but the gzip is damaged",
      );
    }
  }
  return bytes;
}

export function readSchematic(
  bytes: Uint8Array,
  limit = 256 << 20,
  /** What other uploads taught about pre-1.13 block ids. */
  learned: ReadonlyMap<number, LegacyName> = new Map(),
): SchematicRead {
  const plain = unwrap(bytes, limit);
  let root;
  try {
    root = readNbt(plain).value;
  } catch (error) {
    throw new SchematicError(
      `this is not a schematic the site can read: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }

  // Litematica first: it is the only one with Regions, and it also carries a
  // Version, so testing it first costs nothing and cannot be confused.
  if (root.Regions !== undefined) {
    return readLitematic(root);
  }
  // Sponge, at the root or wrapped once by version 3.
  if (root.Palette !== undefined || root.BlockData !== undefined || root.Schematic !== undefined) {
    return readSponge(root);
  }
  // And the old one, which is the only thing left that has Blocks as bytes.
  if (root.Blocks instanceof Uint8Array) {
    return readMcEdit(root, learned);
  }
  throw new SchematicError(
    "this file is NBT, but not a schematic: no Regions, no Palette and no Blocks.",
  );
}

export { SchematicError } from "./types.js";
export type { SchematicRead } from "./types.js";
