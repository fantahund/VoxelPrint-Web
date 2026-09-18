import { oklabDistance, toOklab } from "../colour";

export interface FilamentSlot {
  readonly name: string;
  /** Print colour as 0xRRGGBB. */
  readonly colour: number;
}

/**
 * The standard colours, in the order they are handed out.
 *
 * <p>One ordered list rather than a table of ready made sets, because the
 * filament count is free to choose: taking the first four gives the four colour
 * set, the first eight the eight colour one, and an unusual count is no longer
 * a gap in a table.
 *
 * <p>Light, dark, wood and green first, because those four carry most of a
 * build; the rest widen the range rather than refine it.
 */
const STANDARD_COLOURS: readonly number[] = [
  0xd8d8d8, // white
  0x2f2f33, // near black
  0x8a5a2b, // wood brown
  0x4a8a3a, // leaf green
  0x8a8a8a, // stone grey
  0xb03030, // red
  0x3050a0, // blue
  0xd0b040, // yellow
  0x6a3f8a, // purple
  0xc86a20, // orange
  0x2f7f77, // teal
  0xe0c9a6, // sand
];

/** How many filaments may be asked for. Well past any real printer. */
export const MAX_SLOTS = 64;

/** The counts offered as a shortcut. Any other number can still be typed in. */
export const SLOT_COUNTS = [1, 2, 4, 6, 8] as const;

/**
 * The standard set at a given size.
 *
 * <p>Past the end of the list the colours are spread around the hue circle, so
 * asking for more than there are named ones still gives distinguishable
 * filaments rather than repeats.
 */
export function standardPalette(count: number): FilamentSlot[] {
  const wanted = Math.max(1, Math.min(Math.round(count), MAX_SLOTS));
  const slots: FilamentSlot[] = [];
  for (let i = 0; i < wanted; i++) {
    slots.push({
      name: `Filament ${i + 1}`,
      colour: STANDARD_COLOURS[i] ?? spreadHue(i - STANDARD_COLOURS.length),
    });
  }
  return slots;
}

/** A colour off the hue circle, for counts past the named list. */
function spreadHue(index: number): number {
  // The golden angle, so consecutive colours stay far apart however many there
  // are, rather than clustering the way a fixed step does.
  const hue = (index * 137.508) % 360;
  const c = 0.55;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];
  const to = (v: number): number => Math.round((v + 0.25) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

/** A block type and what it looks like, as the caller worked it out. */
export interface ColouredBlock {
  readonly id: string;
  /** What the block looks like in Minecraft, as 0xRRGGBB. */
  readonly colour: number;
}

/**
 * Assigns every block type to the filament that looks most like it.
 *
 * <p>A starting point, not an answer: the point of the screen is that the user
 * overrides it. Starting from an empty mapping would mean assigning thirty
 * block types by hand before seeing anything.
 *
 * <p>The colours are passed in rather than looked up here, because where they
 * come from matters: an export with real models carries the measured colour of
 * every texture, and matching against that is worth far more than matching
 * against a table of guesses.
 */
export function autoAssign(
  blocks: readonly ColouredBlock[],
  slots: readonly FilamentSlot[],
): Record<string, number> {
  // Converted once per filament rather than once per comparison.
  const slotColours = slots.map((slot) => toOklab(slot.colour));
  const assignment: Record<string, number> = {};

  for (const { id, colour } of blocks) {
    const blockColour = toOklab(colour);
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < slotColours.length; i++) {
      const candidate = oklabDistance(blockColour, slotColours[i] as ReturnType<typeof toOklab>);
      if (candidate < bestDistance) {
        bestDistance = candidate;
        best = i;
      }
    }
    assignment[id] = best;
  }
  return assignment;
}

export function toHex(colour: number): string {
  return `#${colour.toString(16).padStart(6, "0")}`;
}

export function fromHex(value: string): number {
  const parsed = Number.parseInt(value.replace("#", ""), 16);
  return Number.isNaN(parsed) ? 0x000000 : parsed & 0xffffff;
}
