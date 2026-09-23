import type { ShapeBox, StructureInfo } from "../types";

/**
 * Turns a Minecraft skin into something the rest of the site can print.
 *
 * <p>A skin is a texture, not a shape. The shape is the player model, and it is
 * the same six boxes for everybody: a head, a body, two arms, two legs. So the
 * work here is to walk those boxes a texel at a time, ask the skin what colour
 * that texel is, and hand back the same {@link StructureInfo} and indices a
 * {@code .mcprint} would have produced. Everything downstream -- the preview,
 * the filament plan, the right click menu, the 3MF and STL writers -- then
 * works on a skin without knowing it is looking at one.
 *
 * <p>One voxel is one texel. That is the only resolution the texture actually
 * has, and inventing more would be inventing detail the skin does not carry.
 *
 * <p>Only the surface is built. The inside of a head is not something a skin
 * says anything about, and leaving it empty is what makes the print hollow and
 * fillable rather than a solid block of one colour.
 */

/**
 * What becomes of one part's second layer.
 *
 * <p>{@code off} leaves it out, the way the game's own skin settings do.
 * {@code flat} paints it onto the body where it is opaque, which is what the
 * game draws with the setting on. {@code solid} makes it a layer of its own,
 * standing off the body, which is what the 3D Skin Layers mod draws.
 *
 * <p>Per part rather than for the whole figure, because they do not all suit
 * the same answer: hair standing off a head is the point of the thing, and a
 * jacket standing off a body often just looks swollen.
 */
export type SkinLayers = "off" | "flat" | "solid";

/** Which arms the model has. */
export type PlayerModel = "classic" | "slim";

/** The parts of a skin that have a second layer, as the game names them. */
export const LAYERS = [
  "hat",
  "jacket",
  "rightSleeve",
  "leftSleeve",
  "rightTrousers",
  "leftTrousers",
] as const;

export type Layer = (typeof LAYERS)[number];

/** What each of them is called on screen. */
export const LAYER_NAMES: Readonly<Record<Layer, string>> = {
  hat: "Hat",
  jacket: "Jacket",
  rightSleeve: "Right sleeve",
  leftSleeve: "Left sleeve",
  rightTrousers: "Right trouser leg",
  leftTrousers: "Left trouser leg",
};

/** Every layer the same way, which is where a figure starts. */
export function allLayers(how: SkinLayers): Record<Layer, SkinLayers> {
  return Object.fromEntries(LAYERS.map((layer) => [layer, how])) as Record<Layer, SkinLayers>;
}

/**
 * What a standing off layer's thickness may be set to, in texels.
 *
 * <p>Nothing up to a whole cell. At nothing there is no layer to print, and a
 * part set to stand off shows none -- which is a state worth being able to
 * reach by sliding rather than only by switching every part back.
 */
export const THINNEST = 0;
export const THICKEST = 1;

export interface SkinOptions {
  readonly model: PlayerModel;
  readonly layers: Readonly<Record<Layer, SkinLayers>>;
  /**
   * How thick a standing off layer is, in texels.
   *
   * <p>One texel is the whole cell, which is what a voxel of this figure is and
   * what this used to be with no say in the matter. It is also a great deal:
   * a head is eight texels across, so a hat a texel thick adds a quarter to its
   * width, and hair drawn as a few stray pixels comes out as a slab. Less than
   * one puts the layer on part of its cell instead, hugging the body, which is
   * nearer what the mod draws and what the eye expects.
   */
  readonly thickness: number;
}

/** A skin, always as 64 by 64 RGBA, whatever size it arrived as. */
export interface Skin {
  readonly pixels: Uint8ClampedArray;
  /** True for a 64 by 32 skin, which has no left arm, left leg or sleeves. */
  readonly legacy: boolean;
  /**
   * Whether the skin has a second layer at all.
   *
   * <p>Transparency is the only way a skin says the layer is not there, so a
   * skin with none anywhere is not saying it has a layer everywhere -- it was
   * saved without an alpha channel, which is how every skin was saved before
   * the layer existed. Notch's is one: its hat is a solid opaque square, and
   * read as a layer it puts the head inside a black box.
   */
  readonly layered: boolean;
}

export interface SkinVoxels {
  readonly structure: StructureInfo;
  readonly indices: Uint32Array;
  /** The colour of each palette entry, measured rather than guessed. */
  readonly colours: number[];
}

/** The side of the texture a texel is read from. */
type Side = "top" | "bottom" | "right" | "front" | "left" | "back";

/** Where one side of a box lives on the texture. */
interface Region {
  readonly u: number;
  readonly v: number;
}

/**
 * The six sides of a box, laid out the way Minecraft lays them out.
 *
 * <p>Read off the head, which is the one everybody knows: with the head's box
 * at the origin and eight texels on a side, this gives the top at (8,0), the
 * bottom at (16,0), and the strip of right, front, left and back running along
 * from (0,8). That is the skin template.
 */
function regionsOf(u: number, v: number, w: number, d: number): Record<Side, Region> {
  return {
    top: { u: u + d, v },
    bottom: { u: u + d + w, v },
    right: { u, v: v + d },
    front: { u: u + d, v: v + d },
    left: { u: u + d + w, v: v + d },
    back: { u: u + d + w + d, v: v + d },
  };
}

/**
 * One box of the player model.
 *
 * <p>Placed on a grid whose x runs to the viewer's right, y up from the soles,
 * and z towards the viewer. The player's right hand is therefore at low x,
 * which is what puts the texture's "right" strip on the face at x = 0.
 */
interface Part {
  readonly name: string;
  /** Which of the game's layer settings covers this part. */
  readonly layer: Layer;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly base: Record<Side, Region>;
  /** The second layer, or null where the skin has none. */
  readonly outer: Record<Side, Region> | null;
  /**
   * Whether the texture is read back to front.
   *
   * <p>An old 64 by 32 skin has one arm and one leg, and the game uses them for
   * both sides. A left limb reads the right limb's texture reflected, which is
   * what a body does.
   */
  readonly mirrored: boolean;
}

/** Alpha at or above this counts as drawn. */
const OPAQUE = 128;

/**
 * Which side wins where a voxel is on more than one.
 *
 * <p>A voxel at a corner belongs to three sides and can only be one colour.
 * The ones somebody looks at come first: a figure is seen from the front, then
 * from behind and the sides, and its soles are on the plate.
 */
const PRIORITY: readonly Side[] = ["front", "back", "right", "left", "top", "bottom"];

/** Used where a texel is transparent and no side of the voxel says otherwise. */
const NOTHING = 0x9a9a9a;

/**
 * Reads a skin image, however it arrived.
 *
 * @param width  the image's width, which has to be 64
 * @param height 64, or 32 for a skin from before the second layer existed
 */
export function readSkin(pixels: Uint8ClampedArray, width: number, height: number): Skin {
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error(`A skin is 64 by 64, or 64 by 32 for an old one; this is ${width} by ${height}.`);
  }
  if (pixels.length < width * height * 4) {
    throw new Error("The skin image is shorter than its own size.");
  }
  // Asked of the part of the image that is actually there, so the empty half
  // added to an old skin below does not answer for it.
  let layered = false;
  for (let at = 3; at < width * height * 4; at += 4) {
    if ((pixels[at] as number) < OPAQUE) {
      layered = true;
      break;
    }
  }

  if (height === 64) {
    return { pixels, legacy: false, layered };
  }

  // Grown to 64 by 64 so everything downstream can read one shape. The bottom
  // half stays empty; the parts that would have lived there are mirrored from
  // the top half instead, which is what `mirrored` on a part is for.
  const grown = new Uint8ClampedArray(64 * 64 * 4);
  grown.set(pixels.subarray(0, 64 * 32 * 4));
  return { pixels: grown, legacy: true, layered };
}

/**
 * Whether a skin is drawn for the slim model.
 *
 * <p>Nothing in the file says so, and only a lookup by name gets told. What
 * gives it away is that the slim layout is a texel narrower on each of the
 * arm's four sides, so it stops two columns short of where the classic layout
 * ends and leaves them transparent. A classic skin fills them.
 *
 * <p>Both strips are asked. The side strip is the wide one and does most of the
 * work; the top and bottom are asked as well because a skin that happens to
 * leave its arm's back edge blank should not be taken for a slim one on that
 * alone.
 */
export function slimBySkin(skin: Skin): boolean {
  if (skin.legacy) {
    return false;
  }
  // The right arm's side strip runs from u 40; a classic arm ends at 55, a slim
  // one at 53.
  for (let v = 20; v < 32; v++) {
    if (alphaAt(skin, 54, v) >= OPAQUE || alphaAt(skin, 55, v) >= OPAQUE) {
      return false;
    }
  }
  // Its top and bottom, which a classic arm fills to u 51.
  for (let v = 16; v < 20; v++) {
    if (alphaAt(skin, 50, v) >= OPAQUE || alphaAt(skin, 51, v) >= OPAQUE) {
      return false;
    }
  }
  return true;
}

function alphaAt(skin: Skin, u: number, v: number): number {
  return skin.pixels[(v * 64 + u) * 4 + 3] as number;
}

function colourAt(skin: Skin, u: number, v: number): number {
  const at = (v * 64 + u) * 4;
  return (
    ((skin.pixels[at] as number) << 16) |
    ((skin.pixels[at + 1] as number) << 8) |
    (skin.pixels[at + 2] as number)
  );
}

/**
 * The player model, as boxes on the grid, for one skin.
 *
 * <p>The numbers are the model's own: a head eight on a side sitting on a body
 * eight wide, twelve tall and four deep, arms and legs four wide beside and
 * under it. A slim arm is three wide and moves in against the body by one, so
 * the shoulder still meets it.
 */
function partsOf(skin: Skin, model: PlayerModel): Part[] {
  const arm = model === "slim" ? 3 : 4;
  // An old skin has only a hat; any skin saved without transparency has nothing
  // at all, whatever is drawn in the regions a layer would live in.
  const sleeves = skin.layered && !skin.legacy;
  const hat = skin.layered;

  const part = (
    name: string,
    layer: Layer,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    base: [number, number],
    outer: [number, number] | null,
    mirrored = false,
  ): Part => ({
    name,
    layer,
    x,
    y,
    z,
    w,
    h,
    d,
    base: regionsOf(base[0], base[1], w, d),
    outer: outer === null ? null : regionsOf(outer[0], outer[1], w, d),
    mirrored,
  });

  return [
    part("head", "hat", 4, 24, -2, 8, 8, 8, [0, 0], hat ? [32, 0] : null),
    part("body", "jacket", 4, 12, 0, 8, 12, 4, [16, 16], sleeves ? [16, 32] : null),
    part("right arm", "rightSleeve", 4 - arm, 12, 0, arm, 12, 4, [40, 16], sleeves ? [40, 32] : null),
    // An old skin has no left limbs at all, so the right ones are read
    // reflected, exactly as the game does it.
    skin.legacy
      ? part("left arm", "leftSleeve", 12, 12, 0, arm, 12, 4, [40, 16], null, true)
      : part("left arm", "leftSleeve", 12, 12, 0, arm, 12, 4, [32, 48], [48, 48]),
    part("right leg", "rightTrousers", 4, 0, 0, 4, 12, 4, [0, 16], sleeves ? [0, 32] : null),
    skin.legacy
      ? part("left leg", "leftTrousers", 8, 0, 0, 4, 12, 4, [0, 16], null, true)
      : part("left leg", "leftTrousers", 8, 0, 0, 4, 12, 4, [16, 48], [0, 48]),
  ];
}

/**
 * Which layers this skin actually has.
 *
 * <p>An old skin has a hat and nothing else, and a skin saved without
 * transparency has none at all. Worth knowing on screen: a switch that cannot
 * do anything should say so rather than be pressed twice.
 */
export function layersOf(skin: Skin): ReadonlySet<Layer> {
  return new Set(
    partsOf(skin, "classic")
      .filter((part) => part.outer !== null)
      .map((part) => part.layer),
  );
}

/**
 * Where one texel of a part's side lives on the texture.
 *
 * <p>The four sides are one strip running right, front, left, back, so walking
 * along it is walking around the box. That is what fixes every direction here:
 * the strip's boundary between right and front is the box's own front right
 * edge, so the right side reads front-most at its far end, and the left side
 * the other way about.
 *
 * @param px along the box, from the player's right
 * @param py down the box, from its top
 * @param pz across the box, from its back
 */
function texelOf(
  part: Part,
  regions: Record<Side, Region>,
  side: Side,
  px: number,
  py: number,
  pz: number,
): [number, number] {
  const { w, d, mirrored } = part;
  const region = regions[mirrored ? flip(side) : side];
  const x = mirrored ? w - 1 - px : px;

  switch (side) {
    case "front":
      return [region.u + x, region.v + py];
    case "back":
      return [region.u + (w - 1 - x), region.v + py];
    case "right":
      return [region.u + pz, region.v + py];
    case "left":
      return [region.u + (d - 1 - pz), region.v + py];
    case "top":
      return [region.u + x, region.v + pz];
    case "bottom":
      return [region.u + x, region.v + (d - 1 - pz)];
  }
}

/** A mirrored part shows its left side where its right one is drawn. */
function flip(side: Side): Side {
  return side === "right" ? "left" : side === "left" ? "right" : side;
}

/** Which sides of its box a voxel lies on, outermost first. */
function sidesOf(part: Part, px: number, py: number, pz: number, grown: number): Side[] {
  const sides: Side[] = [];
  const w = part.w + grown * 2;
  const h = part.h + grown * 2;
  const d = part.d + grown * 2;
  if (pz === d - 1) sides.push("front");
  if (pz === 0) sides.push("back");
  if (px === 0) sides.push("right");
  if (px === w - 1) sides.push("left");
  if (py === 0) sides.push("top");
  if (py === h - 1) sides.push("bottom");
  return sides.sort((a, b) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b));
}

function clamp(value: number, limit: number): number {
  return value < 0 ? 0 : value > limit ? limit : value;
}

/**
 * Builds the voxels of a skin.
 *
 * <p>Two passes over the same six boxes. The first is the body itself: every
 * texel on the surface of a box becomes a voxel, coloured by the side it is on.
 * The second, when the second layer is asked for as a layer, is the same boxes
 * grown by one in every direction, with a voxel only where the layer's texture
 * is opaque -- so a hood is a hood and a bald head is bare.
 *
 * <p>Growing the whole box rather than pushing each face outwards is what keeps
 * the layer closed at its corners: a face pushed out on its own leaves a notch
 * along every edge where two of them fail to meet.
 */
export function buildSkinVoxels(skin: Skin, options: SkinOptions): SkinVoxels {
  const parts = partsOf(skin, options.model);
  const thickness = Math.min(Math.max(options.thickness, THINNEST), THICKEST);
  // A layer with no thickness is a layer with nothing to print. Said here once
  // rather than left to make boxes with no volume in them further down.

  /** What is in each cell, keyed by "x,y,z"; the first one to claim it wins. */
  const cells = new Map<string, Cell>();
  let low = [Infinity, Infinity, Infinity];
  let high = [-Infinity, -Infinity, -Infinity];

  const put = (x: number, y: number, z: number, cell: Cell): void => {
    const key = `${x},${y},${z}`;
    if (cells.has(key)) {
      return;
    }
    cells.set(key, cell);
    low = [Math.min(low[0] as number, x), Math.min(low[1] as number, y), Math.min(low[2] as number, z)];
    high = [Math.max(high[0] as number, x), Math.max(high[1] as number, y), Math.max(high[2] as number, z)];
  };

  /** Walks the surface of a part's box, grown by however much. */
  const surface = (
    part: Part,
    grown: number,
    cellOf: (sides: Side[], px: number, py: number, pz: number) => Cell | null,
  ): void => {
    const w = part.w + grown * 2;
    const h = part.h + grown * 2;
    const d = part.d + grown * 2;
    for (let py = 0; py < h; py++) {
      for (let pz = 0; pz < d; pz++) {
        for (let px = 0; px < w; px++) {
          const sides = sidesOf(part, px, py, pz, grown);
          if (sides.length === 0) {
            // Inside the box, where a skin says nothing and a print wants
            // nothing: this is what leaves the figure hollow.
            continue;
          }
          const cell = cellOf(sides, px, py, pz);
          if (cell === null) {
            continue;
          }
          put(part.x - grown + px, part.y + h - 1 - grown - py, part.z - grown + pz, cell);
        }
      }
    }
  };

  // The body. Its own texture, and -- where the layer is being painted on
  // rather than stood off -- the layer over it wherever that is opaque.
  for (const part of parts) {
    const how = options.layers[part.layer];
    surface(part, 0, (sides, px, py, pz) => {
      for (const side of sides) {
        if (how === "flat" && part.outer !== null) {
          const [ou, ov] = texelOf(part, part.outer, side, px, py, pz);
          if (alphaAt(skin, ou, ov) >= OPAQUE) {
            return { colour: colourAt(skin, ou, ov), sides: null };
          }
        }
        const [u, v] = texelOf(part, part.base, side, px, py, pz);
        if (alphaAt(skin, u, v) >= OPAQUE) {
          return { colour: colourAt(skin, u, v), sides: null };
        }
      }
      // Every side of this voxel is transparent, which happens on the unused
      // column of a classic arm in a slim skin. The voxel is still part of the
      // body and is better grey than missing.
      return { colour: NOTHING, sides: null };
    });
  }

  // The layers that stand off, each on the body it belongs to.
  for (const part of parts) {
    if (part.outer === null || options.layers[part.layer] !== "solid" || thickness <= 0) {
      continue;
    }
    const outer = part.outer;
    surface(part, 1, (sides, px, py, pz) => {
      // A cell of the grown box may be on more than one of its sides, and then
      // it carries a slab for each: an edge of a hat is an L, not a gap.
      const drawn: Side[] = [];
      let colour: number | null = null;
      for (const side of sides) {
        const [u, v] = texelOf(
          part,
          outer,
          side,
          clamp(px - 1, part.w - 1),
          clamp(py - 1, part.h - 1),
          clamp(pz - 1, part.d - 1),
        );
        if (alphaAt(skin, u, v) >= OPAQUE) {
          drawn.push(side);
          colour ??= colourAt(skin, u, v);
        }
      }
      return colour === null ? null : { colour, sides: drawn };
    });
  }

  return pack(cells, low as [number, number, number], high as [number, number, number], thickness);
}

/**
 * What one cell of the figure holds.
 *
 * @param sides null for a whole cell, which is what the body is made of; the
 *              sides of its box a layer's cell is on, which is what decides the
 *              shape of the slab it holds
 */
interface Cell {
  readonly colour: number;
  readonly sides: Side[] | null;
}

/**
 * The box a cell of a standing off layer holds.
 *
 * <p>A layer is the body's surface moved outwards by its own thickness, and
 * what that leaves in one cell depends on how many of the box's sides the cell
 * is on: against a face it is a slab, along an edge the bar where two slabs
 * cross, at a corner the little cube where three do. Which is to say the sides
 * are intersected rather than added up. Added up, each arm of the L at an edge
 * runs out to the corner of its cell, and a quarter thick hat keeps the square
 * shoulders of a whole one.
 *
 * <p>Which side of its own cell a slab sits on follows from which side of the
 * grown box the cell is on: a cell out in front of the body has the body behind
 * it, so its slab is at the back of its own cell and the layer rests on the
 * skin rather than floating off it.
 */
function slabOf(sides: readonly Side[], thickness: number): ShapeBox {
  const box: [number, number, number, number, number, number] = [0, 0, 0, 1, 1, 1];
  for (const side of sides) {
    switch (side) {
      case "front":
        box[5] = thickness;
        break;
      case "back":
        box[2] = 1 - thickness;
        break;
      case "right":
        box[0] = 1 - thickness;
        break;
      case "left":
        box[3] = thickness;
        break;
      case "top":
        box[4] = thickness;
        break;
      case "bottom":
        box[1] = 1 - thickness;
        break;
    }
  }
  return box as ShapeBox;
}

/**
 * Turns the cells into a palette and a grid, the way an export carries them.
 *
 * <p>One palette entry per colour and shape. The colour is the block id, so the
 * filament plan treats it the way it treats a block type -- clustered onto the
 * slots there are, reassignable by hand, removable in the preview -- and the
 * shape rides along as a block state, the way a stair's facing does. A hat and
 * the head under it in the same colour therefore print in the same filament
 * without being the same thing.
 */
function pack(
  cells: ReadonlyMap<string, Cell>,
  low: [number, number, number],
  high: [number, number, number],
  thickness: number,
): SkinVoxels {
  if (cells.size === 0) {
    throw new Error("That skin came out empty.");
  }

  const width = high[0] - low[0] + 1;
  const height = high[1] - low[1] + 1;
  const depth = high[2] - low[2] + 1;

  const palette: string[] = ["minecraft:air"];
  const colours: number[] = [0];
  const shapes: ShapeBox[][] = [[]];
  const entries = new Map<string, number>();
  const indices = new Uint32Array(width * height * depth);

  for (const [key, cell] of cells) {
    const hex = cell.colour.toString(16).padStart(6, "0");
    const name =
      cell.sides === null ? `skin:${hex}` : `skin:${hex}[layer=${cell.sides.join(".")}]`;
    let entry = entries.get(name);
    if (entry === undefined) {
      entry = palette.length;
      entries.set(name, entry);
      palette.push(name);
      colours.push(cell.colour);
      shapes.push([cell.sides === null ? WHOLE : slabOf(cell.sides, thickness)]);
    }
    const [x, y, z] = key.split(",").map(Number) as [number, number, number];
    indices[x - low[0] + (z - low[2]) * width + (y - low[1]) * width * depth] = entry;
  }

  return {
    structure: {
      width,
      height,
      depth,
      palette,
      bytesPerIndex: palette.length > 256 ? 2 : 1,
      shapes,
      modelled: false,
      order: "x + z * width + y * width * depth",
    },
    indices,
    colours,
  };
}

/** A cell the body fills completely. */
const WHOLE: ShapeBox = [0, 0, 0, 1, 1, 1];
