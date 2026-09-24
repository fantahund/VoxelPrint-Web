import { zipSync } from "fflate";
import type { FilamentSlot } from "../slots/filament";
import type { VoxelModel } from "../viewer/buildVoxels";
import {
  CORNERS,
  FACES,
  grow,
  newBounds,
  solidsBySlot,
  spanOf,
  type Bounds,
  type GeometryOptions,
  type Solid,
} from "./geometry";

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
 * <p>Triangles used to carry a {@code paint_color} as well, saying the same
 * thing as the parts by a second route. That is gone, and its going is the
 * fifth thing this file got wrong. An OrcaSlicer that had been opening these
 * files stopped: it would chew on one for a minute or two and then die. The
 * cause was measured -- the same geometry as an STL opened at once, and of two
 * 3MF files differing in nothing else, the one without the painting opened and
 * the one without the configuration did not. Painting every triangle of a build
 * is not what the attribute is for; a slicer writes it for the few triangles
 * somebody painted by hand, and thirty-nine thousand of them is a shape its
 * reader is not built for. Nothing was lost: the parts are what colour the
 * build, and they always were.
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

export interface ThreeMfOptions extends GeometryOptions {
  /** Shown as the model's title inside the file. */
  readonly name: string;
  /**
   * Whether to bring the filament colours along.
   *
   * <p>Turning this on writes {@code Metadata/project_settings.config} with the
   * palette in it. The colours then arrive, at a price that was measured once
   * and may or may not still be paid: a slicer that finds a filament set in a
   * file builds a project filament for every slot and pushes aside the profiles
   * already set up there. Whether a given version still does that is a question
   * only that version can answer, which is why this is a choice rather than a
   * decision made here.
   */
  readonly carryColours?: boolean;
  /**
   * The solids to write, where the caller has already worked them out.
   *
   * <p>What lets a build be cut into pieces and each piece written as its own
   * file: the cutting happens once, on the whole build, and each piece is
   * handed back here rather than worked out again from a model it is no longer
   * the whole of.
   */
  readonly grouped?: readonly (readonly Solid[])[];
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

/** One filament's share of the build, as its own object inside the assembly. */
interface Part {
  /** The id of its object, which is what the configuration names it by. */
  readonly id: number;
  readonly slot: number;
  readonly name: string;
}

export function buildThreeMf(
  model: VoxelModel,
  slots: readonly FilamentSlot[],
  assignment: Readonly<Record<string, number>>,
  options: ThreeMfOptions,
): ThreeMfFile {
  const grouped = options.grouped ?? solidsBySlot(model, assignment, slots.length, options);

  const bounds = newBounds();
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
      ...(options.carryColours === true
        ? { "Metadata/project_settings.config": text(projectSettings(slots)) }
        : {}),
    },
    { level: 6 },
  );

  return { bytes, triangles, parts: parts.length, size: spanOf(bounds) };
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
 * <p>Each triangle names the colour group entry of the filament it belongs to,
 * which is the core format's own way of saying it. The slicer configuration
 * beside the model says the same thing in the way a slicer acts on.
 */
function meshOf(
  solids: readonly Solid[],
  slot: number,
  bounds: Bounds,
): { xml: string; triangles: number } {
  const points: string[] = [];
  const triangles: string[] = [];

  solids.forEach((solid, index) => {
    const base = index * CORNERS.length;
    for (const corner of solid) {
      points.push(`    <vertex x="${corner[0]}" y="${corner[1]}" z="${corner[2]}"/>`);
      grow(bounds, corner);
    }

    for (const face of FACES) {
      const [a, b, c, d] = face.map((corner) => base + corner) as [number, number, number, number];
      triangles.push(`    <triangle v1="${a}" v2="${b}" v3="${c}" p1="${slot}"/>`);
      triangles.push(`    <triangle v1="${a}" v2="${c}" v3="${d}" p1="${slot}"/>`);
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

/**
 * The filament set, for a file that is meant to bring its colours.
 *
 * <p>Only the colours. A real slicer project carries the filament types and the
 * profile each slot uses as well, and naming those would tell the printer which
 * plastic to expect and at what temperature -- decided here, from a Minecraft
 * build, that is a guess with a heater attached. The colours alone are the least
 * that can be said.
 */
function projectSettings(slots: readonly FilamentSlot[]): string {
  const colours = slots.map((slot) => `"${plainColour(slot.colour)}"`).join(", ");
  return `{\n "filament_colour": [${colours}]\n}\n`;
}

/** #RRGGBB, which is what a slicer's filament list is written in. */
function plainColour(colour: number): string {
  return `#${(colour & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
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
