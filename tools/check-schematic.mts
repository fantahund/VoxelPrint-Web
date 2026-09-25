/**
 * Checks that a schematic comes back out as the build that went in.
 *
 * <p>Run with {@code npx tsx tools/check-schematic.mts} from the repository root.
 *
 * <p>There are no sample files to test against, so the files are written here.
 * That would be circular if the writer were the reader turned round, so it is
 * not: the packing is written out again from the format's own description --
 * varints for Sponge, bits running end to end through 64-bit words for
 * Litematica -- and the block laid at every single coordinate is checked, not
 * the totals. A reader that is off by one, or that reads y for z, gets the
 * right number of blocks and the wrong building.
 *
 * <p>The bit widths are chosen on purpose. Five palette entries need three
 * bits, which do not divide 64, so entries straddle words; a hundred need
 * seven, which also do not. A packer that quietly assumes entries never cross a
 * word boundary passes with two bits and fails here.
 */
import { gzipSync } from "node:zlib";
import { readSchematic } from "../server/src/schematic/read.js";

let problems = 0;
const fail = (m: string): void => { problems++; console.log("  FAIL " + m); };
const ok = (m: string): void => console.log("  ok   " + m);

// --- a very small NBT writer, enough to build the three formats --------------
type Tag =
  | { t: "byte"; v: number } | { t: "short"; v: number } | { t: "int"; v: number }
  | { t: "string"; v: string } | { t: "bytes"; v: Uint8Array } | { t: "longs"; v: bigint[] }
  | { t: "list"; of: number; v: Tag[] } | { t: "compound"; v: Record<string, Tag> };

const ID = { byte: 1, short: 2, int: 3, long: 4, string: 8, bytes: 7, list: 9, compound: 10, longs: 12 };
const idOf = (tag: Tag): number =>
  tag.t === "byte" ? ID.byte : tag.t === "short" ? ID.short : tag.t === "int" ? ID.int
  : tag.t === "string" ? ID.string : tag.t === "bytes" ? ID.bytes : tag.t === "longs" ? ID.longs
  : tag.t === "list" ? ID.list : ID.compound;

class Writer {
  private parts: number[] = [];
  bytes(): Uint8Array { return Uint8Array.from(this.parts); }
  u8(v: number): void { this.parts.push(v & 0xff); }
  u16(v: number): void { this.u8(v >> 8); this.u8(v); }
  u32(v: number): void { this.u16(v >>> 16); this.u16(v & 0xffff); }
  u64(v: bigint): void { const x = BigInt.asUintN(64, v); this.u32(Number(x >> 32n)); this.u32(Number(x & 0xffffffffn)); }
  str(v: string): void { const b = Buffer.from(v, "utf-8"); this.u16(b.length); for (const c of b) this.u8(c); }
  payload(tag: Tag): void {
    switch (tag.t) {
      case "byte": this.u8(tag.v); break;
      case "short": this.u16(tag.v); break;
      case "int": this.u32(tag.v); break;
      case "string": this.str(tag.v); break;
      case "bytes": this.u32(tag.v.length); for (const b of tag.v) this.u8(b); break;
      case "longs": this.u32(tag.v.length); for (const l of tag.v) this.u64(l); break;
      case "list":
        this.u8(tag.of); this.u32(tag.v.length);
        for (const item of tag.v) this.payload(item);
        break;
      case "compound":
        for (const [name, child] of Object.entries(tag.v)) {
          this.u8(idOf(child)); this.str(name); this.payload(child);
        }
        this.u8(0);
        break;
    }
  }
}

function nbt(rootName: string, root: Tag): Uint8Array {
  const w = new Writer();
  w.u8(idOf(root));
  w.str(rootName);
  w.payload(root);
  return gzipSync(w.bytes());
}

const compound = (v: Record<string, Tag>): Tag => ({ t: "compound", v });
const short = (v: number): Tag => ({ t: "short", v });
const int = (v: number): Tag => ({ t: "int", v });
const str = (v: string): Tag => ({ t: "string", v });

// --- the build every format has to carry -------------------------------------
const W = 5, H = 4, D = 7;
/** Deliberately not a cube, and deliberately not symmetric on any axis. */
const PALETTE = [
  "minecraft:air",
  "minecraft:stone",
  "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]",
  "minecraft:oak_slab[type=top,waterlogged=false]",
  "minecraft:white_wool",
];
/** What stands at (x, y, z), chosen so every coordinate changes the answer. */
const wanted = (x: number, y: number, z: number): number => (x * 7 + y * 13 + z * 3) % PALETTE.length;

const at = (x: number, y: number, z: number): number => x + z * W + y * W * D;

function compare(what: string, read: { width: number; height: number; depth: number; palette: readonly string[]; indices: Uint32Array }, expect: (x: number, y: number, z: number) => string): void {
  if (read.width !== W || read.height !== H || read.depth !== D) {
    fail(`${what}: came back ${read.width}x${read.height}x${read.depth}, wanted ${W}x${H}x${D}`);
    return;
  }
  let wrong = 0;
  let first = "";
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const got = read.palette[read.indices[at(x, y, z)] as number] ?? "?";
        const want = expect(x, y, z);
        if (got !== want) {
          wrong++;
          if (first === "") {
            first = `at ${x},${y},${z}: ${got} instead of ${want}`;
          }
        }
      }
    }
  }
  if (wrong === 0) {
    ok(`${what}: all ${W * H * D} blocks came back where they went in`);
  } else {
    fail(`${what}: ${wrong} of ${W * H * D} blocks are wrong -- ${first}`);
  }
}

const airOr = (index: number): string => (index === 0 ? "minecraft:air" : PALETTE[index] as string);

// --- Sponge ------------------------------------------------------------------
{
  // Indices as varints, in y-z-x order, which is what every schematic uses and
  // the site does not.
  const data: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        let value = wanted(x, y, z);
        do {
          let byte = value & 0x7f;
          value >>>= 7;
          if (value !== 0) byte |= 0x80;
          data.push(byte);
        } while (value !== 0);
      }
    }
  }
  const palette: Record<string, Tag> = {};
  PALETTE.forEach((state, index) => { palette[state] = int(index); });

  const file = nbt("Schematic", compound({
    Version: int(2),
    Width: short(W), Height: short(H), Length: short(D),
    Palette: compound(palette),
    PaletteMax: int(PALETTE.length),
    BlockData: { t: "bytes", v: Uint8Array.from(data) },
    Metadata: compound({ Name: str("A Test Camp") }),
  }));

  const read = readSchematic(file);
  if (read.format !== "sponge") {
    fail(`a .schem was read as ${read.format}`);
  }
  compare("sponge", read, (x, y, z) => airOr(wanted(x, y, z)));
  if (read.name === "A Test Camp") {
    ok("sponge: the name written in the metadata comes through");
  } else {
    fail(`sponge: name came back as ${read.name}`);
  }
}

// --- Litematica ---------------------------------------------------------------
{
  /** Packed the way the format describes: bits end to end, straddling allowed. */
  function pack(values: readonly number[], bits: number): bigint[] {
    const words: bigint[] = new Array(Math.ceil((values.length * bits) / 64)).fill(0n);
    values.forEach((value, index) => {
      const start = index * bits;
      const first = Math.floor(start / 64);
      const offset = BigInt(start % 64);
      const v = BigInt(value);
      words[first] = BigInt.asUintN(64, (words[first] as bigint) | (v << offset));
      const spilled = Number(offset) + bits - 64;
      if (spilled > 0) {
        words[first + 1] = BigInt.asUintN(64, (words[first + 1] as bigint) | (v >> (64n - offset)));
      }
    });
    return words.map((w) => BigInt.asIntN(64, w));
  }

  const values: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        values.push(wanted(x, y, z));
      }
    }
  }
  // Five entries want three bits, which do not divide sixty-four.
  const bits = 3;
  const paletteList: Tag[] = PALETTE.map((state) => {
    const bracket = state.indexOf("[");
    if (bracket === -1) {
      return compound({ Name: str(state) });
    }
    const properties: Record<string, Tag> = {};
    for (const pair of state.slice(bracket + 1, -1).split(",")) {
      const [key, value] = pair.split("=");
      properties[key as string] = str(value as string);
    }
    return compound({ Name: str(state.slice(0, bracket)), Properties: compound(properties) });
  });

  const file = nbt("", compound({
    Version: int(6),
    Metadata: compound({ Name: str("A Test Camp"), EnclosingSize: compound({ x: int(W), y: int(H), z: int(D) }) }),
    Regions: compound({
      Main: compound({
        Position: compound({ x: int(0), y: int(0), z: int(0) }),
        Size: compound({ x: int(W), y: int(H), z: int(D) }),
        BlockStatePalette: { t: "list", of: ID.compound, v: paletteList },
        BlockStates: { t: "longs", v: pack(values, bits) },
      }),
    }),
  }));

  const read = readSchematic(file);
  if (read.format !== "litematica") {
    fail(`a .litematic was read as ${read.format}`);
  }
  compare("litematica", read, (x, y, z) => airOr(wanted(x, y, z)));
}

// --- Litematica, at a bit width that straddles harder -------------------------
{
  function pack(values: readonly number[], bits: number): bigint[] {
    const words: bigint[] = new Array(Math.ceil((values.length * bits) / 64) + 1).fill(0n);
    values.forEach((value, index) => {
      const start = index * bits;
      const first = Math.floor(start / 64);
      const offset = BigInt(start % 64);
      const v = BigInt(value);
      words[first] = BigInt.asUintN(64, (words[first] as bigint) | (v << offset));
      if (Number(offset) + bits > 64) {
        words[first + 1] = BigInt.asUintN(64, (words[first + 1] as bigint) | (v >> (64n - offset)));
      }
    });
    return words.map((w) => BigInt.asIntN(64, w));
  }
  // A hundred entries need seven bits; sixty-four is not a multiple of seven,
  // so nine entries in every sixty-four bits cross into the next word.
  const big = ["minecraft:air", ...Array.from({ length: 99 }, (_, i) => `minecraft:test_block_${i}`)];
  const pick = (x: number, y: number, z: number): number => (x * 31 + y * 17 + z * 11) % big.length;
  const values: number[] = [];
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) values.push(pick(x, y, z));

  const file = nbt("", compound({
    Regions: compound({
      Main: compound({
        Position: compound({ x: int(0), y: int(0), z: int(0) }),
        Size: compound({ x: int(W), y: int(H), z: int(D) }),
        BlockStatePalette: { t: "list", of: ID.compound, v: big.map((n) => compound({ Name: str(n) })) },
        BlockStates: { t: "longs", v: pack(values, 7) },
      }),
    }),
  }));
  const read = readSchematic(file);
  compare("litematica at seven bits", read, (x, y, z) => big[pick(x, y, z)] as string);
}

// --- MCEdit -------------------------------------------------------------------
{
  const blocks = new Uint8Array(W * H * D);
  const data = new Uint8Array(W * H * D);
  // 35:4 is yellow wool, 53:2 an oak stair facing south, 44:0 a stone slab.
  const ids = [[0, 0], [1, 0], [35, 4], [53, 2], [44, 0]];
  const expect = [
    "minecraft:air",
    "minecraft:stone",
    "minecraft:yellow_wool",
    "minecraft:oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]",
    "minecraft:stone_slab[type=bottom,waterlogged=false]",
  ];
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const which = wanted(x, y, z);
        const where = (y * D + z) * W + x;
        blocks[where] = ids[which]?.[0] as number;
        data[where] = ids[which]?.[1] as number;
      }
    }
  }
  const file = nbt("Schematic", compound({
    Width: short(W), Height: short(H), Length: short(D),
    Materials: str("Alpha"),
    Blocks: { t: "bytes", v: blocks },
    Data: { t: "bytes", v: data },
  }));
  const read = readSchematic(file);
  if (read.format !== "mcedit") {
    fail(`a .schematic was read as ${read.format}`);
  }
  compare("mcedit", read, (x, y, z) => expect[wanted(x, y, z)] as string);
  if (read.notes.some((note) => note.includes("pre-1.13"))) {
    ok("mcedit: the file says plainly that it is the old format and had to be looked up");
  } else {
    fail("mcedit: nothing warned that this format cannot carry block states");
  }
}

// --- MCEdit carrying its own names --------------------------------------------
{
  const blocks = Uint8Array.from([0, 200, 200, 0]);
  const file = nbt("Schematic", compound({
    Width: short(2), Height: short(1), Length: short(2),
    Blocks: { t: "bytes", v: blocks },
    Data: { t: "bytes", v: new Uint8Array(4) },
    SchematicaMapping: compound({ "create:andesite_casing": short(200) }),
  }));
  const read = readSchematic(file);
  const found = read.palette.includes("create:andesite_casing");
  if (found) {
    ok("mcedit: a modded block survives when the file brought its own name list");
  } else {
    fail(`mcedit: the mapping was ignored, palette was ${read.palette.join(", ")}`);
  }
}

// --- a region that runs backwards ---------------------------------------------
{
  const values = [1, 0, 0, 1];
  const file = nbt("", compound({
    Regions: compound({
      Main: compound({
        Position: compound({ x: int(0), y: int(0), z: int(0) }),
        // Negative on x: the region runs back from its corner.
        Size: compound({ x: int(-2), y: int(1), z: int(2) }),
        BlockStatePalette: { t: "list", of: ID.compound, v: [
          compound({ Name: str("minecraft:air") }), compound({ Name: str("minecraft:stone") })] },
        BlockStates: { t: "longs", v: [BigInt(values[0]! | (values[1]! << 2) | (values[2]! << 4) | (values[3]! << 6))] },
      }),
    }),
  }));
  const read = readSchematic(file);
  if (read.width === 2 && read.height === 1 && read.depth === 2) {
    ok("a region with a negative size comes back the right size round");
  } else {
    fail(`a backwards region came back ${read.width}x${read.height}x${read.depth}`);
  }
}

// --- and things that are not schematics ---------------------------------------
{
  const cases: Array<[string, Uint8Array]> = [
    ["a text file", new TextEncoder().encode("this is not a schematic at all")],
    ["an empty file", new Uint8Array(0)],
    ["NBT that is not a schematic", nbt("Hello", compound({ Greeting: str("hi") }))],
    ["a damaged gzip", Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 99, 99, 99])],
  ];
  let threw = 0;
  for (const [what, bytes] of cases) {
    try {
      readSchematic(bytes);
      fail(`${what} was accepted as a schematic`);
    } catch {
      threw++;
    }
  }
  if (threw === cases.length) {
    ok(`all ${cases.length} things that are not schematics were refused rather than half-read`);
  }
}

console.log(problems === 0 ? "\nALLE PRUEFUNGEN BESTANDEN" : `\n${problems} PROBLEME`);
process.exit(problems === 0 ? 0 : 1);
