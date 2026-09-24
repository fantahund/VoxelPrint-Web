import { zlibSync } from "fflate";
import type { FilamentSlot } from "../slots/filament";
import type { Piece, Split } from "./split";

/**
 * The booklet that comes with a build cut into pieces.
 *
 * <p>A folder of eight files called 1, 2 and 3 is a puzzle, and a table of
 * sizes is a better puzzle. What somebody wants at a table with printed parts
 * on it is the thing that comes in a box of Lego: a page per step, the build so
 * far in grey, and the piece going on next drawn in its own colour where it
 * goes.
 *
 * <p>So the pieces are drawn -- the bodies themselves, in the filament each of
 * them prints in, not a grid over them. A stair is drawn as the two boxes it is
 * printed as and a torch as the sticks it is made of, because everything to say
 * that with is already here and a picture that agrees with the file is worth
 * the second it takes to draw.
 *
 * <p>Projected the way every building instruction in the world projects them --
 * from a corner, above -- with only the faces turned towards the reader, and
 * painted back to front. A face nearer the reader has a larger x plus y plus z,
 * and that one number sorts the whole page.
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

/** One face of one body, ready to be painted. */
interface Facet {
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly colour: number;
  /** How near the reader it is, for painting back to front. */
  readonly depth: number;
}

/** The corner of the whole build, so every step is drawn at the same size. */
interface Frame {
  readonly low: readonly [number, number, number];
  readonly high: readonly [number, number, number];
}

export function frameOf(pieces: readonly Piece[]): Frame {
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
  return Number.isFinite(low[0] as number)
    ? { low: low as [number, number, number], high: high as [number, number, number] }
    : { low: [0, 0, 0], high: [0, 0, 0] };
}

/**
 * The six faces of a body, as the corners are ordered everywhere else.
 *
 * <p>Repeated here rather than imported so this file needs nothing of the
 * exporter but the shapes themselves.
 */
const SIDES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 7, 6, 2],
  [0, 4, 7, 3],
  [1, 2, 6, 5],
];

/**
 * Draws the build so far, with one piece picked out.
 *
 * <p>The bodies themselves, not a grid over them: a stair is drawn as the two
 * boxes it is printed as, and the colour of each is the filament it prints in.
 * Everything to say it with is already here, and a picture that agrees with the
 * file is worth the second it takes to draw.
 *
 * <p>From a corner and above, which is how every building instruction there has
 * ever been is drawn. Only the faces turned towards the reader, and painted
 * back to front -- a face nearer the reader has a larger x plus y plus z, and
 * that one number sorts the whole page.
 *
 * @param placed everything already on the table, in the order it went on
 * @param next   the piece going on now, drawn in its own colour
 * @param full   every piece in its own colour, for showing the finished thing
 */
function draw(
  page: Page,
  frame: Frame,
  colours: readonly number[],
  placed: readonly Piece[],
  next: Piece | null,
  top: number,
  room: number,
  full = false,
): void {
  const span = [0, 1, 2].map((axis) => (frame.high[axis] as number) - (frame.low[axis] as number));
  if ((span[0] as number) <= 0 && (span[2] as number) <= 0) {
    return;
  }

  // The picture's own size in the isometric view, before it is fitted.
  const wide = ((span[0] as number) + (span[1] as number)) * COS30;
  const tall = ((span[0] as number) + (span[1] as number)) * SIN30 + (span[2] as number);
  const scale = Math.min((WIDTH - MARGIN * 2) / Math.max(wide, 1e-6), room / Math.max(tall, 1e-6));
  const originX =
    MARGIN + (WIDTH - MARGIN * 2 - wide * scale) / 2 + (span[1] as number) * COS30 * scale;
  const originY = top + (room - tall * scale) / 2 + (span[2] as number) * scale;

  const put = (point: readonly number[]): [number, number] => {
    const x = (point[0] as number) - (frame.low[0] as number);
    const y = (point[1] as number) - (frame.low[1] as number);
    const z = (point[2] as number) - (frame.low[2] as number);
    return [originX + (x - y) * COS30 * scale, originY + (x + y) * SIN30 * scale - z * scale];
  };

  const facets: Facet[] = [];
  const collect = (piece: Piece, fresh: boolean): void => {
    piece.solids.forEach((group, slot) => {
      const own = colours[slot] ?? 0x9a9a9a;
      for (const solid of group) {
        for (const side of SIDES) {
          const corners = side.map((index) => solid[index] as readonly number[]);
          const [a, b, c] = corners as [readonly number[], readonly number[], readonly number[]];
          const ux = (b[0] as number) - (a[0] as number);
          const uy = (b[1] as number) - (a[1] as number);
          const uz = (b[2] as number) - (a[2] as number);
          const vx = (c[0] as number) - (a[0] as number);
          const vy = (c[1] as number) - (a[1] as number);
          const vz = (c[2] as number) - (a[2] as number);
          const nx = uy * vz - uz * vy;
          const ny = uz * vx - ux * vz;
          const nz = ux * vy - uy * vx;
          // The reader is out along (1, 1, 1); a face turned away is a face
          // something else is in front of.
          const towards = nx + ny + nz;
          if (towards <= 0) {
            continue;
          }
          const length = Math.hypot(nx, ny, nz) || 1;
          // Top bright, the two sides each a shade darker: the whole of the
          // lighting, and enough of it to read a shape by.
          const lit = 0.66 + 0.34 * Math.max(0, nz / length);
          const paint = darken(fresh ? own : pale(own), lit);
          facets.push({
            points: corners.map(put),
            colour: paint,
            depth: corners.reduce(
              (sum, corner) =>
                sum + (corner[0] as number) + (corner[1] as number) + (corner[2] as number),
              0,
            ),
          });
        }
      }
    });
  };

  for (const piece of placed) {
    collect(piece, full);
  }
  if (next !== null) {
    collect(next, true);
  }

  facets.sort((one, other) => one.depth - other.depth);
  for (const facet of facets) {
    page.face(facet.points, facet.colour);
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
  const frame = frameOf(pieces);
  // Every body in the filament it prints in, which is what the picture is for.
  const colours = slots.map((slot) => slot.colour);
  /** The one colour a piece is, for the swatch beside its name. */
  const colourOf = (piece: Piece): number => colours[slotOf(piece)] ?? 0x9a9a9a;

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
      // A colour beside a step only means anything when the step is a colour:
      // a tile holds every filament, and a chip of the first one is a lie.
      if (split === "colour") {
        page.box((columns[0] as number) - 1, y - 7, 9, 9, colourOf(piece));
        page.outline((columns[0] as number) - 1, y - 7, 9, 9);
      }
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
      draw(page, frame, colours, pieces, null, y + 10, HEIGHT - MARGIN - y - 20, true);
    }
    pages.push(page);
  }

  // --- a page a step ---------------------------------------------------------
  pieces.forEach((piece, index) => {
    const page = new Page();
    let y = MARGIN + 14;
    page.text(MARGIN, y, 18, BOLD, `Step ${index + 1} of ${pieces.length}`);
    y += 20;

    if (split === "colour") {
      page.box(MARGIN, y - 8, 11, 11, colourOf(piece));
      page.outline(MARGIN, y - 8, 11, 11);
    }
    page.text(split === "colour" ? MARGIN + 18 : MARGIN, y, 11, BOLD, piece.name);
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

    draw(
      page,
      frame,
      colours,
      pieces.slice(0, index),
      piece,
      y + 16,
      HEIGHT - MARGIN - y - 30,
    );
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
