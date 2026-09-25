/**
 * What every schematic format boils down to.
 *
 * <p>Three formats go in and one thing comes out, laid out exactly as a
 * {@code .mcprint} lays its blocks out, so that everything downstream -- the
 * viewer, the exporter, the splitter, the printability check -- cannot tell the
 * difference and does not have to.
 */
export interface SchematicRead {
  readonly format: "sponge" | "litematica" | "mcedit";
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** Block states, air included. Index 0 is air by construction. */
  readonly palette: readonly string[];
  /** {@code x + z * width + y * width * depth}, as the rest of the site reads it. */
  readonly indices: Uint32Array;
  /** What the file called itself, when it says. */
  readonly name: string | null;
  /** Anything worth telling the person who uploaded it. */
  readonly notes: readonly string[];
}

export class SchematicError extends Error {}

/** Every schematic is laid out y, then z, then x. The site is not. */
export function reorder(
  source: Uint32Array,
  width: number,
  height: number,
  depth: number,
): Uint32Array {
  const out = new Uint32Array(width * height * depth);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < depth; z++) {
      for (let x = 0; x < width; x++) {
        out[x + z * width + y * width * depth] = source[(y * depth + z) * width + x] as number;
      }
    }
  }
  return out;
}

/**
 * Puts air first and drops what nothing points at.
 *
 * <p>The rest of the site assumes a palette it can ask "is this air" about by
 * name, and a schematic is free to put air anywhere or leave it out entirely.
 */
export function normalise(
  palette: readonly string[],
  indices: Uint32Array,
): { palette: string[]; indices: Uint32Array } {
  const used = new Set<number>();
  for (const index of indices) {
    used.add(index);
  }

  const out: string[] = ["minecraft:air"];
  const moved = new Map<number, number>();
  for (const index of used) {
    const state = palette[index] ?? "minecraft:air";
    const bare = state.split("[")[0] as string;
    if (bare === "minecraft:air" || bare === "minecraft:cave_air" || bare === "minecraft:void_air") {
      moved.set(index, 0);
      continue;
    }
    moved.set(index, out.length);
    out.push(state);
  }

  const packed = new Uint32Array(indices.length);
  for (let at = 0; at < indices.length; at++) {
    packed[at] = moved.get(indices[at] as number) ?? 0;
  }
  return { palette: out, indices: packed };
}
