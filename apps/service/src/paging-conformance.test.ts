import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { fstatSync } from "node:fs";
import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "@yap/core/catalog";
import { operationSchema, hasPageParams, pageResult, type OperationResult } from "@yap/protocol";
import { projectServiceFixture } from "./project-service.fixture.js";
import { seedRecordingStates } from "./capture-store.fixture.js";
import { captureFixture, settleCapture, sourceWorker } from "./project-capture.fixture.js";
import { alignmentProbe, publishRetainedAlignment } from "./alignment.fixture.js";
import { publishControlledObservation, speakerSource } from "./speaker.fixture.js";
import { controlledSpeech, modelMetadata } from "./transcript.fixture.js";
import type { MediaWorker } from "./worker.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Paged operations whose reader cannot be seeded through the service, and the test that covers it. */
const exclusions: Record<string, string> = {
  "audio.pause.get":
    "pause analysis renders source PCM through the native audio worker; the handler pages with filteredPage, covered by core page-cursor.test.ts › filteredPage › conforms to the paging contract over one underlying page",
  "index.get":
    "publishing a screenshot index needs native scene detection and frame decoding; covered by core source-index-processing.test.ts › source index, coverage and face-trajectory pages conform to the paging contract",
  "index.coverage":
    "publishing a screenshot index needs native scene detection and frame decoding; covered by core source-index-processing.test.ts › source index, coverage and face-trajectory pages conform to the paging contract",
  "face.trajectory.get":
    "face observations come from native picture analysis; covered by core source-index-processing.test.ts › source index, coverage and face-trajectory pages conform to the paging contract",
  "transcript.render.get":
    "rendered speech needs a native project audio render; covered by core rendered-speech.test.ts › rendered speech pages conform to the paging contract",
};

type Call = (operation: string, params: Record<string, unknown>) => Promise<OperationResult>;
type Fixture = {
  call: Call;
  params: Record<string, unknown>;
  plural: string;
  ids?: (value: unknown) => string;
  /** Library listings are newest first; evidence keeps its own meaningful order. */
  expectedOrder?: string[];
  /** The same operation with another filter set; a continuation from `params` must not apply. */
  otherFilters?: Record<string, unknown>[];
};

const canvas = {
  width: 16,
  height: 16,
  fps: { numerator: 30, denominator: 1 },
  background: "#000000ff",
};
const image = {
  originUs: 0,
  streams: [
    {
      id: "image:0",
      kind: "image",
      codec: "public.png",
      decodable: true,
      width: 2,
      height: 1,
      orientedWidth: 2,
      orientedHeight: 1,
      orientation: 1,
    },
  ],
};
const imageWorker: MediaWorker = async (operation) =>
  operation === "media.probe" ? { ok: true, data: image } : { ok: true, data: {} };

async function service(
  worker: MediaWorker = imageWorker,
  options: Parameters<typeof projectServiceFixture>[3] = {},
  home?: string,
) {
  return projectServiceFixture(cleanups, worker, home, options);
}
type Service = Awaited<ReturnType<typeof service>>;

function data<T>(result: OperationResult): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data as T;
}
async function importAsset(f: Service, requestId: string, path = f.path) {
  const imported = data<{ jobId: string }>(await f.call("asset.import", { requestId, path }));
  return (await f.job(imported.jobId, "ready")).published!.output.assetId;
}
async function createProject(f: Service, requestId: string) {
  return data<{ project: { projectId: string }; revision: { revisionId: string } }>(
    await f.call("project.create", { requestId, canvas }),
  );
}
/** Waits for an evidence read to publish, joining the job it reports while pending. */
async function ready(f: Service, operation: string, params: Record<string, unknown>) {
  const read = data<{ state: string; jobId?: string | null }>(await f.call(operation, params));
  if (read.state !== "ready" && read.jobId) await f.job(read.jobId, "ready");
  expect(data<{ state: string }>(await f.call(operation, params)).state).toBe("ready");
}
/** Speech with one repeated phrase so search, review and disfluency each have several rows. */
const repeated = [
  { text: "Um,", startUs: 100_000, endUs: 300_000 },
  { text: "press", startUs: 400_000, endUs: 700_000 },
  { text: "record.", startUs: 800_000, endUs: 1_100_000 },
  { text: "Uh,", startUs: 1_200_000, endUs: 1_400_000 },
  { text: "press", startUs: 1_500_000, endUs: 1_800_000 },
  { text: "record.", startUs: 1_900_000, endUs: 2_200_000 },
  { text: "Um,", startUs: 4_100_000, endUs: 4_300_000 },
  { text: "press", startUs: 4_500_000, endUs: 5_000_000 },
  { text: "record.", startUs: 5_100_000, endUs: 5_800_000 },
];
async function transcribed() {
  const f = await service(controlledSpeech([], [], repeated));
  await modelMetadata(await realpath(join(f.home, "library")));
  const assetId = await importAsset(f, "speech");
  const selection = { assetId, streamId: "track:1" };
  const pending = data<{ jobId: string }>(await f.call("transcript.transcribe", selection));
  await f.job(pending.jobId, "ready");
  return { ...f, selection };
}

const fixtures: Record<string, () => Promise<Fixture>> = {
  "project.list": async () => {
    const f = await service();
    const created: string[] = [];
    for (const title of ["one", "two", "three", "four"]) {
      const { project } = await createProject(f, `paging-${title}`);
      created.push(project.projectId);
    }
    return {
      call: f.call,
      params: {},
      plural: "projects",
      ids: (value) => (value as { projectId: string }).projectId,
      expectedOrder: created.reverse(),
    };
  },
  "asset.list": async () => {
    const f = await service();
    const assetIds: string[] = [];
    for (const name of ["one", "two", "three", "four"]) {
      const path = join(f.home, `${name}.png`);
      await writeFile(path, `${name} image bytes`);
      assetIds.push(await importAsset(f, `asset-${name}`, path));
    }
    return {
      call: f.call,
      params: {},
      plural: "assets",
      ids: (value) => (value as { assetId: string }).assetId,
      expectedOrder: assetIds.reverse(),
    };
  },
  "asset.origins": async () => {
    const f = await service();
    const origins: string[] = [];
    for (const name of ["one", "two", "three", "four"]) {
      const path = join(f.home, `same-${name}.png`);
      await writeFile(path, "identical image bytes");
      origins.push(await importAsset(f, `origin-${name}`, path));
    }
    expect(new Set(origins).size, "identical bytes share one asset").toBe(1);
    const other = await importAsset(f, "other-origin");
    return {
      call: f.call,
      params: { assetId: origins[0] },
      plural: "origins",
      otherFilters: [{ assetId: other }],
    };
  },
  "asset.segments": async () => {
    const segments = [0, 1, 2, 3].map((index) => ({
      startUs: index * 1_000_000,
      endUs: (index + 1) * 1_000_000,
      empty: index % 2 === 1,
    }));
    const stream = (id: string) => ({
      id,
      kind: "audio",
      codec: "pcm",
      decodable: true,
      startUs: 0,
      endUs: 4_000_000,
      segments,
    });
    const f = await service(async (operation) =>
      operation === "media.probe"
        ? { ok: true, data: { originUs: 0, streams: [stream("a1"), stream("a2")] } }
        : { ok: true, data: {} },
    );
    const assetId = await importAsset(f, "segmented");
    return {
      call: f.call,
      params: { assetId, streamId: "a1" },
      plural: "segments",
      ids: (value) => String((value as { ordinal: number }).ordinal),
      otherFilters: [{ assetId, streamId: "a2" }],
    };
  },
  "model.list": async () => {
    const f = await service();
    return {
      call: f.call,
      params: {},
      plural: "models",
      ids: (value) => (value as { modelId: string }).modelId,
    };
  },
  "preset.list": async () => {
    const f = await service(undefined, {
      presets: { bundled: join(import.meta.dirname, "../../../presets") },
    });
    return {
      call: f.call,
      params: {},
      plural: "presets",
      ids: (value) => (value as { presetId: string }).presetId,
    };
  },
  "revision.history": async () => {
    const f = await service();
    const projects = [await createProject(f, "history"), await createProject(f, "other")];
    let revisionId = projects[0]!.revision.revisionId;
    for (const width of [32, 48, 64]) {
      const edited = data<{ revision: { revisionId: string } }>(
        await f.call("edit.apply", {
          projectId: projects[0]!.project.projectId,
          requestId: `resize-${width}`,
          expectedRevisionId: revisionId,
          operations: [{ operation: "canvas.set", canvas: { ...canvas, width } }],
        }),
      );
      revisionId = edited.revision.revisionId;
    }
    return {
      call: f.call,
      params: { projectId: projects[0]!.project.projectId },
      plural: "revisions",
      ids: (value) => (value as { revisionId: string }).revisionId,
      otherFilters: [{ projectId: projects[1]!.project.projectId }],
    };
  },
  "recording.list": async () => {
    const home = await mkdtemp(join(tmpdir(), "paging-recordings-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const { complete, failed, unfinished } = await seedRecordingStates(home);
    const f = await service(undefined, {}, home);
    return {
      call: f.call,
      params: {},
      plural: "recordings",
      ids: (value) => (value as { recordingId: string }).recordingId,
      expectedOrder: [unfinished, failed, complete].map((take) => take.recordingId),
    };
  },
  "media.list": async () => {
    const home = await mkdtemp(join(tmpdir(), "paging-media-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    await seedRecordingStates(home);
    const f = await service(undefined, {}, home);
    return {
      call: f.call,
      params: {},
      plural: "media",
      ids: (value) => {
        const row = value as { kind: string; id: string };
        return `${row.kind}:${row.id}`;
      },
    };
  },
  "export.list": async () => {
    // Admission identifies the destination directory and finds no file to replace.
    const f = await service(async (operation, params, options) => {
      if (operation === "publication.inspect") return { ok: true, data: { file: null } };
      if (operation !== "storage.externalDirectory") return imageWorker(operation, params, options);
      const info = fstatSync(options!.descriptors![0]!, { bigint: true });
      return { ok: true, data: { dev: String(info.dev), ino: String(info.ino) } };
    });
    const assetId = await importAsset(f, "picture");
    const projectIds: string[] = [];
    for (const name of ["exported", "other"]) {
      const { project, revision } = await createProject(f, name);
      data(
        await f.call("edit.apply", {
          projectId: project.projectId,
          requestId: `${name}-place`,
          expectedRevisionId: revision.revisionId,
          operations: [
            { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
            {
              operation: "place",
              clip: {
                trackId: { label: "picture" },
                assetId,
                streamId: "image:0",
                source: { kind: "hold", atUs: 0 },
                placement: { kind: "project", range: { startUs: 0, endUs: 1_000_000 } },
              },
            },
          ],
        }),
      );
      projectIds.push(project.projectId);
    }
    const exportIds: string[] = [];
    for (const [index, projectId] of [0, 0, 1, 0].map((at) => [at, projectIds[at]!] as const)) {
      const exportId = `${exportIds.length + 1}0000000-0000-4000-8000-00000000000${index}`;
      data(
        await f.call("export.create", {
          projectId,
          requestId: exportId,
          kind: "video",
          directory: f.home,
          leaf: `${exportId}.mp4`,
        }),
      );
      if (index === 0) exportIds.push(exportId);
    }
    return {
      call: f.call,
      params: { projectId: projectIds[0] },
      plural: "exports",
      ids: (value) => (value as { exportId: string }).exportId,
      expectedOrder: exportIds.reverse(),
      otherFilters: [
        {},
        { projectId: projectIds[1] },
        { projectId: projectIds[0], unfinishedOnly: true },
      ],
    };
  },
  "correspondence.get": async () => {
    const f = await service(async () => ({ ok: true, data: {} }));
    const endpoint = (assetId: string) => ({
      kind: "source",
      assetId,
      streamId: "audio-1",
      channel: 0,
      sourceRange: { startUs: 0, endUs: 4_000_000 },
    });
    const candidate = {
      offsetUs: 120_000,
      residualUs: 1000,
      coverage: 1,
      driftPpm: 0,
      score: 0.9,
      selected: true,
    };
    const anchor = (second: number) => ({
      leftRange: { startUs: second * 1_000_000, endUs: (second + 1) * 1_000_000 },
      rightRange: { startUs: second * 1_000_000 + 120_000, endUs: (second + 1) * 1_000_000 },
      candidates: [candidate],
      selected: 0,
    });
    for (const evidenceId of ["e1", "e2"])
      data(
        await f.call("correspondence.prepare", {
          evidenceId,
          generation: "g1",
          left: endpoint("a"),
          right: endpoint("b"),
          measurement: {
            verdict: "accepted",
            reason: "known delay control",
            anchors: [0, 1, 2].map(anchor),
            candidates: [candidate],
            offsetUs: 120_000,
            residualUs: 1000,
            coverage: 1,
            driftPpm: 0,
            policy: {
              minimumCoverage: 0.8,
              maximumResidualUs: 10_000,
              maximumDriftPpm: 20,
              minimumAnchors: 1,
            },
          },
        }),
      );
    return {
      call: f.call,
      params: { evidenceId: "e1", generation: "g1" },
      plural: "anchors",
      otherFilters: [{ evidenceId: "e2", generation: "g1" }],
    };
  },
  "transcript.get": async () => {
    const f = await transcribed();
    return {
      call: f.call,
      params: f.selection,
      plural: "rows",
      otherFilters: [{ ...f.selection, range: { startUs: 0, endUs: 2_000_000 } }],
    };
  },
  "transcript.review": async () => {
    const f = await transcribed();
    const params = {
      ...f.selection,
      sourceRange: { startUs: 0, endUs: 6_000_000 },
    };
    await ready(f, "transcript.review", params);
    return {
      call: f.call,
      params,
      plural: "rows",
      otherFilters: [{ ...params, sourceRange: { startUs: 0, endUs: 2_000_000 } }],
    };
  },
  "transcript.search": async () => {
    const f = await transcribed();
    return {
      call: f.call,
      params: { ...f.selection, text: "press RECORD" },
      plural: "entries",
      otherFilters: [{ ...f.selection, text: "press" }],
    };
  },
  "transcript.disfluency.get": async () => {
    const f = await transcribed();
    return {
      call: f.call,
      params: f.selection,
      plural: "rows",
      otherFilters: [{ ...f.selection, range: { startUs: 0, endUs: 2_000_000 } }],
    };
  },
  "alignment.get": async () => {
    const f = await service(async (operation) => {
      if (operation !== "media.probe") throw new Error(operation);
      return { ok: true, data: alignmentProbe };
    });
    const assetId = await importAsset(f, "retained-alignment");
    const library = join(f.home, "library"),
      catalog = new Catalog(join(library, "catalog.sqlite"));
    const { identity } = (() => {
      try {
        return publishRetainedAlignment(catalog, library, assetId);
      } finally {
        catalog.close();
      }
    })();
    const params = {
      assetId,
      generation: identity.generation,
      view: "acoustic",
      thresholdRMS: 0.1,
    };
    return {
      call: f.call,
      params,
      plural: "rows",
      otherFilters: [{ ...params, thresholdRMS: 0.2 }],
    };
  },
  "speaker.get": async () => {
    const f = await service(async (operation) => {
      if (operation !== "media.probe") throw new Error(operation);
      return {
        ok: true,
        data: {
          originUs: -250000,
          streams: [
            {
              id: "audio",
              kind: "audio",
              codec: "controlled",
              decodable: true,
              channels: 2,
              sampleRate: 16000,
              startUs: 0,
              endUs: 40000000,
              segments: [{ startUs: 0, endUs: 40000000, empty: false }],
            },
          ],
        },
      };
    });
    const input = {
      assetId: await importAsset(f, "retained-speaker"),
      streamId: "audio",
      channel: 1,
      sourceRange: speakerSource.observationRange,
      modelId: speakerSource.engine.modelId,
    };
    await publishControlledObservation(f.home, input, [
      "0.000 1.000 speaker_0",
      "0.500 2.000 speaker_1",
      "3.000 4.000 speaker_0",
      "5.000 6.000 speaker_1",
    ]);
    const { sourceRange, ...selection } = input;
    const params = { ...selection, sourceRange: sourceRange };
    return {
      call: f.call,
      params,
      plural: "rows",
      otherFilters: [
        { ...params, view: "scores" },
        { ...params, sourceRange: { startUs: 0, endUs: 2_000_000 } },
      ],
    };
  },
  "timeline.events": async () => {
    const f = await service(async () => ({
      ok: false,
      error: {
        code: "MEDIA_WORKER_UNAVAILABLE",
        message: "Controlled fixture has no native audio renderer",
        retryable: false,
        details: {},
      },
    }));
    const { project, revision } = await createProject(f, "events");
    const placed = data<{ revision: { revisionId: string } }>(
      await f.call("edit.apply", {
        projectId: project.projectId,
        expectedRevisionId: revision.revisionId,
        requestId: "events-place",
        operations: [
          { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
          ...[0, 1, 2].map((index) => ({
            operation: "place",
            clip: {
              trackId: { label: "audio" },
              source: { kind: "silence" },
              placement: {
                kind: "project",
                range: { startUs: index * 300_000, endUs: index * 300_000 + 200_000 },
              },
            },
          })),
        ],
      }),
    );
    const params = {
      projectId: project.projectId,
      revisionId: placed.revision.revisionId,
      range: { startUs: 0, endUs: 1_000_000 },
    };
    await ready(f, "timeline.events", params);
    return {
      call: f.call,
      params,
      plural: "rows",
      otherFilters: [{ ...params, range: { startUs: 0, endUs: 500_000 } }],
    };
  },
  "cursor.raw": async () => {
    const samples = [10, 20, 30, 40];
    const f = await captureFixture(cleanups, undefined, async (operation, params, options) => {
      const result = await sourceWorker(operation, params, options);
      if (operation !== "media.sourceEvidence" || !result.ok) return result;
      const records = [
        {
          event: "geometry",
          data: {
            epoch: 1,
            sourceUs: 0,
            hostUs: 0,
            geometry: {
              outputWidth: 16,
              outputHeight: 16,
              contentScale: 1,
              scaleFactor: 1,
              contentRect: { x: 0, y: 0, width: 16, height: 16 },
            },
          },
        },
        ...samples.map((sourceUs) => ({
          event: "cursorSample",
          data: {
            sourceUs,
            x: sourceUs / 10,
            y: 2,
            globalX: sourceUs / 10,
            globalY: 2,
            buttons: 0,
            eligibility: "inside",
            geometryEpoch: 1,
          },
        })),
      ];
      const body = records.map((row) => JSON.stringify(row) + "\n").join("");
      await writeFile(String(params.output), body);
      return {
        ok: true,
        data: {
          ...(result.data as Record<string, unknown>),
          cursorSamples: samples.length,
          geometryRecords: 1,
          firstCursorSourceUs: samples[0],
          lastCursorSourceUs: samples.at(-1),
          lastSequence: records.length,
          bytes: Buffer.byteLength(body),
        },
      };
    });
    const take = await settleCapture(f, "paged-cursor");
    await expect
      .poll(() => f.call("job.get", { jobId: take.job.id }))
      .toMatchObject({ ok: true, data: { state: "ready" } });
    const acquisition = data<{ id: string; bindings: { assetId: string; streamId: string }[] }>(
      await f.call("acquisition.get", { acquisitionId: take.acquisitionId }),
    );
    const binding = acquisition.bindings[0]!;
    const params = {
      assetId: binding.assetId,
      streamId: binding.streamId,
      acquisitionId: acquisition.id,
    };
    return {
      call: f.call,
      params,
      plural: "rows",
      otherFilters: [{ ...params, sourceRange: { startUs: 0, endUs: 25 } }],
    };
  },
};

const paged = operationSchema.options
  .filter((option) => hasPageParams(option.shape.params))
  .map((option) => option.shape.operation.value as string);

/** A real continuation minted by another paged operation, for the foreign-scope refusal. */
let foreign: { operation: string; cursor: string }[] = [];
const foreignCleanups: (() => Promise<void>)[] = [];
beforeAll(async () => {
  const f = await projectServiceFixture(foreignCleanups, imageWorker);
  for (const requestId of ["foreign-one", "foreign-two"])
    data(await f.call("project.create", { requestId, canvas }));
  for (const operation of ["project.list", "model.list"]) {
    const page = data<{ nextCursor: string | null }>(await f.call(operation, { limit: 1 }));
    foreign.push({ operation, cursor: page.nextCursor! });
  }
});
afterAll(async () => {
  for (const cleanup of foreignCleanups.splice(0).reverse()) await cleanup();
  foreign = [];
});

test("every schema-declared paged operation has a real fixture or a named covering test", () => {
  expect(paged.length).toBeGreaterThan(0);
  const missing = paged.filter((operation) => !fixtures[operation] && !exclusions[operation]);
  expect(missing, "new paged operations require a fixture or explicit exclusion").toEqual([]);
  expect(Object.keys(fixtures).concat(Object.keys(exclusions)).sort()).toEqual([...paged].sort());
});

function refused(result: OperationResult) {
  return result.ok ? "ok" : result.error.code;
}

test.for(paged.filter((operation) => fixtures[operation]))(
  "%s follows the shared paging contract",
  { timeout: 30_000 },
  async (operation) => {
    const fixture = await fixtures[operation]!();
    const { call, params, plural } = fixture;
    const ids = fixture.ids ?? ((value: unknown) => JSON.stringify(value));
    const parsed = operationSchema.parse({ operation, params }).params as { limit: number };
    expect(parsed.limit, "schema default").toBe(100);
    for (const limit of [0, 1001])
      expect(refused(await call(operation, { ...params, limit })), `limit ${limit}`).toBe(
        "INVALID_PARAMS",
      );

    const first = await call(operation, { ...params, limit: 1 });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(pageResult(plural).safeParse(first.data).success, JSON.stringify(first.data)).toBe(true);
    const firstCursor = (first.data as { nextCursor: string | null }).nextCursor;
    expect(firstCursor, "the fixture must seed more than one page").toEqual(expect.any(String));

    const pageIds = (value: unknown) =>
      ((value as Record<string, unknown>)[plural] as unknown[]).map(ids);
    const whole = data(await call(operation, { ...params, limit: 1000 }));
    expect((whole as { nextCursor: string | null }).nextCursor).toBeNull();
    const expected = pageIds(whole);
    expect(expected.length, "at least three pages at limit 1").toBeGreaterThanOrEqual(3);
    const traversed: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      expect(pages, "limit-1 traversal must end").toBeLessThanOrEqual(expected.length * 2 + 2);
      const page = data<Record<string, unknown> & { nextCursor: string | null }>(
        await call(operation, { ...params, limit: 1, ...(cursor ? { cursor } : {}) }),
      );
      expect(pageResult(plural).safeParse(page).success).toBe(true);
      traversed.push(...pageIds(page));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(traversed, "limit-1 traversal equals one limit-1000 page").toEqual(expected);
    expect(new Set(traversed).size, "no duplicates").toBe(traversed.length);
    if (fixture.expectedOrder) expect(traversed, "newest first").toEqual(fixture.expectedOrder);

    expect(refused(await call(operation, { ...params, limit: 1, cursor: "garbage" }))).toBe(
      "INVALID_PARAMS",
    );
    const other = foreign.find((candidate) => candidate.operation !== operation)!;
    expect(
      refused(await call(operation, { ...params, limit: 1, cursor: other.cursor })),
      `${other.operation} cursor`,
    ).toBe("INVALID_PARAMS");
    for (const filters of fixture.otherFilters ?? [])
      expect(
        refused(await call(operation, { ...filters, limit: 1, cursor: firstCursor! })),
        `continuation reused with ${JSON.stringify(filters)}`,
      ).toBe("INVALID_PARAMS");
  },
);
