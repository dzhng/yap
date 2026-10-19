import {
  signedTimeValueSchema,
  timeValueSchema,
  toSignedTime,
  subtract,
  ceil,
  type SignedTimeValue,
  type TimeValue,
  omit,
} from "@yap/composition";
import { z } from "zod";
import { ResourceReferences } from "./references.js";
import { isDeepStrictEqual } from "node:util";
import { ownerIdentity, type Owner } from "./jobs.js";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import { selectSource } from "./source-selection.js";
import { setImmediate } from "node:timers/promises";
import type { CaptureStore } from "./capture-store.js";
import { CatalogError, type Catalog } from "./catalog.js";
import {
  scenePolicy,
  sceneSampleTimes,
  type SourceSceneAnalysis,
  type VisualComparison,
} from "./scenes.js";

import { normalizeSourceSceneChunk, type SourceSceneChunk } from "./source-scene-chunks.js";
import { sourceScenePolicy, sceneSampleSourceTime } from "./source-scenes.js";
import { compare, fromTime } from "@yap/composition";
import type { TimeRange } from "./presentation-time.js";

export type SceneOwner = Owner<"recording" | "asset">;
export type SceneEvidenceIdentity = {
  owner: SceneOwner;
  sourceId: string;
  generation: string;
  policy: string;
};
/** Scene generations belong to an owner even when test/provider generation names coincide. */
export function sceneGenerationResource(
  identity: Pick<SceneEvidenceIdentity, "owner" | "generation">,
): string {
  return JSON.stringify([...ownerIdentity(identity.owner), identity.generation]);
}
export type SceneSource =
  | { kind: "recording"; durationUs: number }
  | {
      kind: "asset";
      durationUs: TimeValue;
      streamId: string;
      acquisitionId?: string;
      supportDigest: string;
      originUs: SignedTimeValue;
    };
export type RecordingSceneEvidenceIdentity = {
  recordingId: string;
  sourceId: string;
  generation: string;
  policy: string;
};
export type SceneChunkReport = Awaited<ReturnType<SourceSceneAnalysis["analyze"]>>;
type SceneDetails = {
  sourceWidth: number;
  sourceHeight: number;
  chunkCount: number;
  comparisonCount: number;
  boundaryCount: number;
};
export type SceneEvidenceMetadata = SceneEvidenceIdentity & SceneDetails & { source: SceneSource };
const portableCount = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const portableSceneMetadataSchema = z
  .strictObject({
    owner: z.strictObject({
      kind: z.literal("asset"),
      id: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    sourceId: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.string().min(1).max(256),
    policy: z.literal(sourceScenePolicy),
    source: z
      .strictObject({
        kind: z.literal("asset"),
        streamId: z.string().min(1).max(256),
        acquisitionId: z.uuid().optional(),
        supportDigest: z.string().min(1).max(256),
        originUs: signedTimeValueSchema,
        durationUs: timeValueSchema,
      })
      .transform(({ acquisitionId, ...source }) => ({
        ...source,
        ...(acquisitionId === undefined ? {} : { acquisitionId }),
      })),
    sourceWidth: portableCount.positive(),
    sourceHeight: portableCount.positive(),
    chunkCount: portableCount.positive(),
    comparisonCount: portableCount,
    boundaryCount: portableCount,
  })
  .refine(
    (value) => value.sourceId === value.owner.id,
    "Scene source identity differs from its owner",
  );
export type PortableSceneMetadata = z.infer<typeof portableSceneMetadataSchema>;
export type RecordingSceneEvidenceMetadata = RecordingSceneEvidenceIdentity &
  SceneDetails & { durationUs: number };
export function recordingSceneIdentity({
  recordingId,
  sourceId,
  generation,
  policy,
}: RecordingSceneEvidenceIdentity): SceneEvidenceIdentity {
  return { sourceId, generation, policy, owner: { kind: "recording", id: recordingId } };
}
export function recordingSceneMetadata({
  owner,
  source,
  ...metadata
}: SceneEvidenceMetadata): RecordingSceneEvidenceMetadata {
  if (owner.kind !== "recording" || source.kind !== "recording")
    invalid("Recording scene view requires a recording source");
  return { ...metadata, recordingId: owner.id, durationUs: source.durationUs };
}
export function recordingSceneOwner(store: CaptureStore) {
  return (identity: SceneEvidenceIdentity, source: SceneSource): void => {
    if (identity.owner.kind !== "recording" || source.kind !== "recording")
      invalid("Scene identity requires a recording source");
    const recording = store.get(identity.owner.id);
    if (
      recording.state === "canceled" ||
      recording.sourceId !== identity.sourceId ||
      recording.sourceDurationUs !== source.durationUs
    )
      invalid("Scene evidence identity does not match its source");
  };
}
export function sourceSceneDescriptor(
  selected: Pick<ReturnType<typeof selectSource>, "selection" | "supportDigest" | "durationUs"> & {
    track: Pick<ReturnType<typeof selectSource>["track"], "sourceOffsetUs">;
  },
): Extract<SceneSource, { kind: "asset" }> {
  return {
    kind: "asset",
    streamId: selected.selection.streamId,
    ...(selected.selection.acquisitionId === undefined
      ? {}
      : { acquisitionId: selected.selection.acquisitionId }),
    originUs: toSignedTime(subtract(fromTime(0), fromTime(selected.track.sourceOffsetUs))),
    supportDigest: selected.supportDigest,
    durationUs: selected.durationUs,
  };
}
export function assetSceneOwner(assets: AssetStore, acquisitions: AcquisitionStore) {
  return (identity: SceneEvidenceIdentity, source: SceneSource): void => {
    if (
      identity.owner.kind !== "asset" ||
      source.kind !== "asset" ||
      identity.sourceId !== identity.owner.id
    )
      invalid("Scene identity requires an asset source");
    const selected = selectSource(assets, acquisitions, {
      assetId: identity.owner.id,
      streamId: source.streamId,
      ...(source.acquisitionId === undefined ? {} : { acquisitionId: source.acquisitionId }),
    });
    if (selected.stream.kind !== "video") invalid("Scene evidence requires a video stream");
    if (!isDeepStrictEqual(source, sourceSceneDescriptor(selected)))
      throw new CatalogError("ARTIFACT_CHANGED", "Scene source support changed");
  };
}
type Generation = SceneDetails & {
  ownerKind: SceneOwner["kind"];
  ownerId: string;
  sourceId: string;
  generation: string;
  policy: string;
  source: string;
  durationUs: number;
  throughUs: number;
  complete: number;
  lastComparison: string | null;
  sourceState: string | null;
};
const where = "ownerKind=? AND ownerId=? AND sourceId=? AND generation=? AND policy=?";
const key = (identity: SceneEvidenceIdentity) => [
  ...ownerIdentity(identity.owner),
  identity.sourceId,
  identity.generation,
  identity.policy,
];
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
function metadata(row: Generation): SceneEvidenceMetadata {
  const { ownerKind, ownerId, source, ...details } = omit(
    row,
    "durationUs",
    "throughUs",
    "complete",
    "lastComparison",
    "sourceState",
  );
  const owner: SceneOwner =
    ownerKind === "recording" ? { kind: "recording", id: ownerId } : { kind: "asset", id: ownerId };
  return { ...details, owner, source: JSON.parse(source) };
}
/** Scene resets are the boundary comparisons; chunks do not store a second copy. */
export function sceneBoundaries(chunk: Pick<SceneChunkReport, "comparisons">) {
  return chunk.comparisons
    .filter((pair) => pair.boundary)
    .map((pair) => ({ kind: "scene" as const, atSourceUs: pair.actualSourceUs }));
}

/** Canonical chunk semantics shared by append and portable payload reads. */
export function normalizeSceneChunk(
  report: SceneChunkReport,
  durationUs: number,
  previous?: VisualComparison,
) {
  if (
    report.kept.startUs !== 0 ||
    report.kept.endUs !== durationUs ||
    !integer(report.sourceWidth) ||
    report.sourceWidth < 1 ||
    !integer(report.sourceHeight) ||
    report.sourceHeight < 1
  )
    invalid("Scene evidence requires canonical source bounds and dimensions");
  const times = sceneSampleTimes(report.range, report.kept);
  if (report.coverage.length !== times.length || report.comparisons.length > 51)
    invalid("Incomplete scene coverage");
  for (const [i, point] of report.coverage.entries()) {
    if (
      point.requestedSourceUs !== times[i] ||
      !integer(point.actualSourceUs) ||
      point.actualSourceUs >= durationUs ||
      !integer(point.stillnessRunStartUs) ||
      point.stillnessRunStartUs > point.actualSourceUs ||
      point.distanceUs !== Math.abs(point.requestedSourceUs - point.actualSourceUs) ||
      !integer(point.width) ||
      point.width < 1 ||
      point.width > 64 ||
      !integer(point.height) ||
      point.height < 1 ||
      point.height > 64 ||
      (i > 0 && point.actualSourceUs < report.coverage[i - 1]!.actualSourceUs)
    )
      invalid("Invalid scene coverage");
  }
  let last = previous;
  const comparisons: VisualComparison[] = [];
  for (const pair of report.comparisons) {
    if (
      !integer(pair.previousActualSourceUs) ||
      !integer(pair.actualSourceUs) ||
      pair.previousActualSourceUs >= pair.actualSourceUs ||
      pair.actualSourceUs >= durationUs ||
      typeof pair.boundary !== "boolean" ||
      ![
        pair.changedPixelFraction,
        pair.changedCellFraction,
        pair.meanAbsoluteChannelDifference,
      ].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
    )
      invalid("Invalid scene comparison");
    if (last && pair.actualSourceUs <= last.actualSourceUs) {
      if (JSON.stringify(pair) !== JSON.stringify(last))
        invalid("Scene comparison moved backwards or changed");
      continue;
    }
    comparisons.push(pair);
    last = pair;
  }
  const chunk: SceneChunkReport = {
    policy: report.policy,
    range: report.range,
    kept: report.kept,
    sourceWidth: report.sourceWidth,
    sourceHeight: report.sourceHeight,
    coverage: report.coverage,
    comparisons,
  };
  if (Buffer.byteLength(JSON.stringify(chunk)) > 65_536)
    invalid("Scene chunk exceeds bounded storage");
  return { chunk, last };
}

export type SceneBoundary = {
  ordinal: number;
  actualSourceUs: number;
  sample: (import("./source-scenes.js").SceneSampleClock & { originUs: SignedTimeValue }) | null;
};
export type SceneBoundaryCursor = Pick<SceneBoundary, "ordinal" | "actualSourceUs">;
type ScenePageRequest = { identity: SceneEvidenceIdentity; afterStartUs?: number; limit?: number };

export abstract class SceneEvidenceReader {
  protected abstract readMetadata(identity: SceneEvidenceIdentity): SceneEvidenceMetadata;
  protected abstract readChunks(
    identity: SceneEvidenceIdentity,
    afterStartUs: number,
    limit: number,
  ): (SceneChunkReport | SourceSceneChunk)[];
  page(request: ScenePageRequest) {
    return this.chunkPage<SceneChunkReport>(request, "recording");
  }
  sourcePage(request: ScenePageRequest) {
    return this.chunkPage<SourceSceneChunk>(request, "asset");
  }
  protected chunkPage<T extends SceneChunkReport | SourceSceneChunk>(
    { identity, afterStartUs, limit = 100 }: ScenePageRequest,
    kind: SceneSource["kind"],
    stagedMetadata?: SceneEvidenceMetadata,
  ): { metadata: SceneEvidenceMetadata; chunks: T[]; nextStartUs: number | null } {
    if (
      !integer(limit) ||
      limit < 1 ||
      limit > 100 ||
      (afterStartUs !== undefined && !integer(afterStartUs))
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid scene page limit or cursor");
    const metadata = stagedMetadata ?? this.readMetadata(identity);
    if (metadata.source.kind !== kind)
      invalid(`Scene page requires a ${kind === "recording" ? "recording" : "asset"} source`);
    const rows = this.readChunks(identity, afterStartUs ?? -1, limit + 1);
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      metadata,
      chunks: rows as T[],
      nextStartUs: more ? rows.at(-1)!.range.startUs : null,
    };
  }
}

/** Retained analysis lives in the catalog; queue readiness remains the publication authority. */
export class SceneEvidenceStore extends SceneEvidenceReader {
  private readonly references: ResourceReferences;
  constructor(
    private readonly store: Catalog,
    private readonly validateOwner: (identity: SceneEvidenceIdentity, source: SceneSource) => void,
  ) {
    super();
    this.references = new ResourceReferences(store);
    store.catalog.exec(`CREATE TABLE IF NOT EXISTS scene_evidence_generations (
   ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,
   source TEXT NOT NULL,durationUs INTEGER NOT NULL,sourceWidth INTEGER NOT NULL,sourceHeight INTEGER NOT NULL,
   throughUs INTEGER NOT NULL,chunkCount INTEGER NOT NULL,comparisonCount INTEGER NOT NULL,
   boundaryCount INTEGER NOT NULL,lastComparison TEXT,sourceState TEXT,complete INTEGER NOT NULL,
   PRIMARY KEY(ownerKind,ownerId,sourceId,generation,policy)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS scene_evidence_chunks (
   ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,
   startUs INTEGER NOT NULL,content TEXT NOT NULL,
   PRIMARY KEY(ownerKind,ownerId,sourceId,generation,policy,startUs)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS scene_evidence_boundaries (
   ownerKind TEXT NOT NULL,ownerId TEXT NOT NULL,sourceId TEXT NOT NULL,generation TEXT NOT NULL,policy TEXT NOT NULL,
   actualSourceUs INTEGER NOT NULL,ordinal INTEGER NOT NULL,content TEXT NOT NULL,
   PRIMARY KEY(ownerKind,ownerId,sourceId,generation,policy,actualSourceUs,ordinal)
  ) STRICT;`);
  }
  /** Exclusive startup recovery includes staged owners whose asset transaction never committed. */
  async recoverPending(ownerKind: SceneOwner["kind"], signal: AbortSignal): Promise<void> {
    let cursor = 0;
    for (;;) {
      signal.throwIfAborted();
      const rows = this.store.catalog
        .prepare(
          "SELECT rowid AS cursor,ownerKind,ownerId,sourceId,generation,policy,complete FROM scene_evidence_generations WHERE ownerKind=? AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(ownerKind, cursor) as (Pick<
        Generation,
        "ownerKind" | "ownerId" | "sourceId" | "generation" | "policy" | "complete"
      > & { cursor: number })[];
      for (const row of rows) {
        signal.throwIfAborted();
        if (row.complete !== 1) {
          const owner: SceneOwner =
            row.ownerKind === "asset"
              ? { kind: "asset", id: row.ownerId }
              : { kind: "recording", id: row.ownerId };
          await this.remove({
            owner,
            sourceId: row.sourceId,
            generation: row.generation,
            policy: row.policy,
          });
        }
        cursor = row.cursor;
      }
      if (rows.length < 100) return;
      await setImmediate(undefined, { signal });
    }
  }
  portableGenerations(assetId: string, limit = 25_000): PortableSceneMetadata[] {
    const rows = this.store.catalog
      .prepare(
        "SELECT * FROM scene_evidence_generations WHERE ownerKind='asset' AND ownerId=? ORDER BY generation,sourceId,policy LIMIT ?",
      )
      .all(assetId, limit + 1) as Generation[];
    if (rows.length > limit)
      throw new CatalogError("LIMIT_EXCEEDED", "Scene dependency inventory exceeds its limit");
    return rows.map((row) => {
      if (row.complete !== 1)
        throw new CatalogError("PROCESSING_BUSY", "Scene generation is incomplete", {});
      return portableSceneMetadataSchema.parse(metadata(row));
    });
  }
  async stagePortable(value: unknown, chunks: AsyncIterable<unknown>, signal: AbortSignal) {
    const expected = portableSceneMetadataSchema.parse(value),
      existing = this.get(expected);
    if (existing && existing.complete !== 1)
      throw new CatalogError("PROCESSING_BUSY", "Scene generation is already being prepared", {});
    if (existing && !isDeepStrictEqual(metadata(existing), expected))
      invalid("Retained scene metadata conflicts with package");
    let owned = false,
      count = 0,
      throughUs = 0;
    const close = async () => {
      if (owned && this.get(expected)?.complete !== 1) await this.remove(expected);
    };
    try {
      for await (const value of chunks) {
        signal.throwIfAborted();
        if (!value || typeof value !== "object") invalid("Invalid portable scene chunk");
        const chunk = value as SourceSceneChunk;
        if (
          chunk.range?.startUs !== throughUs ||
          !integer(chunk.range?.endUs) ||
          chunk.range.endUs <= throughUs
        )
          invalid("Portable scene chunks require contiguous coverage");
        throughUs = chunk.range.endUs;
        if (++count > expected.chunkCount) invalid("Scene chunk inventory exceeds metadata");
        if (existing) {
          const row = this.store.catalog
            .prepare(`SELECT content FROM scene_evidence_chunks WHERE ${where} AND startUs=?`)
            .get(...key(expected), chunk?.range?.startUs);
          if (!row || !isDeepStrictEqual(JSON.parse(row.content as string), chunk))
            invalid("Retained scene content conflicts with package");
        } else {
          this.store.transaction(() => this.appendChunk(expected, expected.source, chunk));
          owned = true;
        }
        await setImmediate(undefined, { signal });
      }
      signal.throwIfAborted();
      const ready = this.get(expected);
      if (
        !ready ||
        ready.throughUs !== ceil(fromTime(expected.source.durationUs)) ||
        count !== expected.chunkCount ||
        !isDeepStrictEqual(metadata(ready), expected)
      )
        invalid("Scene inventory is incomplete or differs from metadata");
      const stagedMetadata = (identity: SceneEvidenceIdentity) => {
        if (!isDeepStrictEqual(key(identity), key(expected)))
          invalid("Staged scene read names another generation");
        const row = this.get(expected);
        if (!row || row.complete === -1 || !isDeepStrictEqual(metadata(row), expected))
          invalid("Staged scene evidence is no longer retained");
        return expected;
      };
      return {
        close,
        read: {
          metadata: stagedMetadata,
          sourcePage: (request: ScenePageRequest) =>
            this.chunkPage<SourceSceneChunk>(request, "asset", stagedMetadata(request.identity)),
          sourceWindowPage: (request: Parameters<SceneEvidenceStore["sourceWindowPage"]>[0]) =>
            this.sourceWindow(request, stagedMetadata(request.identity)),
        },
        publish: () => {
          signal.throwIfAborted();
          this.validateOwner(expected, expected.source);
          this.store.catalog
            .prepare(`UPDATE scene_evidence_generations SET complete=1 WHERE ${where}`)
            .run(...key(expected));
        },
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
  private get(identity: SceneEvidenceIdentity): Generation | undefined {
    return this.store.catalog
      .prepare(`SELECT * FROM scene_evidence_generations WHERE ${where}`)
      .get(...key(identity)) as Generation | undefined;
  }
  append(
    identity: SceneEvidenceIdentity,
    source: SceneSource,
    report: SceneChunkReport | SourceSceneChunk,
  ): void {
    this.store.transaction(() => {
      this.validateOwner(identity, source);
      this.appendChunk(identity, source, report);
    });
  }
  private appendChunk(
    identity: SceneEvidenceIdentity,
    source: SceneSource,
    report: SceneChunkReport | SourceSceneChunk,
  ): void {
    // Integer coverage bounds the query grid; the source descriptor retains physical duration.
    const durationUs = ceil(fromTime(source.durationUs));
    if (
      !integer(durationUs) ||
      durationUs < 1 ||
      !identity.generation ||
      !identity.policy ||
      report.policy !== identity.policy
    )
      invalid("Scene evidence identity does not match its source");
    const row = this.get(identity);
    if (row?.complete || report.range.startUs !== (row?.throughUs ?? 0))
      invalid("Scene chunks require contiguous unpublished coverage");
    if (
      row &&
      (row.sourceWidth !== report.sourceWidth ||
        row.sourceHeight !== report.sourceHeight ||
        !isDeepStrictEqual(metadata(row).source, source))
    )
      invalid("Scene source context or dimensions changed");
    if (identity.policy !== (source.kind === "asset" ? sourceScenePolicy : scenePolicy.id))
      invalid("Unsupported scene policy for source owner");
    const normalized =
      source.kind === "asset"
        ? normalizeSourceSceneChunk(
            report as SourceSceneChunk,
            identity.sourceId,
            source,
            row?.sourceState
              ? {
                  ...JSON.parse(row.sourceState),
                  ...(row.lastComparison ? { comparison: JSON.parse(row.lastComparison) } : {}),
                }
              : undefined,
          )
        : normalizeSceneChunk(
            report as SceneChunkReport,
            durationUs,
            row?.lastComparison ? JSON.parse(row.lastComparison) : undefined,
          );
    const { chunk, last } = normalized;
    const content = JSON.stringify(chunk);
    if (!row)
      this.store.catalog
        .prepare(
          `INSERT INTO scene_evidence_generations VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,NULL,NULL,0)`,
        )
        .run(
          ...key(identity),
          JSON.stringify(source),
          durationUs,
          report.sourceWidth,
          report.sourceHeight,
        );
    this.store.catalog
      .prepare("INSERT INTO scene_evidence_chunks VALUES (?,?,?,?,?,?,?)")
      .run(...key(identity), report.range.startUs, content);
    for (const [index, pair] of chunk.comparisons.entries()) {
      if (!pair.boundary) continue;
      const boundary: SceneBoundary = {
        ordinal: (row?.comparisonCount ?? 0) + index,
        actualSourceUs: pair.actualSourceUs,
        sample:
          "current" in pair && source.kind === "asset"
            ? { ...pair.current, originUs: source.originUs }
            : null,
      };
      this.store.catalog
        .prepare("INSERT INTO scene_evidence_boundaries VALUES (?,?,?,?,?,?,?,?)")
        .run(...key(identity), boundary.actualSourceUs, boundary.ordinal, JSON.stringify(boundary));
    }
    this.store.catalog
      .prepare(
        `UPDATE scene_evidence_generations SET throughUs=?,chunkCount=chunkCount+1,comparisonCount=comparisonCount+?,boundaryCount=boundaryCount+?,lastComparison=?,sourceState=? WHERE ${where}`,
      )
      .run(
        report.range.endUs,
        chunk.comparisons.length,
        chunk.comparisons.filter((pair) => pair.boundary).length,
        last ? JSON.stringify(last) : null,
        "sourceState" in normalized ? JSON.stringify(normalized.sourceState) : null,
        ...key(identity),
      );
  }
  finish(identity: SceneEvidenceIdentity): SceneEvidenceMetadata {
    return this.store.transaction(() => {
      const row = this.get(identity);
      if (!row || row.complete === -1 || row.throughUs !== row.durationUs)
        invalid("Scene coverage is incomplete");
      this.validateOwner(identity, metadata(row).source);
      this.store.catalog
        .prepare(`UPDATE scene_evidence_generations SET complete=1 WHERE ${where}`)
        .run(...key(identity));
      return metadata(row);
    });
  }
  metadata(identity: SceneEvidenceIdentity): SceneEvidenceMetadata {
    return this.readMetadata(identity);
  }
  protected readMetadata(identity: SceneEvidenceIdentity): SceneEvidenceMetadata {
    const row = this.get(identity);
    if (row?.complete !== 1) invalid("Scene evidence is not complete");
    return metadata(row);
  }
  protected readChunks(
    identity: SceneEvidenceIdentity,
    afterStartUs: number,
    limit: number,
  ): (SceneChunkReport | SourceSceneChunk)[] {
    const rows = this.store.catalog
      .prepare(
        `SELECT content FROM scene_evidence_chunks WHERE ${where} AND startUs>? ORDER BY startUs LIMIT ?`,
      )
      .all(...key(identity), afterStartUs, limit) as { content: string }[];
    return rows.map((row) => JSON.parse(row.content));
  }
  /** Include the chunk containing the window start, so stillness retains its earlier measured origin. */
  sourceWindowPage(request: {
    identity: SceneEvidenceIdentity;
    range: TimeRange;
    afterStartUs?: number;
    limit?: number;
  }) {
    return this.sourceWindow(request, this.readMetadata(request.identity));
  }
  private sourceWindow(
    {
      identity,
      range,
      afterStartUs,
      limit = 1,
    }: Parameters<SceneEvidenceStore["sourceWindowPage"]>[0],
    metadata: SceneEvidenceMetadata,
  ) {
    if (metadata.source.kind !== "asset") invalid("Scene coverage requires an asset source");
    if (
      !integer(range.startUs) ||
      !integer(range.endUs) ||
      range.startUs >= range.endUs ||
      range.endUs > ceil(fromTime(metadata.source.durationUs)) ||
      !integer(limit) ||
      limit < 1 ||
      limit > 100 ||
      (afterStartUs !== undefined && (!integer(afterStartUs) || afterStartUs >= range.endUs))
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid scene coverage window");
    const first = this.store.catalog
      .prepare(
        `SELECT startUs FROM scene_evidence_chunks WHERE ${where} AND startUs<=? ORDER BY startUs DESC LIMIT 1`,
      )
      .get(...key(identity), range.startUs) as { startUs: number };
    const lower = Math.max(first.startUs, afterStartUs === undefined ? 0 : afterStartUs + 1);
    const rows = this.store.catalog
      .prepare(
        `SELECT content FROM scene_evidence_chunks WHERE ${where} AND startUs>=? AND startUs<? ORDER BY startUs LIMIT ?`,
      )
      .all(...key(identity), lower, range.endUs, limit + 1) as { content: string }[];
    const more = rows.length > limit;
    if (more) rows.pop();
    const chunks = rows.map((row) => JSON.parse(row.content) as SourceSceneChunk);
    return { metadata, chunks, nextStartUs: more ? chunks.at(-1)!.range.startUs : null };
  }
  boundaryPage({
    identity,
    range,
    after,
    limit = 100,
  }: {
    identity: SceneEvidenceIdentity;
    range?: TimeRange;
    after?: SceneBoundaryCursor;
    limit?: number;
  }) {
    const metadata = this.readMetadata(identity);
    const window = range ?? { startUs: 0, endUs: ceil(fromTime(metadata.source.durationUs)) };
    if (
      !integer(limit) ||
      limit < 1 ||
      limit > 100 ||
      !integer(window.startUs) ||
      !integer(window.endUs) ||
      window.startUs >= window.endUs ||
      window.endUs > ceil(fromTime(metadata.source.durationUs)) ||
      (after && (!integer(after.ordinal) || !Number.isSafeInteger(after.actualSourceUs)))
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid scene boundary page");
    // Rounded microseconds provide the seek index; exact physical clocks settle membership.
    const lower =
      after && after.actualSourceUs >= window.startUs
        ? after
        : { actualSourceUs: window.startUs, ordinal: -1 };
    const rows = this.store.catalog
      .prepare(`SELECT content FROM scene_evidence_boundaries WHERE ${where}
      AND (actualSourceUs,ordinal)>(?,?) AND actualSourceUs<=?
      ORDER BY actualSourceUs,ordinal LIMIT ?`)
      .all(...key(identity), lower.actualSourceUs, lower.ordinal, window.endUs, limit + 1) as {
      content: string;
    }[];
    const more = rows.length > limit;
    if (more) rows.pop();
    const scanned = rows.map((row) => JSON.parse(row.content) as SceneBoundary);
    const boundaries = scanned.filter((row) => {
      const at = row.sample
        ? sceneSampleSourceTime(row.sample, row.sample.originUs)
        : fromTime(row.actualSourceUs);
      return compare(at, fromTime(window.startUs)) >= 0 && compare(at, fromTime(window.endUs)) < 0;
    });
    const last = scanned.at(-1);
    return {
      metadata,
      boundaries,
      scanned: scanned.length,
      next: more && last ? { actualSourceUs: last.actualSourceUs, ordinal: last.ordinal } : null,
    };
  }
  async remove(identity: SceneEvidenceIdentity): Promise<void> {
    this.store.transaction(() => {
      this.store.catalog
        .prepare(`UPDATE scene_evidence_generations SET complete=-1 WHERE ${where}`)
        .run(...key(identity));
    });
    for (const table of ["scene_evidence_chunks", "scene_evidence_boundaries"])
      while (true) {
        const removed = this.store.transaction(
          () =>
            this.store.catalog
              .prepare(
                `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT 100)`,
              )
              .run(...key(identity)).changes,
        );
        if (Number(removed) < 100) break;
        await setImmediate();
      }
    this.store.transaction(() => {
      this.store.catalog
        .prepare(`DELETE FROM scene_evidence_generations WHERE ${where}`)
        .run(...key(identity));
    });
  }
  async reclaim(
    owner: SceneOwner,
    keep: (generation: string) => boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor = 0;
    while (true) {
      signal?.throwIfAborted();
      const rows = this.store.catalog
        .prepare(
          "SELECT rowid AS cursor,sourceId,generation,policy FROM scene_evidence_generations WHERE ownerKind=? AND ownerId=? AND rowid>? ORDER BY rowid LIMIT 100",
        )
        .all(...ownerIdentity(owner), cursor) as (Omit<SceneEvidenceIdentity, "owner"> & {
        cursor: number;
      })[];
      for (const row of rows) {
        signal?.throwIfAborted();
        if (
          !keep(row.generation) &&
          !this.references.has(
            "scene-generation",
            sceneGenerationResource({ owner, generation: row.generation }),
          )
        )
          await this.remove({ ...row, owner });
        cursor = row.cursor;
      }
      if (rows.length < 100) return;
      await setImmediate();
    }
  }

  /** Force removal for owner retirement; retained references cannot outlive their owner. */
  async purge(owner: SceneOwner, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const row = this.store.catalog
        .prepare(
          "SELECT sourceId,generation,policy FROM scene_evidence_generations WHERE ownerKind=? AND ownerId=? ORDER BY rowid LIMIT 1",
        )
        .get(...ownerIdentity(owner)) as
        | { sourceId: string; generation: string; policy: string }
        | undefined;
      if (!row) return;
      await this.remove({ ...row, owner });
    }
  }
}

export type SceneEvidenceRead = Pick<SceneEvidenceStore, "page">;
