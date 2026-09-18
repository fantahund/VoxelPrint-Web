import { unzipSync } from "fflate";

/** Something about the uploaded file is wrong, and the user should be told. */
export class McPrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McPrintError";
  }
}

/**
 * How large each wanted entry may be once unpacked.
 *
 * <p>Per entry rather than one number for all of them. A manifest is a few
 * kilobytes and a structure can be hundreds of megabytes; a single limit
 * generous enough for the structure would let a manifest expand to the same
 * size, which is exactly the hole a zip bomb walks through.
 */
export type EntryLimits = Readonly<Record<string, number>>;

/**
 * Reads named entries out of a {@code .mcprint} archive.
 *
 * <p>Only entries we asked for are unpacked. Everything else in the archive is
 * ignored rather than extracted, which removes a whole class of problems: an
 * archive cannot smuggle in a file we never look at.
 *
 * <p>Sizes are checked against the archive's own directory before anything is
 * decompressed. Without that, a few kilobytes of zeroes could expand into
 * gigabytes of memory -- the classic zip bomb.
 */
export function readEntries(data: Uint8Array, limits: EntryLimits): Map<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data, {
      filter: (file) => {
        const allowed = limits[file.name];
        if (allowed === undefined) {
          return false;
        }
        // The archive declares the unpacked size of every entry up front, so
        // this is decided before a single byte is decompressed.
        if (file.originalSize > allowed) {
          throw new McPrintError(
            `${file.name} unpacks to ${file.originalSize} bytes, more than the allowed ${allowed}.`,
          );
        }
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof McPrintError) {
      throw cause;
    }
    throw new McPrintError("The file is not a readable .mcprint archive.");
  }

  return new Map(Object.entries(entries));
}

/**
 * Checks that a name from the manifest really is a plain file name.
 *
 * <p>{@code structureFile} comes out of the uploaded file, so it is input from
 * a stranger. It is only ever used to look up an entry inside the archive, but
 * it would be careless to let it carry a path at all.
 */
export function requirePlainFileName(name: string, field: string): string {
  const invalid = name.includes("/") || name.includes("\\") || name.includes("..") || name.trim() !== name;
  if (invalid || name.length === 0 || name.length > 128) {
    throw new McPrintError(`${field} is not a plain file name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Parses an entry as UTF-8 JSON. */
export function readJsonEntry(entries: Map<string, Uint8Array>, name: string): unknown {
  const bytes = entries.get(name);
  if (bytes === undefined) {
    throw new McPrintError(`The archive has no ${name}.`);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new McPrintError(`${name} is not valid JSON.`);
  }
}
