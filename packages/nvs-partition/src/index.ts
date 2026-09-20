/**
 * Generates ESP-IDF NVS partition images (format version 2), byte-compatible with IDF's
 * nvs_partition_gen.py. Pure TypeScript with no runtime dependencies, so it runs in Bun, Node
 * and the browser.
 *
 * Layout reference: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_flash.html#internals
 */

const PAGE_SIZE = 4096;
const ENTRY_SIZE = 32;
const ENTRIES_PER_PAGE = 126;
const FIRST_ENTRY_OFFSET = 64; // 32 byte page header + 32 byte entry state bitmap
const MIN_PARTITION_SIZE = 0x3000;
const MAX_KEY_LENGTH = 15;
/** Longest string IDF accepts, including the NUL terminator. */
const MAX_STRING_SIZE = 4000;

const PAGE_STATE_FULL = 0xfffffffc;
const NVS_VERSION_2 = 0xfe;

const TYPE = { u8: 0x01, i8: 0x11, u16: 0x02, i16: 0x12, u32: 0x04, i32: 0x14, string: 0x21 } as const;
const INT_BYTES = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4 } as const;

export type NvsValue =
  | { type: "string"; value: string }
  | { type: keyof typeof INT_BYTES; value: number };

/** namespace -> key -> value. Insertion order is preserved in the image. */
export type NvsData = Record<string, Record<string, NvsValue | string>>;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Same as Python's `zlib.crc32(data, 0xFFFFFFFF)`, which is what NVS uses throughout. */
function nvsCrc32(...chunks: Uint8Array[]): number {
  let crc = 0;
  for (const chunk of chunks) {
    for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

function encodeKey(key: string, what: string): Uint8Array {
  const bytes = new TextEncoder().encode(key);
  if (bytes.length === 0 || bytes.length > MAX_KEY_LENGTH) {
    throw new Error(`NVS ${what} "${key}" must be 1-${MAX_KEY_LENGTH} bytes`);
  }
  const padded = new Uint8Array(16);
  padded.set(bytes);
  return padded;
}

class Page {
  readonly bytes = new Uint8Array(PAGE_SIZE).fill(0xff);
  private readonly view = new DataView(this.bytes.buffer);
  private used = 0;

  constructor(sequence: number) {
    // IDF's generator marks every page FULL, including empty ones; match it exactly.
    this.view.setUint32(0, PAGE_STATE_FULL, true);
    this.view.setUint32(4, sequence, true);
    this.bytes[8] = NVS_VERSION_2;
    this.view.setUint32(28, nvsCrc32(this.bytes.subarray(4, 28)), true);
  }

  get free(): number {
    return ENTRIES_PER_PAGE - this.used;
  }

  /** Writes one header entry, followed by `payload` spread over as many raw entries as it needs. */
  write(namespaceIndex: number, type: number, key: Uint8Array, data: Uint8Array, payload?: Uint8Array): void {
    const span = 1 + (payload ? Math.ceil(payload.length / ENTRY_SIZE) : 0);
    if (span > this.free) throw new Error("entry does not fit in page");

    const offset = FIRST_ENTRY_OFFSET + this.used * ENTRY_SIZE;
    const entry = this.bytes.subarray(offset, offset + ENTRY_SIZE);
    entry[0] = namespaceIndex;
    entry[1] = type;
    entry[2] = span;
    entry[3] = 0xff; // chunk index: unused outside blobs
    entry.set(key, 8);
    entry.set(data, 24);
    // The CRC covers the entry except the CRC field itself.
    new DataView(entry.buffer, entry.byteOffset).setUint32(4, nvsCrc32(entry.subarray(0, 4), entry.subarray(8, 32)), true);
    if (payload) this.bytes.set(payload, offset + ENTRY_SIZE);

    for (let i = 0; i < span; i++) this.markWritten(this.used + i);
    this.used += span;
  }

  /** Entry states are 2 bits each: 0b11 empty, 0b10 written. */
  private markWritten(index: number): void {
    const bit = index * 2;
    this.bytes[32 + (bit >> 3)]! &= ~(1 << (bit & 7));
  }
}

function eightBytes(): { data: Uint8Array; view: DataView } {
  const data = new Uint8Array(8).fill(0xff);
  return { data, view: new DataView(data.buffer) };
}

function encodeInt(type: keyof typeof INT_BYTES, value: number): Uint8Array {
  const bits = INT_BYTES[type] * 8;
  const signed = type.startsWith("i");
  const min = signed ? -(2 ** (bits - 1)) : 0;
  const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${value} is out of range for NVS type ${type}`);
  }
  const { data, view } = eightBytes();
  if (bits === 8) view.setUint8(0, value & 0xff);
  else if (bits === 16) view.setUint16(0, value & 0xffff, true);
  else view.setUint32(0, value >>> 0, true);
  return data;
}

/**
 * Builds an NVS partition image of exactly `partitionSize` bytes. Like IDF's generator, the
 * last page is left empty: NVS needs one free page to operate.
 */
export function generateNvsPartition(entries: NvsData, partitionSize: number): Uint8Array {
  if (partitionSize < MIN_PARTITION_SIZE || partitionSize % PAGE_SIZE !== 0) {
    throw new Error(`NVS partition size must be a multiple of ${PAGE_SIZE} and at least ${MIN_PARTITION_SIZE}`);
  }
  const maxPages = partitionSize / PAGE_SIZE - 1;
  const pages = [new Page(0)];

  const pageWithRoom = (span: number): Page => {
    let page = pages.at(-1)!;
    if (page.free < span) {
      if (pages.length === maxPages) throw new Error("data does not fit in the NVS partition");
      page = new Page(pages.length);
      pages.push(page);
    }
    return page;
  };

  let namespaceIndex = 0;
  for (const [namespace, values] of Object.entries(entries)) {
    if (++namespaceIndex > 254) throw new Error("too many NVS namespaces");
    const index = eightBytes().data;
    index[0] = namespaceIndex;
    // Namespaces are themselves u8 entries in namespace 0 mapping name -> index.
    pageWithRoom(1).write(0, TYPE.u8, encodeKey(namespace, "namespace"), index);

    for (const [key, raw] of Object.entries(values)) {
      const entry: NvsValue = typeof raw === "string" ? { type: "string", value: raw } : raw;
      const encodedKey = encodeKey(key, "key");

      if (entry.type !== "string") {
        pageWithRoom(1).write(namespaceIndex, TYPE[entry.type], encodedKey, encodeInt(entry.type, entry.value));
        continue;
      }

      const text = new TextEncoder().encode(entry.value);
      if (text.includes(0)) throw new Error(`NVS string "${key}" must not contain NUL`);
      if (text.length + 1 > MAX_STRING_SIZE) throw new Error(`NVS string "${key}" is longer than ${MAX_STRING_SIZE - 1} bytes`);
      const terminated = new Uint8Array(text.length + 1); // NUL terminated
      terminated.set(text);
      const payload = new Uint8Array(Math.ceil(terminated.length / ENTRY_SIZE) * ENTRY_SIZE).fill(0xff);
      payload.set(terminated);

      const { data, view } = eightBytes();
      view.setUint16(0, terminated.length, true);
      view.setUint32(4, nvsCrc32(terminated), true);
      pageWithRoom(1 + payload.length / ENTRY_SIZE).write(namespaceIndex, TYPE.string, encodedKey, data, payload);
    }
  }

  // Every page except the reserved last one gets a header, used or not.
  while (pages.length < maxPages) pages.push(new Page(pages.length));

  const image = new Uint8Array(partitionSize).fill(0xff);
  pages.forEach((page, i) => image.set(page.bytes, i * PAGE_SIZE));
  return image;
}
