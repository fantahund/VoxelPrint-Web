import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { McPrintError } from "../mcprint/archive.js";
import { readProject } from "../mcprint/readProject.js";
import type { BlockLibrary } from "../blocks/library.js";
import { dress } from "../schematic/dress.js";
import { readSchematic, SchematicError } from "../schematic/read.js";
import { printingPlanSchema } from "../printing.js";
import type { ProjectStore } from "../storage/projectStore.js";

const ACCEPTED_EXTENSION = ".mcprint";
/**
 * Schematics, which carry names and nothing else.
 *
 * <p>Taken on the same endpoint as an export rather than a separate one,
 * because what comes back is the same project either way and the person
 * uploading is doing the same thing.
 */
const SCHEMATICS = [".schem", ".litematic", ".schematic", ".nbt"];

export function registerProjectRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  library: BlockLibrary,
): void {
  /** Accepts an upload and answers with what the file contains. */
  app.post("/api/projects", async (request, reply) => {
    const upload = await request.file();
    if (upload === undefined) {
      return reply.status(400).send({ error: "No file was sent." });
    }

    const name = upload.filename.toLowerCase();
    const schematic = SCHEMATICS.find((suffix) => name.endsWith(suffix));
    if (!name.endsWith(ACCEPTED_EXTENSION) && schematic === undefined) {
      return reply
        .status(415)
        .send({ error: `Only ${ACCEPTED_EXTENSION} and ${SCHEMATICS.join(", ")} files are accepted.` });
    }

    const archive = await upload.toBuffer();
    if (upload.file.truncated) {
      return reply
        .status(413)
        .send({ error: `The file is larger than the allowed ${config.limits.uploadBytes} bytes.` });
    }

    if (schematic !== undefined) {
      try {
        const read = readSchematic(archive, config.limits.structureBytes);
        const built = dress(read, library, `source${schematic}`);
        const project = await store.save(
          upload.filename,
          archive,
          built.contents,
          built.indices,
          built.models,
          `source${schematic}`,
        );
        return reply.status(201).send({
          ...project,
          imported: { ...built.report, format: read.format, notes: read.notes },
        });
      } catch (error) {
        if (error instanceof SchematicError) {
          return reply.status(422).send({ error: error.message });
        }
        request.log.error({ err: error }, "Failed to read a schematic");
        return reply.status(500).send({ error: "The schematic could not be read." });
      }
    }

    try {
      const { contents, indices, models } = readProject(archive, {
        manifestBytes: config.limits.manifestBytes,
        blockSummaryBytes: config.limits.blockSummaryBytes,
        structureBytes: config.limits.structureBytes,
        shapesBytes: config.limits.shapesBytes,
        modelsBytes: config.limits.modelsBytes,
      });
      // Everything an export knows about how blocks look is worth keeping: it
      // is the only place that knowledge ever comes from, and it is what every
      // later schematic import is dressed in.
      const learned = library.learn(contents.structure.palette, contents.structure.shapes, models);
      if (learned > 0) {
        request.log.info({ learned, known: library.size }, "Learned block shapes from an upload");
        void library.save().catch((error: unknown) => {
          request.log.warn({ err: error }, "Could not write the block library");
        });
      }
      const project = await store.save(upload.filename, archive, contents, indices, models);
      return reply.status(201).send(project);
    } catch (error) {
      if (error instanceof McPrintError) {
        // Wrong or damaged input is an everyday event, not a server fault.
        return reply.status(422).send({ error: error.message });
      }
      request.log.error({ err: error }, "Failed to read an upload");
      return reply.status(500).send({ error: "The file could not be read." });
    }
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    let project = null;
    try {
      project = await store.load(request.params.id);
    } catch {
      // A malformed id is simply not found, rather than an error worth naming.
      project = null;
    }
    if (project === null) {
      return reply.status(404).send({ error: "No such project." });
    }
    // The plan travels with the project so opening a link restores the whole
    // screen in one request.
    return { ...project, printing: await store.loadPrinting(request.params.id) };
  });

  /** Stores which block prints in which filament. */
  app.put<{ Params: { id: string } }>("/api/projects/:id/printing", async (request, reply) => {
    let exists = false;
    try {
      exists = (await store.load(request.params.id)) !== null;
    } catch {
      exists = false;
    }
    if (!exists) {
      return reply.status(404).send({ error: "No such project." });
    }

    const plan = printingPlanSchema.safeParse(request.body);
    if (!plan.success) {
      const first = plan.error.issues[0];
      const where = first?.path.join(".") ?? "plan";
      return reply
        .status(422)
        .send({ error: `${where}: ${first?.message ?? "the plan is not valid"}` });
    }

    return store.savePrinting(request.params.id, plan.data);
  });

  /**
   * The block indices as raw bytes.
   *
   * <p>Separate from the project document and deliberately not JSON: a million
   * blocks are a megabyte here and roughly four times that as a list of
   * numbers, which the browser would then have to parse before it could draw
   * anything. The layout is described by the project's structure info.
   */
  app.get<{ Params: { id: string } }>("/api/projects/:id/indices", async (request, reply) => {
    let indices = null;
    try {
      indices = await store.loadIndices(request.params.id);
    } catch {
      indices = null;
    }
    if (indices === null) {
      return reply.status(404).send({ error: "No such project." });
    }
    return reply
      .header("Content-Type", "application/octet-stream")
      // Immutable: a project never changes once uploaded.
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(Buffer.from(indices));
  });

  /**
   * The real model of every block state.
   *
   * <p>Fetched separately for the same reason as the indices: it is wanted once
   * when the viewer starts, not on every look at the project. Sent back exactly
   * as it was stored, which is exactly what was validated on upload.
   */
  app.get<{ Params: { id: string } }>("/api/projects/:id/models", async (request, reply) => {
    let models = null;
    try {
      models = await store.loadModels(request.params.id);
    } catch {
      models = null;
    }
    if (models === null) {
      return reply.status(404).send({ error: "This project carries no models." });
    }
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(Buffer.from(models));
  });
}
