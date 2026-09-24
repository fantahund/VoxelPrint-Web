/**
 * The slab a build stands on, and the name written across the front of it.
 *
 * <p>Two reasons for it, and the second is the one that pays. A printed village
 * with nothing under it is a village that arrives as a bag of loose houses: the
 * plate is what holds a build together while it comes off the plate and while
 * somebody carries it about. And a name along the front is the difference
 * between a print and a thing on a shelf.
 *
 * <p>The letters stand proud rather than being cut in. Cut in, they need the
 * nozzle to reach into a groove narrower than it is, and they fill with the
 * colour of the plate; standing proud they print flat on top of a flat surface,
 * and on a printer with more than one filament they come out in a colour of
 * their own without a single support.
 *
 * <p>Everything here is worked out in the build's own coordinates -- blocks,
 * centred on the model, the way {@link buildVoxels} leaves it -- so the preview
 * and the writers can each place it their own way from the same numbers.
 */

import type { VoxelModel } from "../viewer/buildVoxels";

/** A box in the build's own coordinates: minX, minY, minZ, maxX, maxY, maxZ. */
export type PlateBox = readonly [number, number, number, number, number, number];

/** One piece of the plate, and which filament it prints in. */
export interface PlatePart {
  readonly box: PlateBox;
  readonly slot: number;
}

export type Plate = "off" | "plain" | "labelled";

export interface PlateOptions {
  readonly plate: Plate;
  /** How thick the slab is, in millimetres. */
  readonly plateMillimetres: number;
  /** How far it reaches past the build on every side, in millimetres. */
  readonly plateMargin: number;
  /** What is written on it. Blank writes nothing, whatever the mode. */
  readonly label: string;
  /** How tall a capital letter is, in millimetres. */
  readonly labelMillimetres: number;
  readonly plateSlot: number;
  readonly labelSlot: number;
}

/**
 * A five by seven pixel alphabet, a row per character.
 *
 * <p>Written out rather than taken from a font file for two reasons. A font has
 * curves, and curves at this size come out as a mess of boxes a tenth of a
 * millimetre across; and a build made of blocks wants letters made of blocks.
 * Five by seven is the smallest that still reads: a four wide S is a Z.
 *
 * <p>Anything not here is left out rather than drawn as a box, so an unexpected
 * character costs a gap and not a wrong letter.
 */
const GLYPHS: Readonly<Record<string, string>> = {
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01110/10001/10000/10000/10000/10001/01110",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01110/10001/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "11111/00100/00100/00100/00100/00100/11111",
  J: "00111/00010/00010/00010/00010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/10101/10011/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/11011/10001",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
  "0": "01110/10001/10011/10101/11001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111",
  "3": "11111/00010/00100/00010/00001/10001/01110",
  "4": "00010/00110/01010/10010/11111/00010/00010",
  "5": "11111/10000/11110/00001/00001/10001/01110",
  "6": "00110/01000/10000/11110/10001/10001/01110",
  "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110",
  "9": "01110/10001/10001/01111/00001/00010/01100",
  "-": "00000/00000/00000/11111/00000/00000/00000",
  _: "00000/00000/00000/00000/00000/00000/11111",
  ".": "00000/00000/00000/00000/00000/01100/01100",
  "'": "01100/01100/01000/00000/00000/00000/00000",
  "!": "00100/00100/00100/00100/00100/00000/00100",
  "?": "01110/10001/00001/00010/00100/00000/00100",
  "#": "01010/01010/11111/01010/11111/01010/01010",
  "(": "00010/00100/01000/01000/01000/00100/00010",
  ")": "01000/00100/00010/00010/00010/00100/01000",
  "+": "00000/00100/00100/11111/00100/00100/00000",
  ":": "00000/01100/01100/00000/01100/01100/00000",
};

/**
 * One letter's pixels, for anybody who wants to check what was drawn.
 *
 * <p>Exported so a test can rebuild a letter off the boxes and hold it against
 * this. Measuring how wide each row came out is not the same check: an E is the
 * same widths upside down, and widths cannot see a left to right mirror at all.
 */
export function glyph(character: string): readonly string[] | undefined {
  return GLYPHS[character.toUpperCase()]?.split("/");
}

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Blank columns between letters, and the width of a space. */
const TRACKING = 1;
const SPACE = 3;

/** How proud of the plate the letters stand, as a share of a pixel. */
const RELIEF = 1;

/**
 * What is actually written, once what cannot be drawn is taken out.
 *
 * <p>Upper case throughout: the alphabet has one case, and a name in it reads
 * as a label rather than as a mistake.
 */
export function readable(label: string): string {
  return [...label.toUpperCase()]
    .filter((character) => character === " " || GLYPHS[character] !== undefined)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** How wide a line of it is, in pixels. */
function widthOf(text: string): number {
  let width = 0;
  for (const character of text) {
    width += character === " " ? SPACE + TRACKING : GLYPH_WIDTH + TRACKING;
  }
  return Math.max(width - TRACKING, 0);
}

/**
 * The plate under a build, and its label, as boxes in the build's own
 * coordinates.
 *
 * <p>Empty when there is no plate to make, which the callers take as "draw
 * nothing" without having to know why.
 */
export function plateOf(
  model: VoxelModel,
  millimetresPerBlock: number,
  options: PlateOptions,
): PlatePart[] {
  if (options.plate === "off") {
    return [];
  }

  const scale = millimetresPerBlock;
  const thickness = Math.max(options.plateMillimetres, 0) / scale;
  if (thickness <= 0) {
    return [];
  }
  const margin = Math.max(options.plateMargin, 0) / scale;

  const halfWidth = model.size.width / 2;
  const halfDepth = model.size.depth / 2;
  const floor = -model.size.height / 2;

  const text = options.plate === "labelled" ? readable(options.label) : "";
  // Asked for, but no wider than the plate it is written on. A long name at a
  // letter height chosen for a short one runs off both ends -- measured, a
  // fifteen character name at eight millimetres made the plate of a fifty
  // millimetre build ninety-nine millimetres wide, which is a label with a
  // build attached rather than the other way about.
  const asked = text === "" ? 0 : Math.max(options.labelMillimetres, 0) / scale / GLYPH_HEIGHT;
  const room = (halfWidth + margin) * 2 - margin * 2;
  const pixel =
    text === "" ? 0 : Math.min(asked, widthOf(text) > 0 ? room / widthOf(text) : asked);
  // The front of the plate grows to make room for the writing, with a margin's
  // worth of room above and below it. Nothing is written on a plate that would
  // have to be all label and no build.
  const lip = text === "" ? 0 : pixel * GLYPH_HEIGHT + margin * 2;

  const parts: PlatePart[] = [
    {
      box: [
        -halfWidth - margin,
        floor - thickness,
        -halfDepth - margin,
        halfWidth + margin,
        floor,
        halfDepth + margin + lip,
      ],
      slot: options.plateSlot,
    },
  ];

  if (text === "") {
    return parts;
  }

  // Centred across the plate, sitting in the lip, and reading the way somebody
  // standing in front of the shelf reads it: the build's front is its high z,
  // and so is the front of the plate.
  const width = widthOf(text) * pixel;
  const left = -width / 2;
  const top = halfDepth + margin + lip - margin;

  let at = left;
  for (const character of text) {
    if (character === " ") {
      at += (SPACE + TRACKING) * pixel;
      continue;
    }
    const rows = (GLYPHS[character] as string).split("/");
    rows.forEach((row, line) => {
      // Run the lit pixels of a row together into one box: a letter is a
      // handful of bars rather than thirty five little cubes, which is fewer
      // solids for the slicer and the same shape to the last decimal.
      let from = -1;
      for (let column = 0; column <= GLYPH_WIDTH; column++) {
        const lit = column < GLYPH_WIDTH && row[column] === "1";
        if (lit && from < 0) {
          from = column;
        } else if (!lit && from >= 0) {
          parts.push({
            box: [
              at + from * pixel,
              floor,
              // The writing lies flat and faces up, so it is read by somebody
              // standing at the front looking down at it -- and for them the
              // top of a letter is the edge furthest away. The first row of a
              // glyph therefore goes at the lowest z, nearest the build, and
              // the last row at the plate's own front edge. Laid out the other
              // way about, as it was, every letter is mirrored in a line drawn
              // across it.
              top - (GLYPH_HEIGHT - line) * pixel,
              at + column * pixel,
              floor + RELIEF * pixel,
              top - (GLYPH_HEIGHT - 1 - line) * pixel,
            ],
            slot: options.labelSlot,
          });
          from = -1;
        }
      }
    });
    at += (GLYPH_WIDTH + TRACKING) * pixel;
  }

  return parts;
}

/**
 * How tall the letters actually come out, in millimetres, and how wide one
 * pixel of them is.
 *
 * <p>Asked so the interface can say when a name has been shrunk past what a
 * nozzle can lay down. Five by seven is already the smallest alphabet that
 * reads; below about half a millimetre a pixel there is nothing left to read.
 */
export function labelFit(
  model: VoxelModel,
  millimetresPerBlock: number,
  options: PlateOptions,
): { height: number; pixel: number } {
  const text = options.plate === "labelled" ? readable(options.label) : "";
  if (text === "") {
    return { height: 0, pixel: 0 };
  }
  const margin = Math.max(options.plateMargin, 0);
  const room = model.size.width * millimetresPerBlock;
  const asked = Math.max(options.labelMillimetres, 0) / GLYPH_HEIGHT;
  const pixel = Math.min(asked, widthOf(text) > 0 ? room / widthOf(text) : asked);
  return { height: pixel * GLYPH_HEIGHT, pixel };
}

/**
 * How large the plate makes the whole thing, in millimetres.
 *
 * <p>Asked before anything is built, so the interface can say what will come
 * out of the printer rather than what the build alone measures.
 */
export function plateSpan(
  model: VoxelModel,
  millimetresPerBlock: number,
  options: PlateOptions,
): [number, number, number] {
  const parts = plateOf(model, millimetresPerBlock, options);
  const scale = millimetresPerBlock;
  const build: [number, number, number] = [
    model.size.width * scale,
    model.size.depth * scale,
    model.size.height * scale,
  ];
  if (parts.length === 0) {
    return build;
  }
  const slab = parts[0]?.box as PlateBox;
  return [
    (slab[3] - slab[0]) * scale,
    (slab[5] - slab[2]) * scale,
    build[2] + (slab[4] - slab[1]) * scale,
  ];
}
