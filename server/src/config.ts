import path from "node:path";

const MEGABYTE = 1024 * 1024;

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${raw}`);
  }
  return value;
}

/**
 * Everything the server needs to know, in one place and overridable by
 * environment variables so the container needs no rebuild to be reconfigured.
 */
export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: number("PORT", 3000),

  /** Where uploaded projects live. */
  dataDirectory: path.resolve(process.env.VOXELPRINT_DATA_DIR ?? "data"),

  /** The built frontend, served in production. */
  webRoot: path.resolve(process.env.VOXELPRINT_WEB_ROOT ?? "../web/dist"),

  limits: {
    /** Largest upload accepted at all. */
    uploadBytes: number("VOXELPRINT_MAX_UPLOAD_BYTES", 64 * MEGABYTE),

    /**
     * Largest unpacked size per archive entry, checked before unpacking.
     *
     * <p>One limit per entry, sized to what that entry plausibly is. A zip
     * archive declares the uncompressed size of every entry up front, so a
     * manifest that claims to unpack into two hundred megabytes is rejected
     * without decompressing a single byte.
     */
    manifestBytes: number("VOXELPRINT_MAX_MANIFEST_BYTES", MEGABYTE),
    blockSummaryBytes: number("VOXELPRINT_MAX_SUMMARY_BYTES", 16 * MEGABYTE),
    structureBytes: number("VOXELPRINT_MAX_STRUCTURE_BYTES", 256 * MEGABYTE),
    shapesBytes: number("VOXELPRINT_MAX_SHAPES_BYTES", 32 * MEGABYTE),

    /**
     * Roomier than the shapes, because a model carries twelve coordinates per
     * face where a shape carries six per whole block. It still grows with the
     * palette rather than with the number of blocks.
     */
    modelsBytes: number("VOXELPRINT_MAX_MODELS_BYTES", 64 * MEGABYTE),
  },
} as const;
