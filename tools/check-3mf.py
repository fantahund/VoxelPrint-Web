"""Checks a 3MF the way a strict slicer would, and then some.

Covers the package, the XML, and the geometry: a file that passes this opens,
and what it opens to is a closed solid with its faces pointing outwards.
"""
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
MAT = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
MODEL_REL = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"

problems = []
notes = []


def fail(message):
    problems.append(message)


def ok(message):
    notes.append(message)


path = sys.argv[1]
z = zipfile.ZipFile(path)
names = z.namelist()

# --- package ---------------------------------------------------------------
if names[0] != "[Content_Types].xml":
    fail("[Content_Types].xml must be the first entry, found %r" % names[0])
else:
    ok("[Content_Types].xml is the first entry")

for required in ("[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"):
    if required not in names:
        fail("missing package part: %s" % required)
if any(n.startswith("/") or ".." in n or "\\" in n for n in names):
    fail("entry names must be relative with forward slashes: %r" % names)

types = ET.fromstring(z.read("[Content_Types].xml"))
if types.tag != "{%s}Types" % CT:
    fail("content types root is %s" % types.tag)
extensions = {d.get("Extension"): d.get("ContentType") for d in types}
for name in names:
    # The content types part describes the others and is never described itself.
    if name == "[Content_Types].xml":
        continue
    ending = name.rsplit(".", 1)[-1].lower()
    if "/" in ending or ending not in extensions:
        fail("package part %r has an extension no content type declares" % name)
if extensions.get("model") != "application/vnd.ms-package.3dmanufacturing-3dmodel+xml":
    fail("the .model content type is wrong: %r" % extensions.get("model"))
if extensions.get("rels") != "application/vnd.openxmlformats-package.relationships+xml":
    fail("the .rels content type is wrong: %r" % extensions.get("rels"))
ok("content types declare .model and .rels")

rels = ET.fromstring(z.read("_rels/.rels"))
starts = [r for r in rels if r.get("Type") == MODEL_REL]
if len(starts) != 1:
    fail("expected exactly one 3D model relationship, found %d" % len(starts))
else:
    target = starts[0].get("Target").lstrip("/")
    if target not in names:
        fail("the relationship points at %r, which is not in the package" % target)
    else:
        ok("the start part relationship points at %s" % target)

# --- model xml -------------------------------------------------------------
model = ET.fromstring(z.read("3D/3dmodel.model"))
if model.tag != "{%s}model" % CORE:
    fail("model root is %s, not the 3MF core namespace" % model.tag)
if model.get("unit") != "millimeter":
    fail("unit is %r" % model.get("unit"))
ok("core namespace, unit millimeter")

resources = model.find("{%s}resources" % CORE)
build = model.find("{%s}build" % CORE)
if resources is None or build is None:
    fail("model needs both <resources> and <build>")
    print("\n".join(problems))
    sys.exit(1)

ids = {}
order = []
materials = {}
for element in resources:
    tag = element.tag.split("}")[1]
    rid = element.get("id")
    if rid is None:
        fail("<%s> without an id" % tag)
        continue
    if rid in ids:
        fail("resource id %s used twice" % rid)
    ids[rid] = element
    order.append(rid)
    if tag == "colorgroup":
        entries = list(element)
        materials[rid] = entries
        for colour in entries:
            value = colour.get("color", "")
            if not (len(value) in (7, 9) and value.startswith("#")):
                fail("m:color %r is not #RRGGBB(AA)" % value)
        ok("%d colours in the materials extension colorgroup" % len(entries))
    if tag == "basematerials":
        bases = list(element)
        materials[rid] = bases
        for base in bases:
            colour = base.get("displaycolor", "")
            if not (len(colour) in (7, 9) and colour.startswith("#")):
                fail("displaycolor %r is not #RRGGBB(AA)" % colour)
        ok("%d base materials" % len(bases))

# --- geometry --------------------------------------------------------------
total_triangles = 0
meshes = 0
for rid in order:
    element = ids[rid]
    if element.tag != "{%s}object" % CORE:
        continue
    if element.get("type") not in (None, "model"):
        fail("object %s has type %r" % (rid, element.get("type")))

    pid = element.get("pid")
    if pid is not None:
        if pid not in materials:
            fail("object %s points at material group %s, which is not a basematerials" % (rid, pid))
        else:
            index = int(element.get("pindex", "0"))
            if not 0 <= index < len(materials[pid]):
                fail("object %s uses material index %d of %d" % (rid, index, len(materials[pid])))

    components = element.find("{%s}components" % CORE)
    if components is not None:
        for component in components:
            target = component.get("objectid")
            if target not in ids:
                fail("component points at unknown object %s" % target)
            elif order.index(target) > order.index(rid):
                fail("object %s uses %s before it is defined" % (rid, target))
        ok("assembly %s holds %d components" % (rid, len(list(components))))
        continue

    mesh = element.find("{%s}mesh" % CORE)
    if mesh is None:
        fail("object %s has neither a mesh nor components" % rid)
        continue
    meshes += 1

    points = [
        (float(v.get("x")), float(v.get("y")), float(v.get("z")))
        for v in mesh.find("{%s}vertices" % CORE)
    ]
    faces = []
    colours_used = set()
    for t in mesh.find("{%s}triangles" % CORE):
        a, b, c = int(t.get("v1")), int(t.get("v2")), int(t.get("v3"))
        if t.get("p1") is not None:
            index = int(t.get("p1"))
            group = t.get("pid", pid)
            if group not in materials:
                fail("triangle points at property group %s, which is not declared" % group)
            elif not 0 <= index < len(materials[group]):
                fail("triangle uses colour %d of %d" % (index, len(materials[group])))
            colours_used.add(index)
        for index in (a, b, c):
            if not 0 <= index < len(points):
                fail("object %s: triangle index %d out of %d vertices" % (rid, index, len(points)))
        if a == b or b == c or a == c:
            fail("object %s: degenerate triangle %d %d %d" % (rid, a, b, c))
        faces.append((a, b, c))
    total_triangles += len(faces)
    if colours_used:
        ok("object %s: %d triangles carry one of %d colours" % (rid, len(faces), len(colours_used)))

    used = {i for f in faces for i in f}
    if len(used) != len(points):
        fail("object %s: %d vertices, %d used" % (rid, len(points), len(used)))

    # Manifold: every edge exactly twice, once in each direction.
    edges = defaultdict(int)
    for a, b, c in faces:
        for u, v in ((a, b), (b, c), (c, a)):
            edges[(u, v)] += 1
    bad_direction = [e for e, n in edges.items() if n != 1]
    unmatched = [e for e in edges if (e[1], e[0]) not in edges]
    if bad_direction:
        fail("object %s: %d edges used twice in the same direction (winding)" % (rid, len(bad_direction)))
    if unmatched:
        fail("object %s: %d edges with no matching opposite (a hole)" % (rid, len(unmatched)))
    if not bad_direction and not unmatched:
        ok("object %s: closed and consistently wound, %d triangles" % (rid, len(faces)))

    # Signed volume: positive means the faces point outwards.
    volume = 0.0
    for a, b, c in faces:
        pa, pb, pc = points[a], points[b], points[c]
        volume += (
            pa[0] * (pb[1] * pc[2] - pb[2] * pc[1])
            - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0])
            + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])
        ) / 6.0
    if volume <= 0:
        fail("object %s: volume %.1f, so its faces point inwards" % (rid, volume))
    else:
        ok("object %s: volume %.0f mm3" % (rid, volume))

# --- the slicer configuration ----------------------------------------------
SETTINGS = "Metadata/model_settings.config"
PROJECT = "Metadata/project_settings.config"
if SETTINGS in names:
    config = ET.fromstring(z.read(SETTINGS))
    if config.tag != "config":
        fail("%s root is <%s>" % (SETTINGS, config.tag))

    wanted_slots = []
    for obj in config.findall("object"):
        if obj.get("id") not in ids:
            fail("%s names object %s, which is not in the model" % (SETTINGS, obj.get("id")))
            continue
        named = {p.get("id") for p in obj.findall("part")}
        group = ids[obj.get("id")].find("{%s}components" % CORE)
        held = set() if group is None else {c.get("objectid") for c in group}
        if named != held:
            fail("%s names parts %s, the object is built from %s" % (SETTINGS, sorted(named), sorted(held)))
        else:
            ok("%s names every one of the %d parts the object is built from" % (SETTINGS, len(held)))

        for part in obj.findall("part"):
            if part.get("subtype") != "normal_part":
                fail("part %s has subtype %r" % (part.get("id"), part.get("subtype")))
            keys = {m.get("key"): m.get("value") for m in part.findall("metadata")}
            if "extruder" not in keys:
                fail("part %s has no extruder" % part.get("id"))
            elif int(keys["extruder"]) < 1:
                fail("extruder %s is not a one based slot" % keys["extruder"])
            else:
                wanted_slots.append(int(keys["extruder"]))

    if PROJECT not in names:
        # Deliberately absent: bringing filaments along replaces the printer's
        # own profiles. The parts name a slot, the printer fills it.
        ok("no filament set carried, so the printer keeps its own")
    if PROJECT in names:
        import json
        settings = json.loads(z.read(PROJECT))
        filaments = settings.get("filament_colour", [])
        for colour in filaments:
            if not (isinstance(colour, str) and len(colour) == 7 and colour.startswith("#")):
                fail("filament colour %r is not #RRGGBB" % colour)
        # Only what is there has to line up; naming the filaments is optional
        # and left out on purpose, so the slicer keeps its own profiles.
        for key in ("filament_type", "filament_settings_id"):
            if key in settings and len(settings[key]) != len(filaments):
                fail("%s has a different length from filament_colour" % key)
        if wanted_slots and max(wanted_slots) > len(filaments):
            fail("a part asks for slot %d of %d filaments" % (max(wanted_slots), len(filaments)))
        else:
            ok("%d filaments defined, the highest slot asked for is %d"
               % (len(filaments), max(wanted_slots) if wanted_slots else 0))
        if len(set(wanted_slots)) != len(wanted_slots):
            fail("two parts claim the same filament slot")

# --- painting ---------------------------------------------------------------
# One character per four bits, lowest first: slot 1 is "4", slot 2 is "8",
# and beyond that "c" plus the rest. Checked against the slot the part asks for.
def expected_paint(slot):
    if slot <= 2:
        return "%x" % (slot << 2)
    if slot <= 17:
        return "c%x" % (slot - 3)
    return "cf%x" % (slot - 18)

if SETTINGS in names:
    config = ET.fromstring(z.read(SETTINGS))
    for obj in config.findall("object"):
        for part in obj.findall("part"):
            keys = {m.get("key"): m.get("value") for m in part.findall("metadata")}
            slot = int(keys.get("extruder", "1"))
            target = ids.get(part.get("id"))
            if target is None:
                continue
            mesh = target.find("{%s}mesh" % CORE)
            if mesh is None:
                continue
            painted = {t.get("paint_color") for t in mesh.find("{%s}triangles" % CORE)}
            if painted != {expected_paint(slot)}:
                fail("part %s is on slot %d but painted %s, expected %r"
                     % (part.get("id"), slot, sorted(x for x in painted if x), expected_paint(slot)))
            else:
                ok("part %s: every triangle painted %r for slot %d"
                   % (part.get("id"), expected_paint(slot), slot))

items = list(build)
for item in items:
    if item.get("objectid") not in ids:
        fail("build item points at unknown object %s" % item.get("objectid"))
ok("build places %d item(s)" % len(items))

# --- report ----------------------------------------------------------------
print("%s: %d meshes, %d triangles" % (path, meshes, total_triangles))
for note in notes:
    print("  ok   %s" % note)
for problem in problems:
    print("  FAIL %s" % problem)
print("\n%s" % ("ALLE PRUEFUNGEN BESTANDEN" if not problems else "%d PROBLEME" % len(problems)))
sys.exit(1 if problems else 0)
