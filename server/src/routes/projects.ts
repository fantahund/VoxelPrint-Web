import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { McPrintError } from "../mcprint/archive.js";
import { readProject } from "../mcprint/readProject.js";
import { printingPlanSchema } from "../printing.js";
import type { ProjectStore } from "../storage/projectStore.js";

const ACCEPTED_EXTENSION = ".mcprint";

export function registerProjectRoutes(app: FastifyInstance, store: ProjectStore): void {
  /** Accepts an upload and answers with what the file contains. */
  app.post("/api/projects", async (request, reply) => {
    const upload = await request.file();
    if (upload === undefined) {
      return reply.status(400).send({ error: "No file was sent." });
    }

    if (!upload.filename.toLowerCase().endsWith(ACCEPTED_EXTENSION)) {
      return reply.status(415).send({ error: "Only .mcprint files are accepted." });
    }

    const archive = await upload.toBuffer();
    if (upload.file.truncated) {
      return reply
        .status(413)
        .send({ error: `The file is larger than the allowed ${config.limits.uploadBytes} bytes.` });
    }

    try {
      const { contents, indices, models } = readProject(archive, {
        manifestBytes: config.limits.manifestBytes,
        blockSummaryBytes: config.limits.blockSummaryBytes,
        structureBytes: config.limits.structureBytes,
        shapesBytes: config.limits.shapesBytes,
        modelsBytes: config.limits.modelsBytes,
      });
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
