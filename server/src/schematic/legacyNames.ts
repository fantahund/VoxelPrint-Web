import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { knowsLegacy } from "./legacy.js";

/**
 * Numbers that mean something, learned from the files that say so.
 *
 * <p>A pre-1.13 schematic stores a block as a number. Some writers -- Schematica
 * among them -- leave their own list of what those numbers meant beside the
 * blocks, and that list is the only thing that can carry a modded block through
 * the old format. Most files do not. So the lists that do arrive are kept, and
 * spent on the files that bring none.
 *
 * <p>There is a real limit to this and it is worth being plain about, because
 * the failure is a confidently wrong building rather than an error. Vanilla
 * ids were fixed, but a mod's id was handed out when that modpack was first
 * run: id 200 is one block in one pack and another block in the next. A name
 * learnt from somebody else's file is therefore a good guess and not a fact.
 *
 * <p>Three things follow, and together they are what makes this safe enough to
 * do at all. The built-in table always wins, so no borrowed list can move a
 * vanilla block. Files vote, so a name six files agree on outranks one that a
 * single file claimed. And an id the files disagree about is treated as
 * unknown rather than decided by a majority of two.
 */

interface Vote {
  readonly names: Map<string, number>;
}

export interface LegacyName {
  readonly name: string;
  /** How many uploads said so. */
  readonly agreement: number;
  /** Whether any upload said something else. */
  readonly contested: boolean;
}

export class LegacyNames {
  private readonly votes = new Map<number, Vote>();
  private dirty = false;

  constructor(
    private readonly file: string,
    private readonly limit = 20000,
  ) {}

  get size(): number {
    return this.votes.size;
  }

  /**
   * Takes in a list a file brought with it.
   *
   * <p>Ids the built-in table already covers are ignored rather than stored:
   * they cannot be improved on and a file claiming stone is something else is
   * a file to disbelieve.
   */
  learn(mapping: ReadonlyMap<number, string>): number {
    let learned = 0;
    for (const [id, raw] of mapping) {
      if (knowsLegacy(id) || this.votes.size >= this.limit) {
        continue;
      }
      const name = raw.includes(":") ? raw : `minecraft:${raw}`;
      const vote = this.votes.get(id) ?? { names: new Map<string, number>() };
      vote.names.set(name, (vote.names.get(name) ?? 0) + 1);
      this.votes.set(id, vote);
      learned++;
    }
    if (learned > 0) {
      this.dirty = true;
    }
    return learned;
  }

  /** What an id most likely means, or nothing when the files disagree. */
  nameOf(id: number): LegacyName | null {
    const vote = this.votes.get(id);
    if (vote === undefined) {
      return null;
    }
    let best = "";
    let most = 0;
    let total = 0;
    let others = 0;
    for (const [name, count] of vote.names) {
      total += count;
      if (count > most) {
        others += most;
        most = count;
        best = name;
      } else {
        others += count;
      }
    }
    if (best === "" || total === 0) {
      return null;
    }
    // A disagreement is not settled by one vote more. Either the files are
    // from the same pack and agree, or they are not and nothing here is known.
    if (others > 0 && most < others * 3) {
      return null;
    }
    return { name: best, agreement: most, contested: others > 0 };
  }

  /** Everything known, for handing to a reader in one go. */
  lookup(): ReadonlyMap<number, LegacyName> {
    const out = new Map<number, LegacyName>();
    for (const id of this.votes.keys()) {
      const known = this.nameOf(id);
      if (known !== null) {
        out.set(id, known);
      }
    }
    return out;
  }

  async save(): Promise<boolean> {
    if (!this.dirty) {
      return false;
    }
    const document = {
      formatVersion: 1,
      savedAt: new Date().toISOString(),
      ids: [...this.votes.entries()].map(([id, vote]) => ({
        id,
        names: [...vote.names.entries()].map(([name, count]) => ({ name, count })),
      })),
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    const beside = `${this.file}.writing`;
    await writeFile(beside, JSON.stringify(document), "utf-8");
    await rename(beside, this.file);
    this.dirty = false;
    return true;
  }

  async load(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf-8");
    } catch {
      return 0;
    }
    try {
      const document = JSON.parse(raw) as {
        ids?: Array<{ id?: unknown; names?: Array<{ name?: unknown; count?: unknown }> }>;
      };
      for (const entry of document.ids ?? []) {
        if (typeof entry.id !== "number") {
          continue;
        }
        const names = new Map<string, number>();
        for (const { name, count } of entry.names ?? []) {
          if (typeof name === "string" && typeof count === "number") {
            names.set(name, count);
          }
        }
        if (names.size > 0) {
          this.votes.set(entry.id, { names });
        }
      }
    } catch {
      return 0;
    }
    this.dirty = false;
    return this.votes.size;
  }
}
