import { isCompound, type NbtCompound, type NbtValue } from "../mcprint/nbt.js";
import { normalise, SchematicError, type SchematicRead } from "./types.js";

/**
 * Litematica's {@code .litematic}, which is what people actually build with.
 *
 * <p>Two things make it harder than Sponge. The blocks are bit-packed into
 * 64-bit words with no regard for word boundaries, so an index can straddle
 * two of them; and a file holds any number of regions at any positions, which
 * have to be laid back out into one box.
 *
 * <p>A region may also be given a negative size, which is the file saying the
 * region runs the other way from its corner. The blocks inside are still stored
 * smallest-first, so the size is taken as its magnitude and the corner moved to
 * the low end.
 */

const compound = (value: NbtValue | undefined): NbtCompound | null =>
  value !== undefined && isCompound(value) ? value : null;

const int = (value: NbtValue | undefined): number => (typeof value === "number" ? value : 0);

/** How many bits one palette index takes. Never fewer than two. */
function bitsFor(size: number): number {
  let bits = 1;
  while (1 << bits < size) {
    bits++;
  }
  return Math.max(2, bits);
}

/**
 * Unpacks the indices.
 *
 * <p>Entries run end to end through the words with nothing wasted, so one that
 * begins near the top of a word finishes in the next. Done in {@code BigInt}
 * because the words are genuinely 64 bits wide and doing it in doubles loses
 * the top of every one of them.
 */
function unpack(words: BigInt64Array, count: number, bits: number): Uint32Array {
  const out = new Uint32Array(count);
  const width = BigInt(bits);
  const mask = (1n << width) - 1n;
  for (let at = 0; at < count; at++) {
    const start = BigInt(at) * width;
    const first = Number(start >> 6n);
    const last = Number((start + width - 1n) >> 6n);
    const offset = start & 63n;
    if (first >= words.length) {
      throw new SchematicError("the block data stops before the region does");
    }
    const low = BigInt.asUintN(64, words[first] as bigint);
    let value: bigint;
    if (first === last) {
      value = (low >> offset) & mask;
    } else {
      if (last >= words.length) {
        throw new SchematicError("the block data stops in the middle of a block");
      }
      const high = BigInt.asUintN(64, words[last] as bigint);
      value = ((low >> offset) | (high << (64n - offset))) & mask;
    }
    out[at] = Number(value);
  }
  return out;
}

/** {@code {Name, Properties}} written back out the way the mod writes states. */
function stateOf(entry: NbtValue): string {
  if (!isCompound(entry)) {
    return "minecraft:air";
  }
  const name = typeof entry.Name === "string" ? entry.Name : "minecraft:air";
  const properties = compound(entry.Properties);
  if (properties === null) {
    return name;
  }
  const pairs = Object.entries(properties)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => [key, value as string] as const)
    // Alphabetical, which is the order the mod writes and so the order the
    // library is keyed by. A state written in another order still matches, but
    // only after falling through to the slower, property-by-property path.
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (pairs.length === 0) {
    return name;
  }
  return `${name}[${pairs.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

interface Region {
  readonly at: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly palette: readonly string[];
  readonly indices: Uint32Array;
}

export function readLitematic(root: NbtCompound): SchematicRead {
  const regions = compound(root.Regions);
  if (regions === null) {
    throw new SchematicError("the litematic holds no regions");
  }

  const read: Region[] = [];
  for (const [, raw] of Object.entries(regions)) {
    const region = compound(raw);
    if (region === null) {
      continue;
    }
    const position = compound(region.Position);
    const size = compound(region.Size);
    if (size === null) {
      continue;
    }
    const extent = [int(size.x), int(size.y), int(size.z)] as const;
    const magnitude = extent.map(Math.abs) as unknown as [number, number, number];
    if (magnitude[0] * magnitude[1] * magnitude[2] === 0) {
      continue;
    }
    // A negative extent runs back from the corner, so the corner moves.
    const axes = ["x", "y", "z"] as const;
    const corner = [0, 1, 2].map((axis) => {
      const start = int(position?.[axes[axis] as "x" | "y" | "z"]);
      return (extent[axis] as number) < 0 ? start + (extent[axis] as number) + 1 : start;
    }) as [number, number, number];

    const list = region.BlockStatePalette;
    const palette = Array.isArray(list) ? list.map(stateOf) : ["minecraft:air"];
    const words = region.BlockStates;
    if (!(words instanceof BigInt64Array)) {
      continue;
    }
    const count = magnitude[0] * magnitude[1] * magnitude[2];
    read.push({
      at: corner,
      size: magnitude,
      palette,
      indices: unpack(words, count, bitsFor(palette.length)),
    });
  }

  if (read.length === 0) {
    throw new SchematicError("the litematic holds no blocks");
  }

  // One box around all of them.
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const region of read) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis] as number, region.at[axis] as number);
      high[axis] = Math.max(high[axis] as number, (region.at[axis] as number) + (region.size[axis] as number));
    }
  }
  const width = (high[0] as number) - (low[0] as number);
  const height = (high[1] as number) - (low[1] as number);
  const depth = (high[2] as number) - (low[2] as number);

  // One palette for all of them, since each region brought its own.
  const together: string[] = ["minecraft:air"];
  const known = new Map<string, number>([["minecraft:air", 0]]);
  const indices = new Uint32Array(width * height * depth);

  for (const region of read) {
    const moved = region.palette.map((state) => {
      const seen = known.get(state);
      if (seen !== undefined) {
        return seen;
      }
      const next = together.length;
      together.push(state);
      known.set(state, next);
      return next;
    });
    const [sx, sy, sz] = region.size;
    for (let y = 0; y < (sy as number); y++) {
      for (let z = 0; z < (sz as number); z++) {
        for (let x = 0; x < (sx as number); x++) {
          const from = (y * (sz as number) + z) * (sx as number) + x;
          const state = moved[region.indices[from] as number] ?? 0;
          if (state === 0) {
            continue;
          }
          const gx = (region.at[0] as number) - (low[0] as number) + x;
          const gy = (region.at[1] as number) - (low[1] as number) + y;
          const gz = (region.at[2] as number) - (low[2] as number) + z;
          indices[gx + gz * width + gy * width * depth] = state;
        }
      }
    }
  }

  const metadata = compound(root.Metadata);
  const named = metadata?.Name;
  const tidy = normalise(together, indices);

  return {
    format: "litematica",
    width,
    height,
    depth,
    palette: tidy.palette,
    indices: tidy.indices,
    name: typeof named === "string" && named.length > 0 ? named : null,
    notes: read.length > 1 ? [`${read.length} regions were laid back out into one box.`] : [],
  };
}
