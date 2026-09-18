import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchIndices, fetchModels, fetchProject, savePrinting, uploadProject } from "./api";
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
import { buildThreeMf, type Geometry, type ThreeMfFile } from "./export/threeMf";
import {
  buildVoxels,
  colourise,
  unpackIndices,
  type SceneColours,
  type VoxelModel,
} from "./viewer/buildVoxels";
import Viewer from "./viewer/Viewer";
import type { Project } from "./types";

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
    <div className="slot-counts">
      {SLOT_COUNTS.map((option) => (
        <button
          key={option}
          type="button"
          className={count === option ? "chip active" : "chip"}
          onClick={() => onCount(option)}
        >
          {option} {option === 1 ? "colour" : "colours"}
        </button>
      ))}
      <label className="chip count-input">
        <input
          type="number"
          min={1}
          max={MAX_SLOTS}
          value={count}
          aria-label="How many filaments"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next) && next >= 1) {
              onCount(Math.min(Math.round(next), MAX_SLOTS));
            }
          }}
        />
      </label>
    </div>
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
    <section className="panel">
      <h2>Project</h2>
      <dl className="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
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
    <section className="panel">
      <h2>Filaments</h2>
      <p className="muted">
        How many colours the printer can load, and what they look like. Changing a colour updates the
        preview at once.
      </p>

      <SlotCount count={count} onCount={onCount} />

      <div className="slot-counts">
        <button
          type="button"
          className={source === "build" ? "chip active" : "chip"}
          onClick={() => onSource("build")}
          title="Work out the best colours for this build"
        >
          Colours from the build
        </button>
        <button
          type="button"
          className={source === "standard" ? "chip active" : "chip"}
          onClick={() => onSource("standard")}
          title="The same set every time, for spools you already own"
        >
          Standard set
        </button>
        <button type="button" className="chip" onClick={onReassign}>
          Re-assign by colour
        </button>
      </div>

      {slots.length < count && (
        <p className="muted">
          This build has only {slots.length} distinct {slots.length === 1 ? "colour" : "colours"} worth
          giving a filament of its own, so {count - slots.length} would stay unused.
        </p>
      )}

      <ul className="slots">
        {slots.map((slot, index) => (
          <li key={index}>
            <input
              type="color"
              value={toHex(slot.colour)}
              aria-label={`Colour of ${slot.name}`}
              onChange={(event) => change(index, { colour: fromHex(event.target.value) })}
            />
            <input
              type="text"
              value={slot.name}
              aria-label={`Name of filament ${index + 1}`}
              onChange={(event) => change(index, { name: event.target.value })}
            />
          </li>
        ))}
      </ul>
    </section>
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
    <section className="panel">
      <h2>Blocks to filaments</h2>
      <p className="muted">
        {numberFormat.format(model.typeCounts.length)} block types, most common first. Every block of a
        type prints in the same colour.{" "}
        {model.modelled
          ? "The in-game colour is measured from the textures the export carries."
          : "The in-game colour is this site's guess; export again with models to measure it."}
      </p>
      <table className="blocks">
        <thead>
          <tr>
            <th>Blocks</th>
            <th>Type</th>
            <th>In game</th>
            <th>Filament</th>
          </tr>
        </thead>
        <tbody>
          {model.typeCounts.map(([id, count]) => {
            const slotIndex = assignment[id] ?? 0;
            const slot = slots[slotIndex];
            const inGame = model.blockTypeColours[id] ?? 0x9a9a9a;
            return (
              <tr key={id}>
                <td className="count">{numberFormat.format(count)}</td>
                <td className="state">{id}</td>
                <td>
                  <span
                    className="swatch"
                    style={{ background: toHex(inGame) }}
                    title={toHex(inGame)}
                    aria-label={`${id} looks like ${toHex(inGame)}`}
                  />
                </td>
                <td className="assign">
                  <span
                    className="swatch"
                    style={{ background: toHex(slot?.colour ?? 0x9a9a9a) }}
                    aria-hidden="true"
                  />
                  <select
                    value={slotIndex}
                    aria-label={`Filament for ${id}`}
                    onChange={(event) => onAssign(id, Number(event.target.value))}
                  >
                    {slots.map((option, index) => (
                      <option key={index} value={index}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Writes the build out as a 3MF file.
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
}: {
  model: VoxelModel;
  slots: readonly FilamentSlot[];
  assignment: Readonly<Record<string, number>>;
  name: string;
}): React.ReactElement {
  const [millimetres, setMillimetres] = useState(10);
  const [geometry, setGeometry] = useState<Geometry>("shell");
  const [wall, setWall] = useState(1.2);
  const [file, setFile] = useState<ThreeMfFile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh plan or a different setting makes whatever was built stale.
  useEffect(() => setFile(null), [model, slots, assignment, millimetres, geometry, wall]);

  const printed = [
    model.size.width * millimetres,
    model.size.depth * millimetres,
    model.size.height * millimetres,
  ];

  const save = (): void => {
    setFailure(null);
    try {
      const built = buildThreeMf(model, slots, assignment, {
        millimetresPerBlock: millimetres,
        geometry,
        wallMillimetres: wall,
        name,
      });
      setFile(built);

      const blob = new Blob([built.bytes as BlobPart], { type: "model/3mf" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.3mf`;
      link.click();
      // Freed on the next turn of the loop, once the browser has taken it.
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "The file could not be built.");
    }
  };

  return (
    <section className="panel">
      <h2>Print it</h2>
      <p className="muted">
        A 3MF file holding one part per filament, which any slicer can open and give an extruder to.
      </p>

      <div className="slot-counts">
        <button
          type="button"
          className={geometry === "shell" ? "chip active" : "chip"}
          onClick={() => setGeometry("shell")}
          title="Follow the models, as the preview draws them"
        >
          Detailed shell
        </button>
        <button
          type="button"
          className={geometry === "solid" ? "chip active" : "chip"}
          onClick={() => setGeometry("solid")}
          title="One closed box per part of each block's shape"
        >
          Solid shapes
        </button>
        {geometry === "shell" && (
          <label className="chip count-input measure">
            <input
              type="number"
              min={0.2}
              max={10}
              step={0.2}
              value={wall}
              aria-label="Wall thickness in millimetres"
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 0.2) {
                  setWall(Math.min(next, 10));
                }
              }}
            />
            <span>mm wall</span>
          </label>
        )}
      </div>

      <p className="muted">
        {geometry === "shell" ? (
          <>
            The models, each face given a wall to print out of, so a torch is a torch. Hollow, so
            thin parts are fragile and there is a great deal more of it.
          </>
        ) : (
          <>
            One closed box per part of each block&rsquo;s shape. Sturdy and much smaller, but a
            tilted torch comes out as an upright stub.
          </>
        )}
      </p>

      <div className="slot-counts">
        <label className="chip count-input measure">
          <input
            type="number"
            min={1}
            max={200}
            step={1}
            value={millimetres}
            aria-label="Millimetres per block"
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= 1) {
                setMillimetres(Math.min(Math.round(next), 200));
              }
            }}
          />
          <span>mm per block</span>
        </label>
        <button type="button" className="chip" onClick={save}>
          Download .3mf
        </button>
      </div>

      <p className="muted">
        {/* Before building, the size is what the blocks come to; afterwards it
            is what the file actually measures, which a shell overruns by half a
            wall on each side. */}
        {file === null ? (
          <>
            {printed[0]} × {printed[1]} × {printed[2]} mm. Built when you ask for it.
          </>
        ) : (
          <>
            {file.size[0]} × {file.size[1]} × {file.size[2]} mm.{" "}
            {numberFormat.format(file.triangles)} triangles across {file.parts}{" "}
            {file.parts === 1 ? "part" : "parts"}, {bytes(file.bytes.length)}.
          </>
        )}
      </p>
      {failure !== null && <p className="error">{failure}</p>}
    </section>
  );
}

export default function App(): React.ReactElement {
  const [project, setProject] = useState<Project | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** Guards the save effect until the first plan is in place. */
  const [loadedPlan, setLoadedPlan] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Puts the project in the address bar, so a reload keeps what is on screen. */
  const remember = useCallback((next: Project) => {
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
      setModel(null);
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
        const built = buildVoxels(structure, unpackIndices(raw, structure.bytesPerIndex), models);
        setModel(built);

        const saved = project.printing;
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
  }, [project]);

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
      void savePrinting(project.id, { slots: [...slots], assignment: { ...assignment } })
        .then(() => setSaveError(null))
        .catch((cause: unknown) =>
          setSaveError(cause instanceof Error ? cause.message : "The plan could not be saved."),
        );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [project, slots, assignment, loadedPlan]);

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
    <main>
      <header>
        <h1>VoxelPrint</h1>
        <p className="muted">Turn a Minecraft build into something a 3D printer understands.</p>
      </header>

      <section className="panel upload">
        <h2>How many colours can the printer load?</h2>
        <p className="muted">
          Decided before the upload, because the whole palette is worked out from it. Changeable
          afterwards.
        </p>
        <SlotCount count={slotCount} onCount={(next) => repalette(next, paletteSource)} />
      </section>

      <label
        className={dragging ? "drop dragging" : "drop"}
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
        <span>{busy ? "Reading …" : "Drop a .mcprint file here, or choose one"}</span>
      </label>

      {error !== null && <p className="error">{error}</p>}

      {project !== null && (
        <>
          <section className="panel">
            <h2>Preview</h2>
            {model === null ? (
              <p className="muted">Building the preview …</p>
            ) : (
              <>
                <div className="slot-counts">
                  <button
                    type="button"
                    className={colourMode === "filament" ? "chip active" : "chip"}
                    onClick={() => setColourMode("filament")}
                  >
                    Filament colours
                  </button>
                  <button
                    type="button"
                    className={colourMode === "minecraft" ? "chip active" : "chip"}
                    onClick={() => setColourMode("minecraft")}
                    disabled={!model.modelled}
                    title={
                      model.modelled
                        ? "What the build looks like in the game"
                        : "This export carries no textures to take colours from"
                    }
                  >
                    Minecraft colours
                  </button>
                </div>
                <Viewer model={model} colours={colours} />
                <p className="muted preview-note">
                  {numberFormat.format(model.visible)} of {numberFormat.format(model.solid)} solid blocks
                  are drawn; the rest are fully enclosed and can never be seen.{" "}
                  {model.modelled ? (
                    <>
                      Drawn from the real models the export carries, {numberFormat.format(model.quads)}{" "}
                      faces in all, so a torch is a torch.{" "}
                      {model.boxes > 0 && (
                        <>
                          {numberFormat.format(model.boxes)} boxes stand in for blocks the game draws
                          itself, such as chests and signs.
                        </>
                      )}
                    </>
                  ) : model.shaped ? (
                    <>
                      Drawn as {numberFormat.format(model.boxes)} boxes, using the shapes the export
                      carries, so a stair is a stair. Export again with block models switched on to see
                      the real shapes.
                    </>
                  ) : (
                    <>
                      This export carries no block shapes, so every block is drawn as a full cube.
                      Export again with a newer VoxelPrint to see real shapes.
                    </>
                  )}
                </p>
              </>
            )}
          </section>

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
              {saveError !== null && <p className="error">{saveError}</p>}
              <Mapping
                model={model}
                slots={slots}
                assignment={assignment}
                onAssign={(blockId, slot) =>
                  setAssignment((current) => ({ ...current, [blockId]: slot }))
                }
              />
              <Download
                model={model}
                slots={slots}
                assignment={assignment}
                name={project.fileName.replace(/\.mcprint$/i, "") || "voxelprint"}
              />
            </>
          )}

          <Facts project={project} />
        </>
      )}
    </main>
  );
}
