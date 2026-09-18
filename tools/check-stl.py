"""Checks an STL the way a strict slicer would, and then some.

The companion to check-3mf.py. An STL carries no package and no colour, so
what is left to check is the header, the count, and the geometry: a file that
passes this opens, and what it opens to is a heap of closed solids with their
faces pointing outwards.

Solids are checked one at a time rather than all together. They are allowed to
overlap and to sit corner to corner -- a slicer unions them -- and judging the
whole file as one surface would read every such touch as a fault. Twelve
triangles make one box, which is how they are told apart.
"""
import struct
import sys
from collections import defaultdict

HEADER_BYTES = 80
TRIANGLE_BYTES = 50
# Six faces, two triangles each: one solid as the exporter writes it.
PER_SOLID = 12

problems = []
notes = []


def fail(message):
    problems.append(message)


def ok(message):
    notes.append(message)


path = sys.argv[1]
with open(path, "rb") as handle:
    data = handle.read()

# --- the file ---------------------------------------------------------------
if len(data) < HEADER_BYTES + 4:
    print("%s: too short to be an STL at all" % path)
    sys.exit(1)

header = data[:HEADER_BYTES]
if header.lstrip()[:5].lower() == b"solid":
    fail("the header begins with 'solid', so readers will parse this as ASCII")
else:
    ok("the header does not begin with 'solid', so it reads as binary")

count = struct.unpack_from("<I", data, HEADER_BYTES)[0]
expected = HEADER_BYTES + 4 + count * TRIANGLE_BYTES
if len(data) != expected:
    fail("the count says %d triangles, which wants %d bytes, but the file is %d"
         % (count, expected, len(data)))
else:
    ok("%d triangles, and the file is exactly the length that implies" % count)

if count % PER_SOLID != 0:
    fail("%d triangles is not a whole number of %d triangle solids" % (count, PER_SOLID))

# --- the triangles ----------------------------------------------------------
triangles = []
at = HEADER_BYTES + 4
for index in range(count):
    values = struct.unpack_from("<12fH", data, at)
    at += TRIANGLE_BYTES
    normal = values[0:3]
    corners = (values[3:6], values[6:9], values[9:12])
    triangles.append((normal, corners))
    if values[12] != 0:
        fail("triangle %d has a non zero attribute count" % index)

bad_normals = 0
for index, (normal, (a, b, c)) in enumerate(triangles):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    length = (nx * nx + ny * ny + nz * nz) ** 0.5
    if length == 0:
        fail("triangle %d has no area" % index)
        continue
    # The stored normal must agree with the winding, or a reader that trusts
    # one of the two gets a surface facing the other way.
    dot = (normal[0] * nx + normal[1] * ny + normal[2] * nz) / length
    if dot < 0.99:
        bad_normals += 1
if bad_normals:
    fail("%d triangles whose stored normal disagrees with their winding" % bad_normals)
else:
    ok("every triangle's stored normal agrees with its winding")

# --- the solids -------------------------------------------------------------
solids = count // PER_SOLID
open_solids = 0
wound_wrong = 0
inside_out = 0
total_volume = 0.0

for solid in range(solids):
    faces = triangles[solid * PER_SOLID:(solid + 1) * PER_SOLID]

    # An STL names no vertices, so corners are matched by where they are. The
    # exporter rounds to a thousandth of a millimetre and a float32 holds that
    # exactly at these sizes, so equality is safe here.
    edges = defaultdict(int)
    for _, (a, b, c) in faces:
        for u, v in ((a, b), (b, c), (c, a)):
            edges[(u, v)] += 1
    if any(n != 1 for n in edges.values()):
        wound_wrong += 1
    elif any((v, u) not in edges for (u, v) in edges):
        open_solids += 1

    volume = 0.0
    for _, (a, b, c) in faces:
        volume += (
            a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
        ) / 6.0
    if volume <= 0:
        inside_out += 1
    total_volume += volume

if wound_wrong:
    fail("%d solids with an edge used twice in the same direction (winding)" % wound_wrong)
if open_solids:
    fail("%d solids with an edge that has no matching opposite (a hole)" % open_solids)
if inside_out:
    fail("%d solids whose faces point inwards" % inside_out)
if not (wound_wrong or open_solids or inside_out):
    ok("all %d solids closed, consistently wound and facing outwards" % solids)
    ok("they come to %.0f mm3 before the slicer unions the overlaps" % total_volume)

# --- where it sits ----------------------------------------------------------
corners = [corner for _, face in triangles for corner in face]
if corners:
    low = [min(c[axis] for c in corners) for axis in range(3)]
    high = [max(c[axis] for c in corners) for axis in range(3)]
    ok("%.1f x %.1f x %.1f mm" % tuple(high[axis] - low[axis] for axis in range(3)))
    # Z is up in a printer, and a model below the bed is the first thing a
    # slicer complains about.
    if low[2] < -1e-3:
        fail("the build reaches %.3f mm below the bed" % low[2])
    else:
        ok("it stands on the bed, at z = %.3f mm" % low[2])

# --- report -----------------------------------------------------------------
print("%s: %d solids, %d triangles" % (path, solids, count))
for note in notes:
    print("  ok   %s" % note)
for problem in problems:
    print("  FAIL %s" % problem)
print("\n%s" % ("ALLE PRUEFUNGEN BESTANDEN" if not problems else "%d PROBLEME" % len(problems)))
sys.exit(1 if problems else 0)
