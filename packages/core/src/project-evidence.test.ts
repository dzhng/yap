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
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
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
import {
  ProjectEvidenceInspection,
  type ProjectEvidenceInput,
  type ProjectEvidenceCursor,
  type ProjectTranscriptRow,
} from "./project-evidence.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture({
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
} = {}) {
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
const track = (label: string, order = 0): EditOperation => ({
  operation: "track.add",
  track: { kind: "audio", order },
  label,
});
const clip = (
  assetId: string,
  label: string,
  trackLabel: string,
  start: number,
  end: number,
  sourceStart = 0,
  sourceEnd = 1000,
  streamId = "speech",
): EditOperation => ({
  operation: "place",
  label,
  clip: {
    assetId,
    streamId,
    trackId: { label: trackLabel },
    source: { kind: "range", range: { startUs: sourceStart, endUs: sourceEnd } },
    placement: { kind: "project", range: { startUs: start, endUs: end } },
  },
});
function dependencyRows(
  dependencies: Awaited<ReturnType<ProjectEvidenceInspection["get"]>>["dependencies"],
) {
  if (!Array.isArray(dependencies)) throw new Error("Expected complete dependency metadata");
  return dependencies;
}

async function pages(f: Awaited<ReturnType<typeof fixture>>, input: ProjectEvidenceInput) {
  const rows: ProjectTranscriptRow[] = [];
  let cursor: ProjectEvidenceCursor | undefined;
  for (let n = 0; n < 2000; n++) {
    const result = await f.evidence.get({ ...input, ...(cursor === undefined ? {} : { cursor }) });
    if (!result.page) throw new Error("Not ready");
    if (cursor) expect(result.dependencies).toEqual({ manifestId: cursor.manifestId });
    else if (input.cursor === undefined) dependencyRows(result.dependencies);
    rows.push(...result.page.rows);
    if (!result.page.nextCursor) return rows;
    cursor = result.page.nextCursor;
  }
  throw new Error("Pagination failed to advance");
}

test("project transcript reads never infer and explicitly select retained bounded source generations", async () => {
  const f = await fixture();
  const input = f.create([track("speech"), clip(f.asset.id, "take", "speech", 0, 1000)]);
  expect(await f.evidence.get(input)).toMatchObject({
    state: "not_ready",
    reason: "source_evidence_not_ready",
  });
  await f.jobs.idle();
  expect(
    f.catalog.catalog.prepare("SELECT artifact FROM jobs WHERE artifact='transcript'").all(),
  ).toEqual([]);
  const source = { assetId: f.asset.id, streamId: "speech" };
  const preparation = { ...source, executionRange: { startUs: 300, endUs: 700 } };
  f.transcripts.prepareSource(preparation);
  await f.jobs.idle();
  const metadata = f.transcripts.sourceStatus(preparation).published!.transcript;
  expect(await f.evidence.get(input)).toMatchObject({ state: "not_ready" });
  const pinned = {
    ...input,
    sourceGenerations: [{ ...source, generation: metadata.generation }],
    limit: 1,
  };
  f.evidence.request(pinned);
  await f.jobs.idle();
  f.modelState.ready = false;
  const rows: ProjectTranscriptRow[] = [];
  let page = await f.evidence.get(pinned);
  const dependencies = dependencyRows(page.dependencies);
  while (page.page) {
    rows.push(...page.page.rows);
    const cursor = page.page.nextCursor;
    if (!cursor) break;
    await expect(
      f.evidence.get({ projectId: input.projectId, cursor, sourceGenerations: [], limit: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    page = await f.evidence.get({ projectId: input.projectId, cursor, limit: 1 });
    expect(page.dependencies).toEqual({ manifestId: cursor.manifestId });
  }
  expect(dependencies).toEqual(dependencyRows((await f.evidence.get(pinned)).dependencies));
  expect(
    rows
      .filter((row) => row.type === "word")
      .map(({ generation, text, fragments }) => ({ generation, text, fragments })),
  ).toEqual([
    {
      generation: metadata.generation,
      text: "one",
      fragments: [{ source: { startUs: 400, endUs: 500 }, project: { startUs: 400, endUs: 500 } }],
    },
  ]);
});

test("project transcript rows preserve explicit speaker attribution through retiming", async () => {
  const f = await fixture({ speakers: true, durationUs: 40_000_000 });
  const input = f.create([track("speech"), clip(f.asset.id, "take", "speech", 0, 1000)]);
  const speaker = f.observeSpeaker("speaker-project-transcript");
  const transcriptSource = { assetId: f.asset.id, streamId: "speech" };
  f.transcripts.prepareSource(transcriptSource);
  await f.jobs.idle();
  const transcript = f.transcripts.sourceStatus(transcriptSource).published!.transcript;
  const query = {
    ...input,
    sourceGenerations: [{ ...transcriptSource, generation: transcript.generation }],
    speakerGenerations: [
      {
        ...transcriptSource,
        channel: speaker.source.channel,
        modelId: speaker.source.engine.modelId,
        observationRange: speaker.source.observationRange,
        generation: speaker.generation,
      },
    ],
  };
  await f.ready(query);
  const page = await f.evidence.get({ ...query, limit: 1 });
  expect(page).toMatchObject({ state: "ready" });
  const word = page.page!.rows.find((row) => row.type === "word");
  expect(word).toMatchObject({
    text: "one",
    speaker: { state: "attributed", slot: 0 },
  });
  const cursor = page.page!.nextCursor;
  expect(cursor).not.toBeNull();
  const continued = await f.evidence.get({ projectId: input.projectId, cursor, limit: 1 });
  expect(continued.page!.rows[0]).toMatchObject({
    type: "word",
    speaker: { state: "attributed", slot: 0 },
  });
});

test("project pages merge repeated, retimed and tied track words exactly at limit one", async () => {
  const f = await fixture();
  const input = f.create([
    track("a"),
    track("b", 1),
    clip(f.asset.id, "first", "a", 0, 1000),
    clip(f.asset.id, "repeat", "a", 1000, 1700),
    clip(f.asset.id, "reordered", "b", 100, 700, 400),
  ]);
  await f.ready(input);
  const rows = await pages(f, { ...input, limit: 1 });
  expect(
    rows
      .filter((row) => row.type === "word")
      .map((row) => [
        row.type === "word" ? row.text : "",
        row.fragments[0]!.project.startUs,
        row.trackRank,
      ]),
  ).toEqual([
    ["one", 100, 0],
    ["two", 100, 1],
    ["two", 400, 0],
    ["three", 500, 1],
    ["three", 800, 0],
    ["one", 1070, 0],
    ["two", 1280, 0],
    ["three", 1560, 0],
  ]);
  expect(rows.every((row) => !row.partial)).toBe(true);
  expect(await pages(f, { ...input, limit: 20 })).toEqual(rows);
});

test("query clipping preserves editorial partiality and cursors pin history and query identity", async () => {
  const f = await fixture();
  const input = f.create([
    track("a"),
    clip(f.asset.id, "whole", "a", 0, 1000),
    clip(f.asset.id, "partial", "a", 2000, 2850, 150),
  ]);
  await f.ready(input);
  const first = await f.evidence.get({ ...input, limit: 1 });
  const cursor = first.page!.nextCursor!;
  const trackId = f.projects.revision(input.projectId, input.revisionId).document.tracks[0]!.id;
  expect(
    (await f.evidence.get({ ...input, cursor, trackIds: [trackId, trackId], limit: 2 })).page!.rows,
  ).toHaveLength(2);
  f.projects.apply(input.projectId, {
    requestId: "edit",
    expectedRevisionId: input.revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  const resumed = await f.evidence.get({ projectId: input.projectId, cursor, limit: 2 });
  expect(resumed.revisionId).toBe(input.revisionId);
  expect(
    resumed
      .page!.rows.filter((row) => row.type === "word")
      .map((row) => (row.type === "word" ? row.text : "")),
  ).toEqual(["two", "three"]);
  await expect(
    f.evidence.get({ ...input, cursor, range: { startUs: 1, endUs: 2850 } }),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  await f.ready({ ...input, range: { startUs: 120, endUs: 130 } });
  expect((await pages(f, { ...input, range: { startUs: 120, endUs: 130 } }))[0]).toMatchObject({
    partial: false,
    sourceRange: { startUs: 100, endUs: 200 },
  });
  await f.ready({ ...input, range: { startUs: 2001, endUs: 2020 } });
  expect((await pages(f, { ...input, range: { startUs: 2001, endUs: 2020 } }))[0]).toMatchObject({
    partial: true,
    sourceRange: { startUs: 100, endUs: 200 },
  });
  f.cache.remove(cursor.checkpointId);
  await expect(f.evidence.get({ ...input, cursor })).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
});

test("an evidence range past the project's end reads the clamped range with range-clamped", async () => {
  const f = await fixture();
  const input = f.create([track("a"), clip(f.asset.id, "partial", "a", 2000, 2850, 150)]);
  const over = { ...input, range: { startUs: 2001, endUs: 4000 } };
  await f.ready(over);
  const clamped = await f.evidence.get(over);
  expect(clamped).toMatchObject({
    state: "ready",
    issues: [
      {
        code: "range-clamped",
        evidence: {
          requested: { startUs: 2001, endUs: 4000 },
          applied: { startUs: 2001, endUs: 2850 },
          bounds: { startUs: 0, endUs: 2850 },
        },
      },
    ],
  });
  expect(f.evidence.request(over)).toMatchObject({ range: { startUs: 2001, endUs: 2850 } });
  expect(clamped.page!.rows).toEqual(
    (await f.evidence.get({ ...input, range: { startUs: 2001, endUs: 2850 } })).page!.rows,
  );
  expect(() => f.evidence.request({ ...input, range: { startUs: 2850, endUs: 4000 } })).toThrow(
    expect.objectContaining({ code: "INVALID_RANGE" }),
  );
});

test("empty projects, ready zero-word sources and unavailable models remain distinct", async () => {
  const f = await fixture();
  const empty = f.projects.create({
    requestId: "empty",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const emptyInput = { projectId: empty.project.id };
  await f.ready(emptyInput);
  expect((await f.evidence.get(emptyInput)).page).toEqual({ rows: [], nextCursor: null });
  expect(() => f.evidence.request({ ...emptyInput, range: { startUs: 0, endUs: 0 } })).toThrow(
    expect.objectContaining({ code: "INVALID_RANGE" }),
  );
  const zero = f.create([track("a"), clip(f.asset.id, "empty", "a", 0, 1000, 0, 1000, "empty")]);
  await f.ready(zero);
  const ready = await f.evidence.get(zero);
  expect(ready.page).toEqual({ rows: [], nextCursor: null });
  expect(dependencyRows(ready.dependencies)[0]!.transcript!.wordCount).toBe(0);
  const speech = f.create([track("a"), clip(f.asset.id, "speech", "a", 0, 1000)]);
  f.modelState.ready = false;
  const unavailable = await f.evidence.get(speech);
  expect(unavailable.page).toBeNull();
  expect(dependencyRows(unavailable.dependencies)[0]).toMatchObject({
    transcript: null,
    reason: "model_not_prepared",
  });
});

test("ancestor acquisition gaps remain explicit and original words stay partial across the hole", async () => {
  const f = await fixture();
  f.catalog.catalog.prepare("INSERT INTO acquisitions VALUES(?,?,?,?)").run(
    "mask",
    "mask",
    JSON.stringify({ kind: "import", path: "fixture", files: {} }),
    JSON.stringify({
      id: "mask",
      bindings: [
        {
          assetId: f.asset.id,
          streamId: "video",
          available: [
            { startUs: 0, endUs: 450 },
            { startUs: 475, endUs: 1000 },
          ],
        },
      ],
    }),
  );
  const input = f.create([
    { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
    track("audio"),
    {
      operation: "place",
      label: "parent",
      clip: {
        assetId: f.asset.id,
        streamId: "video",
        acquisitionId: "mask",
        trackId: { label: "picture" },
        source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
      },
    },
    {
      operation: "place",
      label: "child",
      clip: {
        assetId: f.asset.id,
        streamId: "speech",
        trackId: { label: "audio" },
        source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
        placement: {
          kind: "content",
          clipId: { label: "parent" },
          sourceRange: { startUs: 0, endUs: 1000 },
        },
      },
    },
  ]);
  await f.ready(input);
  const rows = await pages(f, { ...input, limit: 1 });
  expect(rows.map((row) => (row.type === "word" ? row.text : row.reason))).toEqual([
    "one",
    "two",
    "not_acquired",
    "three",
  ]);
  expect(await matches(f, { ...input, text: "one two", limit: 1 })).toEqual([]);
  expect(rows[1]).toMatchObject({
    partial: true,
    fragments: [
      { source: { startUs: 400, endUs: 450 }, project: { startUs: 400, endUs: 450 } },
      { source: { startUs: 475, endUs: 500 }, project: { startUs: 475, endUs: 500 } },
    ],
  });
  expect(rows[2]).toMatchObject({ type: "gap", sourceRange: { startUs: 450, endUs: 475 } });
});

test.each(["get", "search"] as const)(
  "%s rejects an unvisited source generation change during checkpoint publication",
  async (operation) => {
    const f = await fixture();
    const input = {
      ...f.create([
        track("a"),
        clip(f.asset.id, "speech", "a", 0, 1000),
        clip(f.asset.id, "later", "a", 10000, 11000, 0, 1000, "narrow"),
      ]),
      ...(operation === "search" ? { text: "one" } : {}),
    };
    await f.ready(input);
    let published!: () => void, release!: () => void;
    const publishedPromise = new Promise<void>((resolve) => {
      published = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = f.cache.publish.bind(f.cache);
    // Hold the completed real cache write before the page can validate and return its continuation.
    f.cache.publish = async (id) => {
      const result = await publish(id);
      published();
      await releasePromise;
      return result;
    };
    f.reads.length = 0;
    const pending =
      operation === "search"
        ? f.evidence.search({ ...input, text: "one", limit: 1 })
        : f.evidence.get({ ...input, limit: 1 });
    try {
      await publishedPromise;
      const source = f.transcripts.sourceStatus({ assetId: f.asset.id, streamId: "narrow" });
      expect(f.reads.length).toBeGreaterThan(0);
      expect(f.reads.map((read) => read.generation)).not.toContain(source.published!.generation);
      f.jobs.regenerate(source.jobId!, f.jobs.job(source.jobId!).generation);
      await f.jobs.idle();
      expect(
        f.transcripts.sourceStatus({ assetId: f.asset.id, streamId: "narrow" }).published!
          .generation,
      ).not.toBe(source.published!.generation);
      release();
      await expect(pending).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
    } finally {
      release();
    }
  },
);

test("tied tracks checkpoint bounded initialization and read near-linearly across limit-one pages", async () => {
  const f = await fixture();
  const tracks = 140;
  const operations = Array.from({ length: tracks }, (_, n) => [
    track(`t${n}`, n),
    clip(f.asset.id, `c${n}`, `t${n}`, 0, 1000),
  ]).flat();
  const input = f.create(operations);
  await f.ready(input);
  const first = await f.evidence.get({ ...input, limit: 1 });
  expect(first.page!.rows).toEqual([]);
  expect(first.page!.nextCursor).not.toBeNull();
  let cursor: unknown = first.page!.nextCursor;
  const rows: ProjectTranscriptRow[] = [];
  for (let calls = 0; calls < tracks * 4; calls++) {
    const before = f.reads.length;
    const page = (await f.evidence.get({ ...input, cursor, limit: 1 })).page!;
    expect(f.reads.length - before).toBeLessThanOrEqual(128 * 4);
    rows.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  expect(rows).toHaveLength(tracks * 3);
  expect(rows.slice(0, tracks).map((row) => row.trackRank)).toEqual(
    Array.from({ length: tracks }, (_, n) => n),
  );
  expect(f.reads.reduce((sum, read) => sum + read.rows, 0)).toBeLessThan(tracks * 8);
  expect(Math.max(...f.reads.map((read) => read.limit))).toBeLessThanOrEqual(4);
}, 30000);

test("a late narrow query seeks relevant source rows and never prepares an unrelated transcript", async () => {
  const f = await fixture();
  const external = join(f.home, "unrelated.mov");
  await writeFile(external, "unrelated media");
  const unrelated = await f.assets.import(external, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "speech",
        kind: "audio",
        codec: "fixture",
        decodable: true,
        startUs: 0,
        endUs: 1000,
        segments: [{ startUs: 0, endUs: 1000, empty: false }],
      },
    ],
  }));
  const input = f.create([
    track("a"),
    track("other", 1),
    ...Array.from({ length: 200 }, (_, n) =>
      clip(f.asset.id, `c${n}`, "a", n * 1000, (n + 1) * 1000),
    ),
    clip(unrelated.id, "unrelated", "other", 0, 1000),
  ]);
  const query = { ...input, range: { startUs: 199100, endUs: 199901 } };
  await f.ready(query);
  const rows = await pages(f, { ...query, limit: 1 });
  expect(
    rows.filter((row) => row.type === "word").map((row) => (row.type === "word" ? row.text : "")),
  ).toEqual(["one", "two", "three"]);
  expect(f.reads.every((read) => read.source === f.asset.id)).toBe(true);
  expect(f.reads.reduce((sum, read) => sum + read.rows, 0)).toBeLessThan(15);
  expect(f.transcripts.sourceStatus({ assetId: unrelated.id, streamId: "speech" }).state).toBe(
    "not_requested",
  );
});

test("no audio tracks and a source with no acquired support have different evidence results", async () => {
  const f = await fixture();
  const video = f.create([
    { operation: "track.add", track: { kind: "video", order: 0 }, label: "v" },
    clip(f.asset.id, "picture", "v", 0, 1000, 0, 1000, "video"),
  ]);
  await f.ready(video);
  const noSpeech = await f.evidence.get(video);
  expect(noSpeech.dependencies).toEqual([]);
  expect(noSpeech.page).toEqual({ rows: [], nextCursor: null });
  f.catalog.catalog.prepare("INSERT INTO acquisitions VALUES(?,?,?,?)").run(
    "empty",
    "empty",
    JSON.stringify({ kind: "import", path: "fixture", files: {} }),
    JSON.stringify({
      id: "empty",
      bindings: [{ assetId: f.asset.id, streamId: "speech", available: [] }],
    }),
  );
  const empty = f.create([
    track("a"),
    {
      operation: "place",
      clip: {
        assetId: f.asset.id,
        streamId: "speech",
        acquisitionId: "empty",
        trackId: { label: "a" },
        source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
      },
    },
  ]);
  await f.ready(empty);
  const unavailable = await f.evidence.get(empty);
  expect(dependencyRows(unavailable.dependencies)[0]).toMatchObject({
    state: "unavailable",
    reason: "no_audio",
    transcript: null,
  });
  expect(unavailable.page!.rows).toMatchObject([
    {
      type: "gap",
      reason: "not_acquired",
      generation: null,
      sourceRange: { startUs: 0, endUs: 1000 },
    },
  ]);
});

test("future track envelopes do not initialize source readers before the next emitted word", async () => {
  const f = await fixture();
  const input = f.create(
    Array.from({ length: 100 }, (_, n) => [
      track(`track${n}`, n),
      clip(f.asset.id, `clip${n}`, `track${n}`, n * 1000, (n + 1) * 1000),
    ]).flat(),
  );
  await f.ready(input);
  const page = (await f.evidence.get({ ...input, limit: 1 })).page!;
  expect(page.rows).toMatchObject([{ type: "word", text: "one", trackRank: 0 }]);
  expect(f.reads.length).toBeLessThanOrEqual(4);
  expect(f.reads.reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(4);
});

test("raw too-short gaps project through the same retained source mapping", async () => {
  const f = await fixture();
  const input = f.create([track("a"), clip(f.asset.id, "short", "a", 100, 660, 100, 900, "short")]);
  await f.ready(input);
  expect(await pages(f, { ...input, limit: 1 })).toMatchObject([
    {
      type: "gap",
      reason: "too_short",
      partial: true,
      sourceRange: { startUs: 0, endUs: 1000 },
      fragments: [{ source: { startUs: 100, endUs: 900 }, project: { startUs: 100, endUs: 660 } }],
    },
  ]);
});

test("actual native gaps narrower than requested support survive project projection", async () => {
  const f = await fixture();
  const input = f.create([track("a"), clip(f.asset.id, "narrow", "a", 0, 1000, 0, 1000, "narrow")]);
  await f.ready(input);
  const rows = await pages(f, { ...input, limit: 1 });
  expect(
    rows.map((row) => (row.type === "word" ? row.text : [row.reason, row.sourceRange])),
  ).toEqual([
    ["not_acquired", { startUs: 0, endUs: 100 }],
    "one",
    "two",
    "three",
    ["not_acquired", { startUs: 900, endUs: 1000 }],
  ]);
});

test("continuation pages reuse the immutable revision execution context", async () => {
  const f = await fixture();
  const input = f.create([
    track("a"),
    ...Array.from({ length: 100 }, (_, n) =>
      clip(f.asset.id, `clip${n}`, "a", n * 1000, (n + 1) * 1000),
    ),
  ]);
  await f.ready(input);
  const first = (await f.evidence.get({ ...input, limit: 1 })).page!;
  let reads = 0;
  const revision = f.projects.revision.bind(f.projects);
  f.projects.revision = (...args) => {
    reads++;
    return revision(...args);
  };
  const rows = [
    ...first.rows,
    ...(await pages(f, { ...input, cursor: first.nextCursor, limit: 1 })),
  ];
  expect(rows).toHaveLength(300);
  expect(reads).toBe(0);
}, 30000);

test("a cold execution owner rebuilds once and a cached context never revives a deleting project", async () => {
  const f = await fixture();
  const input = f.create([track("a"), clip(f.asset.id, "speech", "a", 0, 1000)]);
  await f.ready(input);
  const first = (await f.evidence.get({ ...input, limit: 1 })).page!;
  let reads = 0;
  const revision = f.projects.revision.bind(f.projects);
  f.projects.revision = (...args) => {
    reads++;
    return revision(...args);
  };
  const restarted = new ProjectEvidenceInspection({
    projects: f.projects,
    assets: f.assets,
    jobs: f.jobs,
    cache: f.cache,
    transcripts: f.transcripts,
    records: f.records,
  });
  const second = (await restarted.get({ ...input, cursor: first.nextCursor, limit: 1 })).page!;
  expect(second.rows).toMatchObject([{ type: "word", text: "two" }]);
  const third = (await restarted.get({ ...input, cursor: second.nextCursor, limit: 1 })).page!;
  expect(third.rows).toMatchObject([{ type: "word", text: "three" }]);
  expect(reads).toBe(1);
  f.projects.markDeleting(input.projectId);
  await expect(
    restarted.get({ ...input, cursor: third.nextCursor, limit: 1 }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("phrase search merges by first word across tracks and contiguous cuts", async () => {
  const f = await fixture();
  const input = f.create([
    track("slow"),
    track("fast", 1),
    clip(f.asset.id, "slow-clip", "slow", 0, 10000),
    clip(f.asset.id, "first", "fast", 1500, 1800, 100, 400),
    clip(f.asset.id, "second", "fast", 1800, 2400, 400, 1000),
  ]);
  const query = { ...input, text: "ONE two" };
  await f.ready(query);
  const first = await f.evidence.search({ ...query, limit: 1 });
  expect(first.page?.entries.map((entry) => entry.projectRange)).toEqual([
    { startUs: 1000, endUs: 5000 },
  ]);
  const second = await f.evidence.search({ ...query, limit: 20, cursor: first.page!.nextCursor });
  expect(second.page?.entries.map((entry) => entry.projectRange)).toEqual([
    { startUs: 1500, endUs: 1900 },
  ]);
  expect(new Set(second.page!.entries[0]!.words.map((word) => word.clipId)).size).toBe(2);
});

async function matches(
  f: Awaited<ReturnType<typeof fixture>>,
  input: ProjectEvidenceInput & { text: string },
) {
  await f.ready(input);
  const entries = [];
  let cursor: ProjectEvidenceCursor | undefined;
  for (let n = 0; n < 2000; n++) {
    const result = await f.evidence.search({
      ...input,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!result.page) throw new Error("Not ready");
    if (cursor) expect(result.dependencies).toEqual({ manifestId: cursor.manifestId });
    else if (input.cursor === undefined) dependencyRows(result.dependencies);
    entries.push(...result.page.entries);
    if (!result.page.nextCursor) return entries;
    cursor = result.page.nextCursor;
  }
  throw new Error("Search failed to advance");
}

test("phrase boundaries reject authored gaps, partial words, and cross-track combinations", async () => {
  const f = await fixture();
  const input = f.create([
    track("gap"),
    track("partial", 1),
    track("one", 2),
    track("two", 3),
    track("native-gap", 4),
    clip(f.asset.id, "g1", "gap", 0, 300, 100, 400),
    clip(f.asset.id, "g2", "gap", 301, 901, 400, 1000),
    clip(f.asset.id, "p1", "partial", 0, 350, 150, 500),
    clip(f.asset.id, "a", "one", 0, 300, 100, 400),
    clip(f.asset.id, "b", "two", 300, 900, 400, 1000),
    clip(f.asset.id, "n1", "native-gap", 0, 300, 100, 400),
    clip(f.asset.id, "n2", "native-gap", 300, 1300, 0, 1000, "short"),
    clip(f.asset.id, "n3", "native-gap", 1300, 1900, 400, 1000),
  ]);
  expect(await matches(f, { ...input, text: "one two", limit: 1 })).toEqual([]);
});

test("phrase checkpoints pin raw query and domain while allowing page-size changes", async () => {
  const f = await fixture();
  const input = f.create([
    track("speech"),
    clip(f.asset.id, "a", "speech", 0, 1000),
    clip(f.asset.id, "b", "speech", 1000, 2000),
  ]);
  const query = { ...input, text: "one two" };
  await f.ready(query);
  const first = await f.evidence.search({ ...query, limit: 1 });
  expect(first.page?.entries[0]?.projectRange).toEqual({ startUs: 100, endUs: 500 });
  const cursor = first.page!.nextCursor;
  await expect(f.evidence.search({ ...query, text: "ONE TWO", cursor })).rejects.toMatchObject({
    code: "INVALID_PARAMS",
  });
  await expect(f.evidence.get({ ...input, cursor })).rejects.toMatchObject({
    code: "INVALID_PARAMS",
  });
  const second = await f.evidence.search({ ...query, limit: 500, cursor });
  expect(second.page?.entries.map((e) => e.projectRange)).toEqual([{ startUs: 1100, endUs: 1500 }]);
  f.cache.remove(cursor!.checkpointId);
  await expect(f.evidence.search({ ...query, cursor })).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
});

test("phrase initialization and limit-one resumes have bounded near-linear source reads", async () => {
  const f = await fixture();
  const operations: EditOperation[] = [];
  for (let i = 0; i < 70; i++)
    operations.push(track(`t${i}`, i), clip(f.asset.id, `c${i}`, `t${i}`, 0, 1000));
  const input = { ...f.create(operations), text: "one two", limit: 1 };
  await f.ready(input);
  f.reads.length = 0;
  const first = await f.evidence.search(input);
  expect(first.page).toMatchObject({ entries: [] });
  expect(first.page!.nextCursor).not.toBeNull();
  expect(f.reads.reduce((sum, read) => sum + read.rows, 0)).toBeLessThan(600);
  const all = [];
  let cursor = first.page!.nextCursor;
  while (cursor) {
    const before = f.reads.length;
    const page = (await f.evidence.search({ ...input, cursor })).page!;
    expect(f.reads.slice(before).reduce((sum, read) => sum + read.rows, 0)).toBeLessThan(600);
    all.push(...page.entries);
    cursor = page.nextCursor;
  }
  expect(all.map((entry) => [entry.trackRank, entry.projectRange])).toEqual(
    Array.from({ length: 70 }, (_, rank) => [rank, { startUs: 100, endUs: 500 }]),
  );
  expect(f.reads.reduce((sum, read) => sum + read.rows, 0)).toBeLessThan(70 * 20);
});

test("phrase matches preserve rational timing and reject replaced source generations", async () => {
  const f = await fixture();
  const input = f.create([
    track("voice"),
    clip(f.asset.id, "first", "voice", 0, 1001),
    clip(f.asset.id, "again", "voice", 1001, 2001),
  ]);
  const query = { ...input, text: "two three", limit: 1 };
  await f.ready(query);
  const first = await f.evidence.search(query);
  expect(first.page!.entries[0]!.projectRange).toEqual({
    startUs: { numerator: 2002, denominator: 5 },
    endUs: { numerator: 9009, denominator: 10 },
  });
  expect(first.page!.entries[0]!.words.map((word) => [word.ordinal, word.sourceRange])).toEqual([
    [1, { startUs: 400, endUs: 500 }],
    [2, { startUs: 800, endUs: 900 }],
  ]);
  const source = f.transcripts.sourceStatus({ assetId: f.asset.id, streamId: "speech" });
  f.jobs.regenerate(source.jobId!, f.jobs.job(source.jobId!).generation);
  await f.jobs.idle();
  await expect(
    f.evidence.search({ ...query, cursor: first.page!.nextCursor }),
  ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
});

const cursorSample = (sourceUs: number) => ({
  event: "cursorSample",
  data: {
    sourceUs,
    x: 12,
    y: 34,
    globalX: 112,
    globalY: 134,
    buttons: 0,
    eligibility: "inside",
    geometryEpoch: 1,
  },
});
const geometry = (sourceUs: number | null) => ({
  event: "geometry",
  data: {
    epoch: 1,
    hostUs: 10,
    sourceUs,
    geometry: {
      outputWidth: 160,
      outputHeight: 96,
      contentScale: 1,
      scaleFactor: 1,
      contentRect: { x: 0, y: 0, width: 160, height: 96 },
    },
  },
});
function capturedClip(
  assetId: string,
  acquisitionId: string,
  label: string,
  trackLabel: string,
  start: number,
  end: number,
): EditOperation {
  const operation = clip(assetId, label, trackLabel, start, end, 0, 1000, "video");
  if (operation.operation !== "place") throw new Error("Expected placement");
  return { ...operation, clip: { ...operation.clip, acquisitionId } };
}
function observeSourceMetadata(f: Awaited<ReturnType<typeof fixture>>) {
  const work = { headers: 0, segments: 0, acquisitions: 0 };
  const prepare = f.catalog.catalog.prepare.bind(f.catalog.catalog);
  f.catalog.catalog.prepare = (sql, ...options) => {
    const statement = prepare(sql, ...options);
    const key = /SELECT (?:id,)?metadata FROM assets/.test(sql)
      ? "headers"
      : sql.includes("FROM asset_segments")
        ? "segments"
        : /SELECT (?:id,)?metadata FROM acquisitions/.test(sql)
          ? "acquisitions"
          : null;
    if (key) {
      const get = statement.get.bind(statement),
        all = statement.all.bind(statement);
      vi.spyOn(statement, "get").mockImplementation((...args) => {
        work[key]++;
        return get(...args);
      });
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        work[key]++;
        return all(...args);
      });
    }
    return statement;
  };
  return {
    work,
    restore: () => {
      f.catalog.catalog.prepare = prepare;
      vi.restoreAllMocks();
    },
  };
}
test("cursor continuations reference complete manifest dependencies within each fresh validation phase", async () => {
  const f = await fixture();
  const captures = await Promise.all([
    f.capture([cursorSample(600)]),
    f.capture([cursorSample(600)]),
  ]);
  const input = f.create([
    { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
    ...Array.from({ length: 8 }, (_, n) =>
      capturedClip(f.asset.id, captures[n % 2]!.id, `clip-${n}`, "video", n * 1000, (n + 1) * 1000),
    ),
  ]);
  const query = { ...input, domain: "cursor" as const, limit: 1 };
  await f.ready(query);
  const first = await f.evidence.cursor(query);
  const manifestId = first.page!.nextCursor!.manifestId;
  const manifest = JSON.parse(
    await readFile(join(f.home, "cache/derived", `${manifestId}.cache`), "utf8"),
  );
  expect(first.dependencies).toEqual(manifest.dependencies);
  const { work, restore } = observeSourceMetadata(f);
  try {
    const next = await f.evidence.cursor({ ...query, cursor: first.page!.nextCursor });
    expect(next.dependencies).toEqual({ manifestId });
    expect(next.page!.rows).toMatchObject([
      {
        acquisitionId: captures[1]!.id,
        sourceAtUs: 100,
        captureAtUs: 600,
        projectAtUs: 1100,
        observation: { x: 12, y: 34, buttons: 0 },
      },
    ]);
    expect(next.page!.nextCursor).not.toBeNull();
    expect(work).toEqual({ headers: 2, segments: 2, acquisitions: 2 });
  } finally {
    restore();
  }
});
test("scene-enabled continuation validation shares source metadata within each fresh phase", async () => {
  const f = await fixture({ scenes: true });
  const captures = await Promise.all([
    f.capture([{ event: "pause", data: { atSourceUs: 600, elapsedPauseUs: 17 } }]),
    f.capture([{ event: "pause", data: { atSourceUs: 700, elapsedPauseUs: 23 } }]),
  ]);
  const input = f.create([
    { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
    ...captures.map((capture, n) =>
      capturedClip(f.asset.id, capture.id, `clip-${n}`, "video", n * 1000, (n + 1) * 1000),
    ),
  ]);
  const query = { ...input, domain: "events" as const, limit: 1 };
  await f.ready(query);
  const first = await f.evidence.events(query);
  const firstSource = first.page!.rows[0]!;
  if (firstSource.kind === "cut") throw Error("Expected the authored pause before the cut");
  expect(firstSource).toEqual({
    kind: "pause",
    sourceAtUs: 100,
    captureAtUs: 600,
    sourceSequence: 1,
    observation: { atSourceUs: 600, elapsedPauseUs: 17 },
    clipId: first.coverage!.occurrences![0]!.clipId,
    assetId: f.asset.id,
    streamId: "video",
    acquisitionId: captures[0]!.id,
    trackId: firstSource.trackId,
    trackRank: 0,
    generation: "first",
    projectAtUs: 100,
  });
  const { work, restore } = observeSourceMetadata(f);
  try {
    const next = await f.evidence.events({ ...query, cursor: first.page!.nextCursor });
    expect(next.page!.rows).toEqual([
      {
        kind: "cut",
        mediaKind: "video",
        projectAtUs: 1000,
        trackId: firstSource.trackId,
        trackRank: 0,
        before: {
          kind: "range",
          clipId: firstSource.clipId,
          assetId: f.asset.id,
          streamId: "video",
          acquisitionId: captures[0]!.id,
          sourceAtUs: 1000,
          rate: 1,
        },
        after: {
          kind: "range",
          clipId: first.coverage!.occurrences![1]!.clipId,
          assetId: f.asset.id,
          streamId: "video",
          acquisitionId: captures[1]!.id,
          sourceAtUs: 0,
          rate: 1,
        },
      },
    ]);
    expect(next.dependencies).toEqual({ manifestId: first.coverage!.manifestId });
    expect(next.coverage).toEqual({ manifestId: first.coverage!.manifestId });
    expect(next.page!.nextCursor).not.toBeNull();
    expect(work).toEqual({ headers: 2, segments: 2, acquisitions: 2 });
  } finally {
    restore();
  }
});
test.each(["asset", "missing", "pending", "malformed"] as const)(
  "read-only source-event batches keep the first source failure ahead of later %s metadata failures",
  async (failure) => {
    const f = await fixture({ scenes: true });
    const capture = await f.capture([]);
    const selected = { assetId: f.asset.id, streamId: "video", acquisitionId: capture.id };
    f.sourceEvents.resolveMany([selected], "events", true);
    await f.jobs.idle();
    f.catalog.catalog
      .prepare("UPDATE artifacts SET result=? WHERE artifact='source-scenes' AND targetId=?")
      .run("invalid scene publication JSON", f.asset.id);
    const later = await f.capture([]);
    if (failure === "missing")
      f.catalog.catalog.prepare("DELETE FROM acquisitions WHERE id=?").run(later.id);
    if (failure === "pending" || failure === "malformed")
      f.catalog.catalog
        .prepare("UPDATE acquisitions SET metadata=? WHERE id=?")
        .run(failure === "pending" ? null : "invalid acquisition JSON", later.id);
    const next =
      failure === "asset"
        ? { assetId: "missing", streamId: "video" }
        : { assetId: f.asset.id, streamId: "video", acquisitionId: later.id };
    expect(() => f.sourceEvents.resolveMany([selected, next], "events", false)).toThrow(
      SyntaxError,
    );
    // Without the earlier scene failure, the later acquisition still owns its actual refusal.
    if (failure !== "asset") {
      if (failure === "malformed")
        expect(() => f.captureRead.resolveMany([next], "cursor")).toThrow(SyntaxError);
      else
        expect(() => f.captureRead.resolveMany([next], "cursor")).toThrow(
          failure === "pending"
            ? "The acquisition is still importing. Retry in 15 seconds."
            : "Acquisition does not exist",
        );
    }
  },
);
test("scene preparation admits the earlier source before a later selection fails", async () => {
  const f = await fixture({ scenes: true });
  const capture = await f.capture([]);
  const selected = { assetId: f.asset.id, streamId: "video", acquisitionId: capture.id };
  expect(f.sceneProcessing.sourceStatus(selected).state).toBe("not_requested");
  expect(() =>
    f.sourceEvents.resolveMany(
      [selected, { assetId: "missing", streamId: "video" }],
      "events",
      true,
    ),
  ).toThrow("Asset does not exist");
  await f.jobs.idle();
  const status = f.sceneProcessing.sourceStatus(selected);
  expect(status.state).toBe("ready");
  expect(status.published!.evidence.source).toEqual({
    kind: "asset",
    streamId: "video",
    acquisitionId: capture.id,
    originUs: 500,
    durationUs: 1000,
    supportDigest: createHash("sha256")
      .update(JSON.stringify([{ startUs: 0, endUs: 1000 }]))
      .digest("hex"),
  });
});
test.each(["cursor", "events"] as const)(
  "%s metadata is resolved again after checkpoint publication and on the next request",
  async (domain) => {
    const f = await fixture({ scenes: true });
    const captured = await f.capture([
      cursorSample(600),
      { event: "pause", data: { atSourceUs: 600, elapsedPauseUs: 17 } },
    ]);
    const input = f.create([
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      capturedClip(f.asset.id, captured.id, "first", "video", 0, 1000),
      capturedClip(f.asset.id, captured.id, "next", "video", 1000, 2000),
    ]);
    const query = { ...input, domain, limit: 1 };
    await f.ready(query);
    const first = await f.evidence[domain](query);
    const original = await readFile(f.assets.path(f.asset.id));
    const publish = f.cache.publish.bind(f.cache);
    let checkpoint: string | undefined;
    f.cache.publish = async (id) => {
      const published = await publish(id);
      checkpoint = id;
      f.catalog.catalog.prepare("UPDATE acquisitions SET metadata=? WHERE id=?").run(
        JSON.stringify({
          ...captured,
          evidence: { ...captured.evidence, generation: "replaced" },
        }),
        captured.id,
      );
      return published;
    };
    await expect(
      f.evidence[domain]({ ...query, cursor: first.page!.nextCursor }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
    expect(checkpoint).toBeDefined();
    expect(f.cache.acquire(checkpoint!)).toBeNull();
    await expect(
      f.evidence[domain]({ ...query, cursor: first.page!.nextCursor }),
    ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
    expect(await readFile(f.assets.path(f.asset.id))).toEqual(original);
  },
);
test("capture source and project reads preserve raw clocks, exact retimes and missing context coverage", async () => {
  const f = await fixture();
  const capture = await f.capture([
    cursorSample(750),
    { event: "pause", data: { atSourceUs: 750, elapsedPauseUs: 77 } },
    geometry(750),
    geometry(null),
  ]);
  const source = { assetId: f.asset.id, streamId: "video", acquisitionId: capture.id };
  const raw = f.captureRead.cursor({ ...source, sourceRange: { startUs: 200, endUs: 300 } });
  expect(raw.page!.rows).toMatchObject([
    {
      kind: "cursor",
      sourceAtUs: 250,
      captureAtUs: 750,
      sourceSequence: 1,
      observation: { sourceUs: 750, x: 12, y: 34 },
    },
  ]);
  const input = f.create([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    capturedClip(f.asset.id, capture.id, "first", "v", 0, 1501),
    clip(f.asset.id, "unbound", "v", 1501, 2501, 0, 1000, "video"),
  ]);
  for (let n = 0; n < 4; n++) {
    if ((await f.evidence.events(input)).page) break;
    await f.jobs.idle();
  }
  const result = await f.evidence.events({ ...input, limit: 1 });
  expect(result.page!.rows[0]).toMatchObject({
    kind: "pause",
    sourceAtUs: 250,
    captureAtUs: 750,
    sourceSequence: 2,
    projectAtUs: 375,
    observation: { elapsedPauseUs: 77 },
  });
  const second = await f.evidence.events({ ...input, limit: 500, cursor: result.page!.nextCursor });
  expect(second.page!.rows.map((row) => row.kind)).toEqual(["geometry", "cut"]);
  expect(
    dependencyRows(result.dependencies).map(
      (d) => d.capture!.coverage.find((c) => c.kind === "pause")!.state,
    ),
  ).toEqual(["ready", "unavailable"]);
  expect(
    dependencyRows(result.dependencies).find((d) => d.capture!.evidence)?.capture!.coverage,
  ).toContainEqual({
    kind: "unplaced_geometry",
    state: "unavailable",
    reason: "no_source_time",
  });
});

test("timeline events expose active marks with projected points and stable paging", async () => {
  const f = await fixture();
  const captured = await f.capture([
    {
      event: "geometry",
      data: {
        epoch: 1,
        hostUs: 1,
        sourceUs: 500,
        geometry: {
          outputWidth: 200,
          outputHeight: 100,
          contentScale: 2,
          scaleFactor: 1,
          contentRect: { x: 10, y: 20, width: 100, height: 50 },
          screenRect: { x: 100, y: 200, width: 50, height: 25 },
        },
      },
    },
    {
      event: "mark",
      data: {
        hostUs: 2,
        sourceUs: 600,
        epoch: 1,
        id: "stroke-1",
        kind: "stroke",
        points: [
          { hostUs: 2, globalX: 101, globalY: 202, x: 16, y: 28 },
          { hostUs: 3, globalX: 102, globalY: 203, x: 18, y: 30 },
        ],
      },
    },
    {
      event: "mark",
      data: {
        hostUs: 4,
        sourceUs: 700,
        epoch: 1,
        id: "pin-1",
        kind: "pin",
        pin: 1,
        points: [{ hostUs: 4, globalX: 103, globalY: 204, x: 16, y: 28 }],
      },
    },
    {
      event: "mark",
      data: {
        hostUs: 5,
        sourceUs: 800,
        epoch: 1,
        id: "undo-1",
        kind: "stroke",
        points: [],
        retracts: "stroke-1",
      },
    },
  ]);
  const selection = { assetId: f.asset.id, streamId: "video", acquisitionId: captured.id };
  const first = f.sourceEvents.events({ ...selection, limit: 1 });
  expect(first.page!.rows).toHaveLength(1);
  expect(first.page!.nextCursor).toBeTruthy();
  const rows = [...first.page!.rows];
  let cursor = first.page!.nextCursor;
  while (cursor) {
    const page = f.sourceEvents.events({ ...selection, limit: 1, cursor });
    rows.push(...page.page!.rows);
    cursor = page.page!.nextCursor;
  }
  const marks = rows.filter((row) => row.kind === "mark");
  expect(marks).toHaveLength(1);
  expect(marks[0]).toMatchObject({
    captureAtUs: 700,
    observation: { id: "pin-1", points: [{ hostUs: 4, x: 16, y: 28 }] },
  });
  const direct = f.captureRead.marks(selection);
  expect(direct).toHaveLength(1);
  // The mark reader answers in asset time, the clock its event row already reports.
  expect(direct[0]).toEqual(
    expect.objectContaining({
      assetUs: marks[0]!.sourceAtUs,
      id: "pin-1",
      points: [expect.objectContaining({ x: 16, y: 28 })],
    }),
  );
  expect(direct[0]).not.toHaveProperty("sourceUs");
  expect(marks[0]!.sourceAtUs).not.toBe(700);
  expect(f.sourceEvents.events({ assetId: f.asset.id, streamId: "video" })).toMatchObject({
    state: "unavailable",
    page: null,
  });
});

test("capture cursor repeats every visual occurrence and masks unavailable samples without audio duplication", async () => {
  const f = await fixture();
  const captured = await f.capture(
    [cursorSample(600), cursorSample(700), cursorSample(800)],
    [
      { startUs: 0, endUs: 150 },
      { startUs: 250, endUs: 1000 },
    ],
  );
  const selection = { assetId: f.asset.id, streamId: "video", acquisitionId: captured.id };
  const raw = f.captureRead.cursor({ ...selection, limit: 1 });
  expect(raw.page!.rows.map((row) => row.sourceAtUs)).toEqual([100]);
  const next = f.captureRead.cursor({ ...selection, limit: 5000, cursor: raw.page!.nextCursor });
  expect(next.page!.rows.map((row) => row.sourceAtUs)).toEqual([300]);
  expect(f.captureRead.cursor({ assetId: f.asset.id, streamId: "video" })).toMatchObject({
    state: "unavailable",
    page: null,
  });
  expect(f.captureRead.cursor({ ...selection, streamId: "speech" })).toMatchObject({
    state: "unavailable",
    page: null,
    context: { coverage: [{ reason: "requires_captured_video" }] },
  });
  const input = f.create([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    capturedClip(f.asset.id, captured.id, "a", "v", 0, 1000),
    capturedClip(f.asset.id, captured.id, "b", "v", 1000, 2000),
    track("audio", 1),
    {
      operation: "place",
      clip: {
        assetId: f.asset.id,
        streamId: "speech",
        acquisitionId: captured.id,
        trackId: { label: "audio" },
        source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
      },
    },
  ]);
  for (let n = 0; n < 4; n++) {
    if ((await f.evidence.cursor(input)).page) break;
    await f.jobs.idle();
  }
  const rows = [];
  let cursor: unknown;
  for (let n = 0; n < 20; n++) {
    const page = (await f.evidence.cursor({ ...input, limit: 1, ...(cursor ? { cursor } : {}) }))
      .page!;
    rows.push(...page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  expect(
    rows.map((row) => {
      if (row.kind === "scene" || row.kind === "cut")
        throw new Error("Cursor domain returned non-cursor evidence");
      return [row.projectAtUs, row.sourceAtUs, row.sourceSequence];
    }),
  ).toEqual([
    [100, 100, 1],
    [300, 300, 3],
    [1100, 100, 1],
    [1300, 300, 3],
  ]);
  expect(new Set(rows.filter((row) => row.kind !== "cut").map((row) => row.clipId)).size).toBe(2);
  expect(() => f.captureRead.events({ ...selection, cursor: raw.page!.nextCursor })).toThrow(
    /changed/,
  );
});

test("actual native-normalized capture observations retain coordinates and half-open source boundaries", async () => {
  const f = await fixture({ durationUs: 1_000_000, originUs: 0 });
  const body = await readFile(
    new URL(
      "../../../specs/done/agent-editing/assets/10c-capture-evidence/native-source-excerpt.jsonl",
      import.meta.url,
    ),
    "utf8",
  );
  const normalized = body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const captured = await f.capture(normalized);
  const result = f.captureRead.cursor({
    assetId: f.asset.id,
    streamId: "video",
    acquisitionId: captured.id,
    sourceRange: { startUs: 49814, endUs: 100658 },
  });
  expect(result.page!.rows.map((row) => row.captureAtUs)).toEqual([49814, 67253, 83514]);
  expect(result.page!.rows.map((row) => row.observation)).toEqual(
    normalized
      .filter((row) => row.event === "cursorSample")
      .slice(0, 3)
      .map((row) => row.data),
  );
  expect(result.page!.rows[0]!.observation).toMatchObject({
    eligibility: "outside",
    x: 3139.828125,
    y: 629.53125,
  });
});

test("capture project checkpoints bound tied-track initialization and reject domain/query/cache changes", async () => {
  const f = await fixture();
  const captured = await f.capture([cursorSample(750)]);
  const operations: EditOperation[] = [];
  for (let n = 0; n < 140; n++)
    operations.push(
      { operation: "track.add", label: `v${n}`, track: { kind: "video", order: n } },
      capturedClip(f.asset.id, captured.id, `c${n}`, `v${n}`, 0, 1000),
    );
  const input = f.create(operations);
  for (let n = 0; n < 4; n++) {
    if ((await f.evidence.cursor(input)).page) break;
    await f.jobs.idle();
  }
  f.captureReads.length = 0;
  const first = await f.evidence.cursor({ ...input, limit: 1 });
  expect(first.page!.rows).toEqual([]);
  expect(first.coverage!.occurrences!.length).toBe(140);
  expect(f.captureReads.length).toBeLessThanOrEqual(128);
  const saved = first.page!.nextCursor!;
  await expect(f.evidence.events({ ...input, cursor: saved })).rejects.toMatchObject({
    code: "INVALID_PARAMS",
  });
  await expect(
    f.evidence.cursor({ ...input, range: { startUs: 1, endUs: 1000 }, cursor: saved }),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  const rows = [];
  let cursor = first.page!.nextCursor;
  while (cursor) {
    const before = f.captureReads.length;
    const result = await f.evidence.cursor({ ...input, limit: 1, cursor });
    expect(f.captureReads.length - before).toBeLessThanOrEqual(128);
    expect(result.coverage).toEqual({ manifestId: saved.manifestId });
    rows.push(...result.page!.rows);
    cursor = result.page!.nextCursor;
  }
  expect(rows.map((row) => [row.trackRank, row.projectAtUs])).toEqual(
    Array.from({ length: 140 }, (_, rank) => [rank, 250]),
  );
  expect(f.captureReads.length).toBeLessThan(140 * 3);
  f.cache.remove(saved.checkpointId);
  await expect(f.evidence.cursor({ ...input, cursor: saved })).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
});

test("late capture windows seek only relevant points and report unavailable support independently", async () => {
  const f = await fixture();
  const captured = await f.capture(
    Array.from({ length: 500 }, (_, n) => cursorSample(500 + 2 * n)),
    [
      { startUs: 0, endUs: 805 },
      { startUs: 807, endUs: 1000 },
    ],
  );
  const input = f.create([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    capturedClip(f.asset.id, captured.id, "c", "v", 0, 1000),
  ]);
  const query = { ...input, range: { startUs: 800, endUs: 810 } };
  for (let n = 0; n < 4; n++) {
    if ((await f.evidence.cursor(query)).page) break;
    await f.jobs.idle();
  }
  f.captureReads.length = 0;
  const result = await f.evidence.cursor(query);
  expect(
    result.page!.rows.map((row) => {
      if (row.kind === "cut") throw Error("Unexpected cursor cut");
      return row.sourceAtUs;
    }),
  ).toEqual([800, 802, 804, 808]);
  expect(f.captureReads.flat()).toEqual([1300, 1302, 1304, 1306, 1308]);
  expect(result.coverage!.occurrences![0]).toMatchObject({
    available: [
      { startUs: 800, endUs: 805 },
      { startUs: 807, endUs: 810 },
    ],
    unavailable: [{ startUs: 805, endUs: 807 }],
  });
});

test("empty capture observations remain ready and audio occurrences receive only pause markers", async () => {
  const f = await fixture();
  const empty = await f.capture([]);
  const source = { assetId: f.asset.id, streamId: "video", acquisitionId: empty.id };
  expect(f.captureRead.events(source)).toMatchObject({
    state: "ready",
    page: { rows: [], nextCursor: null },
  });
  const captured = await f.capture([
    geometry(700),
    { event: "pause", data: { atSourceUs: 700, elapsedPauseUs: 12 } },
  ]);
  const input = f.create([
    track("a"),
    {
      operation: "place",
      clip: {
        assetId: f.asset.id,
        streamId: "speech",
        acquisitionId: captured.id,
        trackId: { label: "a" },
        source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
      },
    },
  ]);
  for (let n = 0; n < 4; n++) {
    if ((await f.evidence.events(input)).page) break;
    await f.jobs.idle();
  }
  const result = await f.evidence.events(input);
  expect(result.page!.rows.map((row) => [row.kind, row.projectAtUs])).toEqual([["pause", 200]]);
  expect(dependencyRows(result.dependencies)[0]!.capture!.coverage).toContainEqual({
    kind: "geometry",
    state: "unavailable",
    reason: "requires_captured_video",
  });
  const first = await f.evidence.events({ ...input, limit: 1 });
  f.projects.apply(input.projectId, {
    requestId: randomUUID(),
    expectedRevisionId: input.revisionId,
    operations: [track("later", 1)],
  });
  const historical = await f.evidence.events({
    projectId: input.projectId,
    cursor: first.page!.nextCursor,
  });
  expect(historical.revisionId).toBe(input.revisionId);
  expect(historical.page!.rows).toEqual([]);
});

test("capture replies close by bytes and resume without losing observations", async () => {
  const f = await fixture();
  const captured = await f.capture(
    Array.from({ length: 100 }, (_, n) => ({
      event: "cursorSample",
      data: { ...cursorSample(500 + n).data, retainedDetail: "x".repeat(50_000) },
    })),
  );
  const selection = { assetId: f.asset.id, streamId: "video", acquisitionId: captured.id };
  const sourceRows = [];
  let sourceCursor: unknown;
  do {
    const result = f.captureRead.cursor({
      ...selection,
      limit: 5000,
      ...(sourceCursor ? { cursor: sourceCursor } : {}),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4 * 1024 * 1024);
    sourceRows.push(...result.page!.rows);
    sourceCursor = result.page!.nextCursor;
  } while (sourceCursor);
  expect(sourceRows.map((row) => row.sourceAtUs)).toEqual(Array.from({ length: 100 }, (_, n) => n));
  expect(
    f.captureRead.cursor({ ...selection, limit: 1 }).page!.rows.map((row) => row.sourceAtUs),
  ).toEqual([0]);
  const input = f.create([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    capturedClip(f.asset.id, captured.id, "c", "v", 0, 1000),
  ]);
  for (let n = 0; n < 4; n++) {
    if ((await f.evidence.cursor({ ...input, limit: 1 })).page) break;
    await f.jobs.idle();
  }
  const projected = [];
  let pageCursor: ProjectEvidenceCursor | undefined;
  do {
    const result = await f.evidence.cursor({
      ...input,
      limit: 5000,
      ...(pageCursor ? { cursor: pageCursor } : {}),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4 * 1024 * 1024);
    projected.push(...result.page!.rows);
    pageCursor = result.page!.nextCursor ?? undefined;
  } while (pageCursor);
  expect(projected.map((row) => row.projectAtUs)).toEqual(Array.from({ length: 100 }, (_, n) => n));
});

async function eventPages(f: Awaited<ReturnType<typeof fixture>>, input: ProjectEvidenceInput) {
  for (let n = 0; n < 8; n++) {
    const result = await f.evidence.events(input);
    if (result.page) break;
    await f.jobs.idle();
  }
  const rows = [];
  let cursor: ProjectEvidenceCursor | undefined;
  for (let n = 0; n < 1000; n++) {
    const result = await f.evidence.events({ ...input, ...(cursor ? { cursor } : {}) });
    if (!result.page) throw new Error("events not ready");
    if (cursor) expect(result.dependencies).toEqual({ manifestId: cursor.manifestId });
    else if (input.cursor === undefined) dependencyRows(result.dependencies);
    rows.push(...result.page.rows);
    if (!result.page.nextCursor) return { rows, result };
    cursor = result.page.nextCursor;
  }
  throw new Error("event pages did not progress");
}
test("source scene readiness is independent of capture context and exact scene clocks project through repeated retimes", async () => {
  const f = await fixture({ durationUs: 1000000, originUs: 0, scenes: true });
  const selection = { assetId: f.asset.id, streamId: "video" };
  expect(f.sourceEvents.events(selection)).toMatchObject({ state: "not_ready", page: null });
  await f.jobs.idle();
  const source = f.sourceEvents.events(selection);
  expect(source.context.coverage).toContainEqual({ kind: "scene", state: "ready", reason: null });
  expect(source.context.coverage).toContainEqual({
    kind: "pause",
    state: "unavailable",
    reason: "capture_context_missing",
  });
  expect(source.page!.rows.map((row) => row.sourceAtUs)).toEqual(
    [999998, 1999998, 2999998, 3999998].map((numerator) => ({ numerator, denominator: 5 })),
  );
  expect(source.page!.rows.every((row) => !("captureAtUs" in row))).toBe(true);
  const input = f.create([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    clip(f.asset.id, "slow", "v", 0, 3000000, 0, 1000000, "video"),
    clip(f.asset.id, "again", "v", 3000000, 4000000, 0, 1000000, "video"),
  ]);
  const one = await eventPages(f, { ...input, limit: 1 });
  expect(one.rows.filter((r) => r.kind === "scene").map((r) => r.projectAtUs)).toEqual([
    599999, 1199999, 1799999, 2399999, 3200000, 3400000, 3600000, 3800000,
  ]);
  expect(one.rows.filter((r) => r.kind === "cut").map((r) => r.projectAtUs)).toEqual([3000000]);
  expect((await eventPages(f, { ...input, limit: 500 })).rows).toEqual(one.rows);
  expect(new Set(one.rows.filter((r) => r.kind !== "cut").map((r) => r.clipId)).size).toBe(2);
  const pinned = await f.evidence.events({ ...input, limit: 1 });
  const prepared = f.sceneProcessing.sourceStatus(selection);
  f.jobs.regenerate(prepared.jobId!, f.jobs.job(prepared.jobId!).generation);
  await f.jobs.idle();
  await expect(
    f.evidence.events({ ...input, cursor: pinned.page!.nextCursor }),
  ).rejects.toMatchObject({ code: "ARTIFACT_CHANGED" });
  expect((await eventPages(f, input)).rows.filter((r) => r.kind === "cut")).toEqual(
    one.rows.filter((r) => r.kind === "cut"),
  );
  expect(
    (
      await eventPages(f, { ...input, range: { startUs: 200000, endUs: 600000 }, limit: 1 })
    ).rows.map((r) => r.projectAtUs),
  ).toEqual([599999]);
});
test("mixed capture and scene source pagination preserves exact ordering and pins generation", async () => {
  const f = await fixture({ durationUs: 1000000, originUs: 0, scenes: true });
  const captured = await f.capture([
    { event: "pause", data: { atSourceUs: 200000, elapsedPauseUs: 50 } },
    geometry(400000),
  ]);
  const selection = { assetId: f.asset.id, streamId: "video", acquisitionId: captured.id };
  f.sourceEvents.events(selection);
  await f.jobs.idle();
  const first = f.sourceEvents.events({ ...selection, limit: 1 });
  const rows = [...first.page!.rows];
  let cursor = first.page!.nextCursor;
  while (cursor) {
    const page = f.sourceEvents.events({ ...selection, limit: 1, cursor }).page!;
    rows.push(...page.rows);
    cursor = page.nextCursor;
  }
  expect(rows.map((row) => row.kind)).toEqual([
    "scene",
    "pause",
    "scene",
    "geometry",
    "scene",
    "scene",
  ]);
  expect(rows).toEqual(f.sourceEvents.events({ ...selection, limit: 500 }).page!.rows);
  const prepared = f.sceneProcessing.sourceStatus(selection);
  f.jobs.regenerate(prepared.jobId!, f.jobs.job(prepared.jobId!).generation);
  await f.jobs.idle();
  expect(() =>
    f.sourceEvents.events({ ...selection, limit: 1, cursor: first.page!.nextCursor }),
  ).toThrow("changed");
  const audio = f.sourceEvents.events({ ...selection, streamId: "speech" });
  expect(audio.state).toBe("ready");
  expect(audio.page!.rows.map((r) => r.kind)).toEqual(["pause"]);
  expect(audio.context.coverage).toContainEqual({
    kind: "scene",
    state: "unavailable",
    reason: "requires_video",
  });
});

test("scene-only tied tracks preserve bounded empty-page progress and acquisition gaps", async () => {
  const f = await fixture({ durationUs: 1000000, originUs: 0, scenes: true });
  const context = await f.capture(
    [],
    [
      { startUs: 0, endUs: 300000 },
      { startUs: 600000, endUs: 1000000 },
    ],
  );
  const selected = { assetId: f.asset.id, streamId: "video", acquisitionId: context.id };
  f.sourceEvents.events(selected);
  await f.jobs.idle();
  expect(f.sourceEvents.events(selected).available).toEqual([
    { startUs: 0, endUs: 300000 },
    { startUs: 600000, endUs: 1000000 },
  ]);
  const coverage = f.sceneRead.coverage(f.sceneRead.resolve(selected), {
    startUs: 600000,
    endUs: 900000,
  });
  expect(coverage.chunks[0]!.coverage).toContainEqual({
    requestedSourceUs: 400000,
    status: "unavailable",
    reason: "outside_support",
    continuousFromPrevious: false,
  });
  expect(coverage.chunks[0]!.coverage.find((p) => p.requestedSourceUs === 600000)).toMatchObject({
    stillnessRunStartUs: 600000,
    continuousFromPrevious: false,
  });
  const operations: EditOperation[] = [];
  for (let i = 0; i < 129; i++) {
    operations.push({ operation: "track.add", label: `v${i}`, track: { kind: "video", order: i } });
    const placed = clip(f.asset.id, `c${i}`, `v${i}`, 0, 1000000, 0, 1000000, "video");
    if (placed.operation !== "place") throw Error("fixture");
    operations.push({ ...placed, clip: { ...placed.clip, acquisitionId: context.id } });
  }
  const input = f.create(operations);
  for (let n = 0; n < 4; n++) {
    await f.evidence.events({ ...input, limit: 1 });
    await f.jobs.idle();
  }
  const first = await f.evidence.events({ ...input, limit: 1 });
  expect(first.page!.rows).toEqual([]);
  expect(first.page!.nextCursor).not.toBeNull();
  const all = await eventPages(f, { ...input, limit: 500 });
  expect(all.rows).toHaveLength(258);
  expect(
    new Set(all.rows.filter((r) => r.kind !== "cut").map((r) => JSON.stringify(r.sourceAtUs))),
  ).toEqual(
    new Set([
      JSON.stringify({ numerator: 999998, denominator: 5 }),
      JSON.stringify({ numerator: 3999998, denominator: 5 }),
    ]),
  );
  expect(first.coverage!.occurrences![0]!.unavailable).toEqual([
    { startUs: 300000, endUs: 600000 },
  ]);
});

test("project-native cuts page without source evidence, survive historical heads, and belong to right query windows", async () => {
  const f = await fixture();
  const input = f.create([
    { operation: "track.add", label: "a", track: { kind: "audio", order: 0 } },
    {
      operation: "place",
      label: "s1",
      clip: {
        trackId: { label: "a" },
        source: { kind: "silence" },
        placement: { kind: "project", range: { startUs: 0, endUs: 200 } },
      },
    },
    {
      operation: "place",
      label: "s2",
      clip: {
        trackId: { label: "a" },
        source: { kind: "silence" },
        placement: { kind: "project", range: { startUs: 400, endUs: 800 } },
      },
    },
  ]);
  const all = await eventPages(f, { ...input, limit: 1 });
  expect(all.rows.map((r) => [r.kind, r.projectAtUs])).toEqual([
    ["cut", 200],
    ["cut", 400],
  ]);
  const first = await f.evidence.events({ ...input, limit: 1 });
  expect(first.dependencies).toEqual([]);
  expect(first.coverage).toMatchObject({ cuts: { state: "ready", basis: "revision" } });
  expect(first.page!.rows[0]).toMatchObject({
    before: { kind: "silence" },
    after: null,
    mediaKind: "audio",
  });
  f.projects.apply(input.projectId, {
    requestId: randomUUID(),
    expectedRevisionId: input.revisionId,
    operations: [{ operation: "track.add", label: "unused", track: { kind: "video", order: 1 } }],
  });
  const historical = await f.evidence.events({
    projectId: input.projectId,
    cursor: first.page!.nextCursor,
  });
  expect(historical.revisionId).toBe(input.revisionId);
  expect([...first.page!.rows, ...historical.page!.rows]).toEqual(all.rows);
  expect(
    (await eventPages(f, { ...input, range: { startUs: 200, endUs: 400 } })).rows.map(
      (r) => r.projectAtUs,
    ),
  ).toEqual([200]);
  expect((await eventPages(f, { ...input, range: { startUs: 201, endUs: 400 } })).rows).toEqual([]);
});

test("known-unavailable source prefixes do not delay ready editorial cuts", async () => {
  const f = await fixture();
  const input = f.create([
    track("a"),
    ...Array.from({ length: 500 }, (_, index) =>
      clip(f.asset.id, `c${index}`, "a", index * 2000, index * 2000 + 1000),
    ),
  ]);
  await f.evidence.events({ ...input, limit: 50 });
  await f.jobs.idle();
  const first = await f.evidence.events({ ...input, limit: 50 });
  expect(first.page!.rows.map((row) => [row.kind, row.projectAtUs])).toEqual(
    Array.from({ length: 50 }, (_, index) => ["cut", (index + 1) * 1000]),
  );
  expect(first.page!.nextCursor).not.toBeNull();
  expect(first.coverage).toMatchObject({ cuts: { state: "ready", basis: "revision" } });
  expect(
    dependencyRows(first.dependencies).every((dependency) => dependency.state === "unavailable"),
  ).toBe(true);
});

test("fractional capture mapping stays exact through integer filtering and project projection", async () => {
  const f = await fixture({
    originUs: { numerator: 1, denominator: 3 },
    durationUs: { numerator: 2001, denominator: 2 },
  });
  const capture = await f.capture([
    cursorSample(1),
    cursorSample(2),
    { event: "pause", data: { atSourceUs: 1, elapsedPauseUs: 77 } },
  ]);
  const selection = { assetId: f.asset.id, streamId: "video", acquisitionId: capture.id };
  expect(
    f.captureRead.cursor({ ...selection, sourceRange: { startUs: 0, endUs: 1 } }).page!.rows,
  ).toMatchObject([{ captureAtUs: 1, sourceAtUs: { numerator: 2, denominator: 3 } }]);
  expect(
    f.captureRead.cursor({ ...selection, sourceRange: { startUs: 1, endUs: 2 } }).page!.rows,
  ).toMatchObject([{ captureAtUs: 2, sourceAtUs: { numerator: 5, denominator: 3 } }]);
  const input = f.create([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    capturedClip(f.asset.id, capture.id, "first", "v", 0, 1500),
  ]);
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await f.evidence.events(input)).page) break;
    await f.jobs.idle();
  }
  const result = await f.evidence.events(input);
  expect(result.page!.rows.find((row) => row.kind === "pause")).toMatchObject({
    captureAtUs: 1,
    sourceAtUs: { numerator: 2, denominator: 3 },
    projectAtUs: 1,
  });
});

test("project speaker rows preserve exact repeated retiming and generation-local anonymous slots", async () => {
  const f = await fixture({ durationUs: 40000000, speakers: true });
  f.observeSpeaker("first", { numerator: 125, denominator: 2 });
  const input = {
    ...f.create([
      track("a"),
      clip(f.asset.id, "first", "a", 0, 20000000, 0, 30000000),
      clip(f.asset.id, "repeat", "a", 20000000, 40000000, 0, 30000000),
    ]),
    channel: 1,
    modelId: speakerSource.engine.modelId,
    limit: 1,
  };
  const rows = [];
  let cursor: ProjectEvidenceCursor | undefined;
  for (let n = 0; n < 8; n++) {
    const page = await f.evidence.speakers({ ...input, ...(cursor ? { cursor } : {}) });
    if (!page.page) {
      await f.jobs.idle();
      continue;
    }
    rows.push(...page.page.rows);
    if (!page.page.nextCursor) break;
    cursor = page.page.nextCursor;
  }
  expect(rows.map((row) => [row.slot, row.generation, row.identity])).toEqual([
    [0, "first", "unknown"],
    [1, "first", "unknown"],
    [0, "first", "unknown"],
    [1, "first", "unknown"],
  ]);
  expect(rows[0]!.sourceRange).toEqual({
    startUs: { numerator: 125, denominator: 2 },
    endUs: { numerator: 2000125, denominator: 2 },
  });
  expect(rows[0]!.fragments).toEqual([
    {
      source: rows[0]!.sourceRange,
      project: {
        startUs: { numerator: 125, denominator: 3 },
        endUs: { numerator: 2000125, denominator: 3 },
      },
    },
  ]);
  expect(rows[2]!.clipId).not.toBe(rows[0]!.clipId);
});

test("overlapping speaker observations retain native ordinals without identifying slots across generations", async () => {
  const f = await fixture({ durationUs: 40000000, speakers: true });
  f.observeSpeaker("later-window", 1000000, ["0.000 1.000 speaker_0"]);
  f.observeSpeaker("earlier-window", 0, ["2.000 3.000 speaker_1", "1.000 2.000 speaker_0"]);
  const input = {
    ...f.create([track("a"), clip(f.asset.id, "speaker-clip", "a", 0, 40000000, 0, 40000000)]),
    channel: 1,
    modelId: speakerSource.engine.modelId,
    limit: 1,
  };
  await f.ready({ ...input, domain: "speakers", prepare: false });
  const rows = [];
  let cursor: ProjectEvidenceCursor | undefined;
  for (let n = 0; n < 5; n++) {
    const result = await f.evidence.speakers({ ...input, ...(cursor ? { cursor } : {}) });
    rows.push(...result.page!.rows);
    if (!result.page!.nextCursor) break;
    cursor = result.page!.nextCursor;
  }
  expect(
    rows.map((row) => [row.sourceRange.startUs, row.generation, row.ordinal, row.slot]),
  ).toEqual([
    [1000000, "earlier-window", 1, 0],
    [1000000, "later-window", 0, 0],
    [2000000, "earlier-window", 0, 1],
  ]);
  expect(rows.every((row) => row.identity === "unknown")).toBe(true);
});

test("cropped speaker intervals paginate in projected order while retaining native ordinals", async () => {
  const f = await fixture({ durationUs: 40000000, speakers: true });
  f.observeSpeaker("cropped", 0, ["1.000 3.000 speaker_0", "0.000 4.000 speaker_1"]);
  const input = {
    ...f.create([track("a"), clip(f.asset.id, "cropped", "a", 0, 2000000, 2000000, 4000000)]),
    channel: 1,
    modelId: speakerSource.engine.modelId,
    limit: 1,
  };
  await f.ready({ ...input, domain: "speakers", prepare: false });
  const first = await f.evidence.speakers(input);
  const second = await f.evidence.speakers({ ...input, cursor: first.page!.nextCursor! });
  expect(
    [...first.page!.rows, ...second.page!.rows].map((row) => ({
      ordinal: row.ordinal,
      slot: row.slot,
      fragments: row.fragments,
      partial: row.partial,
    })),
  ).toEqual([
    {
      ordinal: 1,
      slot: 1,
      fragments: [
        { source: { startUs: 2000000, endUs: 4000000 }, project: { startUs: 0, endUs: 2000000 } },
      ],
      partial: true,
    },
    {
      ordinal: 0,
      slot: 0,
      fragments: [
        { source: { startUs: 2000000, endUs: 3000000 }, project: { startUs: 0, endUs: 1000000 } },
      ],
      partial: true,
    },
  ]);
});

test("speaker coverage separates unobserved audio from ancestor support holes and display windows", async () => {
  const f = await fixture({ durationUs: 40000000, speakers: true });
  f.observeSpeaker("observed", 0, ["0.000 1.000 speaker_0"]);
  f.catalog.catalog.prepare("INSERT INTO acquisitions VALUES(?,?,?,?)").run(
    "mask",
    "mask",
    JSON.stringify({ kind: "import", path: "fixture", files: {} }),
    JSON.stringify({
      id: "mask",
      bindings: [
        {
          assetId: f.asset.id,
          streamId: "video",
          available: [
            { startUs: 0, endUs: 400000 },
            { startUs: 600000, endUs: 40000000 },
          ],
        },
      ],
    }),
  );
  const input = {
    ...f.create([
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
      track("audio"),
      {
        operation: "place",
        label: "parent",
        clip: {
          assetId: f.asset.id,
          streamId: "video",
          acquisitionId: "mask",
          trackId: { label: "picture" },
          source: { kind: "range", range: { startUs: 0, endUs: 40000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 40000000 } },
        },
      },
      {
        operation: "place",
        label: "child",
        clip: {
          assetId: f.asset.id,
          streamId: "speech",
          trackId: { label: "audio" },
          source: { kind: "range", range: { startUs: 0, endUs: 40000000 } },
          placement: {
            kind: "content",
            clipId: { label: "parent" },
            sourceRange: { startUs: 0, endUs: 40000000 },
          },
        },
      },
    ]),
    channel: 1,
    modelId: speakerSource.engine.modelId,
  };
  await f.ready({ ...input, domain: "speakers", prepare: false });
  const full = await f.evidence.speakers(input);
  expect(full.coverage!.occurrences![0]).toMatchObject({
    observed: [
      { startUs: 0, endUs: 400000 },
      { startUs: 600000, endUs: 30000000 },
    ],
    unobserved: [{ startUs: 30000000, endUs: 40000000 }],
    unavailable: [{ startUs: 400000, endUs: 600000 }],
  });
  const narrow = { ...input, range: { startUs: 300000, endUs: 800000 } };
  await f.ready({ ...narrow, domain: "speakers", prepare: false });
  const result = await f.evidence.speakers(narrow);
  expect(result.page!.rows[0]).toMatchObject({
    partial: true,
    sourceRange: { startUs: 0, endUs: 1000000 },
    fragments: [
      { source: { startUs: 0, endUs: 400000 }, project: { startUs: 0, endUs: 400000 } },
      { source: { startUs: 600000, endUs: 1000000 }, project: { startUs: 600000, endUs: 1000000 } },
    ],
  });
  expect(result.coverage!.occurrences![0]!.unobserved).toEqual([]);
});

test("speaker cursors advance through empty source pages and reject changed selector or generation", async () => {
  const f = await fixture({ durationUs: 40000000, speakers: true });
  f.observeSpeaker("first", 0, [
    ...Array.from({ length: 130 }, () => "0.000 1.000 speaker_0"),
    "3.000 4.000 speaker_1",
  ]);
  const input = {
    ...f.create([track("a"), clip(f.asset.id, "speaker-clip", "a", 0, 1000000, 3000000, 4000000)]),
    channel: 1,
    modelId: speakerSource.engine.modelId,
    limit: 1,
  };
  await f.ready({ ...input, domain: "speakers", prepare: false });
  const empty = await f.evidence.speakers(input);
  expect(empty.page!.rows).toEqual([]);
  expect(empty.page!.nextCursor).not.toBeNull();
  const cursor = empty.page!.nextCursor!;
  await expect(f.evidence.speakers({ ...input, cursor, channel: 0 })).rejects.toMatchObject({
    code: "INVALID_PARAMS",
  });
  await expect(
    f.evidence.speakers({ ...input, cursor, modelId: "different" }),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  const next = await f.evidence.speakers({ ...input, cursor });
  expect(next.page!.rows.map((row) => [row.ordinal, row.slot, row.sourceRange])).toEqual([
    [130, 1, { startUs: 3000000, endUs: 4000000 }],
  ]);
  f.speakerMetadata.splice(0);
  f.observeSpeaker("replacement", 0, ["3.000 4.000 speaker_1"]);
  await expect(f.evidence.speakers({ ...input, cursor })).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
});

test("missing speaker evidence is reported without preparing sources or suppressing observed rows", async () => {
  const f = await fixture({ durationUs: 40000000, speakers: true });
  f.observeSpeaker("known", 0, ["0.000 1.000 speaker_0"]);
  const input = {
    ...f.create([
      track("a"),
      clip(f.asset.id, "known", "a", 0, 30000000, 0, 30000000),
      clip(f.asset.id, "unknown", "a", 30000000, 60000000, 0, 30000000, "empty"),
    ]),
    channel: 1,
    modelId: speakerSource.engine.modelId,
  };
  const prepare = vi.spyOn(f.transcripts, "sourceStatus");
  await f.ready({ ...input, domain: "speakers", prepare: false });
  const result = await f.evidence.speakers(input);
  expect(result.page!.rows.map((row) => row.generation)).toEqual(["known"]);
  expect(dependencyRows(result.dependencies).map((d) => [d.state, d.reason])).toEqual([
    ["unavailable", "source_evidence_unobserved"],
    ["ready", null],
  ]);
  expect(
    result.coverage!.occurrences!.find((v) => v.unobserved!.some((r) => r.startUs === 30000000))!
      .unobserved,
  ).toEqual([{ startUs: 30000000, endUs: 60000000 }]);
  expect(prepare).not.toHaveBeenCalled();
});

test("overlapping phrase search keeps its widest retimed envelope across repeated occurrences", async () => {
  const f = await fixture({ wordExtents: [600, 100, 100] });
  const input = f.create([
    track("speech"),
    clip(f.asset.id, "first", "speech", 0, 3333),
    clip(f.asset.id, "repeat", "speech", 3333, 6666),
  ]);
  const query = { ...input, text: "one two" };
  await f.ready(query);
  const first = await f.evidence.search({ ...query, limit: 1 });
  expect(first.page?.entries.map((entry) => entry.projectRange)).toEqual([
    { startUs: { numerator: 3333, denominator: 10 }, endUs: { numerator: 23331, denominator: 10 } },
  ]);
  const second = await f.evidence.search({ ...query, limit: 1, cursor: first.page!.nextCursor });
  expect(second.page?.entries.map((entry) => entry.projectRange)).toEqual([
    {
      startUs: { numerator: 36663, denominator: 10 },
      endUs: { numerator: 56661, denominator: 10 },
    },
  ]);
  expect(first.page!.entries[0]!.words.map((word) => word.sourceRange)).toEqual([
    { startUs: 100, endUs: 700 },
    { startUs: 400, endUs: 500 },
  ]);
  const repeated = f.projects.revision(input.projectId, input.revisionId).document.clips[1]!.id;
  expect(second.page!.entries[0]!.words.map((word) => word.clipId)).toEqual([repeated, repeated]);
});

test("project cursor reads carry the sample in force into each cut opening", async () => {
  const f = await fixture({ durationUs: 1000, originUs: 0 });
  const acquisition = await f.capture(
    [geometry(0), cursorSample(100), cursorSample(700)],
    undefined,
    true,
  );
  const place = (label: string, start: number) => {
    const operation = clip(f.asset.id, label, "v", start, start + 400, 200, 600, "video");
    if (operation.operation !== "place") throw Error("Expected place");
    return { ...operation, clip: { ...operation.clip, acquisitionId: acquisition.id } };
  };
  const input = f.create([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    place("a", 0),
    place("b", 400),
  ]);
  await f.ready({ ...input, domain: "cursor" });
  const rows = [];
  let cursor: unknown;
  do {
    const page = await f.evidence.cursor({ ...input, limit: 1, ...(cursor ? { cursor } : {}) });
    rows.push(...page.page!.rows);
    cursor = page.page!.nextCursor;
  } while (cursor);
  expect(
    rows.map((row) => {
      if (row.kind !== "cursor") throw Error("Expected cursor evidence");
      return [row.projectAtUs, row.captureAtUs, row.observation.sourceUs];
    }),
  ).toEqual([
    [0, 100, 100],
    [400, 100, 100],
  ]);
  const raw = f.captureRead.cursor({
    assetId: f.asset.id,
    streamId: "video",
    acquisitionId: acquisition.id,
    sourceRange: { startUs: 200, endUs: 600 },
    limit: 1,
  });
  expect(raw.page!.rows.map((row) => [row.sourceAtUs, row.captureAtUs])).toEqual([[200, 100]]);
});
