import type { FastifyInstance } from "fastify";

/**
 * Fetches a player's skin by name.
 *
 * <p>The browser cannot do this itself. Mojang's profile services send no
 * cross-origin headers, so a page asking for them directly is refused before
 * the request is even made; and the answer needs three hops that would each hit
 * that wall. So the server asks, and the browser asks the server.
 *
 * <p>Nothing is stored. A skin is somebody else's file, fetched because they
 * were named, and keeping copies of them is not something this site needs to be
 * doing. It goes straight back out as the answer.
 */

/** Long enough for a slow lookup, short enough that a dead service gives up. */
const TIMEOUT_MS = 8000;

/**
 * A skin is a small PNG and always has been.
 *
 * <p>The limit is here because the answer comes from somewhere this server does
 * not control, and "the reply is as large as it likes" is not a thing to accept
 * from anywhere.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/** A name is at most sixteen of these; anything else is not worth a request. */
const NAME = /^[A-Za-z0-9_]{1,16}$/;

/** Where the textures themselves may come from. */
const TEXTURE_HOSTS = new Set(["textures.minecraft.net"]);

interface Lookup {
  readonly id: string;
  readonly name: string;
}

interface Profile {
  readonly name?: string;
  readonly properties?: ReadonlyArray<{ name?: string; value?: string }>;
}

interface Textures {
  readonly textures?: {
    readonly SKIN?: { readonly url?: string; readonly metadata?: { readonly model?: string } };
  };
}

async function get(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: accept, "User-Agent": "VoxelPrint" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
}

/**
 * The account id for a name.
 *
 * <p>Two services answer this. The newer one is where Mojang has been moving
 * these lookups; the older one still answers and is what most of the world
 * still calls. Asked in that order rather than picking one, because a name that
 * exists should not fail to resolve over which host happened to be chosen.
 */
async function idOf(name: string): Promise<Lookup | null> {
  const addresses = [
    `https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(name)}`,
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
  ];
  for (const address of addresses) {
    const response = await get(address, "application/json");
    if (response.status === 404 || response.status === 204) {
      return null;
    }
    if (!response.ok) {
      continue;
    }
    const body = (await response.json()) as Partial<Lookup>;
    if (typeof body.id === "string" && body.id.length > 0) {
      return { id: body.id, name: typeof body.name === "string" ? body.name : name };
    }
  }
  throw new Error("Mojang did not answer.");
}

export function registerSkinRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { name?: string } }>("/api/skin", async (request, reply) => {
    const name = (request.query.name ?? "").trim();
    if (!NAME.test(name)) {
      return reply
        .status(400)
        .send({ error: "A player name is up to sixteen letters, digits or underscores." });
    }

    try {
      const found = await idOf(name);
      if (found === null) {
        return reply.status(404).send({ error: `Nobody is called ${name}.` });
      }

      const session = await get(
        `https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(found.id)}`,
        "application/json",
      );
      if (!session.ok) {
        return reply.status(502).send({ error: "Mojang would not say what that skin is." });
      }
      const profile = (await session.json()) as Profile;
      const encoded = profile.properties?.find((property) => property.name === "textures")?.value;
      if (encoded === undefined) {
        return reply.status(404).send({ error: `${found.name} has no skin on record.` });
      }

      const textures = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Textures;
      const skin = textures.textures?.SKIN;
      if (skin?.url === undefined) {
        // Somebody who has never set one: the game shows them a default, which
        // is not a file anybody can be handed.
        return reply.status(404).send({ error: `${found.name} uses the default skin.` });
      }

      // The address comes from a reply rather than from us, so it is checked
      // before it is followed: a profile that named some other host would
      // otherwise have this server fetch whatever it liked.
      const address = new URL(skin.url);
      if (
        (address.protocol !== "https:" && address.protocol !== "http:") ||
        !TEXTURE_HOSTS.has(address.hostname)
      ) {
        request.log.warn({ url: skin.url }, "Skin texture from an unexpected host");
        return reply.status(502).send({ error: "That skin is hosted somewhere unexpected." });
      }
      // Mojang still hands these out as plain http. The host serves the same
      // file over https, so the address is raised to it rather than followed as
      // given -- there is no reason to fetch somebody's skin in the clear.
      address.protocol = "https:";

      const image = await get(address.toString(), "image/png");
      if (!image.ok) {
        return reply.status(502).send({ error: "The skin itself could not be fetched." });
      }
      const bytes = Buffer.from(await image.arrayBuffer());
      if (bytes.length > MAX_BYTES) {
        return reply.status(502).send({ error: "That skin is far larger than a skin should be." });
      }

      return reply.send({
        name: found.name,
        model: skin.metadata?.model === "slim" ? "slim" : "classic",
        png: bytes.toString("base64"),
      });
    } catch (error) {
      request.log.error({ err: error, name }, "Skin lookup failed");
      return reply.status(502).send({ error: "Mojang could not be reached." });
    }
  });
}
