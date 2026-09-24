import type { FilamentSlot } from "../slots/filament";
import type { Piece, Split } from "./split";

/**
 * The sheet that comes with a build cut into pieces.
 *
 * <p>A folder of eight files called 1, 2 and 3 is a puzzle. This says which
 * file is which colour, how big each piece is, how many bodies it holds, and --
 * for a build cut to fit a bed -- where each tile goes, as a plan somebody can
 * hold beside the parts on the table.
 *
 * <p>Written out as PDF by hand. A PDF is a handful of objects, a cross
 * reference table and a page of drawing commands, and the fonts it is asking
 * for are the fourteen every reader already has -- so a page of text and
 * coloured rectangles needs no library at all, and the alternative is half a
 * megabyte of one to draw eleven lines.
 */

/** A4 in points, which is the unit a PDF measures in: 72 to the inch. */
const WIDTH = 595;
const HEIGHT = 842;
const MARGIN = 48;

/** What a PDF calls the fonts every reader is required to have. */
const PLAIN = "Helvetica";
const BOLD = "Helvetica-Bold";

/** Escapes a string for a PDF literal, where brackets and slashes are syntax. */
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
    const red = ((colour >> 16) & 0xff) / 255;
    const green = ((colour >> 8) & 0xff) / 255;
    const blue = (colour & 0xff) / 255;
    this.parts.push(
      `${red.toFixed(3)} ${green.toFixed(3)} ${blue.toFixed(3)} rg ` +
        `${x.toFixed(2)} ${(HEIGHT - y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`,
    );
    return this;
  }

  outline(x: number, y: number, width: number, height: number, grey = 0.7): this {
    this.parts.push(
      `${grey} G 0.75 w ${x.toFixed(2)} ${(HEIGHT - y - height).toFixed(2)} ` +
        `${width.toFixed(2)} ${height.toFixed(2)} re S`,
    );
    return this;
  }

  rule(y: number, grey = 0.85): this {
    this.parts.push(
      `${grey} G 0.75 w ${MARGIN} ${(HEIGHT - y).toFixed(2)} m ${WIDTH - MARGIN} ${(
        HEIGHT - y
      ).toFixed(2)} l S`,
    );
    return this;
  }

  toString(): string {
    return this.parts.join("\n");
  }
}

/**
 * The instructions for a set of pieces, as a PDF.
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
      ? `${pieces.length} parts, one per filament. Print each in its own colour and glue them together.`
      : `${pieces.length} tiles. Print each on its own and glue them along the seams.`,
    0.35,
  );
  y += 10;
  page.text(MARGIN, y, 9, PLAIN, `One block is ${millimetresPerBlock} mm.`, 0.35);
  y += 16;
  page.rule(y);
  y += 18;

  // --- the table ------------------------------------------------------------
  const columns = [MARGIN, MARGIN + 150, MARGIN + 260, MARGIN + 380, MARGIN + 450];
  page.text(columns[0] as number, y, 9, BOLD, split === "colour" ? "Filament" : "Tile");
  page.text(columns[1] as number, y, 9, BOLD, "File");
  page.text(columns[2] as number, y, 9, BOLD, "Size in mm");
  page.text(columns[3] as number, y, 9, BOLD, "Bodies");
  page.text(columns[4] as number, y, 9, BOLD, split === "colour" ? "Colour" : "Where");
  y += 6;
  page.rule(y);
  y += 14;

  pieces.forEach((piece, index) => {
    if (y > HEIGHT - MARGIN - 160) {
      // One page: a second would want a whole page tree, and a build with more
      // than fifty parts has a bigger problem than its instructions.
      return;
    }
    page.text(columns[0] as number, y, 9, PLAIN, piece.name);
    page.text(columns[1] as number, y, 9, PLAIN, `${fileName(piece, index)}`, 0.35);
    page.text(
      columns[2] as number,
      y,
      9,
      PLAIN,
      piece.size.map((value) => value.toFixed(0)).join(" x "),
      0.35,
    );
    page.text(columns[3] as number, y, 9, PLAIN, String(piece.bodies), 0.35);
    if (split === "colour") {
      const slot = piece.solids.findIndex((group) => group.length > 0);
      const colour = slots[slot]?.colour ?? 0x9a9a9a;
      page.box((columns[4] as number) - 1, y - 7, 9, 9, colour);
      page.outline((columns[4] as number) - 1, y - 7, 9, 9);
      page.text((columns[4] as number) + 13, y, 9, PLAIN, slots[slot]?.name ?? "", 0.35);
    } else if (piece.at !== null) {
      page.text(
        columns[4] as number,
        y,
        9,
        PLAIN,
        `column ${(piece.at[0] ?? 0) + 1}, row ${(piece.at[1] ?? 0) + 1}`,
        0.35,
      );
    }
    y += 14;
  });

  // --- a plan of where the tiles go ------------------------------------------
  if (split === "bed" && pieces.some((piece) => piece.at !== null)) {
    y += 14;
    page.rule(y);
    y += 18;
    page.text(MARGIN, y, 11, BOLD, "Seen from above");
    y += 6;

    const columnsAcross = Math.max(...pieces.map((piece) => (piece.at?.[0] ?? 0) + 1));
    const rowsDeep = Math.max(...pieces.map((piece) => (piece.at?.[1] ?? 0) + 1));
    const room = Math.min(
      (WIDTH - MARGIN * 2) / Math.max(columnsAcross, 1),
      (HEIGHT - MARGIN - y - 20) / Math.max(rowsDeep, 1),
      110,
    );
    y += 12;

    for (let row = 0; row < rowsDeep; row++) {
      for (let column = 0; column < columnsAcross; column++) {
        const x = MARGIN + column * room;
        const top = y + row * room;
        page.outline(x, top, room - 4, room - 4, 0.6);
        const here = pieces.filter((piece) => piece.at?.[0] === column && piece.at[1] === row);
        here.forEach((piece, level) => {
          page.text(x + 8, top + 18 + level * 12, 10, level === 0 ? BOLD : PLAIN, piece.name);
        });
      }
    }
    y += rowsDeep * room + 8;
    page.text(
      MARGIN,
      y,
      8,
      PLAIN,
      "The front of the build is at the bottom of this plan, as it stands on the printer.",
      0.45,
    );
  }

  return assemble(page.toString());
}

/** What a piece's file is called inside the archive. */
export function fileName(piece: Piece, index: number): string {
  const safe = piece.name.replace(/[^A-Za-z0-9 _-]/g, "").trim() || `part ${index + 1}`;
  return `${String(index + 1).padStart(2, "0")} ${safe}`;
}

/**
 * Wraps a page's drawing commands in the smallest PDF that holds them.
 *
 * <p>Five objects: the catalogue, the page tree, the page, its contents, and
 * the two fonts. The cross reference table at the end has to give the byte
 * offset of every one of them, which is why this is built as bytes and counted
 * rather than as a string and hoped for.
 */
function assemble(content: string): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${PLAIN} /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${BOLD} /Encoding /WinAnsiEncoding >>`,
  ];

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const push = (text: string): void => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    at += bytes.length;
  };

  push("%PDF-1.4\n");
  objects.forEach((body, index) => {
    offsets.push(at);
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const start = at;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`,
  );

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pdf = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, cursor);
    cursor += chunk.length;
  }
  return pdf;
}
