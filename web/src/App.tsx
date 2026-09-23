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
import { apply, describe, invert, removal, type Edit, type EditorState } from "./editor";
import type { Pick } from "./viewer/Viewer";
import { buildThreeMf, type ThreeMfFile } from "./export/threeMf";
import { buildStl, type StlFile } from "./export/stl";
import type { Geometry } from "./export/geometry";
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
  onSlots,
  count,
  onCount,
  source,
  onSource,
  onReassign,
}: {
  slots: readonly FilamentSlot[];
  onSlots: (next: readonly FilamentSlot[]) => void;
  count: number;
  onCount: (next: number) => void;
  source: PaletteSource;
  onSource: (next: PaletteSource) => void;
  onReassign: () => void;
}): React.ReactElement {
  const change = (index: number, patch: Partial<FilamentSlot>): void => {
    onSlots(slots.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  };

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
            </Flex>
          ))}
        </Flex>
      </Flex>
    </Panel>
  );
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

/**
 * Whichever file was built last, and which kind it was.
 *
 * <p>An STL has no parts, so it counts as one: the summary then reads the same
 * way for both without the two needing separate wording.
 */
type Built = (ThreeMfFile | StlFile) & { readonly kind: Kind; readonly parts: number };

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
}): React.ReactElement {
  const [millimetres, setMillimetres] = useState(startingSize);
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
  const [file, setFile] = useState<Built | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh plan or a different setting makes whatever was built stale.
  useEffect(
    () => setFile(null),
    [model, slots, assignment, millimetres, geometry, wall, carryColours],
  );

  const printed = [
    model.size.width * millimetres,
    model.size.depth * millimetres,
    model.size.height * millimetres,
  ];

  const save = (kind: Kind): void => {
    setFailure(null);
    try {
      const options = {
        millimetresPerBlock: millimetres,
        geometry,
        wallMillimetres: wall,
        name,
        carryColours,
      };
      const built: Built =
        kind === "3mf"
          ? { kind, ...buildThreeMf(model, slots, assignment, options) }
          : { kind, parts: 1, ...buildStl(model, slots, assignment, options) };
      setFile(built);

      const blob = new Blob([built.bytes as BlobPart], { type: MEDIA_TYPES[kind] });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.${kind}`;
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
        <Box>
          <Text as="div" size="1" weight="medium" mb="1">
            Geometry
          </Text>
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
        </Box>

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

        <Box>
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
        </Box>

        <Separator size="4" />

        <Flex gap="2">
          <Button style={{ flex: 1 }} onClick={() => save("3mf")}>
            Download .3mf
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
              {file.size[0]} × {file.size[1]} × {file.size[2]} mm.{" "}
              {numberFormat.format(file.triangles)} triangles
              {file.kind === "3mf" ? (
                <>
                  {" "}
                  across {file.parts} {file.parts === 1 ? "part" : "parts"}
                </>
              ) : (
                <> in one body</>
              )}
              , {bytes(file.bytes.length)} of .{file.kind}.
            </>
          )}
        </Text>

        {failure !== null && (
          <Callout.Root size="1" color="red">
            <Callout.Text>{failure}</Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    </Panel>
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
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [skinDragging, setSkinDragging] = useState(false);
  /** Guards the save effect until the first plan is in place. */
  const [loadedPlan, setLoadedPlan] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Puts the project in the address bar, so a reload keeps what is on screen. */
  const remember = useCallback((next: Project) => {
    setSkin(null);
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
      setSlots(palette);
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
          setSlots(saved.slots);
          setSlotCount(saved.slots.length);
          settingsRef.current = { ...settingsRef.current, count: saved.slots.length };
          setAssignment({ ...guessed, ...saved.assignment });
          setLoadedPlan(true);
        } else {
          const { count, source } = settingsRef.current;
          const palette = paletteFor(built, count, source);
          setSlots(palette);
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
        setSlots(standardPalette(count));
        return;
      }
      const palette = paletteFor(model, count, source);
      setSlots(palette);
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
    return colourise(model, perPaletteIndex, false);
  }, [model, slots, assignment, colourMode]);

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
                    onSlots={setSlots}
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
                    // Remounted between a build and a skin, so the size it
                    // starts at is the one that suits what is open.
                    key={skin === null ? "build" : "skin"}
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
