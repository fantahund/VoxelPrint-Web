import type { FilamentSlot } from "../slots/filament";
import type { VoxelModel } from "../viewer/buildVoxels";
import {
  FACES,
  grow,
  newBounds,
  solidsBySlot,
  spanOf,
  TOO_THIN,
  type GeometryOptions,
  type Point,
} from "./geometry";

/**
 * Writes a build as a binary STL file.
 *
 * <p>The same solids the 3MF gets, with everything an STL has no room for left
 * off. An STL is a heap of triangles and nothing else: no colour, no parts, no
 * units, no name. So the filaments are not written -- they are merged, because
 * a build split across four files that have to be lined up again by hand is
 * worse than one file somebody paints in their slicer.
 *
 * <p>Binary rather than ASCII, and not for the file size alone. A shell of a
 * village runs to millions of triangles, and written out as text that is a
 * number no editor opens and a parse slow enough to look like a hang. Binary is
 * fifty bytes a triangle whatever the coordinates are.
 *
 * <p>The header must not begin with the word {@code solid}: that is how a
 * reader tells ASCII from binary, there being no other marker in the format,
 * and a binary file that starts with it is read as text and rejected. Hence the
 * leading space before the name.
 *
 * <p>STL carries no unit either. Every slicer assumes millimetres, and so does
 * the geometry, so the two agree without anything being said.
 */

/** Bytes per triangle: twelve floats and the attribute count. */
const TRIANGLE_BYTES = 50;
/** The fixed header, in bytes, followed by the triangle count. */
const HEADER_BYTES = 80;
const COUNT_BYTES = 4;

export interface StlOptions extends GeometryOptions {
  /** Written into the header, as far as it fits. */
  readonly name: string;
}

export interface StlFile {
  readonly bytes: Uint8Array;
  /** How many triangles the file holds. */
  readonly triangles: number;
  /** The printed size in millimetres, so the caller can say whether it fits. */
  readonly size: readonly [number, number, number];
}

export function buildStl(
  model: VoxelModel,
  slots: readonly FilamentSlot[],
  assignment: Readonly<Record<string, number>>,
  options: StlOptions,
): StlFile {
  // One group, so every filament's share lands together. The assignment still
  // goes in, because it is what decides that a block is printed at all.
  const solids = solidsBySlot(model, assignment, slots.length, options).flat();

  const bounds = newBounds();
  const triangles = solids.length * FACES.length * 2;
  const bytes = new Uint8Array(HEADER_BYTES + COUNT_BYTES + triangles * TRIANGLE_BYTES);
  const view = new DataView(bytes.buffer);

  header(bytes, options.name);
  view.setUint32(HEADER_BYTES, triangles, true);

  let at = HEADER_BYTES + COUNT_BYTES;
  for (const solid of solids) {
    for (const corner of solid) {
      grow(bounds, corner);
    }
    for (const face of FACES) {
      const [a, b, c, d] = face.map((corner) => solid[corner] as Point) as [
        Point,
        Point,
        Point,
        Point,
      ];
      at = triangle(view, at, a, b, c);
      at = triangle(view, at, a, c, d);
    }
  }

  return { bytes, triangles, size: spanOf(bounds) };
}

/**
 * Fills the eighty byte header.
 *
 * <p>Begins with a space so the file can never be mistaken for an ASCII one,
 * and the name is cut to what is left rather than being allowed to run over
 * into the triangle count.
 */
function header(bytes: Uint8Array, name: string): void {
  const written = new TextEncoder().encode(` VoxelPrint ${name}`);
  bytes.set(written.subarray(0, HEADER_BYTES), 0);
}

/**
 * Writes one triangle and returns where the next one starts.
 *
 * <p>The normal is worked out from the triangle's own corners rather than
 * carried over from the face, so a triangle is right on its own terms. A
 * degenerate one is left at zero, which the format defines as asking the reader
 * to work the direction out from the winding -- and the winding is outward,
 * from {@link FACES}.
 */
function triangle(view: DataView, at: number, a: Point, b: Point, c: Point): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];

  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length < TOO_THIN) {
    nx = 0;
    ny = 0;
    nz = 0;
  } else {
    nx /= length;
    ny /= length;
    nz /= length;
  }

  for (const value of [nx, ny, nz, ...a, ...b, ...c]) {
    view.setFloat32(at, value, true);
    at += 4;
  }
  // The attribute byte count, which nothing here uses.
  view.setUint16(at, 0, true);
  return at + 2;
}
