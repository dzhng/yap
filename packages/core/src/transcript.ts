import { JsonDocument } from "./json-stream.js";
import {
  signedTimeValueSchema,
  timeValueSchema,
  selectionRangeSchema,
  fromTime,
  compare,
  round,
  type SelectionRange,
  type SignedTimeValue,
  type TimeValue,
  omit,
  issueSchema,
  type Issue,
} from "@yap/composition";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { copyImportedFile, fileIdentity, hashFile, type IdentifiedFile } from "./files.js";
import { ResourceReferences } from "./references.js";
import { constants, openSync, fstatSync, closeSync } from "node:fs";
import { lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import type { CaptureStore } from "./capture-store.js";
import { CatalogError, type Catalog } from "./catalog.js";
import { createOutputIssueTable, wordIssues } from "./issues.js";
import { ownerIdentity, type Owner } from "./jobs.js";
import type { PageQuery } from "./ordered-pages.js";
import type { SpeechEnginePins, SpeechModelRequest } from "./models.js";
import type { TimeRange } from "./presentation-time.js";
import { wordKind, wordKindPolicy, type WordKind } from "./word-kind.js";

export const transcriptPolicy = "transcript-v5";

const speechWindowRecipe = "source-windows-20s-context4s-guard1s-v3";
/** Retained and replayed execution keeps whatever recipe produced it; it is never relabelled. */
export const historicalSpeechExecutionSchema = z.strictObject({
  executionRange: selectionRangeSchema.nullable(),
  context: z.strictObject({
    beforeUs: z.int().min(0).max(4_000_000),
    afterUs: z.int().min(0).max(4_000_000),
  }),
  recipe: z.string().min(1).max(256),
});
/** What a new request may ask native to produce: only the current recipe. */
export const speechExecutionSchema = historicalSpeechExecutionSchema.extend({
  recipe: z.literal(speechWindowRecipe),
});
export type SpeechExecution = z.infer<typeof historicalSpeechExecutionSchema>;
export type TranscriptExecutionSelection = {
  executionRange?: SelectionRange | undefined;
  context?: { beforeUs: number; afterUs: number } | undefined;
};
export function speechExecution(selection: TranscriptExecutionSelection = {}): SpeechExecution {
  if (
    !selection.executionRange &&
    selection.context &&
    (selection.context.beforeUs !== 0 || selection.context.afterUs !== 0)
  )
    throw new CatalogError("INVALID_REQUEST", "Context requires an execution range");
  return speechExecutionSchema.parse({
    executionRange: selection.executionRange ?? null,
    context: selection.context ?? { beforeUs: 0, afterUs: 0 },
    recipe: speechWindowRecipe,
  });
}

/** What the native `speech.transcribe` operation receives. */
export type SpeechTranscriptionRequest = {
  models: SpeechModelRequest;
  track: {
    source: string;
    streamId?: string;
    sourceOffsetUs: SignedTimeValue;
    available: SelectionRange[];
  };
  output: string;
  execution: SpeechExecution;
};
/** What the native operation answers after publishing `output`; parsed tolerantly of added fields. */
export type SpeechTranscriptionReceipt = {
  output: { file: string; bytes: number; sha256: string };
  engine: {
    runtime: string;
    runtimeVersion: string;
    decoder: string;
    encoderPrecision: string;
    computeUnits: string;
  };
  segments: {
    ordinal: number;
    source: SelectionRange;
    state: "transcribed" | "skipped";
    reason?: "too_short" | undefined;
    wordCount: number;
    owned: SelectionRange;
  }[];
  wordCount: number;
  execution: SpeechExecution;
  available: SelectionRange[];
};
export type SpeechTranscriber = (
  request: SpeechTranscriptionRequest,
  signal: AbortSignal,
) => Promise<SpeechTranscriptionReceipt>;
export type TranscriptEngine = SpeechEnginePins & {
  modelDigest: string;
  encoderPrecision: string;
  computeUnits: string;
  policy: string;
  kindPolicy: string;
};

const engineLabel = z.string().min(1).max(256);
/** Retained engines keep the policies that produced them; `currentTranscript` decides staleness. */
export const transcriptEngineSchema = z.strictObject({
  runtime: engineLabel,
  runtimeVersion: engineLabel,
  runtimeRevision: engineLabel,
  decoder: engineLabel,
  model: engineLabel,
  modelRevision: engineLabel,
  modelDigest: engineLabel,
  encoderPrecision: engineLabel,
  computeUnits: engineLabel,
  policy: engineLabel,
  kindPolicy: engineLabel,
});
/**
 * A generation is current when the recipe and policy that key its job are today's. Anything else
 * is stale: reads and inventories skip it, cleanup may reclaim it, and the next request
 * regenerates it. The kind policy is not part of the job key, so bumping it alone changes nothing.
 */
export function currentTranscript(value: {
  engine: { policy: string };
  execution: { recipe: string };
}): boolean {
  return value.engine.policy === transcriptPolicy && value.execution.recipe === speechWindowRecipe;
}
const portableInteger = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const portableTranscriptSchema = z
  .strictObject({
    owner: z.strictObject({
      kind: z.literal("asset"),
      id: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    sourceId: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z
      .uuid()
      .refine((value) => value === value.toLowerCase(), "Transcript generation must be canonical"),
    source: z
      .strictObject({
        kind: z.literal("asset"),
        streamId: engineLabel,
        acquisitionId: z.uuid().optional(),
        supportDigest: engineLabel,
        durationUs: timeValueSchema,
      })
      .transform(({ acquisitionId, ...source }) => ({
        ...source,
        ...(acquisitionId === undefined ? {} : { acquisitionId }),
      })),
    engine: transcriptEngineSchema,
    execution: historicalSpeechExecutionSchema,
    available: z.array(selectionRangeSchema),
    track: z.strictObject({
      streamId: engineLabel,
      sourceOffsetUs: signedTimeValueSchema,
    }),
    segmentCount: portableInteger,
    wordCount: portableInteger,
    gapCount: portableInteger,
    maxWordUs: portableInteger,
    raw: z.strictObject({
      bytes: portableInteger,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  })
  .refine(
    (value) => value.owner.id === value.sourceId && value.source.streamId === value.track.streamId,
    "Transcript source differs from its owner and track",
  );
export type PortableTranscript = z.infer<typeof portableTranscriptSchema>;
export function transcriptGenerationResource(
  identity: Pick<TranscriptIdentity, "owner" | "generation">,
): string {
  return JSON.stringify([...ownerIdentity(identity.owner), identity.generation]);
}
export function portableTranscript(metadata: TranscriptMetadata): PortableTranscript {
  const value = metadata as TranscriptMetadata & { raw: { sizeBytes?: number; bytes?: number } };
  const raw =
    value.raw.sizeBytes !== undefined
      ? { bytes: value.raw.sizeBytes, sha256: value.raw.sha256 }
      : value.raw;
  return portableTranscriptSchema.parse({ ...value, raw, track: omit(value.track, "source") });
}
export type TranscriptOwner = Owner<"recording" | "asset">;
export type TranscriptIdentity = Readonly<{
  owner: TranscriptOwner;
  sourceId: string;
  generation: string;
}>;
export type TranscriptSource = Readonly<
  | { kind: "recording"; sourceGeneration: string; durationUs: number }
  | {
      kind: "asset";
      streamId: string;
      acquisitionId?: string;
      supportDigest: string;
      durationUs: TimeValue;
    }
>;
type TranscriptDetails = {
  engine: TranscriptEngine;
  execution: SpeechExecution;
  available: SelectionRange[];
  segmentCount: number;
  wordCount: number;
  gapCount: number;
  /** Longest stored word, bounding the lookback for words covering a source point. */
  maxWordUs: number;
  raw: { bytes: number; sha256: string };
};
export type TranscriptMetadata = TranscriptIdentity &
  TranscriptDetails & {
    source: TranscriptSource;
    track: Pick<SpeechTranscriptionRequest["track"], "source" | "streamId" | "sourceOffsetUs">;
  };
/** Retained public metadata uses unit-bearing byte names; catalog rows stay internal. */
export function publicTranscriptMetadata(value: TranscriptMetadata) {
  return { ...value, raw: { sizeBytes: value.raw.bytes, sha256: value.raw.sha256 } };
}
export function parsePublicTranscriptMetadata(value: unknown): TranscriptMetadata {
  if (!value || typeof value !== "object")
    throw new CatalogError("ARTIFACT_CHANGED", "Transcript metadata is unavailable");
  const record = value as Record<string, any>;
  if (!record.raw || "bytes" in record.raw || !Number.isSafeInteger(record.raw.sizeBytes))
    throw new CatalogError("ARTIFACT_CHANGED", "Transcript metadata uses an obsolete shape");
  return {
    ...record,
    raw: { bytes: record.raw.sizeBytes, sha256: record.raw.sha256 },
  } as TranscriptMetadata;
}
export function publicTranscriptIssues(value: readonly Issue[]) {
  return value.map((issue) => {
    const evidence = issue.evidence;
    if (
      !evidence ||
      typeof evidence !== "object" ||
      typeof (evidence as any).endSeconds !== "number"
    )
      return issue;
    const { endSeconds, startSeconds, ...rest } = evidence as Record<string, unknown>;
    return {
      ...issue,
      evidence: {
        ...rest,
        ...(typeof startSeconds === "number"
          ? { startUs: Math.round(startSeconds * 1_000_000) }
          : { startSeconds }),
        endUs: Math.round((endSeconds as number) * 1_000_000),
      },
    } as Issue;
  });
}
export type RecordingTranscriptIdentity = Readonly<{
  recordingId: string;
  sourceId: string;
  generation: string;
}>;
/** The actual recording/package contract, which has no asset-source variant. */
export type RecordingTranscriptMetadata = RecordingTranscriptIdentity &
  TranscriptDetails & {
    sourceGeneration: string;
    narration: { source: string; sourceOffsetUs: number };
  };
export function recordingTranscriptIdentity(
  value: RecordingTranscriptIdentity,
): TranscriptIdentity {
  return {
    owner: { kind: "recording", id: value.recordingId },
    sourceId: value.sourceId,
    generation: value.generation,
  };
}
export function recordingTranscript(metadata: TranscriptMetadata): RecordingTranscriptMetadata {
  const { owner, source, track, ...details } = metadata;
  if (
    owner.kind !== "recording" ||
    source.kind !== "recording" ||
    typeof track.sourceOffsetUs !== "number"
  )
    throw new CatalogError("INVALID_EVIDENCE", "Recording transcript requires a recording source");
  return {
    ...details,
    recordingId: owner.id,
    sourceGeneration: source.sourceGeneration,
    narration: { source: track.source, sourceOffsetUs: track.sourceOffsetUs },
  };
}
export function recordingTranscriptOwner(store: CaptureStore) {
  return (identity: TranscriptIdentity, source: TranscriptSource): void => {
    if (identity.owner.kind !== "recording" || source.kind !== "recording")
      throw new CatalogError("INVALID_EVIDENCE", "Recording transcript requires a recording owner");
    const recording = store.get(identity.owner.id);
    if (
      !store.isAvailable(recording.id) ||
      recording.sourceId !== identity.sourceId ||
      recording.sourceDurationUs === null ||
      recording.sourceDurationUs !== source.durationUs
    )
      throw new CatalogError("UNAVAILABLE", "Recording no longer accepts this transcript source");
  };
}
export type GapReason = "not_acquired" | "not_observed" | "too_short";
export type TranscriptWordRecord = {
  ordinal: number;
  text: string;
  kind: WordKind;
  startUs: number;
  endUs: number;
  /** An estimated instant observation, retained without inventing playable duration. */
  instant: boolean;
  confidence: number | null;
  /** Connected primary observation run; native inference windows are retained separately. */
  segment: number;
  /** What the publication reported about this word, when anything. */
  issues?: Issue[];
};
export type TranscriptGapRecord = { startUs: number; endUs: number; reason: GapReason };
/** One decoded inference window as the engine saw it. */
export type TranscriptSegmentRecord = {
  ordinal: number;
  startUs: number;
  endUs: number;
  state: "transcribed" | "skipped";
  reason: "too_short" | null;
};
/** Words are ordered by [startUs, ordinal] (the same order as ordinal); gaps by [startUs]; segments by [ordinal]. */
export type TranscriptRecordQuery = Omit<PageQuery, "index"> & {
  /** Estimated intervals intersect the half-open window; zero-width observations are points. */
  intersects?: TimeRange;
};
/** An indexed generation and the issues its raw evidence reports, ready for its publication. */
export type IndexedTranscript = { transcript: TranscriptMetadata; issues: Issue[] };
export type TranscriptRecords = {
  wordRecords(identity: TranscriptIdentity, query: TranscriptRecordQuery): TranscriptWordRecord[];
  gapRecords(identity: TranscriptIdentity, query: TranscriptRecordQuery): TranscriptGapRecord[];
};

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.object({ startUs: time, endUs: time });
const label = z.string().min(1).max(128);
const receiptSchema = z.object({
  output: z.object({
    file: z.string(),
    bytes: time,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  engine: z.object({
    runtime: label,
    runtimeVersion: label,
    decoder: label,
    encoderPrecision: label,
    computeUnits: label,
  }),
  segments: z.array(
    z.object({
      ordinal: time,
      source: selectionRangeSchema,
      state: z.enum(["transcribed", "skipped"]),
      reason: z.literal("too_short").optional(),
      wordCount: time,
      owned: selectionRangeSchema,
    }),
  ),
  wordCount: time,
  execution: historicalSpeechExecutionSchema,
  available: z.array(selectionRangeSchema),
});
const lineSchema = z.object({
  ordinal: time,
  source: selectionRangeSchema,
  owned: selectionRangeSchema,
  state: z.enum(["transcribed", "skipped"]),
  reason: z.literal("too_short").optional(),
  words: z.array(
    z.object({
      text: z.string().min(1).max(1024),
      source: range,
      confidence: z.number().min(0).max(1).nullable().optional(),
    }),
  ),
  /** Local problems native reported; `word` indexes this line's words. Absent before recipe v3. */
  issues: z
    .array(
      z.strictObject({
        code: z.string(),
        message: z.string(),
        word: time.optional(),
        range: selectionRangeSchema.optional(),
        evidence: z.unknown(),
      }),
    )
    .optional(),
});
function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new CatalogError("INVALID_RESPONSE", message, details);
}
function component(value: string): string {
  if (!value || basename(value) !== value || value === "." || value === "..")
    throw new CatalogError("INVALID_JOB", "Transcript identity is not a path component");
  return value;
}
const where = "ownerKind=? AND ownerId=? AND generation=?";
type GenerationRow = {
  ownerKind: TranscriptOwner["kind"];
  ownerId: string;
  sourceId: string;
  generation: string;
  source: string;
  engine: string;
  execution: string;
  available: string;
  track: string;
  segmentCount: number;
  wordCount: number;
  gapCount: number;
  maxWordUs: number;
  rawSha256: string;
  bytes: number;
  state: string;
};

/** Retained transcript rows and raw engine files; the job queue alone decides what is published. */
export class TranscriptStore implements TranscriptRecords {
  private readonly references: ResourceReferences;
  constructor(
    private readonly store: Catalog,
    private readonly home: string,
    private readonly validateOwner: (
      identity: TranscriptIdentity,
      source: TranscriptSource,
    ) => void,
  ) {
    this.references = new ResourceReferences(store);
    createOutputIssueTable(store);
    store.catalog.exec(`
      CREATE TABLE IF NOT EXISTS transcript_generations (
        ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,
        source TEXT NOT NULL,engine TEXT NOT NULL,execution TEXT NOT NULL,available TEXT NOT NULL,track TEXT NOT NULL,
        segmentCount INTEGER NOT NULL,wordCount INTEGER NOT NULL DEFAULT 0,gapCount INTEGER NOT NULL DEFAULT 0,
        maxWordUs INTEGER NOT NULL DEFAULT 0,rawSha256 TEXT,bytes INTEGER,state TEXT NOT NULL,
        PRIMARY KEY(ownerKind,ownerId,generation)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transcript_segments (
        ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,
        startUs INTEGER NOT NULL,endUs INTEGER NOT NULL,source TEXT NOT NULL,owned TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,
        PRIMARY KEY(ownerKind,ownerId,generation,ordinal)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transcript_words (
        ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,generation TEXT NOT NULL,ordinal INTEGER NOT NULL,
        startUs INTEGER NOT NULL,endUs INTEGER NOT NULL,instant INTEGER NOT NULL,text TEXT NOT NULL,
        kind TEXT NOT NULL,confidence REAL,segment INTEGER NOT NULL,windowOrdinal INTEGER NOT NULL,
        PRIMARY KEY(ownerKind,ownerId,generation,ordinal)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS transcript_words_time
        ON transcript_words(ownerKind,ownerId,generation,startUs,ordinal);
      CREATE TABLE IF NOT EXISTS transcript_gaps (
        ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,generation TEXT NOT NULL,startUs INTEGER NOT NULL,
        endUs INTEGER NOT NULL,reason TEXT NOT NULL,
        PRIMARY KEY(ownerKind,ownerId,generation,startUs)
      ) STRICT;
    `);
  }

  /** Exclusive startup recovery reaches unpublished assets and pre-index raw directories. */
  async recoverPendingAssets(signal: AbortSignal): Promise<void> {
    let failure: unknown;
    const root = join(this.home, "transcripts", "assets");
    let entries;
    try {
      entries = await opendir(root, { bufferSize: 16 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entries)
      for await (const entry of entries) {
        signal.throwIfAborted();
        const owner = { kind: "asset" as const, id: entry.name };
        try {
          await this.reclaim(
            owner,
            (generation) =>
              this.store.catalog
                .prepare(`SELECT state FROM transcript_generations WHERE ${where}`)
                .get(...ownerIdentity(owner), generation)?.state === "complete",
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          failure ??= error;
        }
      }
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const rows = this.store.catalog
        .prepare(
          "SELECT rowid AS cursor,ownerId,generation,state FROM transcript_generations WHERE ownerKind='asset' AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(cursor) as { cursor: number; ownerId: string; generation: string; state: string }[];
      for (const row of rows) {
        if (row.state !== "complete")
          try {
            await this.remove(
              { owner: { kind: "asset", id: row.ownerId }, generation: row.generation },
              signal,
            );
          } catch (error) {
            signal.throwIfAborted();
            failure ??= error;
          }
        cursor = row.cursor;
      }
      if (rows.length < 100) {
        if (failure) throw failure;
        return;
      }
      await setImmediate(undefined, { signal });
    }
  }
  /**
   * A complete, current generation. `historical` also admits a readable stale one, for evidence an
   * existing revision already pins; nothing new may be derived from a stale generation.
   */
  retainedGeneration(
    identity: Pick<TranscriptIdentity, "owner" | "generation">,
    { historical = false }: { historical?: boolean } = {},
  ): TranscriptMetadata {
    const { value, stale } = this.completeGeneration(identity);
    if (!value || (stale && !historical))
      throw new CatalogError("NOT_FOUND", "Retained transcript generation is unavailable", {
        generation: identity.generation,
        ...(stale ? { stale: true } : {}),
      });
    return value;
  }

  /** Whether a complete retained generation is unreadable or names a recipe or policy that isn't current. */
  isStale(identity: Pick<TranscriptIdentity, "owner" | "generation">): boolean {
    return this.completeGeneration(identity).stale;
  }

  /** The one staleness rule: a complete generation this version can't read, or isn't current. */
  private completeGeneration(identity: Pick<TranscriptIdentity, "owner" | "generation">) {
    const row = this.store.catalog
      .prepare(`SELECT * FROM transcript_generations WHERE ${where}`)
      .get(...ownerIdentity(identity.owner), identity.generation) as GenerationRow | undefined;
    if (row?.state !== "complete") return { value: null, stale: false };
    const value = readable(row);
    return { value, stale: !value || !currentTranscript(value) };
  }

  /** Current generations travel in packages; stale ones are left out and named for the caller to report. */
  portableGenerations(
    assetId: string,
    limit = 25000,
  ): { generations: PortableTranscript[]; stale: string[] } {
    const rows = this.store.catalog
      .prepare(
        "SELECT * FROM transcript_generations WHERE ownerKind='asset' AND ownerId=? ORDER BY generation LIMIT ?",
      )
      .all(assetId, limit + 1) as GenerationRow[];
    if (rows.length > limit)
      throw new CatalogError("LIMIT_EXCEEDED", "Transcript inventory exceeds its limit");
    const generations: PortableTranscript[] = [],
      stale: string[] = [];
    for (const row of rows) {
      if (row.state !== "complete")
        throw new CatalogError("PROCESSING_BUSY", "Transcript generation is incomplete", {});
      const value = readable(row);
      if (value && currentTranscript(value)) generations.push(portableTranscript(value));
      else stale.push(row.generation);
    }
    return { generations, stale };
  }
  portableFile(value: PortableTranscript): IdentifiedFile {
    const path = join(
      this.home,
      "transcripts",
      "assets",
      value.owner.id,
      value.generation,
      "raw.jsonl",
    );
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.size !== BigInt(value.raw.bytes))
        throw new CatalogError("INVALID_STORAGE", "Transcript raw file differs from metadata");
      return { path, bytes: value.raw.bytes, identity: fileIdentity(stat) };
    } finally {
      closeSync(fd);
    }
  }
  portableReceipt(value: PortableTranscript): SpeechTranscriptionReceipt {
    const counts = new Map(
      (
        this.store.catalog
          .prepare(
            `SELECT windowOrdinal,COUNT(*) AS count FROM transcript_words WHERE ${where} GROUP BY windowOrdinal`,
          )
          .all(...ownerIdentity(value.owner), value.generation) as {
          windowOrdinal: number;
          count: number;
        }[]
      ).map((row) => [row.windowOrdinal, row.count]),
    );
    const segments = this.store.catalog
      .prepare(
        `SELECT ordinal,source,owned,state,reason FROM transcript_segments WHERE ${where} ORDER BY ordinal LIMIT 10001`,
      )
      .all(...ownerIdentity(value.owner), value.generation) as {
      ordinal: number;
      source: string;
      owned: string;
      state: "transcribed" | "skipped";
      reason: "too_short" | null;
    }[];
    if (segments.length !== value.segmentCount)
      throw new CatalogError(
        "INVALID_STORAGE",
        "Transcript segment inventory differs from metadata",
      );
    return {
      output: { file: "raw.jsonl", ...value.raw },
      engine: {
        runtime: value.engine.runtime,
        runtimeVersion: value.engine.runtimeVersion,
        decoder: value.engine.decoder,
        encoderPrecision: value.engine.encoderPrecision,
        computeUnits: value.engine.computeUnits,
      },
      wordCount: value.wordCount,
      execution: value.execution,
      available: value.available,
      segments: segments.map((segment) => ({
        ordinal: segment.ordinal,
        source: selectionRangeSchema.parse(JSON.parse(segment.source)),
        owned: selectionRangeSchema.parse(JSON.parse(segment.owned)),
        state: segment.state,
        ...(segment.reason === null ? {} : { reason: segment.reason }),
        wordCount: counts.get(segment.ordinal) ?? 0,
      })),
    };
  }
  async stagePortable(
    value: unknown,
    receiptValue: unknown,
    raw: IdentifiedFile,
    track: SpeechTranscriptionRequest["track"],
    signal: AbortSignal,
  ) {
    const parsedMetadata = portableTranscriptSchema.safeParse(value),
      parsedReceipt = receiptSchema.safeParse(receiptValue);
    if (!parsedMetadata.success || !parsedReceipt.success)
      throw new CatalogError("INVALID_PACKAGE", "Invalid portable transcript metadata or receipt");
    const expected = parsedMetadata.data,
      receipt = parsedReceipt.data;
    if (
      !isDeepStrictEqual(
        { bytes: receipt.output.bytes, sha256: receipt.output.sha256 },
        expected.raw,
      ) ||
      receipt.output.file !== "raw.jsonl"
    )
      throw new CatalogError("INVALID_PACKAGE", "Transcript raw receipt differs from inventory");
    const prior = this.store.catalog
      .prepare(`SELECT * FROM transcript_generations WHERE ${where}`)
      .get(...ownerIdentity(expected.owner), expected.generation) as GenerationRow | undefined;
    if (prior) {
      if (prior.state !== "complete")
        throw new CatalogError(
          "PROCESSING_BUSY",
          "Transcript generation is already being staged",
          {},
        );
      const existing = readable(prior);
      if (
        !existing ||
        !isDeepStrictEqual(portableTranscript(existing), expected) ||
        !isDeepStrictEqual(this.portableReceipt(expected), receipt)
      )
        throw new CatalogError(
          "INVALID_PACKAGE",
          "Transcript metadata conflicts with retained generation",
        );
      const file = await open(
        this.portableFile(expected).path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if ((await hashFile(file, expected.raw.bytes, signal)).sha256 !== expected.raw.sha256)
          throw new CatalogError(
            "INVALID_PACKAGE",
            "Transcript raw bytes conflict with retained generation",
          );
      } finally {
        await file.close();
      }
      return {
        metadata: existing,
        // The local generation was indexed already; its publication, if any, carries its issues.
        issues: [],
        close: async () => {},
        publish: () => {
          signal.throwIfAborted();
          this.validateOwner(existing, existing.source);
        },
      };
    }
    let owned = false;
    const close = async () => {
      const row = this.store.catalog
        .prepare(`SELECT state FROM transcript_generations WHERE ${where}`)
        .get(...ownerIdentity(expected.owner), expected.generation);
      if (owned && row?.state !== "complete") await this.remove(expected);
    };
    try {
      const output = await this.reserve(expected);
      owned = true;
      const copied = await copyImportedFile(raw.path, output, signal, raw);
      if (copied.bytes !== expected.raw.bytes || copied.sha256 !== expected.raw.sha256)
        throw new CatalogError("INVALID_PACKAGE", "Transcript raw bytes differ from inventory");
      const pins = omit(
        expected.engine,
        "encoderPrecision",
        "computeUnits",
        "policy",
        "kindPolicy",
      );
      const { transcript: indexed, issues } = await this.index({
        identity: expected,
        source: expected.source,
        request: { track, output, execution: expected.execution },
        receipt: { ...receipt, output: { ...receipt.output, file: output } },
        pins,
        signal,
      });
      if (!isDeepStrictEqual(portableTranscript(indexed), expected))
        throw new CatalogError(
          "INVALID_PACKAGE",
          "Indexed transcript differs from retained metadata",
        );
      for (let path = resolve(output); ; path = dirname(path)) {
        const file = await open(path, constants.O_RDONLY);
        try {
          await file.sync();
        } finally {
          await file.close();
        }
        if (path === resolve(this.home)) break;
      }
      return {
        metadata: indexed,
        issues,
        close,
        publish: () => {
          signal.throwIfAborted();
          this.publish(indexed);
        },
      };
    } catch (error) {
      await close();
      if (error instanceof CatalogError && error.code === "INVALID_RESPONSE")
        throw new CatalogError("INVALID_PACKAGE", error.message, error.details);
      throw error;
    }
  }

  /** Owned parent directories must be real directories so removal never follows a link out. */
  private async parent(owner: TranscriptOwner, create = false): Promise<string | null> {
    let path = this.home;
    const names =
      owner.kind === "recording"
        ? ["recordings", component(owner.id), "evidence", "transcript"]
        : ["transcripts", "assets", component(owner.id)];
    for (const name of names) {
      path = join(path, name);
      if (create)
        await mkdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      try {
        const entry = await lstat(path);
        if (!entry.isDirectory())
          throw new CatalogError("INVALID_EVIDENCE", "Transcript parent is not a directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }
    return path;
  }

  /** Creates the attempt's empty generation directory and names the file native must publish. */
  async reserve(identity: TranscriptIdentity): Promise<string> {
    const directory = join(
      (await this.parent(identity.owner, true))!,
      component(identity.generation),
    );
    await mkdir(directory);
    return join(directory, "raw.jsonl");
  }

  async ingest(input: {
    identity: TranscriptIdentity;
    source: TranscriptSource;
    request: SpeechTranscriptionRequest;
    receipt: SpeechTranscriptionReceipt;
    pins: SpeechEnginePins & { modelDigest: string };
    signal: AbortSignal;
  }): Promise<IndexedTranscript> {
    this.validateOwner(input.identity, input.source);
    const result = await this.index(input);
    input.signal.throwIfAborted();
    this.store.transaction(() => this.publish(result.transcript));
    return result;
  }
  private publish(value: TranscriptMetadata): void {
    this.validateOwner(value, value.source);
    this.store.catalog
      .prepare(`UPDATE transcript_generations SET state='complete' WHERE ${where}`)
      .run(...ownerIdentity(value.owner), value.generation);
  }
  private async index(input: {
    identity: TranscriptIdentity;
    source: TranscriptSource;
    request: Pick<SpeechTranscriptionRequest, "track" | "output" | "execution">;
    receipt: SpeechTranscriptionReceipt;
    pins: SpeechEnginePins & { modelDigest: string };
    signal: AbortSignal;
  }): Promise<IndexedTranscript> {
    const { identity, request, pins, signal } = input;
    const { owner, sourceId, generation } = identity;
    const [ownerKind, ownerId] = ownerIdentity(owner);
    const source = input.source;
    signal.throwIfAborted();
    if (
      source.kind !== owner.kind ||
      !timeValueSchema.safeParse(source.durationUs).success ||
      (source.kind === "asset" &&
        (sourceId !== ownerId || source.streamId !== request.track.streamId))
    )
      throw new CatalogError(
        "INVALID_EVIDENCE",
        "Transcript source does not match its owner or selection",
      );
    const parsed = receiptSchema.safeParse(input.receipt);
    if (!parsed.success) invalid("Transcription receipt is malformed");
    const receipt = parsed.data;
    if (!isDeepStrictEqual(receipt.execution, request.execution))
      invalid("Transcription execution differs from requested preparation");
    const available = receipt.available;
    let availableEnd: TimeValue = 0;
    for (const support of available) {
      const admitted = request.track.available.find(
        (candidate) =>
          compare(fromTime(candidate.startUs), fromTime(support.startUs)) <= 0 &&
          compare(fromTime(candidate.endUs), fromTime(support.endUs)) >= 0,
      );
      if (!admitted || compare(fromTime(support.startUs), fromTime(availableEnd)) < 0)
        invalid("Transcription physical support differs from admitted source");
      availableEnd = support.endUs;
    }
    if (
      receipt.output.file !== request.output ||
      receipt.engine.runtime !== pins.runtime ||
      receipt.engine.runtimeVersion !== pins.runtimeVersion ||
      receipt.engine.decoder !== pins.decoder
    )
      invalid("Transcription receipt names another output or engine");
    // Native narrows each acquired interval to the media the selected source actually holds, so a
    // decoded windows can overlap; their ordered primary ownership never fills missing support.
    let words = 0,
      interval = 0,
      readUs: TimeValue = 0,
      ownedEnd: TimeValue = 0;
    for (const [ordinal, segment] of receipt.segments.entries()) {
      if (segment.ordinal !== ordinal)
        invalid("Transcription segment ordinals must be unique and ordered");
      while (
        interval < available.length &&
        compare(fromTime(available[interval]!.endUs), fromTime(segment.source.startUs)) <= 0
      )
        interval++;
      const acquired = available[interval];
      const owned = segment.owned;
      const execution = request.execution;
      if (
        compare(fromTime(segment.source.startUs), fromTime(readUs)) < 0 ||
        compare(fromTime(segment.source.endUs), fromTime(segment.source.startUs)) <= 0 ||
        !acquired ||
        compare(fromTime(segment.source.startUs), fromTime(acquired.startUs)) < 0 ||
        compare(fromTime(segment.source.endUs), fromTime(acquired.endUs)) > 0 ||
        compare(fromTime(owned.startUs), fromTime(segment.source.startUs)) < 0 ||
        compare(fromTime(owned.endUs), fromTime(segment.source.endUs)) > 0 ||
        compare(fromTime(owned.startUs), fromTime(ownedEnd)) < 0 ||
        (execution.executionRange !== null &&
          (compare(fromTime(owned.startUs), fromTime(execution.executionRange.startUs)) < 0 ||
            compare(fromTime(owned.endUs), fromTime(execution.executionRange.endUs)) > 0)) ||
        (segment.state === "skipped") !== (segment.reason === "too_short") ||
        (segment.state === "skipped" && segment.wordCount !== 0)
      )
        invalid("Transcription segment does not lie in an acquired source interval");
      readUs = segment.source.startUs;
      ownedEnd = owned.endUs;
      words += segment.wordCount;
    }
    if (words !== receipt.wordCount) invalid("Transcription word count does not match segments");
    const durationUs = source.durationUs;
    const engine: TranscriptEngine = {
      ...pins,
      encoderPrecision: receipt.engine.encoderPrecision,
      computeUnits: receipt.engine.computeUnits,
      policy: transcriptPolicy,
      kindPolicy: wordKindPolicy,
    };
    const track = {
      source: request.track.source,
      ...(request.track.streamId === undefined ? {} : { streamId: request.track.streamId }),
      sourceOffsetUs: request.track.sourceOffsetUs,
    };
    this.store.catalog
      .prepare(
        `INSERT INTO transcript_generations(ownerKind,ownerId,sourceId,generation,source,engine,execution,available,track,segmentCount,state)
         VALUES(?,?,?,?,?,?,?,?,?,?,'ingesting')`,
      )
      .run(
        ownerKind,
        ownerId,
        sourceId,
        component(generation),
        JSON.stringify(source),
        JSON.stringify(engine),
        JSON.stringify(request.execution),
        JSON.stringify(available),
        JSON.stringify(track),
        receipt.segments.length,
      );
    const insertSegment = this.store.catalog.prepare(
      "INSERT INTO transcript_segments VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    const insertWord = this.store.catalog.prepare(
      "INSERT INTO transcript_words VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    let segments: SpeechTranscriptionReceipt["segments"] = [];
    let batch: (TranscriptWordRecord & { windowOrdinal: number })[] = [];
    const flush = async () => {
      signal.throwIfAborted();
      this.store.transaction(() => {
        for (const segment of segments)
          insertSegment.run(
            ownerKind,
            ownerId,
            generation,
            segment.ordinal,
            round(fromTime(segment.source.startUs)),
            round(fromTime(segment.source.endUs)),
            JSON.stringify(segment.source),
            JSON.stringify(segment.owned),
            segment.state,
            segment.reason ?? null,
          );
        for (const word of batch)
          insertWord.run(
            ownerKind,
            ownerId,
            generation,
            word.ordinal,
            word.startUs,
            word.endUs,
            Number(word.instant),
            word.text,
            word.kind,
            word.confidence,
            word.segment,
            word.windowOrdinal,
          );
      });
      segments = [];
      batch = [];
      await setImmediate(undefined, { signal });
    };

    const issues: Issue[] = [];
    let lines = 0,
      ordinal = 0,
      maxWordUs = 0,
      previousStartUs = 0,
      connectedRun = -1;
    let previousSegment: SpeechTranscriptionReceipt["segments"][number] | undefined;
    const consume = async (document: JsonDocument) => {
      let value: unknown;
      try {
        value = document.finish();
      } catch {
        invalid("Raw transcript line is not JSON");
      }
      const line = lineSchema.safeParse(value);
      if (!line.success)
        invalid("Raw transcript line is malformed", { line: lines, issues: line.error.issues });
      const segment = receipt.segments[lines++];
      if (
        !segment ||
        line.data.ordinal !== segment.ordinal ||
        !isDeepStrictEqual(line.data.source, segment.source) ||
        line.data.state !== segment.state ||
        line.data.reason !== segment.reason ||
        line.data.words.length !== segment.wordCount
      )
        invalid("Raw transcript segment differs from its receipt");
      if (!isDeepStrictEqual(line.data.owned, segment.owned))
        invalid("Raw transcript ownership differs from its receipt");
      // Inference windows are provenance, not phrase barriers. Exact connected ownership
      // continues one observation run; skipped or uncovered support starts another.
      const owned = segment.owned;
      if (
        !previousSegment ||
        previousSegment.state !== "transcribed" ||
        segment.state !== "transcribed" ||
        compare(fromTime(previousSegment.owned.endUs), fromTime(owned.startUs)) !== 0
      )
        connectedRun++;
      previousSegment = segment;
      segments.push(segment);
      for (const { word, range, ...reported } of line.data.issues ?? []) {
        const parsed = issueSchema.safeParse({
          ...reported,
          ...(word === undefined
            ? range === undefined
              ? {}
              : { at: { range } }
            : { at: { word: ordinal + word } }),
        });
        if (!parsed.success || (word !== undefined && word >= line.data.words.length))
          invalid("Raw transcript issue is malformed", { line: lines - 1 });
        issues.push(parsed.data);
      }
      const observed = {
        startUs: round(fromTime(segment.source.startUs)),
        endUs: round(fromTime(segment.source.endUs)),
      };
      for (const word of line.data.words) {
        const { source } = word;
        const operands = {
          segmentOrdinal: segment.ordinal,
          wordOrdinal: ordinal,
          source,
          segmentSource: observed,
        };
        if (source.endUs < source.startUs) invalid("Transcript word range is reversed", operands);
        if (source.startUs < observed.startUs || source.endUs > observed.endUs)
          invalid("Transcript word lies outside its segment", operands);
        const instant = source.startUs === source.endUs;
        const { startUs, endUs } = source;
        if (startUs < previousStartUs)
          invalid("Transcript words must be ordered by start", { ...operands, previousStartUs });
        previousStartUs = startUs;
        maxWordUs = Math.max(maxWordUs, endUs - startUs);
        batch.push({
          ordinal: ordinal++,
          text: word.text,
          kind: wordKind(word.text),
          startUs,
          endUs,
          instant,
          confidence: word.confidence ?? null,
          segment: connectedRun,
          windowOrdinal: segment.ordinal,
        });
        if (batch.length === 256) await flush();
      }
      if (segments.length === 256) await flush();
    };

    const handle = await open(request.output, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      if (!(await handle.stat()).isFile()) invalid("Raw transcript is not a regular file");
      // Provider windows decode incrementally; no whole raw line is retained beside its words.
      let document = new JsonDocument(),
        partBytes = 0;
      for await (const chunk of handle.createReadStream({ highWaterMark: 65_536, signal })) {
        bytes += chunk.length;
        if (bytes > receipt.output.bytes) invalid("Raw transcript exceeds its byte receipt");
        hash.update(chunk);
        let start = 0,
          newline: number;
        while ((newline = chunk.indexOf(10, start)) >= 0) {
          document.write(chunk.subarray(start, newline));
          await consume(document);
          document = new JsonDocument();
          partBytes = 0;
          start = newline + 1;
        }
        if (start < chunk.length) {
          document.write(chunk.subarray(start));
          partBytes += chunk.length - start;
        }
      }
      await flush();
      if (
        partBytes ||
        lines !== receipt.segments.length ||
        bytes !== receipt.output.bytes ||
        hash.digest("hex") !== receipt.output.sha256
      )
        invalid("Raw transcript does not match its receipt");
    } finally {
      await handle.close();
    }

    const gaps = transcriptGaps(
      receipt.segments.map(({ owned, state }) => ({
        startUs: round(fromTime(owned.startUs)),
        endUs: round(fromTime(owned.endUs)),
        state,
      })),
      round(fromTime(durationUs)),
      available.map(({ startUs, endUs }) => ({
        startUs: round(fromTime(startUs)),
        endUs: round(fromTime(endUs)),
      })),
    );
    signal.throwIfAborted();
    return this.store.transaction(() => {
      const insertGap = this.store.catalog.prepare(
        "INSERT INTO transcript_gaps VALUES(?,?,?,?,?,?)",
      );
      for (const gap of gaps)
        insertGap.run(ownerKind, ownerId, generation, gap.startUs, gap.endUs, gap.reason);
      this.store.catalog
        .prepare(
          `UPDATE transcript_generations SET wordCount=?,gapCount=?,maxWordUs=?,rawSha256=?,bytes=? WHERE ${where}`,
        )
        .run(
          ordinal,
          gaps.length,
          maxWordUs,
          receipt.output.sha256,
          bytes,
          ownerKind,
          ownerId,
          generation,
        );
      return {
        transcript: metadata(
          this.store.catalog
            .prepare(`SELECT * FROM transcript_generations WHERE ${where}`)
            .get(ownerKind, ownerId, generation) as GenerationRow,
        ),
        issues,
      };
    });
  }

  wordRecords(identity: TranscriptIdentity, query: TranscriptRecordQuery): TranscriptWordRecord[] {
    const rows = this.records("transcript_words", ["startUs", "ordinal"], identity, query) as (Omit<
      TranscriptWordRecord,
      "instant"
    > & { instant: number })[];
    if (!rows.length) return [];
    const ordinals = rows.map((row) => row.ordinal);
    // A transcript generation is the attempt that published it, so its issues are found by it.
    const issues = wordIssues(this.store, identity.generation, {
      first: Math.min(...ordinals),
      last: Math.max(...ordinals),
    });
    return rows.map(({ instant, ...word }) => {
      const reported = issues.get(word.ordinal);
      return { ...word, instant: instant === 1, ...(reported ? { issues: reported } : {}) };
    });
  }

  gapRecords(identity: TranscriptIdentity, query: TranscriptRecordQuery): TranscriptGapRecord[] {
    return this.records("transcript_gaps", ["startUs"], identity, query) as TranscriptGapRecord[];
  }

  segmentRecords(
    identity: TranscriptIdentity,
    query: TranscriptRecordQuery,
  ): TranscriptSegmentRecord[] {
    return this.records(
      "transcript_segments",
      ["ordinal"],
      identity,
      query,
    ) as TranscriptSegmentRecord[];
  }

  private records(
    table: "transcript_words" | "transcript_gaps" | "transcript_segments",
    keys: readonly string[],
    identity: TranscriptIdentity,
    query: TranscriptRecordQuery,
  ): unknown[] {
    const columns = {
      transcript_words: "ordinal,text,kind,startUs,endUs,instant,confidence,segment",
      transcript_gaps: "startUs,endUs,reason",
      transcript_segments: "ordinal,startUs,endUs,state,reason",
    }[table];
    const clauses = [where];
    const args: (string | number)[] = [...ownerIdentity(identity.owner), identity.generation];
    if (query.intersects) {
      clauses.push("startUs<? AND (endUs>? OR (startUs=endUs AND startUs>=?))");
      args.push(query.intersects.endUs, query.intersects.startUs, query.intersects.startUs);
    }
    const tuple = keys.length === 1 ? keys[0]! : `(${keys.join(",")})`;
    for (const [bound, operator] of [
      [query.lower, ">"],
      [query.upper, "<"],
    ] as const) {
      if (!bound) continue;
      clauses.push(
        `${tuple}${operator}${bound.inclusive ? "=" : ""}${keys.length === 1 ? "?" : `(${keys.map(() => "?").join(",")})`}`,
      );
      args.push(...bound.key);
    }
    return this.store.catalog
      .prepare(
        `SELECT ${columns} FROM ${table} WHERE ${clauses.join(" AND ")}
         ORDER BY ${keys.map((key) => `${key} ${query.reverse ? "DESC" : "ASC"}`).join(",")} LIMIT ?`,
      )
      .all(...args, query.limit);
  }

  /** Removes one unretained generation's files and rows, yielding between bounded batches. */
  async remove(identity: Pick<TranscriptIdentity, "owner" | "generation">, signal?: AbortSignal) {
    const { owner, generation } = identity;
    const [ownerKind, ownerId] = ownerIdentity(owner);
    const parent = await this.parent(owner);
    if (parent) await rm(join(parent, component(generation)), { recursive: true, force: true });
    for (const table of ["transcript_words", "transcript_segments", "transcript_gaps"]) {
      for (;;) {
        signal?.throwIfAborted();
        const removed = this.store.catalog
          .prepare(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT 256)`,
          )
          .run(ownerKind, ownerId, generation);
        if (Number(removed.changes) < 256) break;
        await setImmediate(undefined, signal ? { signal } : {});
      }
    }
    this.store.catalog
      .prepare(`DELETE FROM transcript_generations WHERE ${where}`)
      .run(ownerKind, ownerId, generation);
  }

  /**
   * Reclaims every generation `keep` does not hold, whether it left only files (native wrote before
   * ingestion began) or only rows (a crash removed its directory first). Continues past failures.
   */
  async reclaim(
    owner: TranscriptOwner,
    keep: (generation: string) => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    let firstError: unknown;
    let failed = false;
    const visit = async (generation: string) => {
      signal.throwIfAborted();
      if (
        keep(generation) ||
        this.references.has(
          "transcript-generation",
          transcriptGenerationResource({ owner, generation }),
        )
      )
        return;
      try {
        await this.remove({ owner, generation }, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!failed) firstError = error;
        failed = true;
      }
    };
    const parent = await this.parent(owner);
    if (parent)
      for await (const entry of await opendir(parent, { bufferSize: 16 })) await visit(entry.name);
    let after = "";
    for (;;) {
      signal.throwIfAborted();
      const row = this.store.catalog
        .prepare(
          "SELECT generation FROM transcript_generations WHERE ownerKind=? AND ownerId=? AND generation>? ORDER BY generation LIMIT 1",
        )
        .get(...ownerIdentity(owner), after) as { generation: string } | undefined;
      if (!row) break;
      after = row.generation;
      await visit(row.generation);
    }
    if (failed) throw firstError;
  }

  /** The caller has fenced this owner and stopped every transcript producer. */
  async purge(owner: TranscriptOwner, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const row = this.store.catalog
        .prepare(
          "SELECT generation FROM transcript_generations WHERE ownerKind=? AND ownerId=? ORDER BY generation LIMIT 1",
        )
        .get(...ownerIdentity(owner)) as { generation: string } | undefined;
      if (!row) break;
      await this.remove({ owner, generation: row.generation }, signal);
    }
    const parent = await this.parent(owner);
    if (parent) await rm(parent, { recursive: true, force: true });
  }
}

/** Gaps are exactly the source never acquired between segments plus each skipped segment. */
export function transcriptGaps(
  segments: readonly (TimeRange & Pick<TranscriptSegmentRecord, "state">)[],
  durationUs: number,
  available?: readonly TimeRange[],
): TranscriptGapRecord[] {
  const gaps: TranscriptGapRecord[] = [];
  let atUs = 0;
  for (const segment of segments) {
    if (atUs < segment.startUs) appendUnobserved(atUs, segment.startUs);
    if (segment.state === "skipped" && segment.startUs < segment.endUs)
      gaps.push({ startUs: segment.startUs, endUs: segment.endUs, reason: "too_short" });
    atUs = Math.max(atUs, segment.endUs);
  }
  if (atUs < durationUs) appendUnobserved(atUs, durationUs);
  return gaps;

  function appendUnobserved(startUs: number, endUs: number) {
    let at = startUs;
    for (const support of available ?? []) {
      if (support.endUs <= at || support.startUs >= endUs) continue;
      if (at < support.startUs)
        gaps.push({ startUs: at, endUs: Math.min(endUs, support.startUs), reason: "not_acquired" });
      const lower = Math.max(at, support.startUs),
        upper = Math.min(endUs, support.endUs);
      if (lower < upper) gaps.push({ startUs: lower, endUs: upper, reason: "not_observed" });
      at = upper;
    }
    if (at < endUs) gaps.push({ startUs: at, endUs, reason: "not_acquired" });
  }
}

/** A retained row this version can't read at all is as stale as one with a foreign identity. */
function readable(row: GenerationRow): TranscriptMetadata | null {
  try {
    return metadata(row);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return null;
    throw error;
  }
}
function metadata(row: GenerationRow): TranscriptMetadata {
  return {
    owner:
      row.ownerKind === "recording"
        ? { kind: "recording", id: row.ownerId }
        : { kind: "asset", id: row.ownerId },
    sourceId: row.sourceId,
    generation: row.generation,
    source: JSON.parse(row.source) as TranscriptSource,
    engine: JSON.parse(row.engine) as TranscriptEngine,
    execution: historicalSpeechExecutionSchema.parse(JSON.parse(row.execution)),
    available: z.array(selectionRangeSchema).parse(JSON.parse(row.available)),
    track: JSON.parse(row.track) as TranscriptMetadata["track"],
    segmentCount: row.segmentCount,
    wordCount: row.wordCount,
    gapCount: row.gapCount,
    maxWordUs: row.maxWordUs,
    raw: { bytes: row.bytes, sha256: row.rawSha256 },
  };
}
