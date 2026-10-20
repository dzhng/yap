import { readJsonChunks, jsonChunks } from "./json-stream.js";
import { createHash } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import { fileAccess, type FileAccess } from "./files.js";
import { mkdir, rename, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { JOURNAL_RECORD_BYTES } from "@yap/protocol";
import { CatalogError } from "./catalog.js";

// A portable row double-encodes JSON: 2× the derived record bound, plus array framing.
const rowBytes = 2 * JOURNAL_RECORD_BYTES;
// Ordinary batching target; a larger valid record advances alone.
export const EVIDENCE_BATCH_BYTES = 1024 ** 2;
const pageBytes = rowBytes + 2;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type PageKey = readonly number[];
export type PageBound = { key: PageKey; inclusive: boolean };
export type PageQuery = {
  index: string;
  lower?: PageBound;
  upper?: PageBound;
  reverse?: boolean;
  limit: number;
  /** Cumulative row bytes; an oversized first row is returned alone. */
  maxBytes?: number;
};
export function comparePageKeys(a: PageKey, b: PageKey): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
const keySchema = z.array(integer).min(1).max(2);
const descriptorSchema = z.strictObject({
  file: z.string().regex(/^\d+\.json$/),
  first: keySchema,
  last: keySchema,
  rows: integer.min(1).max(256),
  bytes: integer.min(1).max(pageBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  metadata: z.unknown(),
  indexes: z.record(z.string().regex(/^[a-zA-Z]+$/), z.array(descriptorSchema)),
});
type Descriptor = z.infer<typeof descriptorSchema>;
const rowsSchema = z.array(z.unknown()).min(1).max(256);
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function parse<T>(schema: z.ZodType<T>, bytes: Buffer): T {
  try {
    return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return invalid("Malformed source evidence page or manifest");
  }
}
/** Reads one bounded regular member. Full archive/root lifetime containment belongs to the package owner. */
export function readMember(root: FileAccess, file: string, limit: number): Buffer {
  const opened = root.open(file),
    fd = opened.fd;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      invalid("Source evidence member exceeds its read budget");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0,
      n: number;
    while ((n = readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) bytes += n;
    if (bytes !== stat.size) invalid("Source evidence member changed during read");
    return buffer.subarray(0, bytes);
  } finally {
    opened.close();
  }
}
/** Parse a growing metadata inventory through fixed-size reads on the held member. */
export function readJsonMember(root: FileAccess, name: string): unknown {
  const file = root.open(name);
  try {
    return readJsonDescriptor(file.fd);
  } finally {
    file.close();
  }
}

/** Borrow a held descriptor; positional reads preserve its caller's offset and lifetime. */
export function readJsonDescriptor(fd: number): unknown {
  const before = fstatSync(fd);
  if (!before.isFile()) invalid("JSON inventory requires a regular member");
  let bytes = 0;
  function* chunks() {
    const buffer = Buffer.alloc(64 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, bytes)) > 0) {
      bytes += count;
      yield buffer.subarray(0, count);
    }
  }
  try {
    const result = readJsonChunks(chunks());
    if (bytes !== before.size || fstatSync(fd).size !== before.size)
      invalid("JSON inventory changed during read");
    return result;
  } catch {
    invalid("Malformed JSON inventory");
  }
}
/** Enumerate only the transport manifest, never arbitrary directory contents. */
export function readOrderedPageManifest(root: string | FileAccess) {
  try {
    return manifestSchema.parse(readJsonMember(fileAccess(root), "pages.json"));
  } catch {
    return invalid("Malformed source evidence manifest");
  }
}
export type OrderedPageCodec<Row, Metadata> = {
  metadata: z.ZodType<Metadata>;
  orders: Readonly<Record<string, number>>;
  decode: (value: unknown, context: { index: string; metadata: Metadata }) => Row;
  key: (row: Row, index: string) => PageKey;
};

/** Producer uses published normalized evidence; absent manifest leaves an interrupted export unreadable. */
export async function writeOrderedPages<Row, Metadata>(
  directory: string,
  metadata: Metadata,
  codec: OrderedPageCodec<Row, Metadata>,
  batches: (index: string) => AsyncIterable<readonly Row[]> | Iterable<readonly Row[]>,
  signal?: AbortSignal,
): Promise<void> {
  codec.metadata.parse(metadata);
  signal?.throwIfAborted();
  await mkdir(directory);
  const indexes = {} as Record<string, Descriptor[]>;
  let count = 0;
  for (const index of Object.keys(codec.orders)) {
    indexes[index] = [];
    let rows: Row[] = [],
      bytes = 2;
    const flush = async () => {
      if (!rows.length) return;
      signal?.throwIfAborted();
      ++count;
      const body = Buffer.from(JSON.stringify(rows));
      const file = `${count}.json`;
      await writeFile(join(directory, file), body, { flag: "wx", signal });
      indexes[index]!.push({
        file,
        first: [...codec.key(rows[0]!, index)],
        last: [...codec.key(rows.at(-1)!, index)],
        rows: rows.length,
        bytes: body.length,
        sha256: hash(body),
      });
      rows = [];
      bytes = 2;
    };
    for await (const batch of batches(index)) {
      for (const row of batch) {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (size > rowBytes)
          throw new CatalogError("LIMIT_EXCEEDED", "Portable evidence record exceeds page budget");
        if (rows.length === 256 || bytes + size + (rows.length ? 1 : 0) > EVIDENCE_BATCH_BYTES)
          await flush();
        bytes += size + (rows.length ? 1 : 0);
        rows.push(row);
      }
      await setImmediate(undefined, { signal });
    }
    await flush();
  }
  signal?.throwIfAborted();
  const file = await open(join(directory, "pages.pending"), "wx");
  try {
    let buffer = "";
    for (const part of jsonChunks({ version: 1, metadata, indexes })) {
      buffer += part;
      if (buffer.length >= 64 * 1024) {
        signal?.throwIfAborted();
        await file.writeFile(buffer);
        buffer = "";
      }
    }
    if (buffer) await file.writeFile(buffer);
  } finally {
    await file.close();
  }
  signal?.throwIfAborted();
  await rename(join(directory, "pages.pending"), join(directory, "pages.json"));
}

/** Bounded ordered JSON transport for an internally owned stable directory. */
export class OrderedPages<Row, Metadata> {
  private readonly manifest: z.infer<typeof manifestSchema>;
  private readonly admittedMetadata: Metadata;
  get metadata(): Metadata {
    this.root.check();
    return this.admittedMetadata;
  }
  private readonly root: FileAccess;
  constructor(
    root: string | FileAccess,
    private readonly codec: OrderedPageCodec<Row, Metadata>,
  ) {
    this.root = fileAccess(root);
    this.manifest = readOrderedPageManifest(this.root);
    this.admittedMetadata = codec.metadata.parse(this.manifest.metadata);
    if (
      Object.keys(this.manifest.indexes).sort().join(",") !==
      Object.keys(codec.orders).sort().join(",")
    )
      invalid("Unknown or missing evidence order");
    const files = new Set<string>();
    for (const index of Object.keys(codec.orders)) {
      let previous: number[] | undefined;
      for (const page of this.manifest.indexes[index]!) {
        if (files.has(page.file)) invalid("Duplicate evidence pages");
        files.add(page.file);
        const width = codec.orders[index];
        if (
          page.first.length !== width ||
          page.last.length !== width ||
          comparePageKeys(page.first, page.last) > 0 ||
          (previous && comparePageKeys(previous, page.first) >= 0)
        )
          invalid("Unordered evidence page boundaries");
        previous = page.last;
      }
    }
  }
  private pageRows(index: string, descriptor: Descriptor): Row[] {
    const bytes = readMember(this.root, descriptor.file, pageBytes);
    if (bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256)
      invalid("Source evidence page differs from its descriptor");
    let rows: Row[];
    try {
      rows = parse(rowsSchema, bytes).map((row) =>
        this.codec.decode(row, { index, metadata: this.metadata }),
      );
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      invalid("Invalid evidence page payload");
    }
    if (rows.length !== descriptor.rows) invalid("Source evidence page row count differs");
    let previous: number[] | undefined;
    for (const row of rows) {
      const key = this.codec.key(row, index);
      if (previous && comparePageKeys(previous, key) >= 0)
        invalid("Unordered source evidence page");
      previous = [...key];
    }
    if (
      comparePageKeys(descriptor.first, this.codec.key(rows[0]!, index)) !== 0 ||
      comparePageKeys(descriptor.last, this.codec.key(rows.at(-1)!, index)) !== 0
    )
      invalid("Source evidence page boundaries differ");
    return rows;
  }
  rowCount(index: string): number {
    this.root.check();
    const pages = this.manifest.indexes[index];
    if (!pages) invalid("Unknown evidence order");
    return pages.reduce((count, page) => count + page.rows, 0);
  }
  read(query: PageQuery, sizeOf = (row: Row) => Buffer.byteLength(JSON.stringify(row))): Row[] {
    this.root.check();
    const pages = this.manifest.indexes[query.index];
    if (!pages) invalid("Unknown evidence order");
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 5001)
      invalid("Invalid evidence read limit");
    for (const bound of [query.lower, query.upper]) {
      if (
        bound &&
        (bound.key.length !== this.codec.orders[query.index] ||
          bound.key.some((value) => !Number.isSafeInteger(value) || value < 0))
      )
        invalid("Invalid evidence read bound");
    }
    const result: Row[] = [];
    let bytes = 0;
    const before = (key: readonly number[]) =>
      query.lower &&
      (comparePageKeys(key, query.lower.key) < 0 ||
        (!query.lower.inclusive && comparePageKeys(key, query.lower.key) === 0));
    const after = (key: readonly number[]) =>
      query.upper &&
      (comparePageKeys(key, query.upper.key) > 0 ||
        (!query.upper.inclusive && comparePageKeys(key, query.upper.key) === 0));
    // Binary search the first page that can contribute, in the requested direction.
    let low = 0,
      high = pages.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (query.reverse ? !after(pages[mid]!.first) : before(pages[mid]!.last)) low = mid + 1;
      else high = mid;
    }
    for (
      let i = query.reverse ? low - 1 : low;
      i >= 0 && i < pages.length;
      i += query.reverse ? -1 : 1
    ) {
      const page = pages[i]!;
      if (query.reverse ? before(page.last) : after(page.first)) break;
      const rows = this.pageRows(query.index, page);
      if (query.reverse) rows.reverse();
      for (const row of rows) {
        const key = this.codec.key(row, query.index);
        if (before(key) || after(key)) continue;
        if (query.maxBytes !== undefined) {
          const size = sizeOf(row);
          if (result.length && bytes + size > query.maxBytes) return result;
          bytes += size;
        }
        result.push(row);
        if (
          result.length === query.limit ||
          (query.maxBytes !== undefined && bytes >= query.maxBytes)
        )
          return result;
      }
    }
    return result;
  }
}
