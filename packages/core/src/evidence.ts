import { createReadStream } from "node:fs";
import { JOURNAL_RECORD_BYTES, JsonLineStream } from "@yap/protocol";
import { setImmediate } from "node:timers/promises";
import type { CaptureStore } from "./capture-store.js";
import { CatalogError, type Catalog } from "./catalog.js";
import { SourceEvidenceReader, type RecordQuery, type EvidenceIndex } from "./evidence-read.js";
import { compare, fromTime, selectionRangeSchema, type SelectionRange } from "@yap/composition";

export type EvidenceOwner = Readonly<{ kind: "recording" | "acquisition"; id: string }>;
export function evidenceOwnerKey(owner: EvidenceOwner): [EvidenceOwner["kind"], string] {
  return [owner.kind, owner.id];
}
export function recordingEvidenceOwner(store: CaptureStore): (identity: EvidenceIdentity) => void {
  return ({ owner, sourceId }) => {
    if (owner.kind !== "recording") invalid("Recording evidence requires a recording owner");
    const recording = store.get(owner.id);
    if (recording.state === "canceled" || recording.sourceId !== sourceId)
      invalid("Recording identity no longer accepts evidence");
  };
}
/** Recording-domain readers must reject evidence owned by an acquisition. */
export function evidenceRecordingId(identity: EvidenceIdentity): string {
  if (identity.owner.kind !== "recording") invalid("Evidence requires a recording owner");
  return identity.owner.id;
}
export type EvidenceIdentity = Readonly<{
  owner: EvidenceOwner;
  sourceId: string;
  generation: string;
}>;
export type SourceFileProof = Readonly<{ bytes: string; sha256: string }>;
export type SourcePublicationProof = Readonly<{
  canonical: SourceFileProof;
  receipt: SourceFileProof;
}>;
/** `support` is the outer span; `gaps` (omitted when empty) are the off times strictly inside it. */
export type CameraPublicationProof = SourcePublicationProof &
  Readonly<{
    mapping: SourceFileProof;
    support: SelectionRange;
    gaps?: readonly SelectionRange[];
    representedFrames: number;
  }>;
/** The only TypeScript reading of camera availability: support minus gaps, as a fresh list. */
export function cameraProofIntervals(proof: CameraPublicationProof): SelectionRange[] {
  const intervals: SelectionRange[] = [];
  let startUs = proof.support.startUs;
  for (const gap of proof.gaps ?? []) {
    intervals.push({ startUs, endUs: gap.startUs });
    startUs = gap.endUs;
  }
  intervals.push({ startUs, endUs: proof.support.endUs });
  return intervals;
}
function validCameraGaps(support: SelectionRange, gaps: unknown): boolean {
  if (gaps === undefined) return true;
  if (!Array.isArray(gaps) || gaps.length === 0) return false;
  let previousEnd = support.startUs;
  for (const gap of gaps) {
    const parsed = selectionRangeSchema.safeParse(gap);
    if (!parsed.success || compare(fromTime(previousEnd), fromTime(parsed.data.startUs)) >= 0)
      return false;
    previousEnd = parsed.data.endUs;
  }
  return compare(fromTime(previousEnd), fromTime(support.endUs)) < 0;
}
export type SourceEvidenceReceipt = Readonly<{
  normalizationVersion?: 2;
  file: string;
  journal: string;
  header?: Record<string, unknown> | null;
  originHostUs?: number | null;
  cursorSamples: number;
  geometryRecords: number;
  displaySpaces: number;
  pauseEvents: number;
  audioIntervals: number;
  markEvents?: number;
  openPauseHostUs?: number | null;
  firstCursorSourceUs?: number | null;
  lastCursorSourceUs?: number | null;
  lastSequence: number;
  incompleteTail: boolean;
  invalidAtSequence?: number | null;
  finished: boolean;
  lastLifecycle?: Readonly<{ state: string; reason?: string | null }> | null;
  /** Recorded capture/video endpoint, never inferred from a selected stream's duration. */
  completion?: Readonly<{
    sequence: number;
    state: "complete" | "interrupted";
    durationUs: number;
    failureCode?: string | null;
    failureMessage?: string | null;
  }> | null;
  publications?: Readonly<{
    narration?: SourcePublicationProof;
    system?: SourcePublicationProof;
    video?: CameraPublicationProof;
  }>;
  bytes: number;
}>;
export type SourceEvidenceMetadata = EvidenceIdentity & { receipt: SourceEvidenceReceipt };
export const DEFAULT_CURSOR_SAMPLING: { intervalUs: number; holds: boolean } = Object.freeze({
  intervalUs: 16_667,
  holds: false,
});
export function receiptCursorSampling(receipt: Pick<SourceEvidenceReceipt, "header">) {
  return journalCapabilities(receipt.header ?? {})!.cursorSampling;
}
export type RawCursorSample = Record<string, unknown> & {
  sourceUs: number;
  x?: number | null;
  y?: number | null;
  globalX: number;
  globalY: number;
  buttons: number;
  eligibility: string;
  geometryEpoch: number;
};
export type SourceGeometry = Record<string, unknown> & {
  epoch: number;
  hostUs: number;
  sourceUs?: number | null;
  geometry: Record<string, unknown>;
  sequence: number;
};
export type RecordRow = {
  sequence: number;
  event: string;
  sourceUs: number | null;
  content: string;
};
function invalid(message: string, code = "INVALID_EVIDENCE"): never {
  throw new CatalogError(code, message);
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function object(value: unknown, code = "INVALID_EVIDENCE"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Expected evidence object", code);
  return value as Record<string, unknown>;
}
function finite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}
export function validateRecord(event: string, data: Record<string, unknown>): void {
  if (event === "cursorSample") {
    if (
      !integer(data.sourceUs) ||
      !integer(data.buttons) ||
      !integer(data.geometryEpoch) ||
      !finite(data.globalX) ||
      !finite(data.globalY) ||
      !["inside", "outside", "unknownGeometry"].includes(data.eligibility as string) ||
      (data.x != null && !finite(data.x)) ||
      (data.y != null && !finite(data.y)) ||
      (data.x == null) !== (data.y == null)
    )
      invalid("Invalid normalized cursor sample");
  } else if (event === "geometry") {
    if (
      !integer(data.epoch) ||
      !integer(data.hostUs) ||
      (data.sourceUs != null && !integer(data.sourceUs))
    )
      invalid("Invalid geometry timing");
    const geometry = object(data.geometry);
    if (
      !integer(geometry.outputWidth) ||
      !integer(geometry.outputHeight) ||
      !finite(geometry.contentScale) ||
      !finite(geometry.scaleFactor)
    )
      invalid("Invalid geometry dimensions");
    for (const key of ["contentRect", "screenRect", "boundingRect", "requestedSourceRect"]) {
      if (key !== "contentRect" && geometry[key] == null) continue;
      const rect = object(geometry[key]);
      if (![rect.x, rect.y, rect.width, rect.height].every(finite))
        invalid("Invalid geometry rectangle");
    }
  } else if (event === "displaySpace") {
    if (!integer(data.hostUs) || !finite(data.zeroOriginHeight)) invalid("Invalid display space");
  } else if (event === "pause") {
    if (!integer(data.atSourceUs) || !integer(data.elapsedPauseUs)) invalid("Invalid pause timing");
  } else if (event === "audioAcquired") {
    if (
      !["narration", "system"].includes(data.role as string) ||
      !integer(data.startUs) ||
      !integer(data.endUs) ||
      data.endUs <= data.startUs
    )
      invalid("Invalid audio acquisition timing");
  } else if (event === "mark") {
    if (
      !integer(data.hostUs) ||
      !integer(data.sourceUs) ||
      !integer(data.epoch) ||
      typeof data.id !== "string" ||
      !data.id ||
      !["stroke", "pin", "click"].includes(data.kind as string) ||
      !Array.isArray(data.points) ||
      (data.retracts == null && data.points.length === 0) ||
      (data.retracts != null &&
        (typeof data.retracts !== "string" || !data.retracts || data.points.length !== 0)) ||
      (data.kind === "pin"
        ? !integer(data.pin) || (data.pin as number) < 1
        : data.pin !== undefined)
    )
      invalid("Invalid normalized mark");
    for (const point of data.points) {
      const value = object(point);
      if (
        !integer(value.hostUs) ||
        !finite(value.globalX) ||
        !finite(value.globalY) ||
        (value.x != null && !finite(value.x)) ||
        (value.y != null && !finite(value.y)) ||
        (value.x == null) !== (value.y == null)
      )
        invalid("Invalid normalized mark point");
    }
    if (data.window != null) {
      const window = object(data.window);
      const bounds = object(window.bounds);
      if (
        typeof window.app !== "string" ||
        !window.app ||
        typeof window.title !== "string" ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(finite)
      )
        invalid("Invalid normalized mark window");
    }
  } else invalid("Unknown normalized evidence event");
}

// Journal version literals belong only in this capability table.
const journalSchemas = {
  1: { isPacked: false, carriesMarks: false, holdsCursor: false },
  2: { isPacked: true, carriesMarks: false, holdsCursor: false },
  3: { isPacked: true, carriesMarks: true, holdsCursor: false },
  4: { isPacked: true, carriesMarks: true, holdsCursor: true },
} as const;
export function journalCapabilities(
  header: { schemaVersion?: unknown; cursorSampling?: unknown },
  code = "INVALID_EVIDENCE",
) {
  const version = header.schemaVersion === undefined ? 1 : header.schemaVersion;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    !Object.hasOwn(journalSchemas, version)
  )
    return undefined;
  let cursorSampling = { ...DEFAULT_CURSOR_SAMPLING };
  if (header.cursorSampling !== undefined) {
    const sampling = object(header.cursorSampling, code);
    const { intervalUs, holds } = sampling;
    if (!integer(intervalUs) || intervalUs === 0 || typeof holds !== "boolean")
      invalid("Invalid journal cursor sampling", code);
    cursorSampling = { intervalUs, holds };
  }
  const capabilities = journalSchemas[version as keyof typeof journalSchemas];
  cursorSampling.holds &&= capabilities.holdsCursor;
  return { ...capabilities, cursorSampling };
}

/** Receipt shape is shared by native ingest and portable evidence inspection. */
export function validateSourceReceipt(
  value: unknown,
  sourceId: string,
  code = "INVALID_EVIDENCE",
): SourceEvidenceReceipt {
  function invalid(message: string): never {
    throw new CatalogError(code, message);
  }
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalid("Expected evidence object");
    return value as Record<string, unknown>;
  };
  const receipt = object(value);
  const header = object(receipt.header);
  if (header.sessionID !== sourceId) invalid("Evidence identity does not match its recording");
  const capabilities = journalCapabilities(header, code);
  if (!capabilities) invalid(`Unsupported evidence journal schema ${header.schemaVersion}`);
  if (
    typeof receipt.file !== "string" ||
    !receipt.file ||
    receipt.journal !== "capture.journal.jsonl" ||
    ![
      receipt.cursorSamples,
      receipt.geometryRecords,
      receipt.displaySpaces,
      receipt.pauseEvents,
      receipt.audioIntervals,
      receipt.markEvents ?? 0,
      receipt.lastSequence,
    ].every(integer) ||
    !integer(receipt.bytes) ||
    (receipt.normalizationVersion !== undefined && receipt.normalizationVersion !== 2) ||
    typeof receipt.incompleteTail !== "boolean" ||
    typeof receipt.finished !== "boolean" ||
    [
      receipt.originHostUs,
      receipt.openPauseHostUs,
      receipt.firstCursorSourceUs,
      receipt.lastCursorSourceUs,
      receipt.invalidAtSequence,
    ].some((v) => v != null && !integer(v))
  )
    invalid("Invalid evidence receipt");
  if (receipt.lastLifecycle != null) {
    const lifecycle = object(receipt.lastLifecycle);
    if (
      typeof lifecycle.state !== "string" ||
      (lifecycle.reason != null && typeof lifecycle.reason !== "string")
    )
      invalid("Invalid capture lifecycle provenance");
  }
  if (receipt.completion != null) {
    const completion = object(receipt.completion);
    if (
      (receipt.normalizationVersion === undefined && completion.failureMessage !== undefined) ||
      !receipt.finished ||
      !integer(completion.sequence) ||
      completion.sequence < 1 ||
      completion.sequence > (receipt.lastSequence as number) ||
      !["complete", "interrupted"].includes(completion.state as string) ||
      !integer(completion.durationUs) ||
      (completion.failureCode != null && typeof completion.failureCode !== "string") ||
      (completion.failureMessage != null &&
        (typeof completion.failureMessage !== "string" ||
          completion.failureMessage.length > 4096 ||
          completion.failureCode == null)) ||
      (completion.state === "complete" &&
        (completion.failureCode != null || completion.failureMessage != null))
    )
      invalid("Invalid capture completion provenance");
  }
  if (receipt.publications !== undefined) {
    for (const [role, proof] of Object.entries(object(receipt.publications))) {
      if (!["video", "narration", "system"].includes(role)) invalid("Invalid publication role");
      if (role !== "video" && !capabilities.isPacked)
        invalid("Audio publication proof requires the packed journal layout");
      const identity = object(proof);
      for (const kind of role === "video"
        ? ["canonical", "receipt", "mapping"]
        : ["canonical", "receipt"]) {
        const file = object(identity[kind]);
        if (
          typeof file.bytes !== "string" ||
          !/^[1-9][0-9]*$/.test(file.bytes) ||
          BigInt(file.bytes) > BigInt(Number.MAX_SAFE_INTEGER) ||
          typeof file.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(file.sha256)
        )
          invalid("Invalid verified publication identity");
      }
      if (
        role === "video" &&
        (!integer(identity.representedFrames) ||
          identity.representedFrames === 0 ||
          !selectionRangeSchema.safeParse(identity.support).success)
      )
        invalid("Invalid verified camera support");
      if (role === "video" && !validCameraGaps(identity.support as SelectionRange, identity.gaps))
        invalid("Invalid verified camera gaps");
    }
  } else if (capabilities.isPacked) invalid("Packed evidence requires verified publications");
  const camera = header.source != null && object(header.source).kind === "camera";
  if ((camera && !capabilities.isPacked) || header.cameraBinding !== undefined) {
    const binding = object(header.cameraBinding);
    if (
      !camera ||
      capabilities.isPacked ||
      binding.sourceId !== sourceId ||
      ![binding.recordingId, binding.sourceId, binding.deviceId].every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 256,
      )
    )
      invalid("Invalid supplied camera binding");
    if (!object(receipt.publications ?? {}).video)
      invalid("Declared camera requires verified camera publication");
  }
  return receipt as SourceEvidenceReceipt;
}

/** One bounded normalized-record validator for indexing and portable source admission. */
export async function* sourceEvidenceRecords(
  file: string,
  receipt: SourceEvidenceReceipt,
  signal?: AbortSignal,
): AsyncGenerator<RecordRow> {
  let bytes = 0,
    sequence = 0,
    cursors = 0,
    geometries = 0,
    displays = 0,
    pauses = 0,
    audio = 0,
    marks = 0;
  const carriesMarks = journalCapabilities(receipt.header ?? {})!.carriesMarks;
  const audioEnds = new Map<string, number>();
  let first: number | null = null,
    last: number | null = null;
  // Protocol framing counts the terminator; the record bound counts JSON bytes.
  const lines = new JsonLineStream(JOURNAL_RECORD_BYTES + 1);
  for await (const chunk of createReadStream(file, { highWaterMark: 65536, signal })) {
    bytes += chunk.length;
    if (bytes > receipt.bytes) invalid("Evidence exceeds its byte receipt");
    for (const line of lines.push(chunk)) {
      if (!line.ok)
        invalid(
          line.error.code === "FRAME_TOO_LARGE"
            ? "Evidence record exceeds read budget"
            : "Malformed normalized evidence JSON",
        );
      const record = object(line.value);
      const event = record.event as string,
        data = object(record.data);
      validateRecord(event, data);
      if (event === "mark" && !carriesMarks)
        invalid("Marks require a journal schema that carries marks");
      if (event === "cursorSample") {
        cursors++;
        first ??= data.sourceUs as number;
        last = data.sourceUs as number;
      } else if (event === "geometry") geometries++;
      else if (event === "displaySpace") displays++;
      else if (event === "pause") pauses++;
      else if (event === "mark") marks++;
      else {
        audio++;
        const role = data.role as string;
        const previous = audioEnds.get(role);
        if (previous !== undefined && (data.startUs as number) <= previous + 1)
          invalid("Audio acquisition intervals must be ordered and coalesced per role");
        audioEnds.set(role, data.endUs as number);
      }
      yield {
        sequence: ++sequence,
        event,
        sourceUs:
          (data.sourceUs as number) ??
          (data.atSourceUs as number) ??
          (data.startUs as number) ??
          null,
        content: JSON.stringify(data),
      };
    }
  }
  if (
    lines.finish() ||
    bytes !== receipt.bytes ||
    cursors !== receipt.cursorSamples ||
    geometries !== receipt.geometryRecords ||
    displays !== receipt.displaySpaces ||
    pauses !== receipt.pauseEvents ||
    audio !== receipt.audioIntervals ||
    marks !== (receipt.markEvents ?? 0) ||
    first !== (receipt.firstCursorSourceUs ?? null) ||
    last !== (receipt.lastCursorSourceUs ?? null)
  )
    invalid("Evidence file does not match its receipt");
}

/** Indexes native-normalized evidence; the artifact queue alone decides whether to publish it. */
export class SourceEvidenceStore extends SourceEvidenceReader {
  constructor(
    private readonly store: Catalog,
    private readonly validateOwner: (identity: EvidenceIdentity) => void,
  ) {
    super();
    store.catalog.exec(`
      CREATE TABLE IF NOT EXISTS source_evidence_generations (
        ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,receipt TEXT,
        PRIMARY KEY(ownerKind,ownerId,sourceId,generation)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_evidence_records (
        ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,
        sequence INTEGER NOT NULL,event TEXT NOT NULL,sourceUs INTEGER,content TEXT NOT NULL,
        PRIMARY KEY(ownerKind,ownerId,sourceId,generation,sequence)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS source_evidence_time ON source_evidence_records
        (ownerKind,ownerId,sourceId,generation,sourceUs,sequence) WHERE event='cursorSample';
      CREATE INDEX IF NOT EXISTS source_evidence_pauses ON source_evidence_records
        (ownerKind,ownerId,sourceId,generation,sourceUs,sequence) WHERE event='pause';
      CREATE INDEX IF NOT EXISTS source_evidence_marks ON source_evidence_records
        (ownerKind,ownerId,sourceId,generation,sourceUs,sequence) WHERE event='mark';
      CREATE INDEX IF NOT EXISTS source_evidence_geometry ON source_evidence_records
        (ownerKind,ownerId,sourceId,generation,sourceUs,sequence) WHERE event='geometry';
      CREATE INDEX IF NOT EXISTS source_evidence_audio ON source_evidence_records
        (ownerKind,ownerId,sourceId,generation,json_extract(content,'$.role'),sourceUs,sequence) WHERE event='audioAcquired';
    `);
  }
  async ingest(
    input: EvidenceIdentity & {
      file: string;
      receipt: SourceEvidenceReceipt;
      signal?: AbortSignal;
    },
  ): Promise<SourceEvidenceMetadata> {
    const { owner, sourceId, generation, receipt, signal } = input;
    const [ownerKind, ownerId] = evidenceOwnerKey(owner);
    signal?.throwIfAborted();
    this.validateOwner(input);
    if (!generation) invalid("Evidence generation is required");
    validateSourceReceipt(receipt, sourceId);
    if (receipt.file !== input.file) invalid("Invalid evidence receipt");
    this.store.transaction(() => {
      if (
        this.store.catalog
          .prepare(
            "SELECT 1 FROM source_evidence_generations WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=?",
          )
          .get(ownerKind, ownerId, sourceId, generation)
      )
        invalid("Evidence generation already exists");
      this.store.catalog
        .prepare("INSERT INTO source_evidence_generations VALUES(?,?,?,?,NULL)")
        .run(ownerKind, ownerId, sourceId, generation);
    });
    const insert = this.store.catalog.prepare(
      "INSERT INTO source_evidence_records VALUES(?,?,?,?,?,?,?,?)",
    );
    let batch: RecordRow[] = [];
    const flush = async () => {
      signal?.throwIfAborted();
      this.store.transaction(() => {
        for (const row of batch)
          insert.run(
            ownerKind,
            ownerId,
            sourceId,
            generation,
            row.sequence,
            row.event,
            row.sourceUs,
            row.content,
          );
      });
      batch = [];
      await setImmediate();
      signal?.throwIfAborted();
    };
    try {
      for await (const row of sourceEvidenceRecords(input.file, receipt, signal)) {
        batch.push(row);
        if (batch.length === 256) await flush();
      }
      await flush();
      this.store.transaction(() => {
        this.validateOwner(input);
        this.store.catalog
          .prepare(
            "UPDATE source_evidence_generations SET receipt=? WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=?",
          )
          .run(JSON.stringify(receipt), ownerKind, ownerId, sourceId, generation);
      });
      return { owner, sourceId, generation, receipt };
    } catch (error) {
      this.removeUnpublished(input);
      throw error;
    }
  }
  /** Caller has fenced admission and stopped every source evidence producer. */
  async purge(owner: EvidenceOwner, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const row = this.store.catalog
        .prepare(`SELECT sourceId,generation FROM source_evidence_generations
        WHERE ownerKind=? AND ownerId=? ORDER BY sourceId,generation LIMIT 1`)
        .get(...evidenceOwnerKey(owner)) as { sourceId: string; generation: string } | undefined;
      if (!row) return;
      await this.reclaim({ owner, ...row }, signal);
      await setImmediate(undefined, { signal });
    }
  }

  /** Reclaim a dead generation without holding the event loop for its entire index. */
  async reclaim(identity: EvidenceIdentity, signal: AbortSignal): Promise<void> {
    const { owner, sourceId, generation } = identity;
    const [ownerKind, ownerId] = evidenceOwnerKey(owner);
    for (;;) {
      signal.throwIfAborted();
      const deleted = this.store.catalog
        .prepare(`DELETE FROM source_evidence_records
        WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=? AND sequence IN
        (SELECT sequence FROM source_evidence_records WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=? LIMIT 256)`)
        .run(ownerKind, ownerId, sourceId, generation, ownerKind, ownerId, sourceId, generation);
      if (Number(deleted.changes) === 0) break;
      await setImmediate(undefined, { signal });
    }
    signal.throwIfAborted();
    this.store.catalog
      .prepare(
        "DELETE FROM source_evidence_generations WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=?",
      )
      .run(ownerKind, ownerId, sourceId, generation);
  }

  cursorSampling(identity: EvidenceIdentity) {
    this.requireComplete(identity);
    const row = this.store.catalog
      .prepare(
        "SELECT receipt FROM source_evidence_generations WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=?",
      )
      .get(...evidenceOwnerKey(identity.owner), identity.sourceId, identity.generation) as {
      receipt: string;
    };
    return receiptCursorSampling(JSON.parse(row.receipt));
  }

  protected requireComplete({ owner, sourceId, generation }: EvidenceIdentity): void {
    const [ownerKind, ownerId] = evidenceOwnerKey(owner);
    if (
      !this.store.catalog
        .prepare(
          "SELECT 1 FROM source_evidence_generations WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=? AND receipt IS NOT NULL",
        )
        .get(ownerKind, ownerId, sourceId, generation)
    )
      throw new CatalogError("PREREQUISITE_MISSING", "Evidence generation is not indexed");
  }

  protected records(identity: EvidenceIdentity, query: RecordQuery): RecordRow[] {
    const indexes: Record<EvidenceIndex, { condition: string; keys: string[] }> = {
      cursor: { condition: "event='cursorSample'", keys: ["sourceUs", "sequence"] },
      cursorSequence: { condition: "event='cursorSample'", keys: ["sequence"] },
      geometry: {
        condition: "event='geometry' AND sourceUs IS NOT NULL",
        keys: ["sourceUs", "sequence"],
      },
      unplaced: { condition: "event='geometry' AND sourceUs IS NULL", keys: ["sequence"] },
      pauses: { condition: "event='pause'", keys: ["sourceUs", "sequence"] },
      marks: { condition: "event='mark'", keys: ["sourceUs", "sequence"] },
      narration: {
        condition: "event='audioAcquired' AND json_extract(content,'$.role')='narration'",
        keys: ["sourceUs", "sequence"],
      },
      system: {
        condition: "event='audioAcquired' AND json_extract(content,'$.role')='system'",
        keys: ["sourceUs", "sequence"],
      },
    };
    const index = indexes[query.index];
    const clauses = ["ownerKind=? AND ownerId=? AND sourceId=? AND generation=?", index.condition];
    const args: (string | number)[] = [
      ...evidenceOwnerKey(identity.owner),
      identity.sourceId,
      identity.generation,
    ];
    for (const [bound, operator] of [
      [query.lower, ">"],
      [query.upper, "<"],
    ] as const) {
      if (!bound) continue;
      const columns = index.keys.length === 1 ? index.keys[0] : `(${index.keys.join(",")})`;
      const placeholders =
        index.keys.length === 1 ? "?" : `(${index.keys.map(() => "?").join(",")})`;
      clauses.push(`${columns}${operator}${bound.inclusive ? "=" : ""}${placeholders}`);
      args.push(...bound.key);
    }
    args.push(query.limit);
    const order = index.keys.map((key) => `${key} ${query.reverse ? "DESC" : "ASC"}`).join(",");
    const selection = `FROM source_evidence_records ${query.index === "unplaced" ? "INDEXED BY source_evidence_geometry" : ""}
      WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ?`;
    // Window only the next bounded set of keys and byte counts. Load content after
    // cutting the prefix, so neither SQL's temporary rows nor JS hold 256 large records.
    if (query.maxBytes !== undefined) {
      return this.store.catalog
        .prepare(`WITH candidates AS (
          SELECT rowid AS recordId,sourceUs,sequence,length(CAST(content AS BLOB)) AS contentBytes ${selection}
        ), ranked AS (
          SELECT recordId,
            SUM(contentBytes) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS bytes,
            ROW_NUMBER() OVER (ORDER BY ${order}) AS ordinal
          FROM candidates
        )
        SELECT sequence,event,sourceUs,content FROM source_evidence_records
        WHERE rowid IN (SELECT recordId FROM ranked WHERE bytes <= ? OR ordinal = 1)
        ORDER BY ${order}`)
        .all(...args, query.maxBytes) as RecordRow[];
    }
    return this.store.catalog
      .prepare(`SELECT sequence,event,sourceUs,content ${selection}`)
      .all(...args) as RecordRow[];
  }

  /** Caller must only remove a generation its artifact queue has not published. */
  removeUnpublished({ owner, sourceId, generation }: EvidenceIdentity): void {
    const [ownerKind, ownerId] = evidenceOwnerKey(owner);
    this.store.transaction(() => {
      this.store.catalog
        .prepare(
          "DELETE FROM source_evidence_records WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=?",
        )
        .run(ownerKind, ownerId, sourceId, generation);
      this.store.catalog
        .prepare(
          "DELETE FROM source_evidence_generations WHERE ownerKind=? AND ownerId=? AND sourceId=? AND generation=?",
        )
        .run(ownerKind, ownerId, sourceId, generation);
    });
  }
}

/** Consumers see only query capabilities; ingestion and lifetime stay with this store. */
export type SourceTrailRead = Pick<
  SourceEvidenceStore,
  | "page"
  | "exportRecords"
  | "cursorSampling"
  | "latestCursor"
  | "timedGeometryAt"
  | "nextTimedGeometry"
  | "unplacedGeometry"
  | "pauseBoundaries"
  | "geometryChanges"
>;
export type SourceSelectionRead = Pick<
  SourceTrailRead,
  "page" | "pauseBoundaries" | "geometryChanges"
>;
export type SourceAudioRead = Pick<SourceEvidenceStore, "hasAudio" | "audio">;
