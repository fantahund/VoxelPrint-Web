import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  DataList,
  Flex,
  Heading,
  IconButton,
  Select,
  Separator,
  Slider,
  Table,
  Text,
  TextField,
  Theme,
  Tooltip,
} from "@radix-ui/themes";
import {
  fetchIndices,
  fetchModels,
  fetchProject,
  fetchSkinByName,
  savePrinting,
  uploadProject,
} from "./api";
import { skinFromBase64, skinFromFile } from "./skin/load";
import {
  LAYERS,
  LAYER_NAMES,
  THICKEST,
  THINNEST,
  allLayers,
  buildSkinVoxels,
  layersOf,
  slimBySkin,
  type Layer,
  type PlayerModel,
  type Skin,
  type SkinLayers,
} from "./skin/skin";
import {
  MAX_SLOTS,
  SLOT_COUNTS,
  autoAssign,
  fromHex,
  standardPalette,
  toHex,
  type FilamentSlot,
} from "./slots/filament";
import { derivePalette } from "./slots/palette";
import FilamentPicker from "./slots/FilamentPicker";
import { closest, colourOf, type LibraryColour } from "./slots/library";
import { apply, describe, invert, removal, type Edit, type EditorState } from "./editor";
import type { Pick } from "./viewer/Viewer";
import { buildThreeMf, type ThreeMfFile } from "./export/threeMf";
import { buildStl, type StlFile } from "./export/stl";
import type { Geometry, GeometryOptions } from "./export/geometry";
import { inspect, NOZZLE, type Findings } from "./export/checks";
import { buildKit } from "./export/kit";
import type { Split } from "./export/split";
import {
  labelFit,
  plateOf,
  plateSpan,
  readable,
  type Plate,
  type PlateOptions,
} from "./export/plate";
import {
  blockIdOf,
  buildVoxels,
  colourise,
  unpackIndices,
  type SceneColours,
  type VoxelModel,
} from "./viewer/buildVoxels";
import Viewer from "./viewer/Viewer";
import type { BlockModels, Project, StructureInfo } from "./types";

const numberFormat = new Intl.NumberFormat();

/** Nothing to draw. Saved as a constant so the memo has something stable to return. */
const NO_COLOURS: SceneColours = {
  boxes: new Float32Array(0),
  meshes: [],
  materialColours: false,
  corners: [],
};

/** Where the filament colours come from. */
type PaletteSource = "build" | "standard";

/**
 * How many filaments to print with.
 *
 * <p>Shown before the upload as well as beside the filaments, because it is the
 * first thing worth deciding: the whole palette is worked out from it, and
 * picking it afterwards means looking at a preview built for the wrong printer.
 *
 * <p>The shortcuts cover the usual printers; the box next to them takes any
 * number, which is why it is a box and not a longer row of buttons.
 */
function SlotCount({
  count,
  onCount,
}: {
  count: number;
  onCount: (next: number) => void;
}): React.ReactElement {
  return (
    <Flex gap="2" align="center" wrap="wrap">
      {SLOT_COUNTS.map((option) => (
        <Button
          key={option}
          size="1"
          variant={count === option ? "solid" : "soft"}
          onClick={() => onCount(option)}
        >
          {option}
        </Button>
      ))}
      <TextField.Root
        size="1"
        type="number"
        min={1}
        max={MAX_SLOTS}
        value={String(count)}
        aria-label="How many filaments"
        style={{ width: "5rem" }}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next >= 1) {
            onCount(Math.min(Math.round(next), MAX_SLOTS));
          }
        }}
      >
        <TextField.Slot side="right">
          <Text size="1" color="gray">
            slots
          </Text>
        </TextField.Slot>
      </TextField.Root>
    </Flex>
  );
}

/** The block types of a build, what each looks like, and how much of it they are. */
function colouredBlocks(model: VoxelModel): Array<{ id: string; colour: number; count: number }> {
  return model.typeCounts.map(([id, count]) => ({
    id,
    colour: model.blockTypeColours[id] ?? 0x9a9a9a,
    count,
  }));
}

/**
 * The filament colours for a build.
 *
 * <p>Derived from the build unless the standard set was asked for, and falling
 * back to it when there is nothing to derive from.
 */
function paletteFor(model: VoxelModel, count: number, source: PaletteSource): FilamentSlot[] {
  if (source === "build") {
    const derived = derivePalette(colouredBlocks(model), count);
    if (derived.length > 0) {
      return derived;
    }
  }
  return standardPalette(count);
}

function bytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} kB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function Facts({ project }: { project: Project }): React.ReactElement {
  const { manifest, structure } = project.contents;
  const { size } = manifest;
  const indexBytes = manifest.volume * structure.bytesPerIndex;

  const rows: Array<[string, string]> = [
    ["File", project.fileName],
    ["Size", `${size.width} × ${size.height} × ${size.depth} blocks`],
    ["Volume", `${numberFormat.format(manifest.volume)} blocks`],
    ["Solid blocks", `${numberFormat.format(manifest.nonAirBlockCount)} blocks`],
    ["Distinct states", numberFormat.format(manifest.paletteSize)],
    ["Dimension", manifest.dimension],
    ["Origin", `${manifest.origin.x}, ${manifest.origin.y}, ${manifest.origin.z}`],
    ["Minecraft", `${manifest.minecraftVersion} (data version ${manifest.dataVersion})`],
    ["Exported by", `${manifest.generator.name} ${manifest.generator.version}`],
    ["Structure", `${manifest.structureFile} (${manifest.structureFormat})`],
    [
      "Read as",
      `${numberFormat.format(manifest.volume)} indices, ${structure.bytesPerIndex} byte each (${bytes(indexBytes)})`,
    ],
    ["Created", new Date(manifest.createdAt).toLocaleString()],
  ];

  return (
    <Panel title="Project">
      <DataList.Root size="1" orientation="vertical" trim="both">
        {rows.map(([label, value]) => (
          <DataList.Item key={label}>
            <DataList.Label minWidth="7rem">{label}</DataList.Label>
            <DataList.Value>
              <Text size="1" style={{ overflowWrap: "anywhere" }}>
                {value}
              </Text>
            </DataList.Value>
          </DataList.Item>
        ))}
      </DataList.Root>
    </Panel>
  );
}

/**
 * A part of a panel that folds away, with what it is set to on the fold.
 *
 * <p>The print panel had grown to eight things stacked one on another, of which
 * somebody touches two. Folded, each says its own name and its own answer --
 * "Stand: plate and name" -- so nothing is hidden, only quiet. Open one and it
 * is the same controls that were always there.
 */
function Section({
  title,
  summary,
  open,
  onOpen,
  children,
}: {
  title: string;
  /** What it is set to, shown when it is shut. */
  summary: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Flex
        asChild
        align="center"
        justify="between"
        gap="2"
        py="1"
        style={{ cursor: "pointer", width: "100%" }}
      >
        <button type="button" aria-expanded={open} onClick={() => onOpen(!open)}>
          <Flex align="center" gap="2" style={{ minWidth: 0 }}>
            <Text size="1" color="gray" style={{ width: "0.75rem" }}>
              {open ? "\u25BE" : "\u25B8"}
            </Text>
            <Text size="1" weight="medium">
              {title}
            </Text>
          </Flex>
          {!open && (
            <Text size="1" color="gray" truncate style={{ minWidth: 0 }}>
              {summary}
            </Text>
          )}
        </button>
      </Flex>
      {open && (
        <Box pl="4" pt="1">
          {children}
        </Box>
      )}
    </Box>
  );
}

/**
 * A titled block in one of the side columns.
 *
 * <p>The panels are the same shape throughout, so they are one component rather
 * than the same three elements written out a dozen times.
 */
function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box p="3">
      <Heading size="2" mb={hint === undefined ? "2" : "1"}>
        {title}
      </Heading>
      {hint !== undefined && (
        <Text as="p" size="1" color="gray" mb="3">
          {hint}
        </Text>
      )}
      {children}
    </Box>
  );
}

function Filaments({
  slots,
  basis,
  onSlots,
  onSpools,
  count,
  onCount,
  source,
  onSource,
  onReassign,
}: {
  slots: readonly FilamentSlot[];
  /**
   * The colour each filament had before a spool was chosen for it.
   *
   * <p>What a spool is matched against, rather than whatever spool was chosen
   * last time. Otherwise a plan sent through two catalogues is matched to the
   * first catalogue rather than to the build.
   */
  basis: readonly number[];
  /** A change somebody made by hand, which becomes what spools match against. */
  onSlots: (next: readonly FilamentSlot[]) => void;
  /** Spools chosen from the library, which leaves the basis where it was. */
  onSpools: (next: readonly FilamentSlot[]) => void;
  count: number;
  onCount: (next: number) => void;
  source: PaletteSource;
  onSource: (next: PaletteSource) => void;
  onReassign: () => void;
}): React.ReactElement {
  const change = (index: number, patch: Partial<FilamentSlot>): void => {
    onSlots(slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  };

  /** Which filament the library is open for, or null for all of them. */
  const [picking, setPicking] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <Panel
      title="Filaments"
      hint="How many colours the printer can load, and what they look like. A change shows in the preview at once."
    >
      <Flex direction="column" gap="3">
        <SlotCount count={count} onCount={onCount} />

        <Flex gap="2" wrap="wrap">
          <Tooltip content="Work out the best colours for this build">
            <Button
              size="1"
              variant={source === "build" ? "solid" : "soft"}
              onClick={() => onSource("build")}
            >
              From the build
            </Button>
          </Tooltip>
          <Tooltip content="The same set every time, for spools you already own">
            <Button
              size="1"
              variant={source === "standard" ? "solid" : "soft"}
              onClick={() => onSource("standard")}
            >
              Standard set
            </Button>
          </Tooltip>
          <Button size="1" variant="outline" onClick={onReassign}>
            Re-assign
          </Button>
        </Flex>

        <Button
          size="2"
          variant="surface"
          onClick={() => {
            setPicking(null);
            setOpen(true);
          }}
        >
          Choose a maker and real spools{"\u2026"}
        </Button>

        {slots.length < count && (
          <Callout.Root size="1" color="amber">
            <Callout.Text>
              This build has only {slots.length} distinct{" "}
              {slots.length === 1 ? "colour" : "colours"} worth a filament of its own, so{" "}
              {count - slots.length} would stay unused.
            </Callout.Text>
          </Callout.Root>
        )}

        <Flex direction="column" gap="2">
          {slots.map((slot, index) => (
            <Flex key={index} gap="2" align="center">
              <Text size="1" color="gray" style={{ width: "1.25rem", textAlign: "right" }}>
                {index + 1}
              </Text>
              <input
                type="color"
                className="colour-input"
                value={toHex(slot.colour)}
                aria-label={`Colour of ${slot.name}`}
                onChange={(event) => change(index, { colour: fromHex(event.target.value) })}
              />
              <TextField.Root
                size="1"
                style={{ flex: 1, minWidth: 0 }}
                value={slot.name}
                aria-label={`Name of filament ${index + 1}`}
                onChange={(event) => change(index, { name: event.target.value })}
              />
              <Tooltip content={`Choose a real spool for filament ${index + 1}`}>
                <Button
                  size="1"
                  variant="soft"
                  aria-label={`Choose a real spool for filament ${index + 1}`}
                  onClick={() => {
                    setPicking(index);
                    setOpen(true);
                  }}
                >
                  Spool
                </Button>
              </Tooltip>
            </Flex>
          ))}
        </Flex>

        <Text as="p" size="1" color="gray">
          These are colours worked out for this build, not spools anybody sells.
          Press Spool beside one to set it to a real filament, or the button
          above to put the whole build on what a single maker stocks.
        </Text>
      </Flex>

      <FilamentPicker
        open={open}
        onOpenChange={setOpen}
        slots={slots}
        basis={basis}
        slot={picking}
        onPick={(index, colour) =>
          onSpools(
            slots.map((slot, i) =>
              i === index ? { colour: colourOf(colour), name: nameOf(colour) } : slot,
            ),
          )
        }
        onPickAll={(colours) =>
          onSpools(
            slots.map((slot, i) => {
              // Against what the build asked for, not against the spool this
              // filament was last set to.
              const match = closest(colours, basis[i] ?? slot.colour);
              return match === null ? slot : { colour: colourOf(match), name: nameOf(match) };
            }),
          )
        }
      />
    </Panel>
  );
}

/**
 * What to call a slot that has been set to a real spool.
 *
 * <p>The colour's own name, and the product where the two are not already the
 * same word: "Bambu Green" says which green, "PLA Matte" says which black.
 */
function nameOf(colour: LibraryColour): string {
  return colour.product.toLowerCase().includes(colour.name.toLowerCase()) ||
    colour.name.toLowerCase().includes(colour.product.toLowerCase())
    ? colour.name
    : `${colour.name} ${colour.product}`;
}

function Mapping({
  model,
  slots,
  assignment,
  onAssign,
}: {
  model: VoxelModel;
  slots: readonly FilamentSlot[];
  assignment: Readonly<Record<string, number>>;
  onAssign: (blockId: string, slot: number) => void;
}): React.ReactElement {
  return (
    <Panel
      title="Blocks to filaments"
      hint={
        <>
          {numberFormat.format(model.typeCounts.length)} block types, most common first.{" "}
          {model.modelled
            ? "In-game colours are measured from the textures the export carries."
            : "In-game colours are guessed; export again with models to measure them."}
        </>
      }
    >
      <Table.Root size="1" variant="surface" className="sticky-head">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell align="right">Blocks</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Filament</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {model.typeCounts.map(([id, count]) => {
            const slotIndex = assignment[id] ?? 0;
            const slot = slots[slotIndex];
            const inGame = model.blockTypeColours[id] ?? 0x9a9a9a;
            return (
              <Table.Row key={id}>
                <Table.Cell>
                  <Flex gap="2" align="center">
                    <span
                      className="swatch"
                      style={{ background: toHex(inGame) }}
                      title={`In game: ${toHex(inGame)}`}
                    />
                    <Text size="1" style={{ overflowWrap: "anywhere" }}>
                      {id.replace(/^minecraft:/, "")}
                    </Text>
                  </Flex>
                </Table.Cell>
                <Table.Cell align="right">
                  <Text size="1" color="gray">
                    {numberFormat.format(count)}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <Flex gap="2" align="center">
                    <span
                      className="swatch"
                      style={{ background: toHex(slot?.colour ?? 0x9a9a9a) }}
                      aria-hidden="true"
                    />
                    <Select.Root
                      size="1"
                      value={String(slotIndex)}
                      onValueChange={(value) => onAssign(id, Number(value))}
                    >
                      <Select.Trigger variant="ghost" aria-label={`Filament for ${id}`} />
                      <Select.Content>
                        {slots.map((option, index) => (
                          <Select.Item key={index} value={String(index)}>
                            {option.name || `Filament ${index + 1}`}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Flex>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Panel>
  );
}

/** Which of the two files is being written. Also the extension. */
type Kind = "3mf" | "stl";

const MEDIA_TYPES: Readonly<Record<Kind, string>> = {
  "3mf": "model/3mf",
  stl: "model/stl",
};

/** A build cut into pieces arrives as one archive, with the sheet inside it. */
const KIT_TYPE = "application/zip";

/**
 * Whichever file was built last, and which kind it was.
 *
 * <p>An STL has no parts, so it counts as one: the summary then reads the same
 * way for both without the two needing separate wording.
 */
type Built = (ThreeMfFile | StlFile) & {
  readonly kind: Kind;
  readonly parts: number;
  /** How many separate things to print, where the build was cut up. */
  readonly pieces?: number;
};

/**
 * Writes the build out as a 3MF or an STL file.
 *
 * <p>Built when asked rather than as the plan changes: a large build is a lot
 * of triangles, and nobody wants that work done on every nudge of a colour
 * picker.
 *
 * <p>What comes out is the solid shape of each block, not the models the
 * preview draws. A game model is a surface, and some of them -- grass, the
 * crossed planes of a torch -- have no thickness at all, which no printer can
 * make. The shapes are closed boxes, which every slicer can.
 */
function Download({
  model,
  slots,
  assignment,
  name,
  startingSize,
  unit,
  source,
  removed,
  handSet,
  onPrint,
}: {
  model: VoxelModel;
  slots: readonly FilamentSlot[];
  assignment: Readonly<Record<string, number>>;
  name: string;
  /**
   * How large one cell starts out, in millimetres.
   *
   * <p>A block is a block and ten of them a centimetre is a sensible village.
   * A skin's cell is one texel of a sixty-four pixel texture, and a figure
   * thirty-two texels tall at ten millimetres a texel would be a third of a
   * metre; two is a figure that fits on a plate.
   */
  startingSize: number;
  /** What one cell is called, which is not a block when it is a texel. */
  unit: string;
  /**
   * The selection itself, for the checks.
   *
   * <p>The model no longer holds what was removed or what is walled in, and
   * both matter to whether a build is one piece.
   */
  source: { structure: StructureInfo; indices: Uint32Array } | null;
  removed: ReadonlySet<number>;
  /** Block types put in a filament by hand, which a colour per face leaves alone. */
  handSet: ReadonlySet<string>;
  /**
   * Told the plate, so the preview can stand the build on the same one.
   *
   * <p>The settings live here because this is where the size in millimetres
   * lives, and a plate two millimetres thick means nothing without it.
   */
  onPrint: (settings: {
    plate: PlateOptions;
    millimetresPerBlock: number;
    /** Whether a face may print in a different filament from its block. */
    perFace: boolean;
  }) => void;
}): React.ReactElement {
  const [millimetres, setMillimetres] = useState(startingSize);
  const [plate, setPlate] = useState<Plate>("off");
  const [plateThickness, setPlateThickness] = useState(2);
  const [plateMargin, setPlateMargin] = useState(2);
  const [label, setLabel] = useState(name);
  const [labelSize, setLabelSize] = useState(6);
  const [geometry, setGeometry] = useState<Geometry>("shell");
  const [wall, setWall] = useState(1.2);
  /**
   * Whether the 3MF brings the palette along; see ThreeMfOptions.carryColours.
   *
   * <p>On by default, chosen deliberately: a build that opens in the colours it
   * was planned in is what somebody expects, and the cost -- a slicer that may
   * build project filaments of its own -- is visible and undoable by unticking
   * the box.
   */
  const [carryColours, setCarryColours] = useState(true);
  /**
   * Whether a face may print in a different filament from the rest of its block.
   *
   * <p>On by default. A grass block is green on top and earth down the sides,
   * and printed in one filament it is a lie either way round; the cost is a
   * body with a wall thick skin on the sides that disagree, which is what a
   * multi-colour printer is for.
   */
  const [perFace, setPerFace] = useState(true);
  const [file, setFile] = useState<Built | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * What the checks found, once somebody has asked.
   *
   * <p>Asked rather than answered by itself: walking a big selection block by
   * block and building every body of it is a second's work, and a panel that
   * did it on every keystroke would be a panel nobody could type in.
   */
  const [findings, setFindings] = useState<Findings | null>(null);
  const [nozzle, setNozzle] = useState(NOZZLE);
  const [split, setSplit] = useState<Split>("off");
  /**
   * How large the bed is, in millimetres, for a build cut down to fit it.
   *
   * <p>A 256 cube is the commonest bed there is, and a number somebody has to
   * correct is a number they will read.
   */
  const [bed, setBed] = useState<[number, number, number]>([256, 256, 256]);
  /** Which section is unfolded, at most one, so the panel stays a panel. */
  const [section, setSection] = useState<string | null>(null);
  const opener = (which: string) => (open: boolean) => setSection(open ? which : null);

  /** The plate as the rest of the site wants it, whole rather than in pieces. */
  const plateOptions: PlateOptions = useMemo(
    () => ({
      plate,
      plateMillimetres: plateThickness,
      plateMargin,
      label,
      labelMillimetres: labelSize,
      // The last two filaments, which is where somebody who wanted a plate in
      // its own colour would have put it. Both are clamped to what there is.
      plateSlot: Math.max(slots.length - 2, 0),
      labelSlot: Math.max(slots.length - 1, 0),
    }),
    [plate, plateThickness, plateMargin, label, labelSize, slots.length],
  );

  useEffect(
    () => onPrint({ plate: plateOptions, millimetresPerBlock: millimetres, perFace }),
    [onPrint, plateOptions, millimetres, perFace],
  );

  // A fresh plan or a different setting makes whatever was built stale, and
  // whatever was found about it too.
  useEffect(() => {
    setFile(null);
  }, [
    model, slots, assignment, millimetres, geometry, wall, carryColours, plateOptions, perFace,
    split, bed,
  ]);
  useEffect(() => {
    setFindings(null);
  }, [model, millimetres, geometry, wall, plateOptions, nozzle, perFace, slots]);

  const printed = plateSpan(model, millimetres, plateOptions).map(Math.round);

  /** What both the writers and the checks work from. */
  const optionsOf = (): GeometryOptions => ({
    millimetresPerBlock: millimetres,
    geometry,
    wallMillimetres: wall,
    plate: plateOptions,
    slotColours: slots.map((slot) => slot.colour),
    perFace,
    spokenFor: handSet,
  });

  const save = (kind: Kind): void => {
    setFailure(null);
    try {
      const options = { ...optionsOf(), name, carryColours };
      let built: Built;
      let type = MEDIA_TYPES[kind];
      let suffix: string = kind;
      if (split === "off") {
        built =
          kind === "3mf"
            ? { kind, ...buildThreeMf(model, slots, assignment, options) }
            : { kind, parts: 1, ...buildStl(model, slots, assignment, options) };
      } else {
        const kit = buildKit(model, slots, assignment, kind, name, { ...options, split, bed });
        built = {
          kind,
          parts: slots.length,
          pieces: kit.pieces,
          bytes: kit.bytes,
          triangles: kit.triangles,
          size: kit.largest as [number, number, number],
        };
        type = KIT_TYPE;
        suffix = "zip";
      }
      setFile(built);

      const blob = new Blob([built.bytes as BlobPart], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.${suffix}`;
      link.click();
      // Freed on the next turn of the loop, once the browser has taken it.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The file could not be built.");
    }
  };

  return (
    <Panel
      title="Print it"
      hint="A 3MF holds one part per filament, which any slicer can give an extruder to. An STL holds the same shape as one body."
    >
      <Flex direction="column" gap="3">
        <Section
          title="Shape"
          summary={geometry === "shell" ? "Detailed shell" : "Solid shapes"}
          open={section === "shape"}
          onOpen={opener("shape")}
        >
          <Flex gap="2" wrap="wrap">
            <Tooltip content="Follow the models, as the preview draws them">
              <Button
                size="1"
                variant={geometry === "shell" ? "solid" : "soft"}
                onClick={() => setGeometry("shell")}
              >
                Detailed shell
              </Button>
            </Tooltip>
            <Tooltip content="One closed box per part of each block's shape">
              <Button
                size="1"
                variant={geometry === "solid" ? "solid" : "soft"}
                onClick={() => setGeometry("solid")}
              >
                Solid shapes
              </Button>
            </Tooltip>
          </Flex>
          <Text as="p" size="1" color="gray" mt="1">
            {geometry === "shell"
              ? "Every face given a wall, so a torch is a torch. Hollow, so thin parts are fragile."
              : "One closed box per part of a block's shape. Sturdy and much smaller, but a tilted torch comes out upright."}
          </Text>
        </Section>

        <Flex gap="3" wrap="wrap">
          <Box style={{ flex: 1, minWidth: "7rem" }}>
            <Text as="div" size="1" weight="medium" mb="1">
              {unit} size
            </Text>
            <TextField.Root
              size="1"
              type="number"
              min={1}
              max={200}
              value={String(millimetres)}
              aria-label={`Millimetres per ${unit.toLowerCase()}`}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 1) {
                  setMillimetres(Math.min(Math.round(next), 200));
                }
              }}
            >
              <TextField.Slot side="right">
                <Text size="1" color="gray">
                  mm
                </Text>
              </TextField.Slot>
            </TextField.Root>
          </Box>

          {geometry === "shell" && (
            <Box style={{ flex: 1, minWidth: "7rem" }}>
              <Text as="div" size="1" weight="medium" mb="1">
                Wall
              </Text>
              <TextField.Root
                size="1"
                type="number"
                min={0.2}
                max={10}
                step={0.2}
                value={String(wall)}
                aria-label="Wall thickness in millimetres"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next) && next >= 0.2) {
                    setWall(Math.min(next, 10));
                  }
                }}
              >
                <TextField.Slot side="right">
                  <Text size="1" color="gray">
                    mm
                  </Text>
                </TextField.Slot>
              </TextField.Root>
            </Box>
          )}
        </Flex>

        <Section
          title="Stand"
          summary={plate === "off" ? "None" : plate === "plain" ? "Plate" : `Plate saying ${readable(label) || "nothing"}`}
          open={section === "stand"}
          onOpen={opener("stand")}
        >
          <Flex gap="2" wrap="wrap">
            <Button
              size="1"
              variant={plate === "off" ? "solid" : "soft"}
              onClick={() => setPlate("off")}
            >
              None
            </Button>
            <Button
              size="1"
              variant={plate === "plain" ? "solid" : "soft"}
              onClick={() => setPlate("plain")}
            >
              Plate
            </Button>
            <Button
              size="1"
              variant={plate === "labelled" ? "solid" : "soft"}
              onClick={() => setPlate("labelled")}
            >
              Plate and name
            </Button>
          </Flex>

          {plate !== "off" && (
            <Flex direction="column" gap="2" mt="2">
              <Flex gap="3" wrap="wrap">
                <Box style={{ flex: 1, minWidth: "6rem" }}>
                  <Text as="div" size="1" color="gray" mb="1">
                    Thickness
                  </Text>
                  <TextField.Root
                    size="1"
                    type="number"
                    min={0.4}
                    max={50}
                    step={0.5}
                    value={String(plateThickness)}
                    aria-label="Plate thickness in millimetres"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next > 0) {
                        setPlateThickness(Math.min(next, 50));
                      }
                    }}
                  >
                    <TextField.Slot side="right">
                      <Text size="1" color="gray">
                        mm
                      </Text>
                    </TextField.Slot>
                  </TextField.Root>
                </Box>
                <Box style={{ flex: 1, minWidth: "6rem" }}>
                  <Text as="div" size="1" color="gray" mb="1">
                    Overhang
                  </Text>
                  <TextField.Root
                    size="1"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={String(plateMargin)}
                    aria-label="How far the plate reaches past the build, in millimetres"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next >= 0) {
                        setPlateMargin(Math.min(next, 100));
                      }
                    }}
                  >
                    <TextField.Slot side="right">
                      <Text size="1" color="gray">
                        mm
                      </Text>
                    </TextField.Slot>
                  </TextField.Root>
                </Box>
              </Flex>

              {plate === "labelled" && (
                <>
                  <TextField.Root
                    size="1"
                    value={label}
                    placeholder="What it says"
                    aria-label="What is written on the plate"
                    onChange={(event) => setLabel(event.target.value)}
                  />
                  <Flex gap="3" align="center">
                    <Box style={{ flex: 1, minWidth: "6rem" }}>
                      <TextField.Root
                        size="1"
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        value={String(labelSize)}
                        aria-label="Letter height in millimetres"
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (Number.isFinite(next) && next > 0) {
                            setLabelSize(Math.min(next, 100));
                          }
                        }}
                      >
                        <TextField.Slot side="left">
                          <Text size="1" color="gray">
                            Letters
                          </Text>
                        </TextField.Slot>
                        <TextField.Slot side="right">
                          <Text size="1" color="gray">
                            mm
                          </Text>
                        </TextField.Slot>
                      </TextField.Root>
                    </Box>
                  </Flex>
                  {readable(label) !== label.toUpperCase().replace(/\s+/g, " ").trim() && (
                    <Text as="p" size="1" color="amber">
                      It will read {readable(label) === "" ? "nothing" : `"${readable(label)}"`}:
                      the alphabet is letters, digits and a little punctuation.
                    </Text>
                  )}
                  {(() => {
                    const fit = labelFit(model, millimetres, plateOptions);
                    if (fit.pixel === 0 || fit.pixel >= 0.5) {
                      return null;
                    }
                    return (
                      <Text as="p" size="1" color="amber">
                        That name only fits at {fit.height.toFixed(1)} mm tall, which is{" "}
                        {fit.pixel.toFixed(2)} mm a pixel -- thinner than a nozzle. Shorten it, or
                        give the plate more overhang.
                      </Text>
                    );
                  })()}
                </>
              )}
            </Flex>
          )}

          <Text as="p" size="1" color="gray" mt="1">
            {plate === "off"
              ? "Nothing under it. A build with parts that do not touch arrives as several pieces."
              : plate === "plain"
                ? "A slab under the whole build, so it comes off the bed in one piece."
                : "The name stands proud on the front of the slab, in the last filament, so it prints flat and needs no supports."}
          </Text>
        </Section>

        <Section
          title="Colours"
          summary={`${perFace ? "Per face" : "Per block"}, ${carryColours ? "palette carried" : "slots only"}`}
          open={section === "colours"}
          onOpen={opener("colours")}
        >
          <Text as="label" size="1">
            <Flex gap="2" align="center">
              <Checkbox checked={perFace} onCheckedChange={(next) => setPerFace(next === true)} />
              A colour per face
            </Flex>
          </Text>
          <Text as="p" size="1" color="gray" mt="1">
            {perFace
              ? "Each face goes to the filament nearest its own colour, so a grass block is green on top and earth down the sides. A block whose faces disagree prints as a body in the commonest of them with the others laid over it a wall thick."
              : "Every face of a block prints in the one filament its type is assigned to, whatever the texture does."}
          </Text>
          {perFace && (
            <Text as="p" size="1" color="gray" mt="1">
              A block whose faces all want the same filament keeps the one its type is
              assigned to, so this only ever gives a block more colours.
              {handSet.size > 0
                ? ` And the ${handSet.size} ${handSet.size === 1 ? "type" : "types"} you have put in a filament by hand ${handSet.size === 1 ? "stays" : "stay"} there throughout, faces and all.`
                : " Put a type in a filament by hand and it stays there throughout, faces and all."}
            </Text>
          )}

          <Separator size="4" my="2" />

          <Text as="label" size="1">
            <Flex gap="2" align="center">
              <Checkbox
                checked={carryColours}
                onCheckedChange={(next) => setCarryColours(next === true)}
              />
              Carry colours
            </Flex>
          </Text>
          <Text as="p" size="1" color="gray" mt="1">
            {carryColours
              ? "The 3MF brings the palette with it, so the build opens in the colours it was planned in. A slicer that finds a filament set in a file may push aside the profiles set up there; untick this if yours does."
              : "Each part names only the slot it prints in, and the printer decides what colour is loaded there."}
          </Text>
        </Section>

        <Section
          title="Splitting"
          summary={
            split === "off"
              ? "One piece"
              : split === "colour"
                ? "One file per filament"
                : `Tiles for a ${bed.join(" x ")} mm bed`
          }
          open={section === "splitting"}
          onOpen={opener("splitting")}
        >
          <Flex gap="2" wrap="wrap">
            <Button
              size="1"
              variant={split === "off" ? "solid" : "soft"}
              onClick={() => setSplit("off")}
            >
              Don't
            </Button>
            <Button
              size="1"
              variant={split === "colour" ? "solid" : "soft"}
              onClick={() => setSplit("colour")}
            >
              By colour
            </Button>
            <Button
              size="1"
              variant={split === "bed" ? "solid" : "soft"}
              onClick={() => setSplit("bed")}
            >
              To fit the bed
            </Button>
          </Flex>

          {split === "bed" && (
            <Flex gap="2" mt="2">
              {/* The printer's axes: across the bed, into it, and up off it. */}
              {(["across", "deep", "up"] as const).map((what, axis) => (
                <Box key={what} style={{ flex: 1, minWidth: "4rem" }}>
                  <Text as="div" size="1" color="gray" mb="1">
                    {what}
                  </Text>
                  <TextField.Root
                    size="1"
                    type="number"
                    min={20}
                    max={2000}
                    step={10}
                    value={String(bed[axis])}
                    aria-label={`How far the bed reaches ${what}, in millimetres`}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next >= 20) {
                        setBed((current) => {
                          const wanted = [...current] as [number, number, number];
                          wanted[axis] = Math.min(next, 2000);
                          return wanted;
                        });
                      }
                    }}
                  />
                </Box>
              ))}
            </Flex>
          )}

          <Text as="p" size="1" color="gray" mt="1">
            {split === "off"
              ? "One file, printed in one go, which wants a printer with as many filaments as the plan has."
              : split === "colour"
                ? "One file per filament, so a printer with one extruder can still make this: print each in its own colour and glue them together. A sheet saying which is which comes in the archive."
                : "Cut into tiles that fit, each still whole in itself, with a plan of where each one goes. The seams are straight lines to glue along."}
          </Text>
        </Section>

        <Separator size="4" />

        <Flex gap="2">
          <Button style={{ flex: 1 }} onClick={() => save("3mf")}>
            {split === "off" ? "Download .3mf" : "Download .3mf set"}
          </Button>
          <Button style={{ flex: 1 }} variant="soft" onClick={() => save("stl")}>
            .stl
          </Button>
        </Flex>

        <Text as="p" size="1" color="gray">
          {file === null ? (
            <>
              {printed[0]} × {printed[1]} × {printed[2]} mm, built when you ask for it.
            </>
          ) : (
            <>
              {file.pieces === undefined ? (
                <>
                  {file.size[0]} × {file.size[1]} × {file.size[2]} mm.{" "}
                </>
              ) : (
                <>
                  {file.pieces} {file.pieces === 1 ? "piece" : "pieces"}, the largest{" "}
                  {file.size[0]} × {file.size[1]} × {file.size[2]} mm.{" "}
                </>
              )}
              {numberFormat.format(file.triangles)} triangles
              {file.pieces !== undefined ? null : file.kind === "3mf" ? (
                <>
                  {" "}
                  across {file.parts} {file.parts === 1 ? "part" : "parts"}
                </>
              ) : (
                <> in one body</>
              )}
              , {bytes(file.bytes.length)} of{" "}
              {file.pieces === undefined ? `.${file.kind}` : "archive"}.
            </>
          )}
        </Text>

        {failure !== null && (
          <Callout.Root size="1" color="red">
            <Callout.Text>{failure}</Callout.Text>
          </Callout.Root>
        )}

        <Separator size="4" />

        <Section
          title="Before you print"
          summary={
            findings === null
              ? "not checked"
              : findings.loose === 0 && findings.thin === 0
                ? "nothing to report"
                : `${findings.loose > 0 ? `${findings.pieces.length} pieces` : ""}${findings.loose > 0 && findings.thin > 0 ? ", " : ""}${findings.thin > 0 ? `${findings.thin} too thin` : ""}`
          }
          open={section === "checks"}
          onOpen={opener("checks")}
        >
          <Flex align="center" justify="end" gap="2" mb="1">
            <TextField.Root
              size="1"
              type="number"
              min={0.1}
              max={2}
              step={0.1}
              style={{ width: "6rem" }}
              value={String(nozzle)}
              aria-label="Nozzle width in millimetres"
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next > 0) {
                  setNozzle(Math.min(next, 2));
                }
              }}
            >
              <TextField.Slot side="left">
                <Text size="1" color="gray">
                  Nozzle
                </Text>
              </TextField.Slot>
            </TextField.Root>
          </Flex>

          {findings === null ? (
            <>
              <Button
                size="1"
                variant="soft"
                style={{ width: "100%" }}
                disabled={source === null}
                onClick={() => {
                  if (source !== null) {
                    setFindings(
                      inspect(model, source.structure, source.indices, removed, optionsOf(), nozzle),
                    );
                  }
                }}
              >
                Check it
              </Button>
              <Text as="p" size="1" color="gray" mt="1">
                Whether it comes off the bed as one thing, whether any of it is finer than the
                nozzle can draw, and how much of it hangs over nothing.
              </Text>
            </>
          ) : (
            <Flex direction="column" gap="1">
              <Finding
                bad={findings.loose > 0}
                good={`One piece, all ${numberFormat.format(findings.blocks)} blocks of it.`}
                bad_={`${findings.pieces.length} separate pieces: ${numberFormat.format(
                  findings.loose,
                )} ${findings.loose === 1 ? "block is" : "blocks are"} not joined to the rest, and will arrive loose.`}
              />
              <Finding
                bad={findings.thin > 0}
                good={`Nothing finer than the nozzle; the thinnest body is ${findings.thinnest.toFixed(2)} mm.`}
                bad_={`${numberFormat.format(findings.thin)} of ${numberFormat.format(
                  findings.bodies,
                )} bodies are thinner than ${nozzle} mm, down to ${findings.thinnest.toFixed(
                  2,
                )} mm. A bigger ${unit.toLowerCase()} or a thicker wall would fix it.`}
              />
              <Finding
                bad={findings.overhanging > findings.blocks / 4}
                good={`${numberFormat.format(findings.overhanging)} blocks stand on nothing, which supports will hold easily.`}
                bad_={`${numberFormat.format(findings.overhanging)} blocks stand on nothing — a quarter of the build. Expect a lot of supports and a rough underside.`}
              />
              <Button size="1" variant="soft" onClick={() => setFindings(null)}>
                Check again
              </Button>
            </Flex>
          )}
        </Section>
      </Flex>
    </Panel>
  );
}

/** One line of the report, said one way when it is fine and another when it is not. */
function Finding({
  bad,
  good,
  bad_,
}: {
  bad: boolean;
  good: string;
  bad_: string;
}): React.ReactElement {
  return (
    <Flex gap="2" align="start">
      <Text size="1" color={bad ? "amber" : "green"} style={{ lineHeight: "1.5" }}>
        {bad ? "\u25B2" : "\u2713"}
      </Text>
      <Text size="1" color={bad ? undefined : "gray"}>
        {bad ? bad_ : good}
      </Text>
    </Flex>
  );
}

/**
 * What the figure is made of, for a skin.
 *
 * <p>Three questions. The arms are a fact about the skin that the file does not
 * state, so it is guessed and left where it can be corrected. The layers are
 * the choice, and it is made a part at a time for the same reason the game
 * makes it a part at a time -- nobody wants all six or none -- with the added
 * question of whether a layer is painted on or stands off the body. And a layer
 * that stands off needs a thickness, because a whole texel of it is a great
 * deal on a head only eight texels across.
 */
function SkinFigure({
  model,
  onModel,
  layers,
  onLayers,
  present,
  thickness,
  onThickness,
}: {
  model: PlayerModel;
  onModel: (next: PlayerModel) => void;
  layers: Readonly<Record<Layer, SkinLayers>>;
  onLayers: (next: Readonly<Record<Layer, SkinLayers>>) => void;
  /** The layers this skin actually carries; the rest are shown but not offered. */
  present: ReadonlySet<Layer>;
  thickness: number;
  onThickness: (next: number) => void;
}): React.ReactElement {
  const standing = LAYERS.some((layer) => present.has(layer) && layers[layer] === "solid");
  /**
   * The thickness as it is being typed, which is not always a number yet.
   *
   * <p>Followed back when it is changed from outside -- by the slider -- but
   * not while it agrees with what is typed, so "0.50" is not rewritten to
   * "0.5" under the cursor.
   */
  const [typed, setTyped] = useState(String(thickness));
  useEffect(() => {
    if (Number(typed) !== thickness) {
      setTyped(String(thickness));
    }
    // On the number, not on what is typed: typing is the other direction, and
    // following it back here would fight the cursor.
  }, [thickness, typed]);
  // Short labels: six rows of three buttons and a part name have to fit a side
  // column, and "Right trouser leg" is not a short part name.
  const choices: ReadonlyArray<{ how: SkinLayers; label: string }> = [
    { how: "off", label: "Off" },
    { how: "flat", label: "Flat" },
    { how: "solid", label: "3D" },
  ];

  return (
    <Panel title="The figure" hint="Every one of these changes the shape, so the preview is built again.">
      <Flex direction="column" gap="3">
        <Box>
          <Text as="div" size="1" weight="medium" mb="1">
            Second layer
          </Text>

          <Flex direction="column" gap="1">
            {LAYERS.map((layer) => {
              const has = present.has(layer);
              return (
                <Flex key={layer} align="center" justify="between" gap="2">
                  <Text size="1" color={has ? undefined : "gray"} truncate>
                    {LAYER_NAMES[layer]}
                  </Text>
                  <Flex gap="1">
                    {choices.map(({ how, label }) => (
                      <Button
                        key={how}
                        size="1"
                        disabled={!has}
                        variant={layers[layer] === how ? "solid" : "soft"}
                        onClick={() => onLayers({ ...layers, [layer]: how })}
                      >
                        {label}
                      </Button>
                    ))}
                  </Flex>
                </Flex>
              );
            })}
          </Flex>

          <Flex align="center" justify="between" gap="2" mt="2">
            <Text size="1" color="gray">
              Every layer
            </Text>
            <Flex gap="1">
              {choices.map(({ how, label }) => (
                <Button
                  key={how}
                  size="1"
                  variant="outline"
                  onClick={() => onLayers(allLayers(how))}
                >
                  {label}
                </Button>
              ))}
            </Flex>
          </Flex>

          <Text as="p" size="1" color="gray" mt="1">
            Flat is what the game draws: the layer goes onto the body where it is
            opaque, and the figure stays six boxes. 3D is what the 3D Skin Layers
            mod draws: the layer sits on the body as a layer of its own, so hair
            sticks out and a hood stands off the head.
            {present.size === 0
              ? " This skin has no second layer at all -- it was saved with nothing see-through, which is the only way a skin can say a layer is not there."
              : present.size < LAYERS.length
                ? " The greyed out ones are not in this skin: an old 64 by 32 skin has a hat and nothing else."
                : ""}
          </Text>
        </Box>

        {standing && (
          <Box>
            <Text as="div" size="1" weight="medium" mb="1">
              Layer thickness
            </Text>
            <Flex direction="column" gap="2">
              <TextField.Root
                size="1"
                inputMode="decimal"
                value={typed}
                aria-label="Layer thickness in texels"
                onChange={(event) => {
                  // The typed text is kept as typed. Clamping every keystroke
                  // is what made this unusable: emptying the field to start
                  // again, or typing the nought of "0.25", both read as a
                  // number out of range and were thrown away as they were
                  // typed.
                  const raw = event.target.value;
                  setTyped(raw);
                  const next = Number(raw);
                  if (raw.trim() !== "" && Number.isFinite(next) && next >= THINNEST && next <= THICKEST) {
                    onThickness(next);
                  }
                }}
                onBlur={() => setTyped(String(thickness))}
              >
                <TextField.Slot side="right">
                  <Text size="1" color="gray">
                    texels
                  </Text>
                </TextField.Slot>
              </TextField.Root>

              <Slider
                size="1"
                min={THINNEST}
                max={THICKEST}
                step={0.05}
                value={[thickness]}
                aria-label="Layer thickness"
                onValueChange={([next]) => onThickness(next ?? thickness)}
              />
            </Flex>
            <Text as="p" size="1" color="gray" mt="1">
              A whole texel is as thick as the body's own voxels, which on a head
              eight texels across is a quarter again as wide; nothing at all
              leaves the layer off. The layer sits against the body whatever it
              is set to, so a thin one is a thin shell on the skin rather than a
              slab floating off it.
            </Text>
          </Box>
        )}

        <Box>
          <Text as="div" size="1" weight="medium" mb="1">
            Arms
          </Text>
          <Flex gap="2" wrap="wrap">
            <Button
              size="1"
              variant={model === "classic" ? "solid" : "soft"}
              onClick={() => onModel("classic")}
            >
              Classic
            </Button>
            <Button
              size="1"
              variant={model === "slim" ? "solid" : "soft"}
              onClick={() => onModel("slim")}
            >
              Slim
            </Button>
          </Flex>
          <Text as="p" size="1" color="gray" mt="1">
            Four texels wide, or three. Guessed from the skin, which gives itself
            away by leaving the fourth column of the arm transparent when it is
            drawn slim.
          </Text>
        </Box>
      </Flex>
    </Panel>
  );
}

/**
 * The menu a right click in the preview opens.
 *
 * <p>Fixed to the pointer rather than placed in the layout, and nudged back
 * inside the window when it would hang off the edge -- a menu opened near the
 * bottom of a tall build is otherwise half unreachable.
 *
 * <p>Everything here acts on what was clicked: the block itself, or every block
 * of its type. Both are offered because both are wanted. Clearing away one
 * torch that spoils a silhouette is one job; clearing away all the grass before
 * printing is another, and doing it a block at a time is not a job at all.
 */
function BlockMenu({
  at,
  state,
  count,
  gone,
  slots,
  slot,
  onRemove,
  onRemoveType,
  onRestoreType,
  onAssign,
  onClose,
}: {
  at: { x: number; y: number };
  state: string;
  count: number;
  gone: number;
  slots: readonly FilamentSlot[];
  slot: number;
  onRemove: () => void;
  onRemoveType: () => void;
  onRestoreType: () => void;
  onAssign: (slot: number) => void;
  onClose: () => void;
}): React.ReactElement {
  const id = blockIdOf(state);
  const properties = state.slice(id.length);

  return (
    <Box
      className="block-menu"
      style={{
        left: Math.min(at.x, Math.max(0, window.innerWidth - 290)),
        top: Math.min(at.y, Math.max(0, window.innerHeight - 280)),
      }}
      // The window closes this on any pointer press; inside it, a press is
      // meant for the menu.
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      role="menu"
    >
      <Card size="2">
        <Flex direction="column" gap="2">
          <Box>
            <Text as="div" size="2" weight="bold" style={{ overflowWrap: "anywhere" }}>
              {id.replace(/^minecraft:/, "")}
            </Text>
            {properties !== "" && (
              <Text as="div" size="1" color="gray" style={{ overflowWrap: "anywhere" }}>
                {properties}
              </Text>
            )}
          </Box>

          <Flex gap="2" align="center">
            <Badge size="1" color="gray">
              {numberFormat.format(count)} in the build
            </Badge>
            {gone > 0 && (
              <Badge size="1" color="amber">
                {numberFormat.format(gone)} removed
              </Badge>
            )}
          </Flex>

          <Separator size="4" />

          <Flex gap="2" align="center" justify="between">
            <Text size="1">Filament</Text>
            <Select.Root
              size="1"
              value={String(slot)}
              onValueChange={(value) => {
                onAssign(Number(value));
                onClose();
              }}
            >
              <Select.Trigger style={{ flex: 1, minWidth: 0 }} />
              <Select.Content>
                {slots.map((option, index) => (
                  <Select.Item key={index} value={String(index)}>
                    {option.name || `Filament ${index + 1}`}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          <Button size="1" variant="soft" color="red" onClick={onRemove}>
            Remove this block
          </Button>
          <Button size="1" variant="soft" color="red" onClick={onRemoveType}>
            Remove all {numberFormat.format(count)}
          </Button>
          {gone > 0 && (
            <Button size="1" variant="soft" onClick={onRestoreType}>
              Put back {numberFormat.format(gone)}
            </Button>
          )}
        </Flex>
      </Card>
    </Box>
  );
}

export default function App(): React.ReactElement {
  const [project, setProject] = useState<Project | null>(null);
  /**
   * A skin, when that is what is open instead of a build.
   *
   * <p>Never a project: a skin is somebody's texture, read in the browser and
   * printed from there, and there is nothing about it worth keeping on a
   * server. The two are mutually exclusive, and everything past the model they
   * produce treats them alike.
   */
  const [skin, setSkin] = useState<{ name: string; skin: Skin } | null>(null);
  const [playerModel, setPlayerModel] = useState<PlayerModel>("classic");
  /**
   * What becomes of each layer.
   *
   * <p>The hat stands off and the rest is painted on, which is the figure most
   * people mean: hair and hoods are what anybody wants in three dimensions, and
   * a jacket standing off a body mostly reads as a body that has swollen.
   */
  const [skinLayers, setSkinLayers] = useState<Readonly<Record<Layer, SkinLayers>>>(() => ({
    ...allLayers("flat"),
    hat: "solid",
  }));
  /** How thick a standing off layer is, in texels. */
  const [skinThickness, setSkinThickness] = useState(0.5);
  const [playerName, setPlayerName] = useState("");
  const [model, setModel] = useState<VoxelModel | null>(null);
  /** Whether the preview shows the build or the print. */
  const [colourMode, setColourMode] = useState<"filament" | "minecraft">("filament");
  const [slots, setSlots] = useState<readonly FilamentSlot[]>(standardPalette(4));
  /**
   * What each filament was before anybody chose a spool for it.
   *
   * <p>Kept because choosing a spool is a rounding, and rounding a rounding
   * drifts. Match a plan to one maker and then to another, and without this
   * the second maker is matched to the first maker's spools rather than to the
   * colours the build asked for -- so a build sent through two catalogues comes
   * out further from itself than a build sent through either.
   */
  const [basis, setBasis] = useState<readonly number[]>(() =>
    standardPalette(4).map((slot) => slot.colour),
  );

  /**
   * Block types somebody has put in a filament by hand.
   *
   * <p>Those print in that filament throughout, faces and all. A colour per
   * face is a guess -- a good one, from the measured colour of each face -- and
   * a guess does not get to overrule somebody who has said what they want.
   *
   * <p>Emptied whenever the palette is worked out afresh, because the filaments
   * a choice was made against are gone by then.
   */
  const [handSet, setHandSet] = useState<ReadonlySet<string>>(() => new Set());

  /** A palette worked out afresh: the slots, and the basis they start from. */
  const planSlots = useCallback((next: readonly FilamentSlot[]) => {
    setSlots(next);
    setBasis(next.map((slot) => slot.colour));
    setHandSet(new Set());
  }, []);
  /** How many filaments the printer has, and where their colours come from. */
  const [slotCount, setSlotCount] = useState(4);
  const [paletteSource, setPaletteSource] = useState<PaletteSource>("build");
  /**
   * The same two settings, readable without depending on them.
   *
   * <p>Building the palette must happen when a project is loaded, and never
   * again when a colour is nudged. Reading the settings from here keeps them
   * out of the effect's dependencies without reaching for a state updater to
   * smuggle them in: an updater that did real work would run twice under
   * StrictMode and cluster the whole build for nothing.
   */
  const settingsRef = useRef<{ count: number; source: PaletteSource }>({
    count: 4,
    source: "build",
  });
  const [assignment, setAssignment] = useState<Readonly<Record<string, number>>>({});
  /** Blocks taken out by hand, as indices into the selection. */
  const [removed, setRemoved] = useState<ReadonlySet<number>>(() => new Set<number>());
  /** What has been done and what has been taken back, newest last. */
  const [done, setDone] = useState<readonly Edit[]>([]);
  const [undone, setUndone] = useState<readonly Edit[]>([]);
  const [menu, setMenu] = useState<Pick | null>(null);
  /**
   * What the model was built from, so it can be built again.
   *
   * <p>Removing a block is not a matter of hiding an instance: the block that
   * was behind it now has a face to show, and the exporter wants the same model
   * the preview does. Rebuilding from the source is the one way to keep all
   * three honest.
   */
  const sourceRef = useRef<{
    structure: StructureInfo;
    indices: Uint32Array;
    models: BlockModels | null;
    /** Colours the source knows outright, which is what a skin's palette is. */
    colours?: readonly number[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Light or dark, starting from what the system asks for.
   *
   * <p>Read once rather than followed: somebody who has clicked the switch
   * means it, and a system that changes at dusk should not overrule them.
   */
  const [appearance, setAppearance] = useState<"light" | "dark">(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  /**
   * The plate the build stands on, as the print panel has it set.
   *
   * <p>Held up here because two things want it: the writers, which is where it
   * is set, and the preview, which has to show what will actually be printed.
   */
  const [plate, setPlate] = useState<{ options: PlateOptions; scale: number } | null>(null);
  /**
   * Whether the preview shows a colour per face, as the print will.
   *
   * <p>Set from the print panel, because that is where it is chosen. A setting
   * that changes what comes out of the printer and not what is on screen is a
   * setting nobody can judge.
   */
  const [perFace, setPerFace] = useState(true);
  const takePrint = useCallback(
    (settings: { plate: PlateOptions; millimetresPerBlock: number; perFace: boolean }) => {
      setPlate({ options: settings.plate, scale: settings.millimetresPerBlock });
      setPerFace(settings.perFace);
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [skinDragging, setSkinDragging] = useState(false);
  /** Guards the save effect until the first plan is in place. */
  const [loadedPlan, setLoadedPlan] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Puts the project in the address bar, so a reload keeps what is on screen. */
  const remember = useCallback((next: Project) => {
    setSkin(null);
    setPlate(null);
    setProject(next);
    const url = new URL(window.location.href);
    url.searchParams.set("project", next.id);
    window.history.replaceState(null, "", url);
  }, []);

  const accept = useCallback(
    async (file: File | undefined) => {
      if (file === undefined) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        remember(await uploadProject(file));
      } catch (cause) {
        setProject(null);
        setError(cause instanceof Error ? cause.message : "The upload failed.");
      } finally {
        setBusy(false);
      }
    },
    [remember],
  );

  /**
   * Takes a skin, from wherever it came from.
   *
   * <p>The model it is drawn for is guessed from the skin itself where nothing
   * else says: a slim skin leaves the fourth column of the classic arm
   * transparent, because the game never reads it. Overridable afterwards, since
   * a guess about somebody's arms should not be the last word.
   */
  const takeSkin = useCallback((name: string, loaded: Skin, model?: PlayerModel) => {
    setProject(null);
    setError(null);
    // The print panel is about to be built afresh for this skin and will say
    // what it wants; until it does, the old one's stand is not this one's.
    setPlate(null);
    setPlayerModel(model ?? (slimBySkin(loaded) ? "slim" : "classic"));
    setSkin({ name, skin: loaded });
    const url = new URL(window.location.href);
    url.searchParams.delete("project");
    window.history.replaceState(null, "", url);
  }, []);

  const acceptSkin = useCallback(
    async (file: File | undefined) => {
      if (file === undefined) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const loaded = await skinFromFile(file);
        takeSkin(file.name.replace(/\.png$/i, "") || "skin", loaded);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That skin could not be read.");
      } finally {
        setBusy(false);
      }
    },
    [takeSkin],
  );

  const lookUpSkin = useCallback(async () => {
    const name = playerName.trim();
    if (name === "") {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const found = await fetchSkinByName(name);
      takeSkin(found.name, await skinFromBase64(found.png), found.model);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That name could not be looked up.");
    } finally {
      setBusy(false);
    }
  }, [playerName, takeSkin]);

  /**
   * Builds the figure whenever the skin or what it is drawn on changes.
   *
   * <p>Rebuilt rather than adjusted, because the two options change the shape
   * of the grid itself: a second layer standing off the body makes every part
   * two texels wider, and an index into one grid means nothing in the other.
   * Which is also why anything removed by hand is let go of here.
   */
  useEffect(() => {
    if (skin === null) {
      return;
    }
    try {
      const built = buildSkinVoxels(skin.skin, {
        model: playerModel,
        layers: skinLayers,
        thickness: skinThickness,
      });
      sourceRef.current = {
        structure: built.structure,
        indices: built.indices,
        models: null,
        colours: built.colours,
      };
      setRemoved(new Set<number>());
      setDone([]);
      setUndone([]);
      setMenu(null);
      setLoadedPlan(false);

      const built3d = buildVoxels(built.structure, built.indices, null, undefined, built.colours);
      setModel(built3d);
      const { count, source } = settingsRef.current;
      const palette = paletteFor(built3d, count, source);
      planSlots(palette);
      setAssignment(autoAssign(colouredBlocks(built3d), palette));
    } catch (cause) {
      setModel(null);
      setError(cause instanceof Error ? cause.message : "That skin could not be turned into a figure.");
    }
  }, [skin, playerModel, skinLayers, skinThickness]);

  // Opening a project link loads it without another upload.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("project");
    if (id === null) {
      return;
    }
    let cancelled = false;
    setBusy(true);
    void fetchProject(id)
      .then((loaded) => {
        if (!cancelled) {
          setProject(loaded);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "That project could not be opened.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the model whenever the project changes, and start from a sensible
  // assignment so the first look is not a wall of one colour.
  useEffect(() => {
    if (project === null) {
      // A skin may be open instead, and then the model is its to build.
      if (skin === null) {
        setModel(null);
      }
      return;
    }
    let cancelled = false;
    setModel(null);
    setLoadedPlan(false);

    void (async () => {
      try {
        const structure = project.contents.structure;
        // Both at once: they are independent, and the models are the larger of
        // the two on a build with a wide palette.
        const [raw, models] = await Promise.all([
          fetchIndices(project.id),
          structure.modelled ? fetchModels(project.id) : Promise.resolve(null),
        ]);
        if (cancelled) {
          return;
        }
        const unpacked = unpackIndices(raw, structure.bytesPerIndex);
        sourceRef.current = { structure, indices: unpacked, models };

        const saved = project.printing;
        // A plan's removals belong to the build it was written for, and the
        // indices only mean anything within that selection's size.
        const taken = new Set<number>(
          (saved?.removed ?? []).filter((block) => block >= 0 && block < unpacked.length),
        );
        setRemoved(taken);
        setDone([]);
        setUndone([]);
        setMenu(null);

        const built = buildVoxels(structure, unpacked, models, taken);
        setModel(built);
        if (saved != null && saved.slots.length > 0) {
          // A saved plan wins, but only for what it actually covers. A plan
          // that names fewer block types than the build has -- because it was
          // written for an earlier upload, or by hand -- would otherwise drop
          // everything it does not mention onto the first filament without
          // saying so. Guessed values fill the gaps, saved ones override them.
          const guessed = autoAssign(colouredBlocks(built), saved.slots);
          planSlots(saved.slots);
          setSlotCount(saved.slots.length);
          settingsRef.current = { ...settingsRef.current, count: saved.slots.length };
          setAssignment({ ...guessed, ...saved.assignment });
          setLoadedPlan(true);
        } else {
          const { count, source } = settingsRef.current;
          const palette = paletteFor(built, count, source);
          planSlots(palette);
          setAssignment(autoAssign(colouredBlocks(built), palette));
          setLoadedPlan(true);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "The preview could not be built.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // A project and a skin are never both open, so this cannot run for a
    // project because of a skin; it is here for the one case above.
  }, [project, skin]);

  /**
   * Saves the plan shortly after the last change.
   *
   * <p>Dragging a colour picker fires continuously, so writing on every change
   * would mean hundreds of requests for one adjustment. The delay collapses a
   * burst into a single save.
   */
  useEffect(() => {
    if (project === null || !loadedPlan) {
      return;
    }
    const timer = window.setTimeout(() => {
      void savePrinting(project.id, {
        slots: [...slots],
        assignment: { ...assignment },
        removed: [...removed],
      })
        .then(() => setSaveError(null))
        .catch((cause: unknown) =>
          setSaveError(cause instanceof Error ? cause.message : "The plan could not be saved."),
        );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [project, slots, assignment, removed, loadedPlan]);

  /**
   * Carries out an edit and rebuilds what depends on it.
   *
   * @param record whether to put it on the undo stack, which undo itself does
   *               not, having its own
   */
  const run = useCallback(
    (edit: Edit, record: boolean): boolean => {
      const before: EditorState = { removed, assignment };
      const after = apply(before, edit);
      if (after === before) {
        // Nothing to do: a block already gone, or the filament it is already
        // in. Recording it would put a step on the stack that undoes nothing.
        return false;
      }

      if (after.removed !== before.removed) {
        setRemoved(after.removed);
        const source = sourceRef.current;
        if (source !== null) {
          setModel(
            buildVoxels(
              source.structure,
              source.indices,
              source.models,
              after.removed,
              source.colours,
            ),
          );
        }
      }
      if (after.assignment !== before.assignment) {
        setAssignment(after.assignment);
        if (edit.kind === "assign") {
          setHandSet((current) => new Set(current).add(edit.blockId));
        }
      }
      if (record) {
        setDone((current) => [...current, edit]);
        setUndone([]);
      }
      return true;
    },
    [removed, assignment],
  );

  const undo = useCallback(() => {
    const last = done[done.length - 1];
    if (last === undefined) {
      return;
    }
    run(invert(last), false);
    setDone((current) => current.slice(0, -1));
    setUndone((current) => [...current, last]);
  }, [done, run]);

  const redo = useCallback(() => {
    const next = undone[undone.length - 1];
    if (next === undefined) {
      return;
    }
    run(next, false);
    setUndone((current) => current.slice(0, -1));
    setDone((current) => [...current, next]);
  }, [undone, run]);

  /**
   * Ctrl+Z and Ctrl+Y, and Cmd on a Mac.
   *
   * <p>Ignored while a field has the focus, so undo inside a filament's name
   * box still means what the browser means by it.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  /** Closes the menu on anything that is not the menu itself. */
  useEffect(() => {
    if (menu === null) {
      return;
    }
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenu(null);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("wheel", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  /**
   * Every block of one palette entry, whether it is still there or not.
   *
   * <p>Walks the selection rather than the model, because the model no longer
   * holds what has been removed, and "put them back" has to find them.
   */
  const blocksOfType = useCallback((blockId: string): number[] => {
    const source = sourceRef.current;
    if (source === null) {
      return [];
    }
    const { indices, structure } = source;
    const wanted = new Set<number>();
    structure.palette.forEach((state, index) => {
      if (blockIdOf(state) === blockId) {
        wanted.add(index);
      }
    });
    const found: number[] = [];
    for (let i = 0; i < indices.length; i++) {
      if (wanted.has(indices[i] as number)) {
        found.push(i);
      }
    }
    return found;
  }, []);

  const reassign = useCallback(() => {
    if (model !== null) {
      setAssignment(autoAssign(colouredBlocks(model), slots));
    }
  }, [model, slots]);

  /**
   * Builds a fresh palette and maps the build onto it.
   *
   * <p>Both at once on purpose: new colours with the old mapping would show a
   * build painted in colours nothing was matched against.
   */
  const repalette = useCallback(
    (count: number, source: PaletteSource) => {
      settingsRef.current = { count, source };
      setSlotCount(count);
      setPaletteSource(source);
      if (model === null) {
        planSlots(standardPalette(count));
        return;
      }
      const palette = paletteFor(model, count, source);
      planSlots(palette);
      setAssignment(autoAssign(colouredBlocks(model), palette));
    },
    [model],
  );

  /** Colour per palette index, which is what the renderer consumes. */
  const colours = useMemo(() => {
    if (model === null) {
      return NO_COLOURS;
    }
    if (colourMode === "minecraft") {
      // What the build looks like in the game. The meshes carry their own
      // material colours; only the boxes need telling, and for those the
      // averaged colour of the state is the closest thing there is.
      return colourise(model, model.minecraftColours, true);
    }
    const perPaletteIndex = model.blockIds.map((id) => {
      const slot = slots[assignment[id] ?? 0];
      return slot?.colour ?? 0x9a9a9a;
    });
    return colourise(
      model,
      perPaletteIndex,
      false,
      perFace ? slots.map((slot) => slot.colour) : undefined,
      handSet,
    );
  }, [model, slots, assignment, colourMode, perFace, handSet]);

  /**
   * The plate, worked out once, with its shape and its colours kept apart.
   *
   * <p>Apart because they change for different reasons: dragging a filament's
   * colour picker must not rebuild the geometry underneath it.
   */
  const plateParts = useMemo(
    () => (model === null || plate === null ? undefined : plateOf(model, plate.scale, plate.options)),
    [model, plate],
  );
  // Nothing rather than an empty list, so that turning the stand off and
  // opening a project with none are the same to the preview and neither
  // rebuilds a mesh to draw no plate.
  const plateBoxes = useMemo(
    () => (plateParts === undefined || plateParts.length === 0 ? undefined : plateParts.map((part) => part.box)),
    [plateParts],
  );
  const plateColours = useMemo(
    () =>
      plateParts?.map((part) =>
        colourMode === "filament"
          ? slots[Math.min(Math.max(part.slot, 0), slots.length - 1)]?.colour ?? 0x9a9a9a
          : 0xb0b0b0,
      ),
    [plateParts, slots, colourMode],
  );

  return (
    <Theme
      appearance={appearance}
      accentColor="teal"
      grayColor="slate"
      radius="medium"
      scaling="95%"
    >
      <Flex direction="column" className="shell">
        <Flex
          align="center"
          justify="between"
          gap="3"
          px="3"
          py="2"
          style={{ borderBottom: "1px solid var(--gray-a5)" }}
        >
          <Flex align="center" gap="3" style={{ minWidth: 0 }}>
            <Heading size="3">VoxelPrint</Heading>
            {(project !== null || skin !== null) && (
              <Text size="1" color="gray" truncate>
                {project?.fileName ?? skin?.name}
              </Text>
            )}
            {model !== null && removed.size > 0 && (
              <Badge size="1" color="amber">
                {numberFormat.format(removed.size)} removed
              </Badge>
            )}
          </Flex>

          <Flex align="center" gap="2">
            {model !== null && (
              <>
                <Tooltip
                  content={
                    done.length === 0
                      ? "Nothing to undo"
                      : `Undo ${describe(done[done.length - 1] as Edit)}`
                  }
                >
                  <Button size="1" variant="soft" onClick={undo} disabled={done.length === 0}>
                    Undo
                  </Button>
                </Tooltip>
                <Tooltip
                  content={
                    undone.length === 0
                      ? "Nothing to redo"
                      : `Redo ${describe(undone[undone.length - 1] as Edit)}`
                  }
                >
                  <Button size="1" variant="soft" onClick={redo} disabled={undone.length === 0}>
                    Redo
                  </Button>
                </Tooltip>
                <Separator orientation="vertical" size="1" />
              </>
            )}
            {(project !== null || skin !== null) && (
              <Button
                size="1"
                variant="outline"
                onClick={() => {
                  setProject(null);
                  setSkin(null);
                  setModel(null);
                }}
              >
                Open another
              </Button>
            )}
            <Tooltip content={appearance === "dark" ? "Light" : "Dark"}>
              <IconButton
                size="1"
                variant="ghost"
                aria-label="Light or dark"
                onClick={() => setAppearance(appearance === "dark" ? "light" : "dark")}
              >
                {appearance === "dark" ? "\u2600" : "\u263E"}
              </IconButton>
            </Tooltip>
          </Flex>
        </Flex>

        {project === null && skin === null ? (
          <Box className="dropzone">
            <Flex direction="column" align="center" gap="4" style={{ width: "min(34rem, 100%)" }}>
              <Box>
                <Heading size="6" mb="1">
                  Turn a Minecraft build into something a printer understands
                </Heading>
                <Text as="p" size="2" color="gray">
                  Drop the <code>.mcprint</code> your VoxelPrint mod exported.
                </Text>
              </Box>

              <Card size="2" style={{ width: "100%" }}>
                <Flex direction="column" gap="2">
                  <Text as="div" size="1" weight="medium">
                    How many colours can the printer load?
                  </Text>
                  <SlotCount count={slotCount} onCount={(next) => repalette(next, paletteSource)} />
                  <Text as="p" size="1" color="gray">
                    Decided first, because the palette is worked out from it. Changeable afterwards.
                  </Text>
                </Flex>
              </Card>

              <label
                className={dragging ? "target dragging" : "target"}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void accept(event.dataTransfer.files[0]);
                }}
              >
                <input
                  type="file"
                  accept=".mcprint"
                  disabled={busy}
                  onChange={(event) => void accept(event.target.files?.[0])}
                />
                <Text size="2" color={dragging ? undefined : "gray"}>
                  {busy ? "Reading \u2026" : "Drop a .mcprint here, or click to choose one"}
                </Text>
              </label>

              <Card size="2" style={{ width: "100%" }}>
                <Flex direction="column" gap="3">
                  <Box>
                    <Text as="div" size="2" weight="medium">
                      Or print a skin
                    </Text>
                    <Text as="p" size="1" color="gray">
                      A skin is a texture on six boxes. One texel becomes one voxel, and the
                      figure comes out the size you ask for.
                    </Text>
                  </Box>

                  <Flex gap="2" align="center">
                    <TextField.Root
                      size="2"
                      style={{ flex: 1 }}
                      placeholder="Player name"
                      value={playerName}
                      disabled={busy}
                      aria-label="Minecraft player name"
                      onChange={(event) => setPlayerName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void lookUpSkin();
                        }
                      }}
                    />
                    <Button
                      size="2"
                      disabled={busy || playerName.trim() === ""}
                      onClick={() => void lookUpSkin()}
                    >
                      Look up
                    </Button>
                  </Flex>

                  <label
                    className={skinDragging ? "target thin dragging" : "target thin"}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setSkinDragging(true);
                    }}
                    onDragLeave={() => setSkinDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setSkinDragging(false);
                      void acceptSkin(event.dataTransfer.files[0]);
                    }}
                  >
                    <input
                      type="file"
                      accept="image/png,.png"
                      disabled={busy}
                      onChange={(event) => void acceptSkin(event.target.files?.[0])}
                    />
                    <Text size="2" color={skinDragging ? undefined : "gray"}>
                      Or drop a skin PNG here
                    </Text>
                  </label>
                </Flex>
              </Card>

              {error !== null && (
                <Callout.Root size="1" color="red" style={{ width: "100%" }}>
                  <Callout.Text>{error}</Callout.Text>
                </Callout.Root>
              )}
            </Flex>
          </Box>
        ) : (
          <Box className="workspace">
            <Box className="side">
              {model !== null && (
                <>
                  <Filaments
                    slots={slots}
                    basis={basis}
                    onSlots={planSlots}
                    onSpools={setSlots}
                    count={slotCount}
                    onCount={(next) => repalette(next, paletteSource)}
                    source={paletteSource}
                    onSource={(next) => repalette(slotCount, next)}
                    onReassign={reassign}
                  />
                  <Separator size="4" />
                  <Mapping
                    model={model}
                    slots={slots}
                    assignment={assignment}
                    onAssign={(blockId, slot) =>
                      run(
                        {
                          kind: "assign",
                          blockId,
                          from: assignment[blockId] ?? 0,
                          to: slot,
                          what: blockId.replace(/^minecraft:/, ""),
                        },
                        true,
                      )
                    }
                  />
                </>
              )}
            </Box>

            <Box className="stage">
              {model === null ? (
                <Flex align="center" justify="center" height="100%">
                  <Text size="2" color="gray">
                    Building the preview \u2026
                  </Text>
                </Flex>
              ) : (
                <>
                  <Viewer
                    model={model}
                    colours={colours}
                    plate={plateBoxes}
                    plateColours={plateColours}
                    onPick={setMenu}
                    frame={project?.id ?? "skin"}
                  />

                  <Box className="overlay top-left">
                    <Card size="1">
                      <Flex gap="2" align="center">
                        <Button
                          size="1"
                          variant={colourMode === "filament" ? "solid" : "soft"}
                          onClick={() => setColourMode("filament")}
                        >
                          Filament
                        </Button>
                        <Tooltip
                          content={
                            model.trueColour
                              ? skin !== null
                                ? "The colours of the skin itself"
                                : "What the build looks like in the game"
                              : "This export carries no textures to take colours from"
                          }
                        >
                          <Button
                            size="1"
                            variant={colourMode === "minecraft" ? "solid" : "soft"}
                            onClick={() => setColourMode("minecraft")}
                            disabled={!model.trueColour}
                          >
                            {skin !== null ? "Skin" : "Minecraft"}
                          </Button>
                        </Tooltip>
                      </Flex>
                    </Card>
                  </Box>

                  <Box className="overlay bottom">
                    <Card size="1">
                      <Flex gap="3" align="center" wrap="wrap">
                        <Text size="1" color="gray">
                          Right click a {skin === null ? "block" : "voxel"} to remove it or change
                          its filament. Drag to turn.
                        </Text>
                        {removed.size > 0 && (
                          <Button
                            size="1"
                            variant="soft"
                            onClick={() =>
                              run({ kind: "restore", blocks: [...removed], what: "blocks" }, true)
                            }
                          >
                            Put back all {numberFormat.format(removed.size)}
                          </Button>
                        )}
                      </Flex>
                    </Card>
                  </Box>
                </>
              )}
            </Box>

            <Box className="side right">
              {model !== null && (
                <>
                  {skin !== null && (
                    <>
                      <SkinFigure
                        model={playerModel}
                        onModel={setPlayerModel}
                        layers={skinLayers}
                        onLayers={setSkinLayers}
                        present={layersOf(skin.skin)}
                        thickness={skinThickness}
                        onThickness={setSkinThickness}
                      />
                      <Separator size="4" />
                    </>
                  )}
                  <Download
                    // Remounted for whatever is opened next, not merely when a
                    // build gives way to a skin. The panel holds the size to
                    // print at and the name on the plate, and both belong to
                    // the thing that is open: Paul's stand saying PAUL is
                    // right until Klaus arrives.
                    key={project?.id ?? `skin:${skin?.name ?? ""}`}
                    model={model}
                    slots={slots}
                    assignment={assignment}
                    name={
                      project !== null
                        ? project.fileName.replace(/\.mcprint$/i, "") || "voxelprint"
                        : skin?.name || "skin"
                    }
                    startingSize={skin === null ? 10 : 2}
                    unit={skin === null ? "Block" : "Voxel"}
                    // Read at render rather than held twice: the reference is
                    // set in the same breath as the model, so by the time this
                    // draws with a new model it is already the new selection.
                    source={sourceRef.current}
                    removed={removed}
                    handSet={handSet}
                    onPrint={takePrint}
                  />
                  {project !== null && (
                    <>
                      <Separator size="4" />
                      <Facts project={project} />
                    </>
                  )}
                </>
              )}
              {saveError !== null && (
                <Box p="3">
                  <Callout.Root size="1" color="red">
                    <Callout.Text>{saveError}</Callout.Text>
                  </Callout.Root>
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Flex>

      {menu !== null &&
        model !== null &&
        (() => {
          const source = sourceRef.current;
          const state = source?.structure.palette[source.indices[menu.block] as number];
          if (source === undefined || source === null || state === undefined) {
            return null;
          }
          const id = blockIdOf(state);
          const all = blocksOfType(id);
          const gone = all.filter((block) => removed.has(block)).length;
          return (
            <BlockMenu
              at={menu}
              state={state}
              count={all.length}
              gone={gone}
              slots={slots}
              slot={assignment[id] ?? 0}
              onClose={() => setMenu(null)}
              onAssign={(slot) =>
                run(
                  {
                    kind: "assign",
                    blockId: id,
                    from: assignment[id] ?? 0,
                    to: slot,
                    what: id.replace(/^minecraft:/, ""),
                  },
                  true,
                )
              }
              onRemove={() => {
                const edit = removal({ removed, assignment }, [menu.block], id.replace(/^minecraft:/, ""));
                if (edit !== null) {
                  run(edit, true);
                }
                setMenu(null);
              }}
              onRemoveType={() => {
                const edit = removal({ removed, assignment }, all, id.replace(/^minecraft:/, ""));
                if (edit !== null) {
                  run(edit, true);
                }
                setMenu(null);
              }}
              onRestoreType={() => {
                run(
                  {
                    kind: "restore",
                    blocks: all.filter((block) => removed.has(block)),
                    what: id.replace(/^minecraft:/, ""),
                  },
                  true,
                );
                setMenu(null);
              }}
            />
          );
        })()}
    </Theme>
  );
}
