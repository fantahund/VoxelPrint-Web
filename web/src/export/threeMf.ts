import { zipSync } from "fflate";
import type { FilamentSlot } from "../slots/filament";
import type { VoxelModel } from "../viewer/buildVoxels";

/**
 * Writes a build as a 3MF file.
 *
 * <p>One object holding every triangle, split into parts by the slicer
 * configuration that travels with it. That layout took three attempts and the
 * first two are worth recording, because both of them looked right.
 *
 * <p>Colours as a core basematerials group came out grey: slicers read the
 * materials extension's colorgroup instead. Colours on one object per filament,
 * gathered into an assembly, came out grey as well: a slicer loads the
 * assembly, and the assembly is the one object carrying no colour. Splitting
 * them into separate objects in the build fixed the colour but made the slicer
 * ask whether a file of loose objects at different heights was meant to be one
 * thing.
 *
 * <p>What a slicer wants is one object built from components, one per filament,
 * and a configuration beside it naming each component as a part and giving it a
 * filament. The components make it a single object on the plate rather than a
 * pile of them; the configuration is what colours them.
 *
 * <p>The filaments themselves are the printer's, not this file's. Bringing a
 * set along -- even only their colours -- makes the slicer build a filament of
 * its own for every slot, named after this file, in place of the profiles
 * already set up there. So the parts name the slot they print in and nothing
 * else, and a slot prints in whatever is loaded in it.
 *
 * <p>The third attempt got the configuration right but attached it to the wrong
 * shape: one mesh with the parts named by ranges of triangles. Both ways exist
 * in a slicer's reader, and mixing them -- a part with an id and a range -- fits
 * neither, which is why that file arrived correct and grey.
 *
 * <p>Every triangle is painted as well, with the filament it belongs to, in the
 * form a slicer stores its own painting in. Parts and paint say the same thing
 * by two routes, and they agree.
 *
 * <p>Those two are ordinary files inside the package that no relationship
 * points at, so a reader that does not know them never opens them. For those,
 * the colour is said again in the core format: the colorgroup on the object and
 * a property on every triangle. A file that lands somewhere neither is
 * understood still opens, in one colour.
 */

/** The 3MF core specification's namespace. Not a URL that gets fetched. */
const CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
/**
 * The materials and properties extension.
 *
 * <p>Declared but never listed as required, which is what makes it safe: a
 * reader that has never heard of it skips what it does not know and still gets
 * the geometry. A reader that knows it gets the colours.
 */
const MATERIAL = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const MODEL_RELATIONSHIP = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const MODEL_PART = "/3D/3dmodel.model";

/** Resource ids. The order matters: a resource is defined before it is used. */
const COLOURS_ID = 1;
/** The first filament's object. The assembly follows the last of them. */
const FIRST_PART_ID = 2;

/** A face thinner than this in millimetres is left out rather than printed. */
const TOO_THIN = 1e-4;

/** How the build is turned into something solid. */
export type Geometry = "shell" | "solid";

export interface ThreeMfOptions {
  /** How large one Minecraft block comes out, in millimetres. */
  readonly millimetresPerBlock: number;
  /** Whether to follow the models or fall back to each block's solid shape. */
  readonly geometry: Geometry;
  /** How thick a shell's walls are, in millimetres. Ignored when solid. */
  readonly wallMillimetres: number;
  /** Shown as the model's title inside the file. */
  readonly name: string;
}

export interface ThreeMfFile {
  readonly bytes: Uint8Array;
  /** How many triangles the file holds. */
  readonly triangles: number;
  /** How many filaments actually carry something. */
  readonly parts: number;
  /** The printed size in millimetres, so the caller can say whether it fits. */
  readonly size: readonly [number, number, number];
}

type Point = readonly [number, number, number];

/** Eight corners in the order {@link CORNERS} gives them. */
type Solid = readonly Point[];

/** One filament's share of the build, as its own object inside the assembly. */
interface Part {
  /** The id of its object, which is what the configuration names it by. */
  readonly id: number;
  readonly slot: number;
  readonly name: string;
}

/**
 * A unit box's corners, and its faces wound to face outwards.
 *
 * <p>Written out rather than generated, and each one checked by hand against
 * the cross product of its own edges: a face wound the wrong way points into
 * the solid, and a slicer reads that as a hole rather than a surface.
 *
 * <p>The same table serves a slab of a model's face, by reading the first four
 * corners as that face and the last four as the same face moved along its
 * normal. Every one of the six windings works out the same way, which is why
 * there is one table and not two.
 */
const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/** Four corners per face, in order around it, outward facing. */
const FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 3, 2, 1], // down
  [4, 5, 6, 7], // up
  [0, 1, 5, 4], // front
  [3, 7, 6, 2], // back
  [0, 4, 7, 3], // left
  [1, 2, 6, 5], // right
];

export function buildThreeMf(
  model: VoxelModel,
  slots: readonly FilamentSlot[],
  assignment: Readonly<Record<string, number>>,
  options: ThreeMfOptions,
): ThreeMfFile {
  const grouped = groupBySlot(model, assignment, slots.length, options);

  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const objects: string[] = [];
  const components: string[] = [];
  const parts: Part[] = [];
  let triangles = 0;
  let id = FIRST_PART_ID;

  for (let slot = 0; slot < slots.length; slot++) {
    const mine = grouped[slot];
    if (mine === undefined || mine.length === 0) {
      // A filament nothing was assigned to is left out rather than named as an
      // empty part, which some slicers refuse to open.
      continue;
    }

    const name = slots[slot]?.name || `Filament ${slot + 1}`;
    const mesh = meshOf(mine, slot, bounds);
    triangles += mesh.triangles;
    objects.push(
      `  <object id="${id}" name="${escape(name)}" type="model"` +
        ` pid="${COLOURS_ID}" pindex="${slot}">
${mesh.xml}
  </object>`,
    );
    components.push(`   <component objectid="${id}"/>`);
    parts.push({ id, slot, name });
    id++;
  }

  const assemblyId = id;
  const bytes = zipSync(
    {
      // The content types part comes first, as an OPC package expects.
      "[Content_Types].xml": text(contentTypesXml()),
      "_rels/.rels": text(relationshipsXml()),
      "3D/3dmodel.model": text(
        modelXml(slots, objects, components, assemblyId, options.name),
      ),
      "Metadata/model_settings.config": text(modelSettings(parts, assemblyId, options.name)),
    },
    { level: 6 },
  );

  const size: [number, number, number] = [0, 1, 2].map((axis) => {
    const min = bounds.min[axis] as number;
    const max = bounds.max[axis] as number;
    return Number.isFinite(min) && Number.isFinite(max) ? round(max - min) : 0;
  }) as [number, number, number];

  return { bytes, triangles, parts: parts.length, size };
}

/**
 * Sorts everything printable into the filament its block prints in.
 *
 * <p>Minecraft counts height along Y and a printer counts it along Z, so the
 * axes are turned a quarter turn about X on the way: up becomes up, and south
 * becomes the near side of the bed. The turn negates one axis as well, which
 * keeps the coordinates right handed -- swapping two axes on their own would
 * mirror the build and turn every face inside out.
 *
 * <p>The build is also lifted to stand on the bed, because a model half below
 * the plate is the first thing a slicer complains about.
 *
 * <p>Shaped like this: a shell follows the models and falls back to a block's
 * shape only where there is no model to follow -- a chest, a sign. Solid uses
 * the shapes throughout.
 */
function groupBySlot(
  model: VoxelModel,
  assignment: Readonly<Record<string, number>>,
  slotCount: number,
  options: ThreeMfOptions,
): Solid[][] {
  const scale = options.millimetresPerBlock;
  const lift = (model.size.height / 2) * scale;
  const grouped: Solid[][] = Array.from({ length: slotCount }, () => []);

  const place = (x: number, y: number, z: number): Point => [
    round(x * scale),
    round(-z * scale),
    round(y * scale + lift),
  ];
  const slotOf = (paletteIndex: number): number => {
    const id = model.blockIds[paletteIndex] as string;
    return Math.min(Math.max(assignment[id] ?? 0, 0), slotCount - 1);
  };

  const surface = new Map<string, { slot: number; corners: Point[]; normal: Point }>();

  // Extract faces from the actual meshes (models)
  for (const mesh of model.meshes) {
    const slot = slotOf(mesh.paletteIndex);
    const faces = mesh.quads.length / 12;

    for (let block = 0; block < mesh.blocks; block++) {
      const ox = mesh.offsets[block * 3] as number;
      const oy = mesh.offsets[block * 3 + 1] as number;
      const oz = mesh.offsets[block * 3 + 2] as number;

      for (let face = 0; face < faces; face++) {
        const corners: Point[] = [];
        for (let corner = 0; corner < 4; corner++) {
          const at = face * 12 + corner * 3;
          corners.push(
            place(
              ox + (mesh.quads[at] as number),
              oy + (mesh.quads[at + 1] as number),
              oz + (mesh.quads[at + 2] as number),
            ),
          );
        }

        const normal = normalOf(corners);
        if (normal === null) continue;

        const key = corners.map((point) => point.join(",")).sort().join("|");
        const met = surface.get(key);
        if (met !== undefined && facingApart(met.normal, normal)) {
          surface.delete(key);
          continue;
        }
        surface.set(key, { slot, corners, normal });
      }
    }
  }

  // Extract faces from the blocks themselves (box shapes)
  const boxCount = options.geometry === "shell" ? model.boxes : model.solids;
  for (let i = 0; i < boxCount; i++) {
    const slot = slotOf(model.paletteIndices[i] as number);
    const cx = model.positions[i * 3] as number;
    const cy = model.positions[i * 3 + 1] as number;
    const cz = model.positions[i * 3 + 2] as number;
    const sx = model.scales[i * 3] as number;
    const sy = model.scales[i * 3 + 1] as number;
    const sz = model.scales[i * 3 + 2] as number;

    const boxCorners = CORNERS.map((corner) =>
      place(
        corner[0] === 0 ? cx - sx / 2 : cx + sx / 2,
        corner[1] === 0 ? cy - sy / 2 : cy + sy / 2,
        corner[2] === 0 ? cz - sz / 2 : cz + sz / 2,
      ),
    );

    for (const faceIndices of FACES) {
      const corners = faceIndices.map(idx => boxCorners[idx] as Point);
      const normal = normalOf(corners);
      if (normal === null) continue;

      const key = corners.map((point) => point.join(",")).sort().join("|");
      const met = surface.get(key);
      if (met !== undefined && facingApart(met.normal, normal)) {
        surface.delete(key);
        continue;
      }
      surface.set(key, { slot, corners, normal });
    }
  }

  if (options.geometry === "solid") {
    // Return thin 4-point faces to be drawn as 1 quad each
    for (const { slot, corners } of surface.values()) {
      (grouped[slot] as Solid[]).push(corners);
    }
  } else {
    // Shell mode: thicken the 4-point faces into 8-point solids
    const wall = Math.max(options.wallMillimetres, TOO_THIN);
    for (const { slot, corners, normal } of surface.values()) {
      (grouped[slot] as Solid[]).push(thicken(corners, normal, wall));
    }
  }
  return grouped;
}
function normalOf(face: readonly Point[]): Point | null {
  const [a, b, c, d] = face as [Point, Point, Point, Point];
  const px = c[0] - a[0];
  const py = c[1] - a[1];
  const pz = c[2] - a[2];
  const qx = d[0] - b[0];
  const qy = d[1] - b[1];
  const qz = d[2] - b[2];

  const nx = py * qz - pz * qy;
  const ny = pz * qx - px * qz;
  const nz = px * qy - py * qx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length < TOO_THIN) {
    return null;
  }
  return [nx / length, ny / length, nz / length];
}

/**
 * Whether two faces in the same place have their backs to each other.
 *
 * <p>That is what tells the wall between two blocks from a surface drawn over
 * another. The threshold is loose because the two are never near each other:
 * facing apart is a dot product of minus one, facing the same way is plus one.
 */
function facingApart(one: Point, other: Point): boolean {
  return one[0] * other[0] + one[1] * other[1] + one[2] * other[2] < 0;
}

/**
 * Turns a face into a slab of the given thickness.
 *
 * <p>A model's face has no thickness at all -- grass is two crossed sheets, a
 * torch a few rectangles -- and no printer can lay down nothing, so each face is
 * given a wall to be printed out of.
 *
 * <p>The wall goes inwards, behind the face, and the face itself stays exactly
 * where the model put it. Growing it half a wall each way was the first
 * attempt, and it reads as the even handed thing to do, but it pushes every
 * face half a wall proud of the surface it belongs to. Where two faces meet at
 * a block's edge both of them then stand out past the corner, and the whole
 * build grows a small ridge along every edge -- the thing that made it look
 * built out of bricks rather than carved. Kept behind the face, the outside is
 * the model's own surface to the last decimal, and edges come out sharp.
 *
 * @param normal which way the face looks, already worked out by the caller
 */
function thicken(face: readonly Point[], normal: Point, wall: number): Solid {
  const [a, b, c, d] = face as [Point, Point, Point, Point];
  const ux = normal[0] * wall;
  const uy = normal[1] * wall;
  const uz = normal[2] * wall;

  const behind = (p: Point): Point => [round(p[0] - ux), round(p[1] - uy), round(p[2] - uz)];
  const front = (p: Point): Point => [round(p[0]), round(p[1]), round(p[2])];
  // The first four corners are the face pushed back, the last four the face
  // where it stands, which is exactly what CORNERS means by bottom and top: the
  // last four are the side the normal points to, and that is the outside.
  return [behind(a), behind(b), behind(c), behind(d), front(a), front(b), front(c), front(d)];
}

/**
 * Turns a heap of solids into one mesh.
 *
 * <p>Every solid keeps its own eight corners. Solids that sit against each
 * other are left alone: their shared walls stay, and no corner is shared
 * between two of them.
 *
 * <p>That is deliberate, and it is the second attempt. Dropping the walls
 * between touching boxes and welding their corners makes a smaller file and
 * reads as the tidier thing to do, but it does not survive a Minecraft build.
 * Two blocks that meet only along a diagonal -- a staircase, a fence, a torch
 * against a wall -- then share one edge between four triangles, which is no
 * longer a surface with an inside and an outside. Checked on a village: 382
 * such edges. Fixing that properly means splitting faces at every T junction,
 * which is a great deal of machinery to save bytes.
 *
 * <p>A pile of separate closed solids has none of that trouble. Every slicer
 * there is takes the union of overlapping solids, so the walls in between cost
 * file size and nothing else -- they are never printed.
 *
 * <p>Each triangle also carries the colour of the filament it belongs to. The
 * configuration files say the same thing in a way a slicer acts on; this says
 * it in a way any reader of the core format can at least draw.
 */
function meshOf(
  solids: readonly Solid[],
  slot: number,
  bounds: { min: number[]; max: number[] },
  isFaces: boolean = false,
): { xml: string; triangles: number } {
  const points: string[] = [];
  const triangles: string[] = [];
  const paint = paintState(slot + 1);

  solids.forEach((solid, index) => {
    const pointsCount = isFaces ? 4 : CORNERS.length;
    const base = index * pointsCount;
    for (const corner of solid) {
      points.push(`    <vertex x="${corner[0]}" y="${corner[1]}" z="${corner[2]}"/>`);
      for (let axis = 0; axis < 3; axis++) {
        const value = corner[axis] as number;
        bounds.min[axis] = Math.min(bounds.min[axis] as number, value);
        bounds.max[axis] = Math.max(bounds.max[axis] as number, value);
      }
    }

    if (isFaces) {
      const a = base, b = base + 1, c = base + 2, d = base + 3;
      triangles.push(`    <triangle v1="${a}" v2="${b}" v3="${c}" p1="${slot}" paint_color="${paint}"/>`);
      triangles.push(`    <triangle v1="${a}" v2="${c}" v3="${d}" p1="${slot}" paint_color="${paint}"/>`);
    } else {
      for (const face of FACES) {
        const [a, b, c, d] = face.map((corner) => base + corner) as [number, number, number, number];
        triangles.push(`    <triangle v1="${a}" v2="${b}" v3="${c}" p1="${slot}" paint_color="${paint}"/>`);
        triangles.push(`    <triangle v1="${a}" v2="${c}" v3="${d}" p1="${slot}" paint_color="${paint}"/>`);
      }
    }
  });

  const xml = [
    "   <mesh>",
    "    <vertices>",
    ...points,
    "    </vertices>",
    "    <triangles>",
    ...triangles,
    "    </triangles>",
    "   </mesh>",
  ].join("\n");
  return { xml, triangles: triangles.length };
}

/**
 * How a slicer records that a triangle is painted with a given filament.
 *
 * <p>One character per four bits, lowest bit first. The low two bits say how
 * the triangle is split, which is never here, and the next two carry the
 * filament: one comes out as {@code 4}, two as {@code 8}. Three and beyond do
 * not fit in two bits, so those two are both set as a marker and a second
 * character follows carrying the rest.
 *
 * @param filament the printer's slot, counting from one
 */
function paintState(filament: number): string {
  if (filament <= 2) {
    return (filament << 2).toString(16);
  }
  if (filament <= 17) {
    return `c${(filament - 3).toString(16)}`;
  }
  return `cf${(filament - 18).toString(16)}`;
}

function modelXml(
  slots: readonly FilamentSlot[],
  objects: readonly string[],
  components: readonly string[],
  assemblyId: number,
  name: string,
): string {
  const colours = slots
    .map((slot) => `   <m:color color="${displayColour(slot.colour)}"/>`)
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}" xmlns:m="${MATERIAL}">\n` +
    ` <metadata name="Application">VoxelPrint</metadata>\n` +
    ` <metadata name="Title">${escape(name)}</metadata>\n` +
    ` <resources>\n` +
    `  <m:colorgroup id="${COLOURS_ID}">\n${colours}\n  </m:colorgroup>\n` +
    `${objects.join("\n")}\n` +
    `  <object id="${assemblyId}" name="${escape(name)}" type="model">\n` +
    `   <components>\n${components.join("\n")}\n   </components>\n` +
    `  </object>\n` +
    ` </resources>\n` +
    ` <build>\n  <item objectid="${assemblyId}"/>\n </build>\n` +
    `</model>\n`
  );
}

/**
 * The slicer's own description of the object, naming its parts.
 *
 * <p>A part is named by the id of the object it is made from, which is how
 * OrcaSlicer and Bambu Studio describe an object built of several materials.
 * The extruder is one based, being a slot on the printer rather than an index.
 */
function modelSettings(parts: readonly Part[], assemblyId: number, name: string): string {
  const lines = parts.map(
    (part) =>
      `  <part id="${part.id}" subtype="normal_part">\n` +
      `   <metadata key="name" value="${escape(part.name)}"/>\n` +
      `   <metadata key="extruder" value="${part.slot + 1}"/>\n` +
      `  </part>`,
  );

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n` +
    ` <object id="${assemblyId}">\n` +
    `  <metadata key="name" value="${escape(name)}"/>\n` +
    `  <metadata key="extruder" value="1"/>\n` +
    `${lines.join("\n")}\n` +
    ` </object>\n` +
    `</config>\n`
  );
}

function contentTypesXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="${CONTENT_TYPES}">\n` +
    ` <Default Extension="rels"` +
    ` ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
    ` <Default Extension="model"` +
    ` ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n` +
    // The configuration files are not part of 3MF, but every extension in a
    // package has to be declared or the package is not well formed.
    ` <Default Extension="config" ContentType="application/octet-stream"/>\n` +
    `</Types>\n`
  );
}

function relationshipsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="${RELATIONSHIPS}">\n` +
    ` <Relationship Id="rel0" Target="${MODEL_PART}" Type="${MODEL_RELATIONSHIP}"/>\n` +
    `</Relationships>\n`
  );
}

/** 3MF wants #RRGGBBAA, fully opaque here. */
function displayColour(colour: number): string {
  return `#${(colour & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}FF`;
}

/**
 * Rounds to a thousandth of a millimetre.
 *
 * <p>Finer than any printer resolves, and it keeps coordinates that should be
 * the same from differing in the last digit.
 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
