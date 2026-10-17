import { isDeepStrictEqual } from "node:util";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { CatalogError, type Catalog } from "./catalog.js";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import { ResourceReferences } from "./references.js";
import {
  alignmentDigest,
  alignmentEvidenceSourceSchema,
  alignmentOperandByteLimit,
  alignmentOperandRows,
  type AlignmentEvidenceSource,
  type AlignmentOperands,
  type AlignmentWord,
  type AlignmentAcoustic,
  type AlignmentScore,
} from "./alignment-operands.js";
import { selectAlignmentSource } from "./source-alignment.js";

export const alignmentIdentitySchema = z.strictObject({
  owner: z.strictObject({ kind: z.literal("asset"), assetId: z.string().regex(/^[a-f0-9]{64}$/) }),
  generation: z.string().min(1).max(256),
  policy: z.literal("alignment-v1"),
});
export type AlignmentEvidenceIdentity = z.infer<typeof alignmentIdentitySchema>;
export const alignmentCapturedMetadataSchema = alignmentIdentitySchema.extend({
  source: alignmentEvidenceSourceSchema,
  nativeReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  correspondenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.literal(false),
});
export type AlignmentCapturedMetadata = z.infer<typeof alignmentCapturedMetadataSchema>;
export const alignmentEvidenceMetadataSchema = alignmentCapturedMetadataSchema
  .omit({ verified: true })
  .extend({
    wordCount: z.int().nonnegative().max(1024),
    acousticCount: z.int().positive().max(2500),
    scoreCount: z.int().positive().max(313),
    matrixSha256: z.string().regex(/^[a-f0-9]{64}$/),
    observedLowerDecileRMS: z.number().finite().nonnegative(),
    conditionalStatus: z.enum(["forced_path_observation", "refused"]),
    correspondenceOptimum: z.int().nonnegative().max(512),
    lexicalIdentity: z.literal("unknown"),
    scoreMeaning: z.literal("uncalibrated"),
  });
export type AlignmentEvidenceMetadata = z.infer<typeof alignmentEvidenceMetadataSchema>;
export const alignmentGenerationResource = (
  identity: Pick<AlignmentEvidenceIdentity, "owner" | "generation">,
) => JSON.stringify([identity.owner.kind, identity.owner.assetId, identity.generation]);
const key = (v: AlignmentEvidenceIdentity) => [v.owner.assetId, v.generation, v.policy];
const where = "ownerId=? AND generation=? AND policy=?";
type Generation = {
  metadata: string;
  nativeReceipt: string;
  report: string;
  correspondence: string;
  complete: number;
};
const summary = (rows: ReturnType<typeof alignmentOperandRows>) => ({
  wordCount: rows.words.length,
  acousticCount: rows.acoustic.length,
  scoreCount: rows.scores.length,
  matrixSha256: rows.matrixSha256,
  observedLowerDecileRMS: rows.observedLowerDecileRMS,
  conditionalStatus: rows.conditionalStatus,
  correspondenceOptimum: rows.correspondenceOptimum,
  lexicalIdentity: "unknown" as const,
  scoreMeaning: "uncalibrated" as const,
});
type AlignmentRow = AlignmentWord | AlignmentAcoustic | AlignmentScore;
function pageArguments(after: number, limit: number) {
  if (
    !Number.isSafeInteger(after) ||
    after < -1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new CatalogError("INVALID_PARAMS", "Invalid alignment evidence page");
}
function boundedPage(
  metadata: AlignmentEvidenceMetadata,
  rows: { sequence: number; content: string }[],
  limit: number,
) {
  let bytes = 0;
  const selected: typeof rows = [];
  for (const row of rows) {
    const next = Buffer.byteLength(row.content);
    if (selected.length && (selected.length >= limit || bytes + next > 192 * 1024)) break;
    bytes += next;
    selected.push(row);
  }
  return {
    metadata,
    rows: selected.map((v) => JSON.parse(v.content) as AlignmentRow),
    nextSequence: selected.length < rows.length ? selected.at(-1)!.sequence : null,
  };
}
function rawPage(operands: AlignmentOperands, operand: keyof AlignmentOperands, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 32768 !== 0)
    throw new CatalogError("INVALID_PARAMS", "Invalid alignment operand offset");
  const bytes = Buffer.from(operands[operand]);
  if (offset > bytes.length)
    throw new CatalogError("INVALID_PARAMS", "Alignment operand offset exceeds retained bytes");
  const end = Math.min(offset + 32768, bytes.length);
  return {
    bytesBase64: bytes.subarray(offset, end).toString("base64"),
    offset,
    totalBytes: bytes.length,
    sha256: alignmentDigest(bytes),
    nextOffset: end < bytes.length ? end : null,
  };
}
/** Immutable package reads share admission, row identity and delivery budgets with the catalog. */
export function alignmentOperandRecords(
  input: AlignmentEvidenceMetadata,
  operands: AlignmentOperands,
) {
  const metadata = alignmentEvidenceMetadataSchema.parse(input),
    rows = alignmentOperandRows(metadata.source, operands);
  for (const operand of ["nativeReceipt", "report", "correspondence"] as const)
    if (alignmentDigest(operands[operand]) !== metadata[`${operand}Sha256`])
      throw new CatalogError("INVALID_PACKAGE", "Alignment operands differ from retained metadata");
  const parsedSummary = summary(rows);
  if (
    !isDeepStrictEqual(
      parsedSummary,
      Object.fromEntries(
        Object.keys(parsedSummary).map((key) => [key, metadata[key as keyof typeof metadata]]),
      ),
    )
  )
    throw new CatalogError("INVALID_PACKAGE", "Alignment metadata differs from complete operands");
  const bind = (identity: AlignmentEvidenceIdentity) => {
    if (
      !isDeepStrictEqual(
        alignmentIdentitySchema.strip().parse(identity),
        alignmentIdentitySchema.strip().parse(metadata),
      )
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Alignment generation changed");
  };
  return {
    page(
      identity: AlignmentEvidenceIdentity,
      kind: "words" | "acoustic" | "scores",
      after: number,
      limit: number,
    ) {
      bind(identity);
      pageArguments(after, limit);
      return boundedPage(
        metadata,
        rows[kind].slice(after + 1, after + limit + 2).map((content, index) => ({
          sequence: after + 1 + index,
          content: JSON.stringify(content),
        })),
        limit,
      );
    },
    rawPage(identity: AlignmentEvidenceIdentity, operand: keyof AlignmentOperands, offset: number) {
      bind(identity);
      return rawPage(operands, operand, offset);
    },
  };
}
const descriptorSchema = alignmentEvidenceSourceSchema.omit({ pcm: true, decoder: true });
const descriptorExpression = "json_remove(json_extract(metadata,'$.source'),'$.pcm','$.decoder')";
export function assetAlignmentOwner(
  assets: Pick<AssetStore, "get" | "path">,
  acquisitions: { get(id: string): Pick<ReturnType<AcquisitionStore["get"]>, "id" | "bindings"> },
) {
  return (identity: AlignmentEvidenceIdentity, source: AlignmentEvidenceSource) => {
    const selected = selectAlignmentSource(assets, acquisitions, {
      assetId: identity.owner.assetId,
      streamId: source.streamId,
      ...(source.acquisitionId === null ? {} : { acquisitionId: source.acquisitionId }),
      channel: source.channel,
      sourceRange: source.observationRange,
      text: source.text,
      modelId: source.engine.modelId,
    });
    if (
      selected.supportDigest !== source.supportDigest ||
      !isDeepStrictEqual(selected.originUs, source.originUs) ||
      !isDeepStrictEqual(selected.durationUs, source.durationUs) ||
      !isDeepStrictEqual(selected.expectedPCM, {
        sampleRate: source.pcm.sampleRate,
        frames: source.pcm.frames,
      })
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Alignment source support or clock changed");
  };
}
/** One immutable evidence owner. The existing queue's settlement owns readiness. */
export class AlignmentEvidenceStore {
  private readonly references: ResourceReferences;
  constructor(
    private readonly store: Catalog,
    private readonly validateOwner: (
      identity: AlignmentEvidenceIdentity,
      source: AlignmentEvidenceSource,
    ) => void,
  ) {
    this.references = new ResourceReferences(store);
    store.catalog
      .exec(`CREATE TABLE IF NOT EXISTS alignment_evidence_generations (ownerId TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,metadata TEXT NOT NULL,nativeReceipt TEXT NOT NULL,report TEXT NOT NULL,correspondence TEXT NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(ownerId,generation,policy)) STRICT;
    CREATE TABLE IF NOT EXISTS alignment_evidence_records (ownerId TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,kind TEXT NOT NULL,sequence INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(ownerId,generation,policy,kind,sequence)) STRICT;
    CREATE INDEX IF NOT EXISTS alignment_evidence_observation ON alignment_evidence_generations(ownerId,${descriptorExpression}) WHERE complete=1;`);
  }
  capture(
    input: AlignmentEvidenceIdentity,
    inputSource: AlignmentEvidenceSource,
    operands: AlignmentOperands,
    jobId?: string,
  ) {
    return this.captureWithOwner(input, inputSource, operands, jobId, this.validateOwner);
  }
  private captureWithOwner(
    input: AlignmentEvidenceIdentity,
    inputSource: AlignmentEvidenceSource,
    operands: AlignmentOperands,
    jobId: string | undefined,
    validateOwner: typeof this.validateOwner,
  ) {
    const identity = alignmentIdentitySchema.parse(input),
      source = alignmentEvidenceSourceSchema.parse(inputSource);
    validateOwner(identity, source);
    for (const value of [operands.nativeReceipt, operands.report, operands.correspondence])
      if (Buffer.byteLength(value) > alignmentOperandByteLimit)
        throw new CatalogError("INVALID_EVIDENCE", "Alignment operand exceeds the byte limit");
    const captured = {
      ...identity,
      source,
      nativeReceiptSha256: alignmentDigest(operands.nativeReceipt),
      reportSha256: alignmentDigest(operands.report),
      correspondenceSha256: alignmentDigest(operands.correspondence),
    };
    let owned = false;
    this.store.transaction(() => {
      const row = this.row(identity);
      if (row) {
        if (
          !isDeepStrictEqual(JSON.parse(row.metadata).source, source) ||
          row.nativeReceipt !== operands.nativeReceipt ||
          row.report !== operands.report ||
          row.correspondence !== operands.correspondence
        )
          throw new CatalogError("INVALID_EVIDENCE", "Retained alignment generation conflicts");
        return;
      }
      this.store.catalog
        .prepare("INSERT INTO alignment_evidence_generations VALUES(?,?,?,?,?,?,?,0)")
        .run(
          ...key(identity),
          JSON.stringify(captured),
          operands.nativeReceipt,
          operands.report,
          operands.correspondence,
        );
      if (jobId) {
        const owner = { kind: "job" as const, id: jobId };
        this.references.release("alignment-generation", owner);
        this.references.retain("alignment-generation", owner, [
          alignmentGenerationResource(identity),
        ]);
      }
      owned = true;
    });
    return { identity, source, captured, owned };
  }
  stage(
    input: AlignmentEvidenceIdentity,
    source: AlignmentEvidenceSource,
    operands: AlignmentOperands,
    jobId?: string,
  ) {
    return this.stageWithOwner(input, source, operands, jobId, this.validateOwner);
  }
  stagePortable(
    metadata: AlignmentEvidenceMetadata,
    operands: AlignmentOperands,
    validateOwner: typeof this.validateOwner,
  ) {
    alignmentOperandRecords(metadata, operands);
    return this.stageWithOwner(
      alignmentIdentitySchema.strip().parse(metadata),
      metadata.source,
      operands,
      undefined,
      validateOwner,
    );
  }
  private stageWithOwner(
    input: AlignmentEvidenceIdentity,
    source: AlignmentEvidenceSource,
    operands: AlignmentOperands,
    jobId: string | undefined,
    validateOwner: typeof this.validateOwner,
  ) {
    const { identity, captured, owned } = this.captureWithOwner(
      input,
      source,
      operands,
      jobId,
      validateOwner,
    );
    if (!owned && this.row(identity)?.complete !== 1)
      throw new CatalogError("PROCESSING_BUSY", "Alignment generation is being prepared", {});
    let rows: ReturnType<typeof alignmentOperandRows>;
    try {
      rows = alignmentOperandRows(source, operands);
    } catch (error) {
      if (error instanceof CatalogError)
        Object.assign(error.details, {
          generation: identity.generation,
          nativeReceiptSha256: captured.nativeReceiptSha256,
          reportSha256: captured.reportSha256,
          correspondenceSha256: captured.correspondenceSha256,
          verified: false,
        });
      throw error;
    }
    const metadata: AlignmentEvidenceMetadata = {
      ...captured,
      ...summary(rows),
    };
    const content = JSON.stringify(metadata);
    if (owned)
      this.store.transaction(() => {
        const insert = this.store.catalog.prepare(
          "INSERT INTO alignment_evidence_records VALUES(?,?,?,?,?,?)",
        );
        for (const [kind, records] of [
          ["words", rows.words],
          ["acoustic", rows.acoustic],
          ["scores", rows.scores],
        ] as const)
          for (const [ordinal, record] of records.entries())
            insert.run(...key(identity), kind, ordinal, JSON.stringify(record));
        this.store.catalog
          .prepare(`UPDATE alignment_evidence_generations SET metadata=? WHERE ${where}`)
          .run(content, ...key(identity));
      });
    return {
      metadata,
      publish: () => {
        if (this.row(identity)?.metadata !== content)
          throw new CatalogError(
            "ARTIFACT_CHANGED",
            "Staged alignment generation is no longer retained",
          );
        this.validateOwner(identity, source);
        this.store.catalog
          .prepare(`UPDATE alignment_evidence_generations SET complete=1 WHERE ${where}`)
          .run(...key(identity));
        return undefined;
      },
      close: async () => {
        if (owned && this.row(identity)?.complete !== 1) {
          if (jobId) this.references.release("alignment-generation", { kind: "job", id: jobId });
          this.remove(identity);
        }
      },
    };
  }
  latestObservation(assetId: string, descriptor: z.infer<typeof descriptorSchema>) {
    const row = this.store.catalog
      .prepare(
        `SELECT metadata FROM alignment_evidence_generations WHERE ownerId=? AND ${descriptorExpression}=? AND complete=1 ORDER BY rowid DESC LIMIT 1`,
      )
      .get(assetId, JSON.stringify(descriptorSchema.parse(descriptor))) as
      | { metadata: string }
      | undefined;
    if (!row) return null;
    const metadata = alignmentEvidenceMetadataSchema.parse(JSON.parse(row.metadata));
    this.validateOwner(metadata, metadata.source);
    return metadata;
  }
  metadata(input: AlignmentEvidenceIdentity): AlignmentEvidenceMetadata {
    const identity = alignmentIdentitySchema.strip().parse(input),
      row = this.row(identity);
    if (!row || row.complete !== 1)
      throw new CatalogError("NOT_READY", "Alignment evidence is not ready", {});
    const metadata = alignmentEvidenceMetadataSchema.parse(JSON.parse(row.metadata));
    this.validateOwner(metadata, metadata.source);
    return metadata;
  }
  capturedMetadata(identity: AlignmentEvidenceIdentity): AlignmentCapturedMetadata {
    const row = this.row(alignmentIdentitySchema.strip().parse(identity));
    if (!row) throw new CatalogError("NOT_FOUND", "Alignment operands are not retained");
    const metadata = alignmentCapturedMetadataSchema
      .strip()
      .parse({ ...JSON.parse(row.metadata), verified: false });
    this.validateOwner(metadata, metadata.source);
    return metadata;
  }
  capturedOperands(identity: AlignmentEvidenceIdentity): AlignmentOperands {
    const row = this.row(alignmentIdentitySchema.strip().parse(identity));
    if (!row) throw new CatalogError("NOT_FOUND", "Alignment operands are not retained");
    return {
      nativeReceipt: row.nativeReceipt,
      report: row.report,
      correspondence: row.correspondence,
    };
  }
  operands(identity: AlignmentEvidenceIdentity) {
    this.metadata(identity);
    return this.capturedOperands(identity);
  }
  page(
    identity: AlignmentEvidenceIdentity,
    kind: "words" | "acoustic" | "scores",
    after: number,
    limit: number,
  ) {
    const metadata = this.metadata(identity);
    pageArguments(after, limit);
    const rows = this.store.catalog
      .prepare(
        `SELECT sequence,content FROM alignment_evidence_records WHERE ${where} AND kind=? AND sequence>? ORDER BY sequence LIMIT ?`,
      )
      .all(...key(identity), kind, after, limit + 1) as { sequence: number; content: string }[];
    return boundedPage(metadata, rows, limit);
  }
  rawPage(identity: AlignmentEvidenceIdentity, operand: keyof AlignmentOperands, offset: number) {
    this.capturedMetadata(identity);
    return rawPage(this.capturedOperands(identity), operand, offset);
  }
  *portableGenerations(assetId: string) {
    for (const row of this.store.catalog
      .prepare(
        "SELECT rowid AS sequence,metadata FROM alignment_evidence_generations WHERE ownerId=? AND complete=1 ORDER BY rowid",
      )
      .iterate(assetId)) {
      const { sequence, metadata } = row as { sequence: number; metadata: string };
      const parsed = alignmentEvidenceMetadataSchema.parse(JSON.parse(metadata));
      this.validateOwner(parsed, parsed.source);
      yield { sequence, metadata: parsed };
    }
  }
  remove(identity: AlignmentEvidenceIdentity) {
    this.store.transaction(() => {
      this.store.catalog
        .prepare(`DELETE FROM alignment_evidence_records WHERE ${where}`)
        .run(...key(identity));
      this.store.catalog
        .prepare(`DELETE FROM alignment_evidence_generations WHERE ${where}`)
        .run(...key(identity));
    });
  }
  async reclaim(assetId: string, keep: (generation: string) => boolean, signal?: AbortSignal) {
    let cursor = 0;
    for (;;) {
      signal?.throwIfAborted();
      const rows = this.store.catalog
        .prepare(
          "SELECT rowid AS cursor,generation,policy FROM alignment_evidence_generations WHERE ownerId=? AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(assetId, cursor) as { cursor: number; generation: string; policy: "alignment-v1" }[];
      for (const row of rows) {
        signal?.throwIfAborted();
        const identity = {
          owner: { kind: "asset" as const, assetId },
          generation: row.generation,
          policy: row.policy,
        };
        if (
          !keep(row.generation) &&
          !this.references.has("alignment-generation", alignmentGenerationResource(identity))
        )
          this.remove(identity);
        cursor = row.cursor;
        await setImmediate();
      }
      if (rows.length < 100) return;
    }
  }
  private row(identity: AlignmentEvidenceIdentity) {
    return this.store.catalog
      .prepare(
        `SELECT metadata,nativeReceipt,report,correspondence,complete FROM alignment_evidence_generations WHERE ${where}`,
      )
      .get(...key(identity)) as Generation | undefined;
  }
}
