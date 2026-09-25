import { isCompound, type NbtCompound, type NbtValue } from "../mcprint/nbt.js";
import { knowsLegacy, legacyState } from "./legacy.js";
import type { LegacyName } from "./legacyNames.js";
import { normalise, reorder, SchematicError, type SchematicRead } from "./types.js";

/**
 * MCEdit's {@code .schematic}, from before block states existed.
 *
 * <p>One byte of id and half a byte of data per block, and nothing at all about
 * what any of it means. Everything this reader knows it either finds written in
 * the file or looks up in a table, and the result is honest about which:
 * a file of blocks the table does not cover comes back with a note saying how
 * many, rather than quietly printing a building made of stone.
 *
 * <p>Where the writer left an id-to-name mapping behind -- Schematica does,
 * and it is the only reason a modded block can survive this format -- that is
 * used instead, and the data value is dropped, because the mapping says nothing
 * about what it meant.
 */

const compound = (value: NbtValue | undefined): NbtCompound | null =>
  value !== undefined && isCompound(value) ? value : null;

const short = (value: NbtValue | undefined, what: string): number => {
  if (typeof value !== "number") {
    throw new SchematicError(`${what} is missing`);
  }
  return value < 0 ? value + 65536 : value;
};

/** {@code name -> id}, as Schematica and friends write it, turned round. */
function mappingOf(root: NbtCompound): Map<number, string> | null {
  const written = compound(root.SchematicaMapping) ?? compound(root.BlockIDs);
  if (written === null) {
    return null;
  }
  const byId = new Map<number, string>();
  for (const [key, value] of Object.entries(written)) {
    // Written both ways round by different tools: name -> id and id -> name.
    if (typeof value === "number") {
      byId.set(value, key);
    } else if (typeof value === "string" && /^\d+$/.test(key)) {
      byId.set(Number(key), value);
    }
  }
  return byId.size > 0 ? byId : null;
}

export function readMcEdit(
  root: NbtCompound,
  /** Names other uploads taught, for ids this file does not name itself. */
  learned: ReadonlyMap<number, LegacyName> = new Map(),
): SchematicRead {
  const width = short(root.Width, "Width");
  const height = short(root.Height, "Height");
  const depth = short(root.Length, "Length");
  const count = width * height * depth;
  if (count === 0) {
    throw new SchematicError("the schematic is empty");
  }

  const blocks = root.Blocks;
  if (!(blocks instanceof Uint8Array) || blocks.length < count) {
    throw new SchematicError("the schematic has no block ids");
  }
  const data = root.Data instanceof Uint8Array ? root.Data : new Uint8Array(count);
  // Ids above 255 are carried in a nibble array beside the bytes.
  const addedRaw = root.AddBlocks ?? root.Add;
  const added = addedRaw instanceof Uint8Array ? addedRaw : null;

  const mapping = mappingOf(root);
  const palette: string[] = [];
  const known = new Map<string, number>();
  const indices = new Uint32Array(count);
  const unknown = new Set<number>();
  const borrowed = new Set<number>();

  for (let at = 0; at < count; at++) {
    let id = blocks[at] as number;
    if (added !== null) {
      const nibble = added[at >> 1] as number | undefined;
      if (nibble !== undefined) {
        const high = (at & 1) === 0 ? (nibble >> 4) & 0xf : nibble & 0xf;
        id |= high << 8;
      }
    }
    const meta = (data[at] as number) ?? 0;

    const named = mapping?.get(id);
    let state: string;
    if (named !== undefined) {
      state = named.includes(":") ? named : `minecraft:${named}`;
    } else if (!knowsLegacy(id) && learned.has(id)) {
      // Nothing in this file says what this is, but other files did. Only for
      // ids the table does not cover, so a borrowed name cannot move stone.
      state = (learned.get(id) as LegacyName).name;
      borrowed.add(id);
    } else {
      if (id !== 0 && !knowsLegacy(id)) {
        unknown.add(id);
      }
      state = legacyState(id, meta & 0xf);
    }

    let index = known.get(state);
    if (index === undefined) {
      index = palette.length;
      palette.push(state);
      known.set(state, index);
    }
    indices[at] = index;
  }

  const tidy = normalise(palette, reorder(indices, width, height, depth));
  const notes: string[] = [
    "This is a pre-1.13 file: it stores numbers, not block states, so some of what it holds had to be looked up rather than read.",
  ];
  if (mapping !== null) {
    notes.push("It carried its own list of block names, which was used instead of the table.");
  }
  if (borrowed.size > 0) {
    notes.push(
      `${borrowed.size} block ${borrowed.size === 1 ? "id was" : "ids were"} named from lists other uploads carried. ` +
        "Mods hand those numbers out per installation, so those blocks are a likely guess rather than a certainty.",
    );
  }
  if (unknown.size > 0) {
    notes.push(
      `${unknown.size} block ${unknown.size === 1 ? "id was" : "ids were"} not in the table and came through as stone.`,
    );
  }

  return {
    format: "mcedit",
    width,
    height,
    depth,
    palette: tidy.palette,
    indices: tidy.indices,
    name: null,
    notes,
    ...(mapping === null ? {} : { learnedNames: mapping }),
  };
}
