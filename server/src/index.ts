import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerProjectRoutes } from "./routes/projects.js";
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

app.get("/api/health", async () => ({ status: "ok" }));

registerProjectRoutes(app, store);

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
