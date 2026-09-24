import { zlibSync } from "fflate";
import type { FilamentSlot } from "../slots/filament";
import type { Piece, Split } from "./split";
import type { Solid } from "./geometry";

/**
 * The booklet that comes with a build cut into pieces.
 *
 * <p>A folder of eight files called 1, 2 and 3 is a puzzle, and a table of
 * sizes is a better puzzle. What somebody wants at a table with printed parts
 * on it is the thing that comes in a box of Lego: a page per step, the build so
 * far in grey, and the piece going on next drawn in its own colour where it
 * goes.
 *
 * <p>So the pieces are drawn. Each is turned into cells the size of a block,
 * the cells are projected the way every building instruction in the world
 * projects them -- from a corner, above -- and drawn back to front with the
 * faces nobody can see left out. It is a small renderer, and a box is the only
 * thing it can draw, which happens to be what a Minecraft build is made of.
 *
 * <p>Written out as PDF by hand. A PDF is a page tree, a cross reference table
 * and some drawing commands; the fonts it asks for are the fourteen every
 * reader already has, and the pages are deflated, which fflate is here for
 * anyway. The alternative is half a megabyte of library to draw some boxes.
 */

/** A4 in points, which is the unit a PDF measures in: 72 to the inch. */
const WIDTH = 595;
const HEIGHT = 842;
const MARGIN = 48;

/** What a PDF calls the fonts every reader is required to have. */
const PLAIN = "Helvetica";
const BOLD = "Helvetica-Bold";

/** How far apart the two halves of the isometric view are, and how tall. */
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);

/**
 * The most cells to draw in one picture.
 *
 * <p>A build of a few thousand is a page of boxes a millimetre across, which is
 * a grey rectangle and not a drawing. Past this the cells are made coarser
 * until it fits, which loses detail and keeps the shape -- and the shape is all
 * a step needs to show.
 */
const MOST_CELLS = 40_000;

function literal(text: string): string {
  return text.replace(/[\\()]/g, (character) => `\\${character}`);
}

/** Anything a reader cannot show in one of the standard fonts is dropped. */
function printable(text: string): string {
  return [...text].filter((character) => character >= " " && character <= "ÿ").join("");
}

/** Commands drawing one page. */
class Page {
  private readonly parts: string[] = [];

  text(x: number, y: number, size: number, font: string, value: string, grey = 0): this {
    this.parts.push(
      `BT /${font === BOLD ? "F2" : "F1"} ${size} Tf ${grey} g ` +
        `1 0 0 1 ${x.toFixed(2)} ${(HEIGHT - y).toFixed(2)} Tm (${literal(printable(value))}) Tj ET`,
    );
    return this;
  }

  box(x: number, y: number, width: number, height: number, colour: number): this {
    this.parts.push(`${rgb(colour)} rg ${rect(x, y, width, height)} f`);
    return this;
  }

  outline(x: number, y: number, width: number, height: number, grey = 0.7): this {
    this.parts.push(`${grey} G 0.75 w ${rect(x, y, width, height)} S`);
    return this;
  }

  rule(y: number, grey = 0.85): this {
    this.parts.push(
      `${grey} G 0.75 w ${MARGIN} ${(HEIGHT - y).toFixed(2)} m ` +
        `${WIDTH - MARGIN} ${(HEIGHT - y).toFixed(2)} l S`,
    );
    return this;
  }

  /** A filled polygon with a hairline round it, which is what a face is. */
  face(points: ReadonlyArray<readonly [number, number]>, colour: number): this {
    if (points.length < 3) {
      return this;
    }
    const path = points
      .map(([x, y], index) => `${x.toFixed(1)} ${(HEIGHT - y).toFixed(1)} ${index === 0 ? "m" : "l"}`)
      .join(" ");
    this.parts.push(`${rgb(colour)} rg ${rgb(darken(colour, 0.55))} RG 0.4 w ${path} h B`);
    return this;
  }

  toString(): string {
    return this.parts.join("\n");
  }
}

function rgb(colour: number): string {
  return (
    `${(((colour >> 16) & 0xff) / 255).toFixed(3)} ` +
    `${(((colour >> 8) & 0xff) / 255).toFixed(3)} ` +
    `${((colour & 0xff) / 255).toFixed(3)}`
  );
}

function rect(x: number, y: number, width: number, height: number): string {
  return `${x.toFixed(2)} ${(HEIGHT - y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re`;
}

function darken(colour: number, by: number): number {
  const red = Math.round(((colour >> 16) & 0xff) * by);
  const green = Math.round(((colour >> 8) & 0xff) * by);
  const blue = Math.round((colour & 0xff) * by);
  return (red << 16) | (green << 8) | blue;
}

/** Where a piece's solids reach, and where they are, as cells of a grid. */
interface Cells {
  /** Cell keys, as x + y * nx + z * nx * ny. */
  readonly filled: ReadonlySet<number>;
  readonly colour: number;
}

interface Frame {
  readonly low: readonly [number, number, number];
  readonly step: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/**
 * A grid over the whole build, coarse enough to draw.
 *
 * <p>A cell is a block to begin with, which is the size the build was made in
 * and the size that reads. It is doubled until the whole thing fits in what a
 * page can hold, because a picture of forty thousand boxes is a grey rectangle.
 */
function frameOf(pieces: readonly Piece[], millimetresPerBlock: number): Frame {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const piece of pieces) {
    for (const group of piece.solids) {
      for (const solid of group) {
        for (const corner of solid) {
          for (let axis = 0; axis < 3; axis++) {
            low[axis] = Math.min(low[axis] as number, corner[axis] as number);
            high[axis] = Math.max(high[axis] as number, corner[axis] as number);
          }
        }
      }
    }
  }
  if (!Number.isFinite(low[0] as number)) {
    return { low: [0, 0, 0], step: 1, nx: 0, ny: 0, nz: 0 };
  }

  let step = Math.max(millimetresPerBlock, 0.5);
  let counts = [0, 0, 0];
  for (let tries = 0; tries < 8; tries++) {
    counts = [0, 1, 2].map((axis) =>
      Math.max(1, Math.ceil(((high[axis] as number) - (low[axis] as number)) / step)),
    );
    if ((counts[0] as number) * (counts[1] as number) * (counts[2] as number) <= MOST_CELLS) {
      break;
    }
    step *= 2;
  }
  return {
    low: low as [number, number, number],
    step,
    nx: counts[0] as number,
    ny: counts[1] as number,
    nz: counts[2] as number,
  };
}

/** Which cells of the grid a piece's solids reach into. */
function cellsOf(piece: Piece, frame: Frame, colour: number): Cells {
  const filled = new Set<number>();
  const at = (x: number, y: number, z: number): number => x + y * frame.nx + z * frame.nx * frame.ny;

  for (const group of piece.solids) {
    for (const solid of group) {
      const low = [Infinity, Infinity, Infinity];
      const high = [-Infinity, -Infinity, -Infinity];
      for (const corner of solid) {
        for (let axis = 0; axis < 3; axis++) {
          low[axis] = Math.min(low[axis] as number, corner[axis] as number);
          high[axis] = Math.max(high[axis] as number, corner[axis] as number);
        }
      }
      const from = [0, 1, 2].map((axis) =>
        Math.max(0, Math.floor(((low[axis] as number) - (frame.low[axis] as number)) / frame.step)),
      );
      const to = [0, 1, 2].map((axis) =>
        Math.min(
          [frame.nx, frame.ny, frame.nz][axis] as number,
          Math.ceil(((high[axis] as number) - (frame.low[axis] as number)) / frame.step),
        ) - 1,
      );
      for (let x = from[0] as number; x <= (to[0] as number); x++) {
        for (let y = from[1] as number; y <= (to[1] as number); y++) {
          for (let z = from[2] as number; z <= (to[2] as number); z++) {
            filled.add(at(x, y, z));
          }
        }
      }
    }
  }
  return { filled, colour };
}

/**
 * Draws the build so far, with one piece picked out.
 *
 * <p>From a corner and above, which is how every building instruction there has
 * ever been is drawn, and back to front so nothing needs sorting afterwards: a
 * cell nearer the reader is one with a larger x plus y plus z. A face with a
 * drawn cell against it is left out, which is most of them.
 *
 * @param placed everything already on the table, in the order it went on
 * @param next   the piece going on now, drawn in its own colour
 * @param full   every piece in its own colour, for showing the finished thing
 */
function draw(
  page: Page,
  frame: Frame,
  placed: readonly Cells[],
  next: Cells | null,
  top: number,
  room: number,
  full = false,
): void {
  if (frame.nx === 0) {
    return;
  }

  /** Which piece owns each cell: the last one to claim it. */
  const owner = new Map<number, number>();
  [...placed, ...(next === null ? [] : [next])].forEach((cells, index) => {
    for (const cell of cells.filled) {
      owner.set(cell, index);
    }
  });
  const colours = [...placed.map((cells) => cells.colour), ...(next === null ? [] : [next.colour])];
  const newest = colours.length - 1;

  // The picture's own size, before it is fitted to the page.
  const wide = (frame.nx + frame.ny) * COS30;
  const tall = (frame.nx + frame.ny) * SIN30 + frame.nz;
  const scale = Math.min((WIDTH - MARGIN * 2) / wide, room / tall);
  const originX = MARGIN + ((WIDTH - MARGIN * 2) - wide * scale) / 2 + frame.ny * COS30 * scale;
  const originY = top + (room - tall * scale) / 2 + frame.nz * scale;

  const put = (x: number, y: number, z: number): [number, number] => [
    originX + (x - y) * COS30 * scale,
    originY + (x + y) * SIN30 * scale - z * scale,
  ];

  const at = (x: number, y: number, z: number): number => x + y * frame.nx + z * frame.nx * frame.ny;
  const has = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < frame.nx && y < frame.ny && z < frame.nz && owner.has(at(x, y, z));

  // Back to front. The three sides facing the reader are the only ones drawn.
  for (let sum = 0; sum <= frame.nx + frame.ny + frame.nz; sum++) {
    for (let x = 0; x < frame.nx; x++) {
      for (let y = 0; y < frame.ny; y++) {
        const z = sum - x - y;
        if (z < 0 || z >= frame.nz || !has(x, y, z)) {
          continue;
        }
        const mine = owner.get(at(x, y, z)) ?? 0;
        const colour = colours[mine] ?? 0x9a9a9a;
        const fresh = full || (mine === newest && next !== null);
        const paint = fresh ? colour : pale(colour);

        if (!has(x, y, z + 1)) {
          page.face(
            [put(x, y, z + 1), put(x + 1, y, z + 1), put(x + 1, y + 1, z + 1), put(x, y + 1, z + 1)],
            paint,
          );
        }
        if (!has(x + 1, y, z)) {
          page.face(
            [put(x + 1, y, z), put(x + 1, y + 1, z), put(x + 1, y + 1, z + 1), put(x + 1, y, z + 1)],
            darken(paint, 0.82),
          );
        }
        if (!has(x, y + 1, z)) {
          page.face(
            [put(x, y + 1, z), put(x + 1, y + 1, z), put(x + 1, y + 1, z + 1), put(x, y + 1, z + 1)],
            darken(paint, 0.66),
          );
        }
      }
    }
  }
}

/** What a piece already on the table looks like: there, and not the point. */
function pale(colour: number): number {
  const mix = (channel: number): number => Math.round(channel * 0.25 + 0xff * 0.75);
  return (
    (mix((colour >> 16) & 0xff) << 16) | (mix((colour >> 8) & 0xff) << 8) | mix(colour & 0xff)
  );
}

/** What a piece's file is called inside the archive. */
export function fileName(piece: Piece, index: number): string {
  const safe = piece.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || `part ${index + 1}`;
  return `${String(index + 1).padStart(2, "0")} ${safe}`;
}

/** Which filament a piece prints in, where it prints in exactly one. */
function slotOf(piece: Piece): number {
  return piece.solids.findIndex((group) => group.length > 0);
}

/**
 * The booklet: a page of parts, then a page for every step.
 *
 * @param split which question the build was cut up to answer
 */
export function instructions(
  name: string,
  split: Split,
  pieces: readonly Piece[],
  slots: readonly FilamentSlot[],
  millimetresPerBlock: number,
): Uint8Array {
  const pages: Page[] = [];
  const frame = frameOf(pieces, millimetresPerBlock);
  const colourOf = (piece: Piece, index: number): number =>
    split === "colour"
      ? slots[slotOf(piece)]?.colour ?? 0x9a9a9a
      : [0x5b8ff9, 0x61ddaa, 0xf6bd16, 0xf08bb4, 0x7262fd, 0x78d3f8][index % 6] ?? 0x9a9a9a;
  const cells = pieces.map((piece, index) => cellsOf(piece, frame, colourOf(piece, index)));

  // --- what is in the box ----------------------------------------------------
  {
    const page = new Page();
    let y = MARGIN + 14;
    page.text(MARGIN, y, 20, BOLD, name || "VoxelPrint");
    y += 18;
    page.text(
      MARGIN,
      y,
      9,
      PLAIN,
      split === "colour"
        ? `${pieces.length} parts, one per filament. Print each in its own colour, then follow the steps.`
        : `${pieces.length} tiles. Print each on its own, then follow the steps.`,
      0.35,
    );
    y += 10;
    page.text(MARGIN, y, 9, PLAIN, `One block is ${millimetresPerBlock} mm.`, 0.35);
    y += 16;
    page.rule(y);
    y += 18;

    const columns = [MARGIN, MARGIN + 60, MARGIN + 210, MARGIN + 320, MARGIN + 400];
    page.text(columns[0] as number, y, 9, BOLD, "Step");
    page.text(columns[1] as number, y, 9, BOLD, split === "colour" ? "Filament" : "Tile");
    page.text(columns[2] as number, y, 9, BOLD, "File");
    page.text(columns[3] as number, y, 9, BOLD, "Size in mm");
    page.text(columns[4] as number, y, 9, BOLD, "Bodies");
    y += 6;
    page.rule(y);
    y += 14;

    pieces.forEach((piece, index) => {
      if (y > HEIGHT - MARGIN - 20) {
        return;
      }
      page.box((columns[0] as number) - 1, y - 7, 9, 9, colourOf(piece, index));
      page.outline((columns[0] as number) - 1, y - 7, 9, 9);
      page.text((columns[0] as number) + 14, y, 9, PLAIN, String(index + 1));
      page.text(columns[1] as number, y, 9, PLAIN, piece.name);
      page.text(columns[2] as number, y, 9, PLAIN, fileName(piece, index), 0.35);
      page.text(
        columns[3] as number,
        y,
        9,
        PLAIN,
        piece.size.map((value) => value.toFixed(0)).join(" x "),
        0.35,
      );
      page.text(columns[4] as number, y, 9, PLAIN, String(piece.bodies), 0.35);
      y += 14;
    });

    // The finished thing, so somebody knows what they are aiming at.
    if (y < HEIGHT - MARGIN - 200) {
      y += 18;
      page.rule(y);
      y += 18;
      page.text(MARGIN, y, 11, BOLD, "Finished");
      // Every piece in its own colour, so this doubles as the key to the
      // swatches in the table above it.
      draw(page, frame, cells, null, y + 10, HEIGHT - MARGIN - y - 20, true);
    }
    pages.push(page);
  }

  // --- a page a step ---------------------------------------------------------
  pieces.forEach((piece, index) => {
    const page = new Page();
    let y = MARGIN + 14;
    page.text(MARGIN, y, 18, BOLD, `Step ${index + 1} of ${pieces.length}`);
    y += 20;

    page.box(MARGIN, y - 8, 11, 11, colourOf(piece, index));
    page.outline(MARGIN, y - 8, 11, 11);
    page.text(MARGIN + 18, y, 11, BOLD, piece.name);
    y += 14;
    page.text(
      MARGIN,
      y,
      9,
      PLAIN,
      split === "colour"
        ? `From ${fileName(piece, index)}, printed in ${slots[slotOf(piece)]?.name ?? "its own colour"}.`
        : `From ${fileName(piece, index)}. It measures ${piece.size
            .map((value) => value.toFixed(0))
            .join(" x ")} mm.`,
      0.35,
    );
    y += 12;
    page.text(
      MARGIN,
      y,
      9,
      PLAIN,
      index === 0
        ? "Nothing to line it up against yet: this is the one everything else goes on."
        : "Shown in colour. What is already glued together is drawn pale.",
      0.45,
    );
    y += 14;
    page.rule(y);

    draw(page, frame, cells.slice(0, index), cells[index] ?? null, y + 16, HEIGHT - MARGIN - y - 30);
    pages.push(page);
  });

  return assemble(pages.map((page) => page.toString()));
}

/**
 * Wraps the pages in the smallest PDF that holds them.
 *
 * <p>The catalogue, the page tree, two fonts, and then a page object and a
 * deflated content stream for each page. The cross reference table has to give
 * the byte offset of every one of them, which is why this is built as bytes and
 * counted rather than as a string and hoped for.
 */
function assemble(contents: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const first = 5;
  const kids = contents.map((_, index) => `${first + index * 2} 0 R`).join(" ");

  /** Object bodies, and the raw bytes of any stream that follows one. */
  const objects: Array<{ body: string; stream?: Uint8Array }> = [
    { body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { body: `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>` },
    { body: `<< /Type /Font /Subtype /Type1 /BaseFont /${PLAIN} /Encoding /WinAnsiEncoding >>` },
    { body: `<< /Type /Font /Subtype /Type1 /BaseFont /${BOLD} /Encoding /WinAnsiEncoding >>` },
  ];

  contents.forEach((content, index) => {
    // zlib and not raw deflate: a PDF's FlateDecode wants the two byte header
    // and the checksum, and a reader handed raw deflate says only that the
    // compression method is unknown.
    const packed = zlibSync(encoder.encode(content), { level: 6 });
    objects.push({
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${first + index * 2 + 1} 0 R >>`,
    });
    objects.push({
      body: `<< /Length ${packed.length} /Filter /FlateDecode >>`,
      stream: packed,
    });
  });

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const push = (value: string | Uint8Array): void => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    at += bytes.length;
  };

  push("%PDF-1.4\n");
  objects.forEach(({ body, stream }, index) => {
    offsets.push(at);
    push(`${index + 1} 0 obj\n${body}\n`);
    if (stream !== undefined) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  });

  const start = at;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pdf = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, cursor);
    cursor += chunk.length;
  }
  return pdf;
}

/** Kept for the checks, which ask what a piece's solids add up to. */
export type { Solid };
