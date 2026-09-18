import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectContents } from "../mcprint/readProject.js";
import type { BlockModels } from "../mcprint/schema.js";
import type { PrintingPlan, StoredPrintingPlan } from "../printing.js";

/** A stored project as the API hands it out. */
export interface StoredProject {
  readonly id: string;
  readonly uploadedAt: string;
  readonly fileName: string;
  readonly contents: ProjectContents;
}

/**
 * Keeps uploaded projects on disk.
 *
 * <p>One directory per project, holding the original archive and the parsed
 * description. No database yet: the data is small, self-contained and read far
 * more often than written. Swapping this out later touches only this file.
 */
export class ProjectStore {
  constructor(private readonly root: string) {}

  async save(
    fileName: string,
    archive: Uint8Array,
    contents: ProjectContents,
    indices: Uint8Array,
    models: BlockModels | null,
  ): Promise<StoredProject> {
    const project: StoredProject = {
      id: randomUUID(),
      uploadedAt: new Date().toISOString(),
      fileName,
      contents,
    };

    const directory = this.directoryFor(project.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "source.mcprint"), archive);
    await writeFile(path.join(directory, "indices.bin"), indices);
    if (models !== null) {
      // Kept out of the project document and fetched on its own: it is read
      // once when the viewer starts and would otherwise be re-sent with every
      // look at the project.
      await writeFile(path.join(directory, "models.json"), JSON.stringify(models), "utf-8");
    }
    await writeFile(path.join(directory, "project.json"), JSON.stringify(project, null, 2), "utf-8");

    return project;
  }

  async load(id: string): Promise<StoredProject | null> {
    const directory = this.directoryFor(id);
    try {
      const raw = await readFile(path.join(directory, "project.json"), "utf-8");
      return JSON.parse(raw) as StoredProject;
    } catch {
      return null;
    }
  }

  /** Reads back the archive exactly as it was uploaded. */
  async loadArchive(id: string): Promise<Uint8Array | null> {
    return this.loadFile(id, "source.mcprint");
  }

  /**
   * Writes the printing plan.
   *
   * <p>A file of its own rather than a field in the project document: the
   * project describes what was uploaded and never changes, the plan is edited
   * constantly. Keeping them apart means a plan can never damage the record of
   * the upload.
   */
  async savePrinting(id: string, plan: PrintingPlan): Promise<StoredPrintingPlan> {
    const stored: StoredPrintingPlan = { ...plan, updatedAt: new Date().toISOString() };
    const directory = this.directoryFor(id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "printing.json"), JSON.stringify(stored, null, 2), "utf-8");
    return stored;
  }

  /** The stored plan, or null when none was ever saved. */
  async loadPrinting(id: string): Promise<StoredPrintingPlan | null> {
    try {
      const raw = await readFile(path.join(this.directoryFor(id), "printing.json"), "utf-8");
      return JSON.parse(raw) as StoredPrintingPlan;
    } catch {
      return null;
    }
  }

  /** The packed block indices, served to the browser as they are. */
  async loadIndices(id: string): Promise<Uint8Array | null> {
    return this.loadFile(id, "indices.bin");
  }

  /**
   * The real models, as the bytes they were stored as.
   *
   * <p>Handed out unparsed: it was validated on the way in and never changes,
   * so parsing it here only to serialise it again would be work for nothing.
   */
  async loadModels(id: string): Promise<Uint8Array | null> {
    return this.loadFile(id, "models.json");
  }

  private async loadFile(id: string, name: string): Promise<Uint8Array | null> {
    try {
      return await readFile(path.join(this.directoryFor(id), name));
    } catch {
      return null;
    }
  }

  /**
   * Resolves a project directory.
   *
   * <p>Ids come from the URL, so they are checked rather than trusted. Only a
   * UUID is accepted, which cannot contain a path separator, and the result is
   * verified to stay under the data directory regardless.
   */
  private directoryFor(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new Error(`Not a project id: ${id}`);
    }
    const directory = path.resolve(this.root, id);
    if (!directory.startsWith(path.resolve(this.root))) {
      throw new Error(`Project id escapes the data directory: ${id}`);
    }
    return directory;
  }
}
