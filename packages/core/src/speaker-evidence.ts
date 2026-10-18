import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  add,
  compare,
  fromTime,
  rational,
  selectionRangeSchema,
  signedTimeValueSchema,
  timeValueSchema,
  subtract,
  toTime,
  type SelectionRange,
} from "@yap/composition";
import { CatalogError, type Catalog } from "./catalog.js";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import { selectSpeakerSource } from "./source-speakers.js";
import { ResourceReferences } from "./references.js";
import { setImmediate } from "node:timers/promises";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const speakerEvidenceSourceSchema = z.strictObject({
  streamId: z.string().min(1),
  acquisitionId: z.string().min(1).nullable(),
  supportDigest: z.string().min(1),
  channel: z.int().nonnegative(),
  originUs: signedTimeValueSchema,
  durationUs: timeValueSchema,
  observationRange: selectionRangeSchema,
  pcm: z.strictObject({
    sha256,
    sampleRate: z.literal(16000),
    frames: z
      .int()
      .min(1280)
      .max(480000)
      .refine((frames) => frames % 1280 === 0, "frames must contain complete 80ms score cells"),
  }),
  decoder: z.strictObject({
    recipe: z.string().min(1),
    workerSha256: sha256,
    osBuild: z.string().min(1),
  }),
  engine: z.strictObject({
    modelId: z.string().min(1),
    descriptorDigest: sha256,
    modelDigest: sha256,
    modelSha256: sha256,
    runtimeDigest: sha256,
    workerSha256: sha256,
    recipe: z.literal("original30s"),
  }),
});
export type SpeakerEvidenceSource = z.infer<typeof speakerEvidenceSourceSchema>;
const observationSourceSchema = speakerEvidenceSourceSchema
  .omit({ pcm: true, decoder: true })
  .strip();
const observationExpression = "json_remove(json_extract(metadata,'$.source'),'$.pcm','$.decoder')";

const speakerIdentitySchema = z
  .strictObject({
    owner: z.strictObject({ kind: z.literal("asset"), assetId: sha256 }),
    sourceId: sha256,
    generation: z.string().min(1).max(256),
    policy: z.literal("speaker-v1"),
  })
  .refine((v) => v.owner.assetId === v.sourceId);
export type SpeakerEvidenceIdentity = z.infer<typeof speakerIdentitySchema>;
export type SpeakerObservation = {
  ordinal: number;
  slot: number;
  sourceRange: SelectionRange;
  identity: "unknown";
  label?: string;
};
export type SpeakerScore = {
  frameIndex: number;
  sourceRange: SelectionRange;
  scores: number[];
  meaning: "uncalibrated";
};
export type SpeakerOperands = { nativeReceipt: string; report: string };
export const speakerEvidenceMetadataSchema = speakerIdentitySchema.safeExtend({
  source: speakerEvidenceSourceSchema,
  intervalCount: z.int().nonnegative().max(1500),
  scoreCount: z.int().positive().max(375),
  nativeReceiptSha256: sha256,
  reportSha256: sha256,
  tensorSha256: sha256,
  dtype: z.literal("<f4"),
  axes: z.tuple([z.literal(1), z.int().positive().max(375), z.literal(4)]),
  scoreMeaning: z.literal("uncalibrated"),
});
export type SpeakerEvidenceMetadata = z.infer<typeof speakerEvidenceMetadataSchema>;
const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
function decodeJSON(v: string): unknown {
  if (Buffer.byteLength(v) > 1024 * 1024) invalid("Native speaker operand exceeds the byte limit");
  try {
    return JSON.parse(v);
  } catch {
    return invalid("Invalid native speaker JSON");
  }
}
const scoreRow = z.array(z.number().finite().min(0).max(1)).length(4);
const nativeSchema = z.strictObject({
  verified: z.literal(false),
  encoding: z.literal("dtype/shape + base64 native tensor bytes"),
  nativeSegmentLines: z.array(z.array(z.string().max(128)).max(1500)).length(1),
  nativeTensors: z
    .array(
      z.strictObject({
        shape: z.tuple([z.literal(1), z.int().positive().max(375), z.literal(4)]),
        dtype: z.literal("<f4"),
        bytesBase64: z.string().max(8000),
      }),
    )
    .length(1),
});
const reportSchema = z
  .object({
    nativeSegmentLines: z.array(z.string().max(128)).max(1500),
    nativeProbabilities: z.array(scoreRow).min(1).max(375),
    probabilityShape: z.tuple([z.int().positive().max(375), z.literal(4)]),
    sampleRate: z.literal(16000),
    sourceFrames: z.int().min(1280).max(480000),
    frameSeconds: z.literal(0.08),
    modelSha256: sha256,
    pcmSha256: sha256,
  })
  .passthrough();
/** Decimal segment labels are preserved exactly instead of passing through binary float time. */
function seconds(v: string) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!match || v.length > 32) return invalid("Invalid native speaker endpoint");
  const digits = match[2] ?? "";
  return rational(BigInt(match[1]! + digits) * 1000000n, 10n ** BigInt(digits.length));
}
function normalized(source: SpeakerEvidenceSource, operands: SpeakerOperands) {
  const start = fromTime(source.observationRange.startUs),
    end = fromTime(source.observationRange.endUs);
  const frames = source.pcm.frames;
  if (compare(subtract(end, start), rational(BigInt(frames) * 1_000_000n, 16_000n)) !== 0)
    invalid("Native speaker observation range differs from its PCM extent");
  const native = nativeSchema.safeParse(decodeJSON(operands.nativeReceipt));
  const report = reportSchema.safeParse(decodeJSON(operands.report));
  if (!native.success || !report.success) invalid("Native speaker tensor axes or report differ");
  const scoreCount = frames / 1280;
  if (
    report.data.sourceFrames !== frames ||
    report.data.nativeProbabilities.length !== scoreCount ||
    report.data.probabilityShape[0] !== scoreCount ||
    native.data.nativeTensors[0]!.shape[1] !== scoreCount
  )
    invalid("Native speaker score extent differs from the selected PCM");
  if (
    report.data.pcmSha256 !== source.pcm.sha256 ||
    report.data.modelSha256 !== source.engine.modelSha256
  )
    invalid("Native speaker source or checkpoint pin differs");
  if (!isDeepStrictEqual(native.data.nativeSegmentLines[0], report.data.nativeSegmentLines))
    invalid("Native speaker segment operands differ");
  const encoded = native.data.nativeTensors[0]!.bytesBase64;
  const tensor = Buffer.from(encoded, "base64");
  if (tensor.length !== scoreCount * 16 || tensor.toString("base64") !== encoded)
    invalid("Native speaker tensor bytes differ from axes");
  const scores: SpeakerScore[] = report.data.nativeProbabilities.map((values, frameIndex) => {
    for (const [slot, value] of values.entries())
      if (tensor.readFloatLE((frameIndex * 4 + slot) * 4) !== value)
        invalid("Native speaker score pages differ from retained Float32 bytes");
    return {
      frameIndex,
      sourceRange: {
        startUs: toTime(add(start, rational(BigInt(frameIndex) * 80000n))),
        endUs: toTime(add(start, rational(BigInt(frameIndex + 1) * 80000n))),
      },
      scores: values,
      meaning: "uncalibrated",
    };
  });
  const intervals: SpeakerObservation[] = report.data.nativeSegmentLines.map((line, ordinal) => {
    const match = /^(\S+)\s+(\S+)\s+speaker_([0-3])$/.exec(line);
    if (!match) return invalid("Invalid native speaker segment");
    const relativeStart = seconds(match[1]!),
      relativeEnd = seconds(match[2]!);
    if (
      compare(relativeStart, rational(0n)) < 0 ||
      compare(relativeStart, relativeEnd) >= 0 ||
      compare(relativeEnd, rational(BigInt(frames) * 1_000_000n, 16_000n)) > 0
    )
      invalid("Native speaker interval is outside observation");
    return {
      ordinal,
      slot: Number(match[3]),
      sourceRange: {
        startUs: toTime(add(start, relativeStart)),
        endUs: toTime(add(start, relativeEnd)),
      },
      identity: "unknown",
    };
  });
  return { intervals, scores, tensorSha256: digest(tensor) };
}
/** One native parser validates lossless package operands and live publication alike. */
export function speakerOperandRows(metadata: SpeakerEvidenceMetadata, operands: SpeakerOperands) {
  const parsed = speakerEvidenceMetadataSchema.parse(metadata),
    result = normalized(parsed.source, operands);
  if (
    digest(operands.nativeReceipt) !== parsed.nativeReceiptSha256 ||
    digest(operands.report) !== parsed.reportSha256 ||
    result.tensorSha256 !== parsed.tensorSha256 ||
    result.intervals.length !== parsed.intervalCount
  )
    invalid("Portable speaker operands differ from retained metadata");
  return result;
}
/** Package readers use the same parsed native rows without another catalog. */
export function speakerOperandRecords(
  metadata: SpeakerEvidenceMetadata,
  operands: SpeakerOperands,
): Pick<SpeakerEvidenceStore, "metadata" | "intervalPage" | "scorePage"> {
  const parsed = speakerOperandRows(metadata, operands);
  const intervals = parsed.intervals.toSorted(
    (a, b) =>
      compare(fromTime(a.sourceRange.startUs), fromTime(b.sourceRange.startUs)) ||
      a.ordinal - b.ordinal,
  );
  const readMetadata = (identity: SpeakerEvidenceIdentity) => {
    if (!isDeepStrictEqual(key(identity), key(metadata)))
      throw new CatalogError("ARTIFACT_CHANGED", "Portable speaker generation changed");
    return metadata;
  };
  const page = <T>(
    records: T[],
    identity: SpeakerEvidenceIdentity,
    after: number,
    limit: number,
  ) => {
    speakerPageBounds(after, limit);
    readMetadata(identity);
    const rows = records.slice(after + 1, after + limit + 2),
      more = rows.length > limit;
    if (more) rows.pop();
    return { records: rows, nextSequence: more ? after + rows.length : null };
  };
  return {
    metadata: readMetadata,
    intervalPage: (request) => {
      const selected = page(
        intervals,
        request.identity,
        request.afterSequence ?? -1,
        request.limit ?? 100,
      );
      return {
        metadata: readMetadata(request.identity),
        intervals: request.range
          ? selected.records.filter((row) => intersects(row.sourceRange, request.range!))
          : selected.records,
        nextSequence: selected.nextSequence,
      };
    },
    scorePage: (request) => {
      const selected = page(
        parsed.scores,
        request.identity,
        request.afterFrame ?? -1,
        request.limit ?? 100,
      );
      return {
        metadata: readMetadata(request.identity),
        scores: request.range
          ? selected.records.filter((row) => intersects(row.sourceRange, request.range!))
          : selected.records,
        nextFrame: selected.nextSequence,
      };
    },
  };
}
function speakerPageBounds(after: number, limit: number) {
  if (
    !Number.isSafeInteger(after) ||
    after < -1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new CatalogError("INVALID_PARAMS", "Invalid speaker evidence page");
}
const key = (identity: SpeakerEvidenceIdentity) => [
  identity.owner.assetId,
  identity.sourceId,
  identity.generation,
  identity.policy,
];
const where = "ownerId=? AND sourceId=? AND generation=? AND policy=?";
type Generation = { metadata: string; nativeReceipt: string; report: string; complete: number };
export function speakerGenerationResource(
  identity: Pick<SpeakerEvidenceIdentity, "owner" | "generation">,
): string {
  return JSON.stringify([identity.owner.kind, identity.owner.assetId, identity.generation]);
}
export function assetSpeakerOwner(
  assets: Pick<AssetStore, "get" | "path">,
  acquisitions: { get(id: string): Pick<ReturnType<AcquisitionStore["get"]>, "id" | "bindings"> },
) {
  return (identity: SpeakerEvidenceIdentity, source: SpeakerEvidenceSource): void => {
    speakerIdentitySchema.parse(identity);
    const selected = selectSpeakerSource(assets, acquisitions, {
      assetId: identity.owner.assetId,
      streamId: source.streamId,
      ...(source.acquisitionId === null ? {} : { acquisitionId: source.acquisitionId }),
      channel: source.channel,
      sourceRange: source.observationRange,
      modelId: source.engine.modelId,
    });
    if (
      selected.supportDigest !== source.supportDigest ||
      compare(fromTime(selected.originUs), fromTime(source.originUs)) !== 0 ||
      compare(fromTime(selected.durationUs), fromTime(source.durationUs)) !== 0
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Speaker source support or clock changed");
  };
}

/** Exact30s is bounded; queue settlement alone publishes its complete native generation. */
export class SpeakerEvidenceStore {
  private readonly references: ResourceReferences;
  constructor(
    private readonly store: Catalog,
    private readonly validateOwner: (
      identity: SpeakerEvidenceIdentity,
      source: SpeakerEvidenceSource,
    ) => void,
    private readonly onRemove?: (identity: SpeakerEvidenceIdentity) => void,
  ) {
    this.references = new ResourceReferences(store);
    store.catalog.exec(`CREATE TABLE IF NOT EXISTS speaker_evidence_generations (
      ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,
      metadata TEXT NOT NULL,nativeReceipt TEXT NOT NULL,report TEXT NOT NULL,complete INTEGER NOT NULL,
      PRIMARY KEY(ownerId,sourceId,generation,policy)) STRICT;
      CREATE TABLE IF NOT EXISTS speaker_evidence_records (
      ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,
      kind TEXT NOT NULL,sequence INTEGER NOT NULL,content TEXT NOT NULL,
      PRIMARY KEY(ownerId,sourceId,generation,policy,kind,sequence)) STRICT;
      CREATE INDEX IF NOT EXISTS speaker_evidence_observation ON
      speaker_evidence_generations(ownerId,${observationExpression}) WHERE complete=1;`);
  }
  /** The producer's job retains raw operands through refusal until retry or retirement. */
  capture(
    inputIdentity: SpeakerEvidenceIdentity,
    inputSource: SpeakerEvidenceSource,
    operands: SpeakerOperands,
    jobId?: string,
  ) {
    return this.captureWithOwner(inputIdentity, inputSource, operands, jobId, this.validateOwner);
  }
  private captureWithOwner(
    inputIdentity: SpeakerEvidenceIdentity,
    inputSource: SpeakerEvidenceSource,
    operands: SpeakerOperands,
    jobId: string | undefined,
    validateOwner: typeof this.validateOwner,
  ) {
    const identity = speakerIdentitySchema.parse(inputIdentity),
      source = speakerEvidenceSourceSchema.parse(inputSource);
    validateOwner(identity, source);
    if (
      Buffer.byteLength(operands.nativeReceipt) > 1024 * 1024 ||
      Buffer.byteLength(operands.report) > 1024 * 1024
    )
      invalid("Native speaker operand exceeds the byte limit");
    const captured = {
      ...identity,
      source,
      nativeReceiptSha256: digest(operands.nativeReceipt),
      reportSha256: digest(operands.report),
    };
    let owned = false;
    this.store.transaction(() => {
      const row = this.row(identity);
      if (row) {
        const previous = JSON.parse(row.metadata) as SpeakerEvidenceMetadata;
        if (
          !isDeepStrictEqual(previous.source, source) ||
          row.nativeReceipt !== operands.nativeReceipt ||
          row.report !== operands.report
        )
          invalid("Retained speaker generation conflicts with source operands");
        return;
      }
      this.store.catalog
        .prepare("INSERT INTO speaker_evidence_generations VALUES(?,?,?,?,?,?,?,0)")
        .run(...key(identity), JSON.stringify(captured), operands.nativeReceipt, operands.report);
      if (jobId) {
        const owner = { kind: "job" as const, id: jobId };
        this.references.release("speaker-generation", owner);
        this.references.retain("speaker-generation", owner, [speakerGenerationResource(identity)]);
      }
      owned = true;
    });
    return { identity, source, captured, owned };
  }
  stage(
    inputIdentity: SpeakerEvidenceIdentity,
    inputSource: SpeakerEvidenceSource,
    operands: SpeakerOperands,
    jobId?: string,
  ) {
    return this.stageWithOwner(inputIdentity, inputSource, operands, jobId, this.validateOwner);
  }
  stagePortable(
    metadata: SpeakerEvidenceMetadata,
    operands: SpeakerOperands,
    validateOwner: typeof this.validateOwner,
  ) {
    speakerOperandRows(metadata, operands);
    const { owner, sourceId, generation, policy } = metadata;
    return this.stageWithOwner(
      { owner, sourceId, generation, policy },
      metadata.source,
      operands,
      undefined,
      validateOwner,
    );
  }
  private stageWithOwner(
    inputIdentity: SpeakerEvidenceIdentity,
    inputSource: SpeakerEvidenceSource,
    operands: SpeakerOperands,
    jobId: string | undefined,
    validateOwner: typeof this.validateOwner,
  ) {
    const { identity, source, captured, owned } = this.captureWithOwner(
      inputIdentity,
      inputSource,
      operands,
      jobId,
      validateOwner,
    );
    if (!owned && this.row(identity)?.complete !== 1)
      throw new CatalogError("PROCESSING_BUSY", "Speaker generation is being prepared", {});
    let result: ReturnType<typeof normalized>;
    try {
      result = normalized(source, operands);
    } catch (error) {
      if (error instanceof CatalogError)
        Object.assign(error.details, {
          generation: identity.generation,
          nativeReceiptSha256: captured.nativeReceiptSha256,
          reportSha256: captured.reportSha256,
          verified: false,
        });
      throw error;
    }
    const metadata: SpeakerEvidenceMetadata = {
      ...captured,
      intervalCount: result.intervals.length,
      scoreCount: result.scores.length,
      tensorSha256: result.tensorSha256,
      dtype: "<f4",
      axes: [1, result.scores.length, 4],
      scoreMeaning: "uncalibrated",
    };
    const content = JSON.stringify(metadata);
    if (owned)
      this.store.transaction(() => {
        const insert = this.store.catalog.prepare(
          "INSERT INTO speaker_evidence_records VALUES(?,?,?,?,?,?,?)",
        );
        const chronological = result.intervals.toSorted(
          (a, b) =>
            compare(fromTime(a.sourceRange.startUs), fromTime(b.sourceRange.startUs)) ||
            a.ordinal - b.ordinal,
        );
        for (const [sequence, interval] of chronological.entries())
          insert.run(...key(identity), "interval", sequence, JSON.stringify(interval));
        for (const score of result.scores)
          insert.run(...key(identity), "score", score.frameIndex, JSON.stringify(score));
        this.store.catalog
          .prepare(`UPDATE speaker_evidence_generations SET metadata=? WHERE ${where}`)
          .run(content, ...key(identity));
      });
    return {
      metadata,
      publish: (): undefined => {
        if (this.row(identity)?.metadata !== content)
          invalid("Staged speaker generation is no longer retained");
        this.validateOwner(identity, source);
        this.store.catalog
          .prepare(`UPDATE speaker_evidence_generations SET complete=1 WHERE ${where}`)
          .run(...key(identity));
      },
      close: async () => {
        if (owned && this.row(identity)?.complete !== 1) {
          if (jobId) this.references.release("speaker-generation", { kind: "job", id: jobId });
          this.remove(identity);
        }
      },
    };
  }
  /** Retained observations bind semantic source/engine pins, independently of current decoder availability. */
  portableGenerations(assetId: string, limit = 25000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25000)
      throw new CatalogError("INVALID_PARAMS", "Invalid speaker inventory limit");
    const rows = this.store.catalog
      .prepare(
        `SELECT rowid AS sequence,metadata FROM speaker_evidence_generations WHERE ownerId=? AND complete=1 ORDER BY rowid LIMIT ?`,
      )
      .all(assetId, limit + 1) as { sequence: number; metadata: string }[];
    if (rows.length > limit)
      throw new CatalogError("LIMIT_EXCEEDED", "Speaker inventory exceeds package budget");
    return rows.map((row) => ({
      sequence: row.sequence,
      metadata: speakerEvidenceMetadataSchema.parse(JSON.parse(row.metadata)),
    }));
  }
  latestObservations(
    assetId: string,
    source: Omit<z.infer<typeof observationSourceSchema>, "observationRange">,
  ) {
    const schema = observationSourceSchema.omit({ observationRange: true });
    const pin = schema.parse(source),
      found = new Map<string, SpeakerEvidenceMetadata>();
    for (const { metadata } of this.portableGenerations(assetId)) {
      if (!isDeepStrictEqual(schema.parse(metadata.source), pin)) continue;
      const { owner, sourceId, generation, policy } = metadata;
      this.validateOwner({ owner, sourceId, generation, policy }, metadata.source);
      found.set(JSON.stringify(metadata.source.observationRange), metadata);
    }
    return [...found.values()].toSorted(
      (a, b) =>
        compare(
          fromTime(a.source.observationRange.startUs),
          fromTime(b.source.observationRange.startUs),
        ) || a.generation.localeCompare(b.generation),
    );
  }
  latestObservation(assetId: string, source: z.infer<typeof observationSourceSchema>) {
    const row = this.store.catalog
      .prepare(`SELECT metadata FROM speaker_evidence_generations
        WHERE ownerId=? AND ${observationExpression}=? AND complete=1 ORDER BY rowid DESC LIMIT 1`)
      .get(assetId, JSON.stringify(observationSourceSchema.parse(source))) as
      | { metadata: string }
      | undefined;
    if (!row) return null;
    const metadata = JSON.parse(row.metadata) as SpeakerEvidenceMetadata;
    this.validateOwner(
      {
        owner: metadata.owner,
        sourceId: metadata.sourceId,
        generation: metadata.generation,
        policy: metadata.policy,
      },
      metadata.source,
    );
    return metadata;
  }
  metadata(identity: SpeakerEvidenceIdentity): SpeakerEvidenceMetadata {
    const row = this.row(identity);
    if (!row || row.complete !== 1)
      throw new CatalogError("NOT_READY", "Speaker evidence is not ready", {});
    return JSON.parse(row.metadata) as SpeakerEvidenceMetadata;
  }
  operands(identity: SpeakerEvidenceIdentity): SpeakerOperands {
    this.metadata(identity);
    return this.capturedOperands(identity);
  }
  /** Captured refusal operands remain private evidence; this read never claims readiness. */
  capturedOperands(identity: SpeakerEvidenceIdentity): SpeakerOperands {
    const row = this.row(identity);
    if (!row) throw new CatalogError("NOT_FOUND", "Speaker operands are not retained");
    return { nativeReceipt: row.nativeReceipt, report: row.report };
  }
  intervalPage(request: {
    identity: SpeakerEvidenceIdentity;
    afterSequence?: number;
    limit?: number;
    range?: SelectionRange;
  }) {
    const page = this.page<SpeakerObservation>(
      request.identity,
      "interval",
      request.afterSequence ?? -1,
      request.limit ?? 100,
    );
    const intervals = request.range
      ? page.records.filter((v) => intersects(v.sourceRange, request.range!))
      : page.records;
    return { metadata: page.metadata, intervals, nextSequence: page.nextSequence };
  }
  scorePage(request: {
    identity: SpeakerEvidenceIdentity;
    afterFrame?: number;
    limit?: number;
    range?: SelectionRange;
  }) {
    const page = this.page<SpeakerScore>(
      request.identity,
      "score",
      request.afterFrame ?? -1,
      request.limit ?? 100,
    );
    const scores = request.range
      ? page.records.filter((v) => intersects(v.sourceRange, request.range!))
      : page.records;
    return { metadata: page.metadata, scores, nextFrame: page.nextSequence };
  }
  private page<T>(
    identity: SpeakerEvidenceIdentity,
    kind: "interval" | "score",
    after: number,
    limit: number,
  ) {
    const metadata = this.metadata(identity);
    speakerPageBounds(after, limit);
    const rows = this.store.catalog
      .prepare(
        `SELECT sequence,content FROM speaker_evidence_records WHERE ${where} AND kind=? AND sequence>? ORDER BY sequence LIMIT ?`,
      )
      .all(...key(identity), kind, after, limit + 1) as { sequence: number; content: string }[];
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      metadata,
      records: rows.map((v) => JSON.parse(v.content) as T),
      nextSequence: more ? rows.at(-1)!.sequence : null,
    };
  }
  /** Caller first retires references and fences all producers through the shared queue. */
  remove(identity: SpeakerEvidenceIdentity): void {
    this.store.transaction(() => {
      this.onRemove?.(identity);
      this.store.catalog
        .prepare(`DELETE FROM speaker_evidence_records WHERE ${where}`)
        .run(...key(identity));
      this.store.catalog
        .prepare(`DELETE FROM speaker_evidence_generations WHERE ${where}`)
        .run(...key(identity));
    });
  }
  async reclaim(
    assetId: string,
    keep: (generation: string) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor = 0;
    for (;;) {
      signal?.throwIfAborted();
      const rows = this.store.catalog
        .prepare(
          "SELECT rowid AS cursor,sourceId,generation,policy FROM speaker_evidence_generations WHERE ownerId=? AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(assetId, cursor) as {
        cursor: number;
        sourceId: string;
        generation: string;
        policy: "speaker-v1";
      }[];
      for (const row of rows) {
        signal?.throwIfAborted();
        const identity: SpeakerEvidenceIdentity = {
          owner: { kind: "asset", assetId },
          sourceId: row.sourceId,
          generation: row.generation,
          policy: row.policy,
        };
        if (
          !keep(row.generation) &&
          !this.references.has("speaker-generation", speakerGenerationResource(identity))
        )
          this.remove(identity);
        cursor = row.cursor;
        await setImmediate();
      }
      if (rows.length < 100) return;
    }
  }
  /** Force removal for owner retirement; retained references cannot outlive the asset. */
  async purge(assetId: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const row = this.store.catalog
        .prepare(
          "SELECT sourceId,generation,policy FROM speaker_evidence_generations WHERE ownerId=? ORDER BY rowid LIMIT 1",
        )
        .get(assetId) as { sourceId: string; generation: string; policy: "speaker-v1" } | undefined;
      if (!row) return;
      this.remove({ owner: { kind: "asset", assetId }, ...row });
    }
  }
  private row(identity: SpeakerEvidenceIdentity): Generation | undefined {
    return this.store.catalog
      .prepare(
        `SELECT metadata,nativeReceipt,report,complete FROM speaker_evidence_generations WHERE ${where}`,
      )
      .get(...key(identity)) as Generation | undefined;
  }
}
function intersects(a: SelectionRange, b: SelectionRange): boolean {
  selectionRangeSchema.parse(b);
  return (
    compare(fromTime(a.startUs), fromTime(b.endUs)) < 0 &&
    compare(fromTime(a.endUs), fromTime(b.startUs)) > 0
  );
}
