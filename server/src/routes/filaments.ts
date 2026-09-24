import type { FastifyInstance } from "fastify";
import type { FilamentLibrary } from "../filaments/library.js";

/**
 * Hands out the filament library.
 *
 * <p>Answered from memory, and cached by the browser for an hour with an ETag,
 * because the same seven hundred kilobytes for every visit of every session is
 * seven hundred kilobytes wasted. The version in the ETag is the database's
 * own, so a refreshed library invalidates it by itself.
 */
export function registerFilamentRoutes(app: FastifyInstance, library: FilamentLibrary): void {
  app.get("/api/filaments", async (request, reply) => {
    const { body, etag } = library.current();
    if (request.headers["if-none-match"] === etag) {
      return reply.status(304).send();
    }
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .header("ETag", etag)
      .send(body);
  });
}
