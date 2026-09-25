import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import Fastify from "fastify";
import { config } from "./config.js";
import { FilamentLibrary } from "./filaments/library.js";
import { registerFilamentRoutes } from "./routes/filaments.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { BlockLibrary } from "./blocks/library.js";
import { LegacyNames } from "./schematic/legacyNames.js";
import { registerSkinRoutes } from "./routes/skins.js";
import { ProjectStore } from "./storage/projectStore.js";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  // Uploads are handled by the multipart plugin, which enforces its own limit.
  bodyLimit: 1024 * 1024,
});

await app.register(fastifyMultipart, {
  limits: {
    fileSize: config.limits.uploadBytes,
    files: 1,
  },
});

await mkdir(config.dataDirectory, { recursive: true });
const store = new ProjectStore(config.dataDirectory);
// What blocks look like, learned from every .mcprint and spent on every
// schematic. A cache: deleting it costs nothing but poorer imports.
const blocks = new BlockLibrary(`${config.dataDirectory}/block-library.json`);
app.log.info({ known: await blocks.load() }, "Block library");
// And what the numbers in pre-1.13 files meant, learned from the files that say.
const legacyNames = new LegacyNames(`${config.dataDirectory}/legacy-block-ids.json`);
app.log.info({ known: await legacyNames.load() }, "Pre-1.13 block ids");

app.get("/api/health", async () => ({ status: "ok" }));

registerProjectRoutes(app, store, blocks, legacyNames);
registerSkinRoutes(app);

/**
 * The filament library, as new as the database is.
 *
 * <p>Checked on start and then once a day, which is how often the database
 * rebuilds itself. A check that finds nothing new costs one conditional
 * request and no body, and a check that cannot reach the database at all costs
 * a line in the log: the snapshot that shipped with the site keeps answering
 * either way.
 */
const filaments = await FilamentLibrary.load(config.webRoot, (message) => app.log.info(message));
registerFilamentRoutes(app, filaments);
filaments.keepFresh(24 * 60 * 60 * 1000, (message) => app.log.info(message));

/**
 * Serves the built frontend, when there is one.
 *
 * <p>In development the frontend runs under Vite on its own port and proxies
 * {@code /api} here, so this directory does not exist yet and is skipped
 * instead of failing the start.
 */
if (existsSync(config.webRoot)) {
  await app.register(fastifyStatic, { root: config.webRoot });

  // Anything that is not an API route belongs to the frontend.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "No such endpoint." });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.log.warn({ webRoot: config.webRoot }, "No built frontend found, serving the API only");
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error({ err: error }, "Failed to start");
  process.exit(1);
}
