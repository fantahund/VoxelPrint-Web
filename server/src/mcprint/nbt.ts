import { McPrintError } from "./archive.js";

export type NbtValue =
  | number
  | bigint
  | string
  | Uint8Array
  | Int32Array
  | BigInt64Array
  | NbtValue[]
  | NbtCompound;

export interface NbtCompound {
  readonly [key: string]: NbtValue;
}

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

/** Deeply nested input must not be able to exhaust the call stack. */
const MAX_DEPTH = 64;

/**
 * Reads uncompressed NBT.
 *
 * <p>NBT is big-endian and self-describing, which means the file tells the
 * reader how much to read next. That is fine for a file you wrote yourself and
 * a liability for one a stranger uploaded, so every read is bounds checked and
 * nesting is capped. A truncated or hostile file produces an error, never a
 * crash and never a hang.
 */
class NbtReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Reads the root compound, which in a Sponge schematic has no name. */
  readRoot(): { name: string; value: NbtCompound } {
    const type = this.u8();
    if (type !== TAG_COMPOUND) {
      throw new McPrintError("The structure file does not start with an NBT compound.");
    }
    const name = this.string();
    return { name, value: this.compound(0) };
  }

  private require(bytes: number): number {
    const start = this.offset;
    if (start + bytes > this.bytes.length) {
      throw new McPrintError("The structure file ends in the middle of a value.");
    }
    this.offset = start + bytes;
    return start;
  }

  private u8(): number {
    return this.view.getUint8(this.require(1));
  }

  private i16(): number {
    return this.view.getInt16(this.require(2), false);
  }

  private i32(): number {
    return this.view.getInt32(this.require(4), false);
  }

  private i64(): bigint {
    return this.view.getBigInt64(this.require(8), false);
  }

  private string(): string {
    const length = this.view.getUint16(this.require(2), false);
    const start = this.require(length);
    // Minecraft writes modified UTF-8. For the names and block states we read,
    // which are ASCII in practice, plain UTF-8 decoding is equivalent.
    return new TextDecoder("utf-8").decode(this.bytes.subarray(start, start + length));
  }

  /** Lengths come from the file, so a negative or absurd one is rejected. */
  private length(): number {
    const value = this.i32();
    if (value < 0 || value > this.bytes.length) {
      throw new McPrintError("The structure file declares an impossible length.");
    }
    return value;
  }

  private compound(depth: number): NbtCompound {
    if (depth > MAX_DEPTH) {
      throw new McPrintError("The structure file is nested too deeply.");
    }
    const result: Record<string, NbtValue> = {};
    for (;;) {
      const type = this.u8();
      if (type === TAG_END) {
        return result;
      }
      // The name comes before the payload. Reading them the other way round is
      // a classic mistake, because the bytes are laid out in this order.
      const name = this.string();
      result[name] = this.payload(type, depth + 1);
    }
  }

  private payload(type: number, depth: number): NbtValue {
    switch (type) {
      case TAG_BYTE:
        return this.view.getInt8(this.require(1));
      case TAG_SHORT:
        return this.i16();
      case TAG_INT:
        return this.i32();
      case TAG_LONG:
        return this.i64();
      case TAG_FLOAT:
        return this.view.getFloat32(this.require(4), false);
      case TAG_DOUBLE:
        return this.view.getFloat64(this.require(8), false);
      case TAG_BYTE_ARRAY: {
        const length = this.length();
        const start = this.require(length);
        return this.bytes.subarray(start, start + length);
      }
      case TAG_STRING:
        return this.string();
      case TAG_LIST: {
        if (depth > MAX_DEPTH) {
          throw new McPrintError("The structure file is nested too deeply.");
        }
        const itemType = this.u8();
        const length = this.length();
        const items: NbtValue[] = [];
        for (let i = 0; i < length; i++) {
          items.push(itemType === TAG_END ? 0 : this.payload(itemType, depth + 1));
        }
        return items;
      }
      case TAG_COMPOUND:
        return this.compound(depth);
      case TAG_INT_ARRAY: {
        const length = this.length();
        const start = this.require(length * 4);
        const values = new Int32Array(length);
        for (let i = 0; i < length; i++) {
          values[i] = this.view.getInt32(start + i * 4, false);
        }
        return values;
      }
      case TAG_LONG_ARRAY: {
        const length = this.length();
        const start = this.require(length * 8);
        const values = new BigInt64Array(length);
        for (let i = 0; i < length; i++) {
          values[i] = this.view.getBigInt64(start + i * 8, false);
        }
        return values;
      }
      default:
        throw new McPrintError(`The structure file uses an unknown NBT tag type ${type}.`);
    }
  }
}

export function readNbt(bytes: Uint8Array): { name: string; value: NbtCompound } {
  return new NbtReader(bytes).readRoot();
}

/** Reads a required child of a known type, with a message naming what is wrong. */
export function require<T extends NbtValue>(
  compound: NbtCompound,
  key: string,
  check: (value: NbtValue) => value is T,
  what: string,
): T {
  const value = compound[key];
  if (value === undefined) {
    throw new McPrintError(`The structure file has no ${key}.`);
  }
  if (!check(value)) {
    throw new McPrintError(`${key} in the structure file is not ${what}.`);
  }
  return value;
}

export const isNumber = (value: NbtValue): value is number => typeof value === "number";
export const isCompound = (value: NbtValue): value is NbtCompound =>
  typeof value === "object" && value !== null && !ArrayBuffer.isView(value) && !Array.isArray(value);
export const isByteArray = (value: NbtValue): value is Uint8Array => value instanceof Uint8Array;
