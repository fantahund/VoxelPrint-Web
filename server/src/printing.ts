import { z } from "zod";

/**
 * Upper bounds on a printing plan.
 *
 * <p>The plan arrives over the network and lands on disk, so its size is
 * capped. The filament count is free to choose, so the cap is well past any
 * real printer rather than at it -- sixty-four slots is a few kilobytes, and a
 * few thousand block types covers a heavily modded build; anything past that is
 * not a plan, it is someone filling up the disk.
 */
const MAX_SLOTS = 64;
const MAX_BLOCK_TYPES = 4096;
/**
 * How many blocks a plan may say were taken out by hand.
 *
 * <p>One per block of the largest selection the mod will export, so a plan can
 * remove all of them and still be stored.
 */
const MAX_REMOVED = 1 << 20;
const MAX_NAME_LENGTH = 64;
const MAX_BLOCK_ID_LENGTH = 256;

const slotSchema = z.object({
  name: z.string().max(MAX_NAME_LENGTH),
  colour: z.number().int().min(0).max(0xffffff),
});

export const printingPlanSchema = z
  .object({
    slots: z.array(slotSchema).min(1).max(MAX_SLOTS),
    assignment: z.record(
      z.string().min(1).max(MAX_BLOCK_ID_LENGTH),
      z.number().int().min(0).max(MAX_SLOTS - 1),
    ),
    // Indices into the selection. Absent on a plan written before the preview
    // could edit one, which must keep loading.
    removed: z.array(z.number().int().min(0)).max(MAX_REMOVED).optional(),
  })
  .refine((plan) => Object.keys(plan.assignment).length <= MAX_BLOCK_TYPES, {
    message: `an assignment may name at most ${MAX_BLOCK_TYPES} block types`,
    path: ["assignment"],
  })
  .refine(
    (plan) => Object.values(plan.assignment).every((slot) => slot < plan.slots.length),
    {
      // Otherwise a reload would show a block assigned to a filament that is
      // not there, which the interface would have to guess its way out of.
      message: "an assignment points at a filament that does not exist",
      path: ["assignment"],
    },
  );

export type PrintingPlan = z.infer<typeof printingPlanSchema>;

/** A stored plan, with the time it was last written. */
export interface StoredPrintingPlan extends PrintingPlan {
  readonly updatedAt: string;
}
