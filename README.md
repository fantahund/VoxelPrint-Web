# VoxelPrint Web

**The other half of [VoxelPrint](https://github.com/fantahund/VoxelPrint).**
Drop in the `.mcprint` the mod exported, look at the build, decide which block
prints in which filament, and download a 3MF a slicer opens on the right tools —
or an STL.

Live preview: **[voxelprint.emrion.de](https://voxelprint.emrion.de)**

```
Minecraft ──[ VoxelPrint mod ]──> .mcprint ──[ this ]──> .3mf / .stl ──> slicer
```

---

## What it does

**Works the palette out from the build.** A fixed set of filaments is wrong for
Minecraft: on one test build it put 369 of 408 block types onto a single colour
and left one unused. The palette here is computed from the build — weighted
k-means in Oklab, deterministic — which splits the same build 205 / 109 / 98 / 5
and cuts the mean colour error from 0.097 to 0.029. Pick 4 slots, or 8, or
however many the printer has.

**Lets you edit the build before printing.** Right click a block in the 3D view
to remove it, remove every block of its type, or move it to another filament.
A frame follows the block under the pointer, the way the game draws one.
Ctrl+Z and Ctrl+Y. A removed block reads as air when the model is rebuilt, so
the preview, the counts and the export all agree — and the block behind it gets
back the face it was hiding.

**Prints solid where solid is right.** Two modes: the **detailed shell** follows
the real models, giving every face a wall so a torch is still a torch; **solid
shapes** is one closed box per part of each block's shape. In either mode the
geometry is worked over before it is written — see below.

**Saves the plan.** Filaments, assignments and removals are stored per project,
so closing the tab does not lose the afternoon.

---

## What happens to the geometry

This is most of the work, and all of it is measured rather than assumed. On one
13×9×11 Minecraft house at 8 filaments:

| | bodies | triangles |
|---|---|---|
| naive shell | 3,288 | 39,456 |
| after the passes below | **1,164** | **13,872** |

**Faces pressed together are taken away.** Where two blocks meet, both faces are
dropped — a quarter of the surface a naive export keeps. Not only exact matches:
the overlap is subtracted, because a dirt path is fifteen sixteenths tall and
the earth beside it meets it with a taller face, and neither covers the other
exactly.

**A sheet with no thickness keeps one side.** Two coincident faces looking away
from each other are a wall between two blocks — unless they come from the *same*
block, in which case they are one sheet drawn from both sides. Getting that
wrong deleted a hanging sign's chains outright and made short grass vanish.

**Coplanar faces are joined.** Otherwise a floor is a hundred slabs that merely
touch, and a slicer draws a perimeter around every one of them.

**A block that is a box is printed as a box.** If a block's model is exactly the
surface of its collision shape — dirt, stairs, slabs, paths — it is emitted
solid and merged in three dimensions across the whole build. That is what gives
the slicer a volume to fill: a 1.2 mm wall is thinner than three perimeters, so
a shell alone never gets infill. Plants, chains and torches keep their walls,
since no box describes them.

---

## What is in the 3MF

One object built from components, one per filament, plus a
`Metadata/model_settings.config` naming each part and the extruder it prints on.
Verified in OrcaSlicer-based slicers, including Snapmaker Orca.

Two things it deliberately does **not** do:

- **No `paint_color` on triangles.** It used to carry one per triangle, saying
  the same thing as the parts by a second route. An OrcaSlicer update began
  dying on it — a minute or two of loading, then gone. Measured three ways: the
  same geometry as an STL opened at once, and of two 3MF files differing in
  nothing else, the one without the painting opened and the one without the
  configuration did not. Painting is meant for the few triangles somebody
  painted by hand, not for thirty-nine thousand.
- **No print profile.** The parts name a slot; what is loaded in it is the
  printer's business. Filament *colours* can travel with the file — that is the
  "Carry colours" box — but nothing else does, so a file cannot quietly replace
  the profiles you set up.

---

## Running it

Node 24, npm workspaces.

```bash
npm install
npm run build
npm run start      # http://localhost:3000, serves the built front end
```

Or with Docker:

```bash
docker compose up -d --build
```

### Checking the output

```bash
npm run typecheck
python3 tools/check-3mf.py my-file.3mf
python3 tools/check-stl.py my-file.stl
```

Both are stricter than a slicer: closed bodies, consistent winding, positive
volume, part assignment, and — since it cost a week once — that no triangle is
painted. `check-stl.py` tests each body on its own, which the 3MF checker cannot,
because overlapping bodies are allowed there and a touch must not read as a
fault. **Run them after any change under `web/src/export/`.**

---

## Layout

| | |
|---|---|
| `server/` | Fastify. Takes the upload, checks it, stores it, serves the structure, the packed indices and the models. Its own NBT reader, with every bound checked *before* the entry is unpacked, so an archive cannot claim to be small and arrive large. |
| `web/` | React, three.js, Radix Themes. Upload, preview, editor, palette, export. |
| `web/src/export/geometry.ts` | everything the 3MF and STL writers share, which is all of the shape and none of the file |
| `tools/` | the checkers, and the script that refreshes the filament library |
| `web/src/slots/` | how many colours the printer has, which ones, and which spool each of them really is |
| `web/public/filaments.json` | 152 makers and 13 730 colours, the floor under what the server keeps fresh |

---

## The filament library

Which colours people can actually buy, from the
[Open Filament Database](https://openfilamentdatabase.org/) — **152 makers,
13 730 colours**, every one with a hex value and a density.

Two copies, because neither alone is right:

- `web/public/filaments.json` is committed. It answers before the first refresh
  has finished, on a machine with no way out to the internet, and on the day the
  database moves house. Refresh it with `npx tsx tools/fetch-filaments.mts`.
- The **server** fetches the database on start and once a day, trims it, and
  serves that from `/api/filaments` instead. The database answers conditional
  requests, so a check that finds nothing new costs one round trip and no body.

The browser never fetches the database itself, and that is a measurement rather
than a preference: the whole export is 14 MB, 3.1 MB over the wire, against
144 kB for what is left after the trimming. Twenty-odd times the traffic per
visitor, for data that changes by a handful of entries a month.

What the trimming drops is the part nobody here reads — ids, spool sizes,
purchase links, barcodes, stores. It keeps every colour of every product,
including the ones no longer sold, because the spool somebody already has on
the shelf is the very one they want to pick; those are marked rather than
dropped. It also keeps the same black in matte and in silk as two entries,
because that is a difference anybody printing can see: `#000000` alone comes
from ABS, ABS-GF, ASA, ASA-CF and Matte ASA CF.

The Open Filament Database is MIT licensed, data included. Its colours are the
makers' own figures rather than measurements of printed filament;
[filamentcolors.xyz](https://filamentcolors.xyz) measures its swatches with a
colorimeter and is the better source where the two overlap, at a fifth of the
coverage and under CC-BY.

---

## Licence

MIT. See [LICENSE](LICENSE).

The filament library is from the Open Filament Database, also MIT.
