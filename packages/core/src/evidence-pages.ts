import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { JOURNAL_RECORD_BYTES } from "@yap/protocol";
import { fileAccess, type FileAccess } from "./files.js";
import { CatalogError } from "./catalog.js";
import {
  validateRecord,
  validateSourceReceipt,
  type SourceEvidenceMetadata,
  type EvidenceIdentity,
  type RecordRow,
} from "./evidence.js";
import {
  SourceEvidenceReader,
  evidenceIndexes,
  recordKey,
  type EvidenceIndex,
  type RecordQuery,
} from "./evidence-read.js";
import {
  OrderedPages,
  readMember,
  writeOrderedPages,
  type OrderedPageCodec,
} from "./ordered-pages.js";
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const evidenceIdentitySchema = z.strictObject({
  owner: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("recording"), id: z.string().min(1).max(256) }),
    z.strictObject({ kind: z.literal("acquisition"), id: z.string().min(1).max(256) }),
  ]),
  sourceId: z.string().min(1).max(256),
  generation: z.string().min(1).max(256),
});
const rowSchema = z.strictObject({
  sequence: integer.min(1),
  event: z.string(),
  sourceUs: integer.nullable(),
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= JOURNAL_RECORD_BYTES),
});
function matches(index: EvidenceIndex, row: RecordRow, data: Record<string, unknown>): boolean {
  if (index === "cursor" || index === "cursorSequence") return row.event === "cursorSample";
  if (index === "geometry") return row.event === "geometry" && row.sourceUs !== null;
  if (index === "unplaced") return row.event === "geometry" && row.sourceUs === null;
  if (index === "pauses") return row.event === "pause";
  if (index === "marks") return row.event === "mark";
  return row.event === "audioAcquired" && data.role === index;
}

const metadataSchema = z.strictObject({
  kind: z.literal("source"),
  identity: evidenceIdentitySchema,
});
const codec: OrderedPageCodec<RecordRow, z.infer<typeof metadataSchema>> = {
  metadata: metadataSchema,
  orders: Object.fromEntries(
    evidenceIndexes.map((index) => [
      index,
      index === "cursorSequence" || index === "unplaced" ? 1 : 2,
    ]),
  ),
  decode(value, { index }) {
    const row = rowSchema.parse(value);
    const data = JSON.parse(row.content);
    validateRecord(row.event, data);
    if (
      !matches(index as EvidenceIndex, row, data) ||
      row.sourceUs !== (data.sourceUs ?? data.atSourceUs ?? data.startUs ?? null)
    )
      throw new CatalogError(
        "INVALID_EVIDENCE",
        "Evidence page record belongs to a different index",
      );
    return row;
  },
  key: (row, index) => recordKey(index as EvidenceIndex, row),
};
export function writeSourceEvidencePages(
  reader: SourceEvidenceReader,
  identity: EvidenceIdentity,
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const { owner, sourceId, generation } = identity;
  return writeOrderedPages(
    directory,
    { kind: "source" as const, identity: { owner, sourceId, generation } },
    codec,
    (index) => reader.exportRecords(identity, index as EvidenceIndex),
    signal,
  );
}
export class FileSourceEvidence extends SourceEvidenceReader {
  private readonly pages: OrderedPages<RecordRow, z.infer<typeof metadataSchema>>;
  constructor(root: string | FileAccess, identity: EvidenceIdentity) {
    super();
    this.pages = new OrderedPages(root, codec);
    this.requireComplete(identity);
  }
  protected requireComplete(identity: EvidenceIdentity): void {
    const expected = this.pages.metadata.identity;
    if (
      !isDeepStrictEqual(identity.owner, expected.owner) ||
      identity.sourceId !== expected.sourceId ||
      identity.generation !== expected.generation
    )
      throw new CatalogError("PREREQUISITE_MISSING", "Evidence generation is not indexed");
  }
  protected records(identity: EvidenceIdentity, query: RecordQuery): RecordRow[] {
    this.requireComplete(identity);
    return this.pages.read(query, (row) => Buffer.byteLength(row.content));
  }
}

/** The receipt is bounded independently of the normalized rows, which remain lazy. */
export function readSourceMetadata(
  root: string | FileAccess,
  identity: EvidenceIdentity,
): SourceEvidenceMetadata {
  const bytes = readMember(fileAccess(root), "metadata.json", 65536);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CatalogError("INVALID_EVIDENCE", "Invalid portable source metadata");
  }
  const parsed = evidenceIdentitySchema.extend({ receipt: z.unknown() }).strict().safeParse(value);
  if (
    !parsed.success ||
    !isDeepStrictEqual(parsed.data.owner, identity.owner) ||
    parsed.data.sourceId !== identity.sourceId ||
    parsed.data.generation !== identity.generation
  )
    throw new CatalogError(
      "INVALID_EVIDENCE",
      "Portable source metadata belongs to another generation",
    );
  return { ...identity, receipt: validateSourceReceipt(parsed.data.receipt, identity.sourceId) };
}
