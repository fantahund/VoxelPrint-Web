import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ShapeBox } from "../mcprint/readProject.js";
import type { BlockModels } from "../mcprint/schema.js";
import { familyOf, parseState } from "./state.js";

/**
 * What the site has learned blocks look like.
 *
 * <p>A {@code .mcprint} is the only thing that knows both halves: the mod ran
 * inside the game, asked the real renderer what each block state looks like,
 * and wrote the shape and the model out. A schematic knows neither -- it is a
 * list of block state names and nothing else. So every upload leaves what it
 * knew behind here, and an imported schematic is dressed in it afterwards.
 *
 * <p>That is also what makes mods work without anyone writing mod support: the
 * moment one person exports a build containing a modded block, its shape and
 * its colour are known, and everybody importing a schematic with that block
 * gets it. Nothing here is specific to Minecraft's own blocks.
 *
 * <p>The library is deliberately a cache and not a source of truth. It can be
 * deleted and the site keeps working; imports simply fall back further.
 */

/** One face of a model, with its colour already worked out. */
export interface LibraryQuad {
  /** {@code up}, {@code north}, ... or null where the model ties it to none. */
  readonly direction: string | null;
  /** Four corners of three coordinates, block-local. */
  readonly vertices: readonly number[];
  /** The face's colour, tint included. */
  readonly colour: number;
}

/** Everything the library knows about one block state. */
export interface BlockLook {
  /** The space it takes up, as axis-aligned boxes. */
  readonly shape: readonly ShapeBox[];
  /** What it looks like, or empty when the export carried no models. */
  readonly quads: readonly LibraryQuad[];
  /** One colour for the whole block, for when only a colour is wanted. */
  readonly colour: number;
}

/** A look plus where it is filed. */
interface Entry extends BlockLook {
  readonly state: string;
  readonly namespace: string;
  readonly name: string;
  readonly family: string;
  readonly material: string;
  readonly properties: ReadonlyMap<string, string>;
}

/** Coordinates are kept to a tenth of a millimetre of a block, which is plenty. */
const round = (value: number): number => Math.round(value * 10000) / 10000;

/**
 * The average of some colours, in plain linear terms.
 *
 * <p>Not Oklab: this is one number standing in for a whole block when nothing
 * better is known, and the difference between a careful average and a rough
 * one is far smaller than the difference between having one and not.
 */
function blend(colours: readonly number[]): number {
  if (colours.length === 0) {
    return 0x9a9a9a;
  }
  let r = 0;
  let g = 0;
  let b = 0;
  for (const colour of colours) {
    r += (colour >> 16) & 0xff;
    g += (colour >> 8) & 0xff;
    b += colour & 0xff;
  }
  const n = colours.length;
  return ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) >>> 0;
}

export class BlockLibrary {
  private readonly entries = new Map<string, Entry>();
  /** Everything of a family, so a relative can be found without a full scan. */
  private readonly byFamily = new Map<string, Entry[]>();
  /** Everything of a block name, whatever its namespace or properties. */
  private readonly byName = new Map<string, Entry[]>();
  /** Everything made of a material, for borrowing a colour. */
  private readonly byMaterial = new Map<string, Entry[]>();
  private dirty = false;

  constructor(
    private readonly file: string,
    /** A cache that grows without bound is a leak with a long fuse. */
    private readonly limit = 200000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  look(state: string): BlockLook | undefined {
    return this.entries.get(state);
  }

  ofFamily(family: string): readonly Entry[] {
    return this.byFamily.get(family) ?? [];
  }

  ofName(name: string): readonly Entry[] {
    return this.byName.get(name) ?? [];
  }

  ofMaterial(material: string): readonly Entry[] {
    return this.byMaterial.get(material) ?? [];
  }

  /**
   * Learns from an upload.
   *
   * <p>Shapes and models are both optional in an export, and an entry is worth
   * keeping with only one of them: a shape alone still prints, it simply prints
   * as boxes. What is never overwritten is a richer entry by a poorer one -- an
   * export made with models off must not blank out what another upload taught.
   */
  learn(
    palette: readonly string[],
    shapes: ReadonlyArray<readonly ShapeBox[]> | null,
    models: BlockModels | null,
  ): number {
    let learned = 0;
    for (let index = 0; index < palette.length; index++) {
      const state = palette[index] as string;
      if (state === "minecraft:air" || state.endsWith(":air") || this.entries.size >= this.limit) {
        continue;
      }

      const shape = (shapes?.[index] ?? []).map(
        (box) => box.map(round) as unknown as ShapeBox,
      );
      const quads: LibraryQuad[] = [];
      const colours: number[] = [];
      for (const quad of models?.models[index] ?? []) {
        const material = models?.materials[quad.material];
        const colour = material?.tint ?? material?.colour ?? 0x9a9a9a;
        quads.push({
          direction: quad.direction ?? null,
          vertices: quad.vertices.map(round),
          colour,
        });
        colours.push(colour);
      }

      const known = this.entries.get(state);
      if (known !== undefined && known.quads.length >= quads.length && known.shape.length >= shape.length) {
        continue;
      }
      if (shape.length === 0 && quads.length === 0) {
        continue;
      }

      const parsed = parseState(state);
      const { family, material } = familyOf(parsed.name);
      const entry: Entry = {
        state,
        namespace: parsed.namespace,
        name: parsed.name,
        family,
        material,
        properties: parsed.properties,
        shape,
        quads,
        colour: blend(colours),
      };
      this.put(entry, known !== undefined);
      learned++;
    }
    if (learned > 0) {
      this.dirty = true;
    }
    return learned;
  }

  private put(entry: Entry, replacing: boolean): void {
    if (replacing) {
      this.drop(entry.state);
    }
    this.entries.set(entry.state, entry);
    for (const [map, key] of [
      [this.byFamily, entry.family],
      [this.byName, entry.name],
      [this.byMaterial, entry.material],
    ] as const) {
      const list = map.get(key);
      if (list === undefined) {
        map.set(key, [entry]);
      } else {
        list.push(entry);
      }
    }
  }

  private drop(state: string): void {
    const gone = this.entries.get(state);
    if (gone === undefined) {
      return;
    }
    this.entries.delete(state);
    for (const [map, key] of [
      [this.byFamily, gone.family],
      [this.byName, gone.name],
      [this.byMaterial, gone.material],
    ] as const) {
      const list = map.get(key);
      if (list === undefined) {
        continue;
      }
      const at = list.indexOf(gone);
      if (at !== -1) {
        list.splice(at, 1);
      }
    }
  }

  /** Written whole and moved into place, so a crash cannot leave half a file. */
  async save(): Promise<boolean> {
    if (!this.dirty) {
      return false;
    }
    const document = {
      formatVersion: 1,
      savedAt: new Date().toISOString(),
      blocks: [...this.entries.values()].map((entry) => ({
        state: entry.state,
        shape: entry.shape,
        quads: entry.quads,
        colour: entry.colour,
      })),
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    const beside = `${this.file}.writing`;
    await writeFile(beside, JSON.stringify(document), "utf-8");
    await rename(beside, this.file);
    this.dirty = false;
    return true;
  }

  /** Reads what earlier runs learned. A missing or broken file is simply empty. */
  async load(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      return 0;
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      return 0;
    }
    const blocks = (document as { blocks?: unknown }).blocks;
    if (!Array.isArray(blocks)) {
      return 0;
    }
    for (const block of blocks as Array<Record<string, unknown>>) {
      const state = block.state;
      if (typeof state !== "string") {
        continue;
      }
      const parsed = parseState(state);
      const { family, material } = familyOf(parsed.name);
      this.put(
        {
          state,
          namespace: parsed.namespace,
          name: parsed.name,
          family,
          material,
          properties: parsed.properties,
          shape: (block.shape as ShapeBox[]) ?? [],
          quads: (block.quads as LibraryQuad[]) ?? [],
          colour: typeof block.colour === "number" ? block.colour : 0x9a9a9a,
        },
        this.entries.has(state),
      );
    }
    this.dirty = false;
    return this.entries.size;
  }
}

export type { Entry as LibraryEntry };
