import { z } from "zod";

const integer = z.number().int();
const count = integer.nonnegative();

/**
 * Contents of {@code manifest.json}.
 *
 * <p>Unknown fields are dropped rather than rejected. A newer VoxelPrint may
 * add fields, and an older website should still be able to read those files --
 * the mod bumps {@code formatVersion} only when the meaning of an existing
 * field changes.
 */
export const manifestSchema = z
  .object({
    format: z.literal("mcprint"),
    formatVersion: integer.positive(),
    createdAt: z.string().min(1),
    generator: z.object({
      name: z.string(),
      version: z.string(),
      modLoader: z.string(),
    }),
    minecraftVersion: z.string().min(1),
    dataVersion: integer,
    dimension: z.string().min(1),
    origin: z.object({ x: integer, y: integer, z: integer }),
    size: z.object({
      width: integer.positive(),
      height: integer.positive(),
      depth: integer.positive(),
    }),
    volume: count,
    nonAirBlockCount: count,
    includeAir: z.boolean(),
    blockEntitiesIncluded: z.boolean(),
    entitiesIncluded: z.boolean(),
    structureFormat: z.string().min(1),
    structureFile: z.string().min(1),

    /** Absent on exports made before shapes existed, or with shapes switched off. */
    shapesFile: z.string().min(1).optional(),

    /** Likewise for the real models, which came later still. */
    modelsFile: z.string().min(1).optional(),

    /**
     * Size of the structure palette, air included.
     *
     * <p>Optional because the very first exports called this
     * {@code uniqueBlockStates}. Both are read, see {@link readManifest}.
     */
    paletteSize: count.optional(),
    uniqueBlockStates: count.optional(),
  })
  .refine((manifest) => manifest.volume === manifest.size.width * manifest.size.height * manifest.size.depth, {
    message: "volume does not match width * height * depth",
    path: ["volume"],
  })
  .refine((manifest) => manifest.nonAirBlockCount <= manifest.volume, {
    message: "nonAirBlockCount is larger than volume",
    path: ["nonAirBlockCount"],
  });

export type RawManifest = z.infer<typeof manifestSchema>;

export const blockSummarySchema = z.object({
  includeAir: z.boolean(),
  volume: count,
  nonAirBlockCount: count,
  uniqueBlockTypes: count,
  uniqueBlockStates: count,
  blocks: z.array(
    z.object({
      id: z.string().min(1),
      state: z.string().min(1),
      count: count,
    }),
  ),
});

export type BlockSummary = z.infer<typeof blockSummarySchema>;

/**
 * Contents of {@code shapes.json}: what each block state looks like.
 *
 * <p>One list of axis-aligned boxes per palette entry, in the palette's order.
 * Coordinates are block-local, normally between 0 and 1, but the range is left
 * generous because a block is allowed to reach past its own cube and rejecting
 * a valid export over that would be worse than drawing it.
 */
const boxSchema = z
  .tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
    z.number().finite(),
  ])
  .refine((box) => box[0] < box[3] && box[1] < box[4] && box[2] < box[5], {
    message: "a box must have a positive size on every axis",
  })
  .refine((box) => box.every((value) => value >= -4 && value <= 5), {
    message: "a box reaches absurdly far outside its block",
  });

export const blockShapesSchema = z.object({
  formatVersion: z.number().int().positive(),
  shapes: z.array(z.array(boxSchema).max(64)),
});

export type BlockShapes = z.infer<typeof blockShapesSchema>;

/** A colour as the mod writes it, turned into a plain number on the way in. */
const hexColour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "a colour must look like #rrggbb")
  .transform((value) => Number.parseInt(value.slice(1), 16));

/**
 * Contents of {@code models.json}: the real model of each block state.
 *
 * <p>Where {@code shapes.json} says how much space a block takes, this says
 * what it looks like: a torch is a stick with a flame rather than a thin box,
 * and a piston has separate faces for its casing, its body and its front.
 *
 * <p>Four corners per face, three coordinates each, in the palette's order.
 * The generous coordinate range is the same trade as for the shapes: a block is
 * allowed to reach past its own cube, and rejecting a valid export over that
 * would be worse than drawing it.
 */
const quadSchema = z.object({
  material: count,
  /** Left out by the mod when the model ties the face to no direction. */
  direction: z.string().min(1).max(16).optional(),
  vertices: z
    .array(z.number().finite().min(-4).max(5))
    .length(12, "a face has four corners of three coordinates"),
});

export const blockModelsSchema = z
  .object({
    formatVersion: integer.positive(),
    materials: z
      .array(
        z.object({
          texture: z.string().min(1).max(256),
          /** Present only where the biome tints the texture. */
          tint: hexColour.optional(),
          colour: hexColour,
        }),
      )
      // Roomy, because a texture is no longer one material: a face is cut up to
      // follow it, so one texture can be several colours, and the count follows
      // how varied the build is rather than how many textures it uses.
      .max(65536),
    models: z.array(z.array(quadSchema).max(4096)),
  })
  .refine(
    (file) => file.models.every((quads) => quads.every((quad) => quad.material < file.materials.length)),
    { message: "a face points at a material that is not in the file", path: ["models"] },
  );

export type BlockModels = z.infer<typeof blockModelsSchema>;

/** A manifest with the palette size resolved, whatever the file called it. */
export type Manifest = Omit<RawManifest, "paletteSize" | "uniqueBlockStates"> & {
  paletteSize: number;
};

/**
 * Normalises a parsed manifest.
 *
 * <p>Early exports wrote {@code uniqueBlockStates} where later ones write
 * {@code paletteSize}. The name changed because the old one meant two different
 * things in two files; the value is the same.
 */
export function normaliseManifest(raw: RawManifest): Manifest {
  const { paletteSize, uniqueBlockStates, ...rest } = raw;
  return {
    ...rest,
    paletteSize: paletteSize ?? uniqueBlockStates ?? 0,
  };
}
