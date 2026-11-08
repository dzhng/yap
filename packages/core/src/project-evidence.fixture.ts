import {
  fromTime,
  compare,
  toTime,
  toSignedTime,
  add,
  subtract,
  type SignedTimeValue,
  type TimeValue,
} from "@yap/composition";
import {
  SpeakerEvidenceStore,
  assetSpeakerOwner,
  type SpeakerEvidenceMetadata,
} from "./speaker-evidence.js";
import { nativeOutput, speakerSource } from "./speaker-evidence.fixture.js";
import { selectSource } from "./source-selection.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { SceneProcessing } from "./scene-processing.js";
import { SourceSceneRead } from "./scene-source-read.js";
import { SceneEvidenceStore, assetSceneOwner } from "./scene-evidence.js";
import { SourceEvents } from "./source-events.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EditOperation } from "@yap/composition";
import { Catalog } from "./catalog.js";
import { SourceEvidenceStore } from "./evidence.js";
import { CaptureSourceRead } from "./capture-source-read.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import { TranscriptStore, type TranscriptRecords } from "./transcript.js";
import {
  TranscriptProcessing,
  assetTranscriptOwner,
  type TranscriptionModels,
} from "./transcript-processing.js";
import { ProjectEvidenceInspection } from "./project-evidence.js";

/**
 * One library with an imported asset, its stores and the evidence readers projects and sources
 * share, for project and source evidence tests. Every scratch directory it makes is closed
 * through `cleanup`.
 */
export async function projectEvidenceFixture(
  cleanup: (() => Promise<void>)[],
  {
    durationUs = 1000,
    originUs = 500,
    scenes = false,
    speakers = false,
    wordExtents = [100, 100, 100],
  }: {
    durationUs?: TimeValue;
    originUs?: SignedTimeValue;
    scenes?: boolean;
    speakers?: boolean;
    wordExtents?: number[];
  } = {},
) {
  const home = await mkdtemp("/tmp/project-evidence-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const projects = projectStoreFixture(catalog, assets, home, acquisitions);
  const cache = new DerivedCache(catalog, home, (owner) => {
    if (owner.kind !== "project") throw new Error("Wrong cache owner");
    projects.get(owner.id);
  });
  await cache.reconcile();
  const input = join(home, "media.mov");
  await writeFile(input, "original media");
  const asset = await assets.import(input, { kind: "import" }, async () => ({
    originUs,
    streams: ["speech", "empty", "short", "narrow", "video"].map((id) => ({
      id,
      kind: id === "video" ? "video" : "audio",
      ...(id === "video" ? { orientedWidth: 160, orientedHeight: 96 } : {}),
      ...(id === "video" ? {} : { channels: 2 }),
      codec: "fixture",
      decodable: true,
      startUs: 0,
      endUs: durationUs,
      segments: [{ startUs: 0, endUs: durationUs, empty: false }],
    })),
  }));
  const captureRecords = new SourceEvidenceStore(catalog, (identity) => {
    if (identity.owner.kind !== "acquisition") throw new Error("Wrong capture owner");
    acquisitions.intent(identity.owner.id);
  });
  const captureReads: number[][] = [];
  const pointRecords = captureRecords.pointRecords.bind(captureRecords);
  captureRecords.pointRecords = (...args) => {
    const rows = pointRecords(...args);
    captureReads.push(rows.map((row) => row.sourceUs!));
    return rows;
  };
  const captureRead = new CaptureSourceRead(assets, acquisitions, captureRecords);
  async function capture(
    rows: { event: string; data: Record<string, unknown> }[],
    available = [{ startUs: 0, endUs: durationUs }],
    holds = false,
  ) {
    const id = randomUUID(),
      file = join(home, `${id}.jsonl`),
      body = rows.map((row) => JSON.stringify(row) + "\n").join("");
    catalog.catalog
      .prepare("INSERT INTO acquisitions VALUES(?,?,?,NULL)")
      .run(id, id, JSON.stringify({ kind: "import", path: home, files: {} }));
    await writeFile(file, body);
    const evidence = await captureRecords.ingest({
      owner: { kind: "acquisition", id: id },
      sourceId: "capture",
      generation: "first",
      file,
      receipt: {
        file,
        journal: "capture.journal.jsonl",
        header: {
          sessionID: "capture",
          ...(holds
            ? { schemaVersion: 4, cursorSampling: { intervalUs: 16667, holds: true } }
            : {}),
        },
        ...(holds ? { publications: {} } : {}),
        cursorSamples: rows.filter((row) => row.event === "cursorSample").length,
        geometryRecords: rows.filter((row) => row.event === "geometry").length,
        displaySpaces: rows.filter((row) => row.event === "displaySpace").length,
        pauseEvents: rows.filter((row) => row.event === "pause").length,
        firstCursorSourceUs:
          (rows.find((row) => row.event === "cursorSample")?.data.sourceUs as number) ?? null,
        lastCursorSourceUs:
          (rows.findLast((row) => row.event === "cursorSample")?.data.sourceUs as number) ?? null,
        audioIntervals: rows.filter((row) => row.event === "audioAcquired").length,
        ...(rows.some((row) => row.event === "mark")
          ? {
              markEvents: rows.filter((row) => row.event === "mark").length,
              header: { sessionID: "capture", schemaVersion: 3, source: { kind: "display" } },
              publications: {},
            }
          : {}),
        lastSequence: rows.length,
        incompleteTail: false,
        finished: true,
        bytes: Buffer.byteLength(body),
      },
    });
    const value = {
      id,
      sourceId: "capture",
      evidence,
      journal: {
        fileName: `${id}.jsonl`,
        bytes: Buffer.byteLength(body),
        sha256: createHash("sha256").update(body).digest("hex"),
      },
      bindings: ["video", "speech"].map((streamId) => ({
        assetId: asset.id,
        streamId,
        available,
        sourceRoles: [streamId === "video" ? "video" : "narration"],
        sourceToAssetOffsetUs: toSignedTime(subtract(fromTime(0), fromTime(originUs))),
        supportBasis: "physical",
      })),
    };
    catalog.catalog
      .prepare("UPDATE acquisitions SET metadata=? WHERE id=?")
      .run(JSON.stringify(value), id);
    return value;
  }
  const records = new TranscriptStore(catalog, home, assetTranscriptOwner(assets, acquisitions));
  const reads: { source: string; generation: string; rows: number; limit: number }[] = [];
  const observed: TranscriptRecords = {
    wordRecords(identity, query) {
      const rows = records.wordRecords(identity, query);
      reads.push({
        source: identity.sourceId,
        generation: identity.generation,
        rows: rows.length,
        limit: query.limit,
      });
      return rows;
    },
    gapRecords(identity, query) {
      const rows = records.gapRecords(identity, query);
      reads.push({
        source: identity.sourceId,
        generation: identity.generation,
        rows: rows.length,
        limit: query.limit,
      });
      return rows;
    },
  };
  const modelState = { ready: true };
  const models: TranscriptionModels = {
    status: () => ({ state: modelState.ready ? "ready" : "absent" }),
    nativeRequest: async () => ({ directory: home, files: [] }),
    modelDigest: "a".repeat(64),
    pins: {
      runtime: "FluidAudio",
      runtimeVersion: "0.15.7",
      runtimeRevision: "runtime",
      decoder: "parakeet-tdt-batch",
      model: "model",
      modelRevision: "revision",
    },
  };
  let transcripts: TranscriptProcessing,
    evidence: ProjectEvidenceInspection,
    sceneProcessing: SceneProcessing;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind === "asset") {
          assets.get(target.id);
          return target;
        }
        if (target.kind === "project")
          return {
            ...target,
            revisionId: projects.revision(target.id, target.revisionId).id,
          };
        throw new Error("Wrong job owner");
      },
      isAvailable: (target) => target.kind !== "project" || !projects.isDeleting(target.id),
      isDeleting: (owner) => owner.kind === "project" && projects.isDeleting(owner.id),
      isCapturing: () => false,
    },
    execute: (execution) =>
      execution.job.artifact === "transcript"
        ? transcripts.execute(execution)
        : execution.job.artifact === "source-scenes"
          ? sceneProcessing.execute(execution)
          : evidence.execute(execution),
  });
  transcripts = new TranscriptProcessing({
    jobs,
    transcripts: records,
    models,
    asset: { assets, acquisitions },
    transcribe: async (request) => {
      const available =
        request.track.streamId === "narrow"
          ? request.track.available.map((source) => ({
              startUs: toTime(add(fromTime(source.startUs), fromTime(100))),
              endUs: toTime(subtract(fromTime(source.endUs), fromTime(100))),
            }))
          : request.track.available;
      const spans = available.flatMap((source) => {
        const scope = request.execution?.executionRange;
        if (!scope) return [{ source, owned: source }];
        const owned = {
          startUs:
            compare(fromTime(source.startUs), fromTime(scope.startUs)) > 0
              ? source.startUs
              : scope.startUs,
          endUs:
            compare(fromTime(source.endUs), fromTime(scope.endUs)) < 0 ? source.endUs : scope.endUs,
        };
        if (compare(fromTime(owned.startUs), fromTime(owned.endUs)) >= 0) return [];
        const lower = subtract(
            fromTime(owned.startUs),
            fromTime(request.execution!.context.beforeUs),
          ),
          upper = add(fromTime(owned.endUs), fromTime(request.execution!.context.afterUs));
        return [
          {
            owned,
            source: {
              startUs:
                compare(fromTime(source.startUs), lower) > 0 ? source.startUs : toTime(lower),
              endUs: compare(fromTime(source.endUs), upper) < 0 ? source.endUs : toTime(upper),
            },
          },
        ];
      });
      const transcribed = spans.map(({ source, owned }, ordinal) => ({
        ordinal,
        source,
        owned,
        state: "transcribed" as const,
        words:
          request.track.streamId === "empty"
            ? []
            : [100, 400, 800]
                .filter(
                  (start) =>
                    compare(fromTime(start), fromTime(source.startUs)) >= 0 &&
                    compare(fromTime(start + 100), fromTime(source.endUs)) <= 0,
                )
                .map((start, i) => ({
                  text: ["one", "two", "three"][i]!,
                  source: { startUs: start, endUs: start + wordExtents[i]! },
                  confidence: 0.9,
                })),
      }));
      const lines =
        request.track.streamId === "short"
          ? transcribed.map((line) => ({
              ...line,
              state: "skipped" as const,
              reason: "too_short" as const,
              words: [],
            }))
          : transcribed;
      const body = lines.map((line) => JSON.stringify(line) + "\n").join("");
      await writeFile(request.output, body);
      return {
        output: {
          file: request.output,
          bytes: Buffer.byteLength(body),
          sha256: createHash("sha256").update(body).digest("hex"),
        },
        engine: {
          runtime: models.pins.runtime,
          runtimeVersion: models.pins.runtimeVersion,
          decoder: models.pins.decoder,
          encoderPrecision: "int8",
          computeUnits: "cpuAndNeuralEngine",
        },
        segments: lines.map(({ words, ...line }) => ({ ...line, wordCount: words.length })),
        wordCount: lines.reduce((sum, line) => sum + line.words.length, 0),
        execution: request.execution,
        available,
      };
    },
  });
  const sceneRecords = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
  sceneProcessing = new SceneProcessing({
    jobs,
    evidence: sceneRecords,
    asset: {
      assets,
      acquisitions,
      implementationId: "fixture-scenes",
      sample: async (request) => ({
        assetId: asset.id,
        streamId: request.asset.streamId,
        originUs,
        sourceWidth: 64,
        sourceHeight: 48,
        readerOpens: 1,
        decodedSamples: request.atSourceUs.length,
        samples: request.atSourceUs.map((at, i) => {
          if (
            !request.available.some(
              (r) =>
                compare(fromTime(r.startUs), fromTime(at)) <= 0 &&
                compare(fromTime(r.endUs), fromTime(at)) > 0,
            )
          )
            return {
              requestedSourceUs: at,
              status: "unavailable",
              reason: "outside_support",
              continuousFromPrevious: false,
            };
          const stamp = add(fromTime(at), fromTime(originUs));
          return {
            requestedSourceUs: at,
            status: "available",
            actualSourceUs: at,
            sample: {
              value: String(stamp.numerator * 5n - (at ? 2n : 0n) * stamp.denominator),
              timescale: Number(stamp.denominator) * 5000000,
              endValue: String((stamp.numerator + stamp.denominator) * 5n),
              endTimescale: Number(stamp.denominator) * 5000000,
            },
            width: 1,
            height: 1,
            rgbBase64: Buffer.alloc(3, Math.floor(at / 200000) % 2 ? 255 : 0).toString("base64"),
            continuousFromPrevious:
              i > 0 &&
              request.available.some(
                (r) =>
                  compare(fromTime(r.startUs), fromTime(request.atSourceUs[i - 1]!)) <= 0 &&
                  compare(fromTime(r.endUs), fromTime(at)) > 0,
              ),
          };
        }),
      }),
    },
  });
  const sceneRead = new SourceSceneRead({
    assets,
    acquisitions,
    processing: sceneProcessing,
    records: sceneRecords,
  });
  const sourceEvents = new SourceEvents({
    assets,
    acquisitions,
    capture: captureRead,
    ...(scenes ? { scenes: sceneRead } : {}),
  });
  const speakerRecords = speakers
    ? new SpeakerEvidenceStore(catalog, assetSpeakerOwner(assets, acquisitions))
    : undefined;
  const speakerMetadata: SpeakerEvidenceMetadata[] = [];
  function observeSpeaker(
    generation: string,
    startUs: TimeValue = { numerator: 125, denominator: 2 },
    lines?: string[],
  ) {
    if (!speakerRecords) throw new Error("Speaker fixture unavailable");
    const source = {
      ...speakerSource,
      streamId: "speech",
      originUs,
      durationUs,
      supportDigest: selectSource(assets, acquisitions, { assetId: asset.id, streamId: "speech" })
        .supportDigest,
      observationRange: { startUs, endUs: toTime(add(fromTime(startUs), fromTime(30000000))) },
    };
    const staged = speakerRecords.stage(
      {
        owner: { kind: "asset", id: asset.id },
        sourceId: asset.id,
        generation,
        policy: "speaker-v1",
      },
      source,
      nativeOutput(lines),
    );
    staged.publish();
    speakerMetadata.push(staged.metadata);
    return staged.metadata;
  }
  evidence = new ProjectEvidenceInspection({
    projects,
    assets,
    jobs,
    cache,
    transcripts,
    records: observed,
    events: sourceEvents,
    ...(speakerRecords
      ? {
          speakers: {
            records: speakerRecords,
            resolveMany: (
              selections: readonly import("./source-selection.js").SourceSelection[],
              request: { channel: number; modelId: string },
            ) =>
              selections.map((selection) => {
                const matching = speakerMetadata.filter(
                  (v) =>
                    v.source.streamId === selection.streamId &&
                    v.source.channel === request.channel &&
                    v.source.engine.modelId === request.modelId,
                );
                return {
                  selection,
                  evidence: matching,
                  state: matching.length ? "ready" : "unavailable",
                  reason: matching.length ? null : "source_evidence_unobserved",
                  retryable: false,
                  jobId: null,
                };
              }),
            sourceStatus: (request: {
              assetId: string;
              streamId: string;
              acquisitionId?: string;
              channel: number;
              modelId: string;
              sourceRange: import("@yap/composition").SelectionRange;
            }) => {
              const found = speakerMetadata.find(
                (value) =>
                  value.owner.id === request.assetId &&
                  value.source.streamId === request.streamId &&
                  value.source.channel === request.channel &&
                  value.source.engine.modelId === request.modelId &&
                  JSON.stringify(value.source.observationRange) ===
                    JSON.stringify(request.sourceRange),
              );
              return {
                state: found ? ("ready" as const) : ("not_requested" as const),
                reason: found ? null : "speaker_evidence_unobserved",
                retryable: false,
                jobId: null,
                published: found ? { generation: 1, issues: [], evidence: found } : null,
              };
            },
          },
        }
      : {}),
  });
  cleanup.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  function create(operations: EditOperation[]) {
    const created = projects.create({
      requestId: randomUUID(),
      canvas: {
        width: 160,
        height: 96,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const revision = projects.apply(created.project.id, {
      requestId: randomUUID(),
      expectedRevisionId: created.revision.id,
      operations,
    }).revision;
    return { projectId: created.project.id, revisionId: revision.id };
  }
  async function ready(input: Parameters<ProjectEvidenceInspection["request"]>[0]) {
    for (let n = 0; n < 8; n++) {
      const status = evidence.request(input);
      if (status.published) return status;
      if (
        input.domain === undefined ||
        input.domain === "transcript" ||
        input.domain === "transcript.search"
      )
        for (const dependency of status.dependencies)
          if (!dependency.transcript && dependency.reason !== "no_audio")
            transcripts.prepareSource(dependency.selection);
      await jobs.idle();
    }
    throw new Error("Evidence did not prepare");
  }
  return {
    home,
    capture,
    captureRead,
    captureRecords,
    sceneRecords,
    sceneProcessing,
    sceneRead,
    sourceEvents,
    captureReads,
    catalog,
    assets,
    acquisitions,
    projects,
    cache,
    records,
    reads,
    modelState,
    transcripts,
    jobs,
    evidence,
    asset,
    observeSpeaker,
    speakerMetadata,
    speakerRecords,
    create,
    ready,
  };
}
