import { AcousticInspection } from "./acoustic-inspection.js";
import { ProjectPreviewInspection } from "./project-preview.js";
import { fstatSync } from "node:fs";
import { DerivedCache } from "./cache.js";
import { MediaAudioInspection } from "./audio-inspection.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import {
  projectComposition,
  projectCompositionFromRevision,
  type AudioWindowInput,
} from "./project-window.js";
import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile, rename, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { ResourceReferences } from "./references.js";
import { JobQueue, type StagedJobResult } from "./jobs.js";
import { PreparedAudioStore, type PreparedAudio } from "./prepared-audio.js";
import { normalizationTolerance } from "./audio-measurement.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function wave(frames: number) {
  const bytes = Buffer.alloc(44 + frames * 8);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(384000, 28);
  bytes.writeUInt16LE(8, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    bytes.writeFloatLE((i % 101) / 256, 44 + i * 8);
    bytes.writeFloatLE((-i % 67) / 128, 48 + i * 8);
  }
  return bytes;
}
async function fixture(
  gaps: { start: number; end: number }[] = [],
  implementationId = "unit-test-native-boundary",
  deferExecution = false,
  processors?: Record<string, string>,
  processingEvidence?: (window: AudioWindowInput["window"]) => unknown[],
) {
  const home = await realpath(await mkdtemp("/tmp/prepared-audio-"));
  let reads = 0;
  const renderedAssets: AudioWindowInput["assets"][] = [];
  let hold: ((result: StagedJobResult) => Promise<void>) | undefined;
  async function connect() {
    const catalog = new Catalog(join(home, "catalog.sqlite"));
    const assets = new AssetStore(catalog, home);
    await assets.recover();
    const projects = projectStoreFixture(catalog, assets, home, new AcquisitionStore(catalog));
    let prepared!: PreparedAudioStore;
    const jobs = new JobQueue({
      store: catalog,
      deferExecution,
      providers: { newId: randomUUID },
      targets: {
        pin: (target) => {
          if (target.kind !== "project") throw Error("project");
          projects.revision(target.id, target.revisionId);
          return target;
        },
        isAvailable: (target) => target.kind === "project" && !projects.isDeleting(target.id),
        isDeleting: (target) => target.kind === "project" && projects.isDeleting(target.id),
        isCapturing: () => false,
      },
      execute: async (execution) => {
        const result = await prepared.execute(execution);
        await hold?.(result);
        return result;
      },
    });
    const probe = async (path: string) => {
      const count = ((await readFile(path)).length - 44) / 8;
      return {
        originUs: 0,
        streams: [
          {
            id: "track:1",
            kind: "audio",
            codec: "pcm_f32le",
            decodable: true,
            startUs: 0,
            endUs: Math.ceil((count / 48000) * 1000000),
            segments: [{ startUs: 0, endUs: Math.ceil((count / 48000) * 1000000), empty: false }],
            sampleRate: 48000,
            channels: 2,
          },
        ],
      };
    };
    prepared = new PreparedAudioStore({
      catalog,
      assets,
      projects,
      jobs,
      staging: join(home, "staging", "prepared-audio"),
      probe,
      renderer: {
        implementationId,
        ...(processors ? { processors, validateAudio: async () => {} } : {}),
        render: async ({ window, output, assets }) => {
          reads++;
          renderedAssets.push(assets);
          const frames = window.manifest.sampleRange.end - window.manifest.sampleRange.start;
          const bytes = wave(frames);
          await writeFile(output, bytes);
          return {
            file: output,
            bytes: bytes.length,
            sampleRate: 48000,
            channels: 2,
            frames,
            peak: 1,
            clippedSamples: 0,
            maximumBlockFrames: 1024,
            peakResidentBytes: 0,
            decoderContext: {
              policy: "bounded-current-retained-run",
              sampleRate: 48000,
              maximumPrerollFrames: 0,
              maximumTailFrames: 0,
            },
            unavailable: [...window.audio()]
              .filter((clip) => clip.source.kind === "range")
              .map((clip) => ({ clipId: clip.clipId, ranges: gaps })),
            ...(processingEvidence ? { processingEvidence: processingEvidence(window) } : {}),
          };
        },
      },
    });
    await prepared.recover();
    return {
      catalog,
      assets,
      projects,
      jobs,
      prepared,
      probe,
      close: async () => {
        await jobs.close();
        catalog.close();
      },
    };
  }
  let current = await connect();
  cleanup.push(async () => {
    await current.close();
    await rm(home, { recursive: true, force: true });
  });
  const input = join(home, "source.wav");
  const sourceBytes = wave(48000);
  sourceBytes.writeFloatLE(0.99, 44);
  await writeFile(input, sourceBytes);
  const asset = await current.assets.import(input, { kind: "import" }, current.probe);
  const created = current.projects.create({
    requestId: "create",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const placed = current.projects.apply(created.project.id, {
    requestId: "place",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "track", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: "track:1",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  return {
    home,
    asset,
    placed,
    input: { projectId: created.project.id, revisionId: placed.revision.id },
    get current() {
      return current;
    },
    get reads() {
      return reads;
    },
    renderedAssets,
    setHold: (value: typeof hold) => {
      hold = value;
    },
    reopen: async (nextImplementation = implementationId, nextProcessors = processors) => {
      await current.close();
      implementationId = nextImplementation;
      processors = nextProcessors;
      current = await connect();
      return current;
    },
  };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  await f.current.prepared.request(f.input);
  await f.current.jobs.idle();
  const status = await f.current.prepared.request(f.input);
  expect(status.state).toBe("ready");
  return JSON.parse(status.published!.result) as PreparedAudio & {
    sizeBytes: number;
    frameCount: number;
    sampleRange: { startSamples: number; endSamples: number };
  };
}
test("retains exact PCM and immutable revision dependencies; bounded reads survive restart and newer edits", async () => {
  const f = await fixture();
  const document = JSON.stringify(f.placed.revision.document);
  const value = await ready(f);
  const refs = new ResourceReferences(f.current.catalog).dependencies({
    kind: "revision",
    id: f.input.revisionId,
  });
  expect(refs).toContainEqual({ kind: "prepared-audio", id: value.resourceId });
  expect(refs).toContainEqual({ kind: "asset", id: value.assetId });
  expect(value.dependencies).toContainEqual({
    kind: "asset",
    id: f.asset.id,
  });
  expect(
    JSON.stringify(f.current.projects.revision(f.input.projectId, f.input.revisionId).document),
  ).toBe(document);
  const check = () => {
    const excerpt = f.current.prepared.open(value.resourceId, { start: 47003, end: 47017 });
    try {
      const bytes = Buffer.alloc(1024);
      expect(excerpt.read(bytes, 0)).toBe(14 * 8);
      expect(bytes.subarray(0, 112)).toEqual(wave(48000).subarray(44 + 47003 * 8, 44 + 47017 * 8));
      expect(excerpt.read(bytes, 112)).toBe(0);
    } finally {
      excerpt.release();
    }
  };
  check();
  f.current.projects.apply(f.input.projectId, {
    requestId: "gain",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 2 } }],
      },
    ],
  });
  await f.reopen();
  check();
  expect(f.reads).toBe(1);
  expect((await f.current.prepared.request(f.input)).state).toBe("ready");
  expect(f.reads).toBe(1);
});

test("preparation retains the selected complete tap and cannot reuse it as the processed output", async () => {
  const f = await fixture();
  const selected = {
    ...f.input,
    tap: {
      target: { kind: "clip" as const, id: f.placed.edit.labels.clip! },
      point: { kind: "dry" as const },
    },
  };
  await f.current.prepared.request(selected);
  await f.current.jobs.idle();
  const status = await f.current.prepared.request(selected);
  expect(status.state).toBe("ready");
  expect(JSON.parse(status.published!.input).tap).toEqual(selected.tap);
  const composition = projectComposition(f.current.projects, f.current.assets, f.input);
  const retained = f.current.prepared.resolve(composition, selected.tap);
  expect(retained?.resourceId).toBe(JSON.parse(status.published!.result).resourceId);
  expect(f.current.prepared.resolve(composition)).toBeNull();
  expect(f.reads).toBe(1);
  const output = await ready(f);
  expect(output.resourceId).not.toBe(retained?.resourceId);
  expect(f.reads).toBe(2);
});
test("an expanded executor can prepare the same revision after a nonretryable old failure", async () => {
  const f = await fixture([], "bounded-executor");
  const document = JSON.stringify(f.placed.revision.document);
  f.setHold(async () => {
    throw new CatalogError("INVALID_REQUEST", "Plan exceeds old executor bounds");
  });
  await f.current.prepared.request(f.input);
  await f.current.jobs.idle();
  const failed = await f.current.prepared.request(f.input);
  expect(failed).toMatchObject({ state: "failed", retryable: false, published: null });
  expect(() => f.current.jobs.retry(failed.jobId!)).toThrow("cannot be retried");
  f.setHold(undefined);
  await f.reopen();
  expect(await f.current.prepared.request(f.input)).toMatchObject({
    jobId: failed.jobId,
    state: "failed",
  });
  await f.reopen("expanded-executor");
  const value = await ready(f);
  expect((await f.current.prepared.request(f.input)).jobId).not.toBe(failed.jobId);
  expect(f.current.jobs.job(failed.jobId!)).toMatchObject({ state: "failed", retryable: false });
  expect(
    JSON.stringify(f.current.projects.revision(f.input.projectId, f.input.revisionId).document),
  ).toBe(document);
  await f.reopen("later-executor");
  f.setHold(async () => {
    throw new CatalogError("NOT_READY", "Execution is unavailable");
  });
  const retained = f.current.prepared.open(value.resourceId, { start: 47003, end: 47017 });
  try {
    const bytes = Buffer.alloc(14 * 8);
    expect(retained.read(bytes, 0)).toBe(bytes.length);
    expect(bytes).toEqual(wave(48000).subarray(44 + 47003 * 8, 44 + 47017 * 8));
  } finally {
    retained.release();
  }
});
test("renaming the normalization implementation re-keys a failed preparation instead of answering failed", async () => {
  const f = await fixture([], "native-window", false, { normalization: "normalization-v1" });
  const normalized = f.current.projects.apply(f.input.projectId, {
    requestId: "normalize",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            processor: {
              type: "normalization",
              mode: "gain-only",
              targetIntegratedLufs: -20,
              truePeakCeilingDbtp: -2,
              maxLoudnessRangeLu: 7,
            },
          },
        ],
      },
    ],
  });
  const input = { projectId: f.input.projectId, revisionId: normalized.revision.id };
  f.setHold(async () => {
    throw new CatalogError("INVALID_PARAMS", "Normalization misses its targets");
  });
  await f.current.prepared.request(input);
  await f.current.jobs.idle();
  const failed = await f.current.prepared.request(input);
  expect(failed).toMatchObject({ state: "failed", retryable: true, published: null });
  await f.reopen("native-window", { normalization: "normalization-v1" });
  expect(await f.current.prepared.request(input)).toMatchObject({
    jobId: failed.jobId,
    state: "failed",
  });
  const reads = f.reads;
  await f.reopen("native-window", { normalization: "normalization-v2" });
  const rerun = await f.current.prepared.request(input);
  await f.current.jobs.idle();
  expect(rerun.jobId).not.toBe(failed.jobId);
  expect(f.reads).toBe(reads + 1);
});
const loudness = (integratedLufs: number, loudnessRangeLu: number, truePeakDbtp: number) => ({
  integratedLufs,
  loudnessRangeLu,
  samplePeakDbfs: truePeakDbtp,
  truePeakDbtp,
  integratedReason: null,
  rangeReason: null,
  algorithm: "meter",
  version: "1",
});
/** Receipt 05's program: −20.4 LUFS, 8 LU range, +0.3 dBTP true peak. */
const receipt05 = loudness(-20.4, 8, 0.3);
function normalizedEvidence(after: ReturnType<typeof loudness>) {
  return (window: AudioWindowInput["window"]) =>
    window.audioState()!.domains.flatMap((domain, domainIndex) =>
      domain.recipe.type === "normalization"
        ? [
            {
              domainIndex,
              recipe: domain.recipe,
              sampleRange: domain.sampleRange,
              implementationId: "normalization-v2",
              normalization: {
                before: receipt05,
                after,
                attempts: [{ offsetDb: null, after }],
                selectedAttempt: 0,
                meterImplementationId: "meter",
                tolerances: normalizationTolerance,
              },
            },
          ]
        : [],
    );
}
async function normalizedFixture(target: number, after: ReturnType<typeof loudness>) {
  const f = await fixture(
    [],
    "native-window",
    false,
    { normalization: "normalization-v2" },
    normalizedEvidence(after),
  );
  const normalized = f.current.projects.apply(f.input.projectId, {
    requestId: "normalize",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            processor: {
              type: "normalization",
              mode: "gain-only",
              targetIntegratedLufs: target,
              truePeakCeilingDbtp: -1,
              maxLoudnessRangeLu: 20,
            },
          },
        ],
      },
    ],
  });
  const input = { projectId: f.input.projectId, revisionId: normalized.revision.id };
  await f.current.prepared.request(input);
  await f.current.jobs.idle();
  return { f, input };
}
test("an unmet loudness target publishes ceiling-limited prepared audio with its issue; a tampered issue fails the read", async () => {
  // Receipt 05 asked for +6.4 dB on a +0.3 dBTP input; the −1 dBTP ceiling allows −1.3 dB.
  const { f, input } = await normalizedFixture(-14, loudness(-21.7, 8, -1));
  const status = await f.current.prepared.request(input);
  expect(status.state).toBe("ready");
  expect(status.published!.issues).toEqual([
    {
      code: "normalization-target-unmet",
      message: expect.any(String),
      evidence: {
        mode: "gain-only",
        domainIndex: 0,
        missed: [
          {
            target: "integrated-loudness",
            requested: -14,
            achieved: -21.7,
            excess: expect.closeTo(7.7, 9),
          },
        ],
        requestedGainDb: expect.closeTo(6.4, 9),
        gainDb: expect.closeTo(-1.3, 9),
        peakToLoudnessDb: expect.closeTo(20.7, 9),
        maximumFeasibleTargetLufs: expect.closeTo(-21.7, 9),
      },
    },
  ]);
  f.current.catalog.catalog
    .prepare("UPDATE output_issues SET issue=json_set(issue,'$.evidence.gainDb',6.4)")
    .run();
  await expect(f.current.prepared.request(input)).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
  f.current.catalog.catalog.prepare("DELETE FROM output_issues").run();
  await expect(f.current.prepared.request(input)).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
});
test("prepared audio packages carry no issues; import derives them from the recipe and evidence", async () => {
  const unmet = await normalizedFixture(-14, loudness(-21.7, 8, -1));
  const clean = await normalizedFixture(-21.7, loudness(-21.7, 8, -1));
  for (const [{ f, input }, issues] of [
    [unmet, ["normalization-target-unmet"]],
    [clean, []],
  ] as const) {
    const status = await f.current.prepared.request(input);
    expect(status.published!.issues.map((issue) => issue.code)).toEqual(issues);
    const original = JSON.parse(status.published!.result) as PreparedAudio;
    const portable = f.current.prepared.portable(original.resourceId);
    expect(portable).not.toHaveProperty("issues");
    f.current.jobs.forgetJob(status.jobId!);
    const staged = await f.current.prepared.stagePortable(
      portable,
      projectCompositionFromRevision(
        f.current.projects.revision(input.projectId, input.revisionId),
        f.current.assets,
        [],
      ),
      f.current.assets.path(original.assetId),
      (reference) => reference,
      new AbortController().signal,
    );
    f.current.catalog.transaction(() => staged.publish());
    expect((await f.current.prepared.request(input)).published!.issues).toEqual(
      status.published!.issues,
    );
  }
});
test("prepared audio over a source gap publishes support-gap; its package re-derives it and a tampered issue fails the read", async () => {
  const f = await fixture([], "native-window", false, { rnnoise: "rnnoise-fixture" });
  const gapped = join(f.home, "gapped.wav");
  await writeFile(gapped, wave(48001)); // distinct bytes: assets are content-addressed
  const asset = await f.current.assets.import(gapped, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "sound",
        kind: "audio",
        codec: "pcm_f32le",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [
          { startUs: 0, endUs: 250000, empty: false },
          { startUs: 250000, endUs: 500000, empty: true },
          { startUs: 500000, endUs: 1000000, empty: false },
        ],
        sampleRate: 48000,
        channels: 2,
      },
    ],
  }));
  const placed = f.current.projects.apply(f.input.projectId, {
    requestId: "gapped",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "place",
        label: "gapped",
        clip: {
          trackId: f.placed.edit.labels.track!,
          assetId: asset.id,
          streamId: "sound",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 1000000, endUs: 2000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: { label: "gapped" } },
        steps: [{ label: "denoise", processor: { type: "rnnoise" } }],
      },
    ],
  });
  const input = { projectId: f.input.projectId, revisionId: placed.revision.id };
  await f.current.prepared.request(input);
  await f.current.jobs.idle();
  const status = await f.current.prepared.request(input);
  expect(status.state).toBe("ready");
  const gap = { startUs: 1250000, endUs: 1500000 };
  const supportGap = {
    code: "support-gap",
    message: expect.any(String),
    at: { range: gap },
    evidence: {
      clipId: placed.edit.labels.gapped,
      unavailable: gap,
      stepIds: [placed.edit.labels.denoise],
    },
  };
  expect(status.published!.issues).toEqual([supportGap]);

  // The package carries the recipe; its recipient derives the same issue from it.
  const original = JSON.parse(status.published!.result) as PreparedAudio;
  const portable = f.current.prepared.portable(original.resourceId);
  f.current.jobs.forgetJob(status.jobId!);
  const staged = await f.current.prepared.stagePortable(
    portable,
    projectComposition(f.current.projects, f.current.assets, input),
    f.current.assets.path(original.assetId),
    (reference) => reference,
    new AbortController().signal,
  );
  f.current.catalog.transaction(() => staged.publish());
  const adopted = await f.current.prepared.request(input);
  expect(adopted.published!.issues).toEqual([supportGap]);

  f.current.catalog.catalog
    .prepare("UPDATE output_issues SET issue=json_set(issue,'$.evidence.stepIds',json('[\"x\"]'))")
    .run();
  await expect(f.current.prepared.request(input)).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
});
test("canceling a fully staged result publishes neither asset nor revision binding; startup recovers orphan bytes", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const staged = new Promise<void>((r) => {
    reached = r;
  });
  f.setHold(async () => {
    reached();
    await gate;
  });
  const before = new ResourceReferences(f.current.catalog).dependencies({
    kind: "revision",
    id: f.input.revisionId,
  });
  const job = await f.current.prepared.request(f.input);
  await staged;
  f.current.jobs.cancel(job.jobId!);
  release();
  await f.current.jobs.idle();
  expect(
    new ResourceReferences(f.current.catalog).dependencies({
      kind: "revision",
      id: f.input.revisionId,
    }),
  ).toEqual(before);
  expect((await f.current.prepared.request(f.input)).published).toBeNull();
  await f.reopen();
  expect(await readdir(join(f.home, "staging", "prepared-audio"))).toEqual([]);
  expect(await readdir(join(f.home, "assets"))).toEqual([f.asset.fileName]);
});
test("missing and replaced output files fail rather than regenerate or return dry media", async () => {
  const f = await fixture();
  const value = await ready(f);
  const path = f.current.assets.path(value.assetId);
  await rename(path, path + ".saved");
  expect(() => f.current.prepared.open(value.resourceId)).toThrow();
  await writeFile(path, wave(48000));
  expect(() => f.current.prepared.open(value.resourceId)).toThrow("changed");
  expect(f.reads).toBe(1);
});
test("unresolved retiming is rejected before job admission", async () => {
  const f = await fixture();
  const revision = f.current.projects.apply(f.input.projectId, {
    requestId: "retime",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "retime",
        clipIds: [f.placed.edit.labels.clip!],
        durationUs: 1200000,
        ripple: "none",
      },
    ],
  }).revision;
  await expect(f.current.prepared.request({ ...f.input, revisionId: revision.id })).rejects.toThrow(
    "not bound",
  );
  expect(f.reads).toBe(0);
});
test("publication failure rolls back asset metadata and revision references together", async () => {
  const f = await fixture();
  const refs = new ResourceReferences(f.current.catalog);
  const before = refs.dependencies({ kind: "revision", id: f.input.revisionId });
  f.current.catalog.catalog.exec(
    `CREATE TRIGGER reject_prepared BEFORE INSERT ON artifacts WHEN NEW.artifact='prepared-audio' BEGIN SELECT RAISE(ABORT,'publication rejected'); END`,
  );
  await f.current.prepared.request(f.input);
  await f.current.jobs.idle();
  expect(await f.current.prepared.request(f.input)).toMatchObject({
    state: "failed",
    published: null,
  });
  expect(refs.dependencies({ kind: "revision", id: f.input.revisionId })).toEqual(before);
  expect(f.current.catalog.catalog.prepare("SELECT id FROM assets").all()).toEqual([
    { id: f.asset.id },
  ]);
  await f.reopen();
  expect(await readdir(join(f.home, "assets"))).toEqual([f.asset.fileName]);
});
test("deleting a project fences staged work and retires every revision dependency kind", async () => {
  const f = await fixture();
  const value = await ready(f);
  f.current.projects.markDeleting(f.input.projectId);
  await f.current.jobs.drainOwner({ kind: "project", id: f.input.projectId });
  await f.current.jobs.forgetOwner({ kind: "project", id: f.input.projectId });
  while (!f.current.projects.finishDeletionPage(f.input.projectId)) {}
  expect(
    new ResourceReferences(f.current.catalog).dependencies({
      kind: "revision",
      id: f.input.revisionId,
    }),
  ).toEqual([]);
  expect(() => f.current.prepared.open(value.resourceId)).toThrow("unavailable");
});
test("prepared publication retains valid missing-source diagnostics and rejects invalid coverage", async () => {
  const f = await fixture([{ start: 100, end: 200 }]);
  const value = await ready(f);
  expect(value.unavailable).toEqual([
    { clipId: f.placed.edit.labels.clip, ranges: [{ start: 100, end: 200 }] },
  ]);
  const invalid = await fixture([{ start: 100, end: 48001 }]);
  await invalid.current.prepared.request(invalid.input);
  await invalid.current.jobs.idle();
  expect(await invalid.current.prepared.request(invalid.input)).toMatchObject({
    state: "failed",
    published: null,
  });
});
test("concurrent revisions attach each completed result to its own immutable history", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  let first = true;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const staged = new Promise<void>((r) => {
    reached = r;
  });
  f.setHold(async () => {
    if (first) {
      first = false;
      reached();
      await gate;
    }
  });
  await f.current.prepared.request(f.input);
  await staged;
  const changed = f.current.projects.apply(f.input.projectId, {
    requestId: "next",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 0.5 } }],
      },
    ],
  }).revision;
  const next = { ...f.input, revisionId: changed.id };
  await f.current.prepared.request(next);
  release();
  await f.current.jobs.idle();
  const old = JSON.parse(
    (await f.current.prepared.request(f.input)).published!.result,
  ) as PreparedAudio;
  const latest = JSON.parse(
    (await f.current.prepared.request(next)).published!.result,
  ) as PreparedAudio;
  expect(old.resourceId).not.toBe(latest.resourceId);
  expect(
    f.current.projects.revisionDependencies(f.input.projectId, f.input.revisionId),
  ).toContainEqual({ kind: "prepared-audio", id: old.resourceId });
  expect(f.current.projects.revisionDependencies(f.input.projectId, changed.id)).toContainEqual({
    kind: "prepared-audio",
    id: latest.resourceId,
  });
  expect(f.current.projects.get(f.input.projectId).currentRevisionId).toBe(changed.id);
});
test("owner deletion rejects an already staged publication", async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const staged = new Promise<void>((r) => {
    reached = r;
  });
  f.setHold(async () => {
    reached();
    await gate;
  });
  await f.current.prepared.request(f.input);
  await staged;
  f.current.projects.markDeleting(f.input.projectId);
  const drained = f.current.jobs.drainOwner({ kind: "project", id: f.input.projectId });
  release();
  await drained;
  expect(
    f.current.catalog.catalog
      .prepare("SELECT result FROM artifacts WHERE artifact='prepared-audio'")
      .all(),
  ).toEqual([]);
  expect(
    new ResourceReferences(f.current.catalog)
      .dependencies({ kind: "revision", id: f.input.revisionId })
      .some((ref) => ref.kind === "prepared-audio"),
  ).toBe(false);
});
test("identical prepared bytes do not merge unrelated project source closures", async () => {
  const f = await fixture();
  const first = await ready(f);
  const source = join(f.home, "other.wav"),
    bytes = wave(48000);
  bytes.writeFloatLE(-0.99, 44);
  await writeFile(source, bytes);
  const asset = await f.current.assets.import(source, { kind: "import" }, f.current.probe);
  const created = f.current.projects.create({
    requestId: "second-project",
    canvas: f.placed.revision.document.canvas,
  });
  const placed = f.current.projects.apply(created.project.id, {
    requestId: "second-source",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "track", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: "track:1",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  const input = { projectId: created.project.id, revisionId: placed.revision.id };
  await f.current.prepared.request(input);
  await f.current.jobs.idle();
  const second = JSON.parse(
    (await f.current.prepared.request(input)).published!.result,
  ) as PreparedAudio;
  expect(second.assetId).toBe(first.assetId);
  expect(second.dependencies).toEqual([{ kind: "asset", id: asset.id }]);
  expect(first.dependencies).toEqual([{ kind: "asset", id: f.asset.id }]);
  expect(f.current.assets.portable(first.assetId).dependencies).toEqual([]);
  expect(
    f.current.projects.revisionDependencies(input.projectId, input.revisionId),
  ).not.toContainEqual({ kind: "asset", id: f.asset.id });
});

test.each(["processed", "dry"] as const)(
  "portable %s preparation retains its selected recipe and bounded PCM under adopted identities",
  async (kind) => {
    const donor = await fixture(),
      receiver = await fixture([], "different-local-renderer");
    const tap = { target: { kind: "output" as const }, point: { kind } };
    await donor.current.prepared.request({ ...donor.input, tap });
    await donor.current.jobs.idle();
    const status = await donor.current.prepared.request({ ...donor.input, tap });
    expect(status.state).toBe("ready");
    const original = JSON.parse(status.published!.result) as PreparedAudio;
    const portable = donor.current.prepared.portable(original.resourceId);
    const adoption = receiver.current.projects.prepareAdoption({
      requestId: "adopt",
      packageIdentity: "prepared",
      snapshot: donor.current.projects.snapshot(donor.input.projectId),
    });
    const assets: Awaited<ReturnType<AssetStore["stagePortable"]>>[] = [];
    for (const id of [donor.asset.id, original.assetId]) {
      const stage = await receiver.current.assets.stagePortable(
        donor.current.assets.portable(id),
        donor.current.assets.path(id),
        new AbortController().signal,
      );
      await stage.close();
      assets.push(stage);
    }
    const revision = adoption.revisions.find(
      (r) => r.id === adoption.revisionIds[donor.input.revisionId],
    )!;
    const composition = projectCompositionFromRevision(revision, receiver.current.assets, []);
    const stage = await receiver.current.prepared.stagePortable(
      portable,
      composition,
      assets[1]!.path,
      (reference) => reference,
      new AbortController().signal,
    );
    const controller = new AbortController();
    const canceled = await receiver.current.prepared.stagePortable(
      portable,
      composition,
      assets[1]!.path,
      (reference) => reference,
      controller.signal,
    );
    controller.abort();
    expect(() =>
      adoption.publish(() => assets.forEach((asset) => asset.publish()), {
        reference: (r) => r,
        publish: () => canceled.publish(),
      }),
    ).toThrow();
    expect(() => receiver.current.projects.get(adoption.project.id)).toThrow();
    expect(() => receiver.current.assets.get(original.assetId)).toThrow();
    await expect(
      receiver.current.prepared.stagePortable(
        { ...portable, audio: { ...portable.audio, dependencies: [] } },
        composition,
        assets[1]!.path,
        (reference) => reference,
        new AbortController().signal,
      ),
    ).rejects.toThrow("upstream dependency");
    await expect(
      receiver.current.prepared.stagePortable(
        { ...portable, audio: { ...portable.audio, frames: portable.audio.frames - 1 } },
        composition,
        assets[1]!.path,
        (reference) => reference,
        new AbortController().signal,
      ),
    ).rejects.toThrow("pinned sample window");
    const unresolved = JSON.parse(portable.publication.input);
    unresolved.requirements[0].implementationId = null;
    await expect(
      receiver.current.prepared.stagePortable(
        {
          ...portable,
          publication: { ...portable.publication, input: JSON.stringify(unresolved) },
        },
        composition,
        assets[1]!.path,
        (reference) => reference,
        new AbortController().signal,
      ),
    ).rejects.toThrow("unresolved execution requirements");
    expect(() => receiver.current.prepared.open(stage.resourceId)).toThrow();
    adoption.publish(() => assets.forEach((asset) => asset.publish()), {
      reference: (reference) =>
        reference.kind === "prepared-audio" ? { ...reference, id: stage.resourceId } : reference,
      publish: () => stage.publish(),
    });
    const adopted = receiver.current.prepared.portable(stage.resourceId);
    expect(JSON.parse(adopted.publication.input)).toEqual({
      ...JSON.parse(portable.publication.input),
      revisionId: revision.id,
    });
    expect(adopted.audio).toEqual(portable.audio);
    await rm(donor.current.assets.path(original.assetId));
    await receiver.reopen();
    const retained = await receiver.current.prepared.request({
      projectId: composition.projectId,
      revisionId: revision.id,
      tap,
    });
    expect(retained.state).toBe("ready");
    expect(JSON.parse(retained.published!.result).resourceId).toBe(stage.resourceId);
    expect(JSON.parse(retained.published!.input).tap).toEqual(tap);
    const read = receiver.current.prepared.open(stage.resourceId, { start: 47980, end: 48000 });
    try {
      const bytes = Buffer.alloc(20 * 8);
      expect(read.read(bytes, 0)).toBe(bytes.length);
      expect(bytes).toEqual(wave(48000).subarray(44 + 47980 * 8));
      expect(read.read(bytes, bytes.length)).toBe(0);
    } finally {
      read.release();
    }
    expect(receiver.reads).toBe(0);
  },
);

test("an adopted ready preparation does not start a replacement job", async () => {
  const f = await fixture();
  const original = await ready(f);
  const publication = f.current.prepared.portable(original.resourceId);
  const pending = await f.current.prepared.request(f.input);
  f.current.jobs.forgetJob(pending.jobId!);
  const stage = await f.current.prepared.stagePortable(
    publication,
    projectCompositionFromRevision(
      f.current.projects.revision(f.input.projectId, f.input.revisionId),
      f.current.assets,
      [],
    ),
    f.current.assets.path(original.assetId),
    (reference) => reference,
    new AbortController().signal,
  );
  f.current.catalog.transaction(() => stage.publish());
  expect(JSON.parse((await f.current.prepared.request(f.input)).published!.result).resourceId).toBe(
    original.resourceId,
  );
  await f.current.jobs.idle();
  expect(JSON.parse((await f.current.prepared.request(f.input)).published!.result).resourceId).toBe(
    original.resourceId,
  );
  expect(f.reads).toBe(1);
});

test("admission resolves pinned inputs once and retains resources without dropping clip occurrences", async () => {
  const f = await fixture([], "unit-test-native-boundary", true);
  const source = join(f.home, "other.wav"),
    bytes = wave(48000);
  bytes.writeFloatLE(-0.99, 44);
  await writeFile(source, bytes);
  const other = await f.current.assets.import(source, { kind: "import" }, f.current.probe);
  const revision = f.current.projects.apply(f.input.projectId, {
    requestId: "repeated-sources",
    expectedRevisionId: f.input.revisionId,
    operations: [f.asset.id, other.id, other.id].map((assetId, index) => ({
      operation: "place",
      clip: {
        trackId: f.placed.edit.labels.track!,
        assetId,
        streamId: "track:1",
        source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
        placement: {
          kind: "project",
          range: { startUs: 1000000 + index * 1000, endUs: 1001000 + index * 1000 },
        },
      },
    })),
  }).revision;
  const input = { projectId: f.input.projectId, revisionId: revision.id };
  const expected = projectComposition(f.current.projects, f.current.assets, input).window(
    {},
    { implementationId: "unit-test-native-boundary" },
    "audio",
  ).window.manifest;
  const dependencies = [f.asset.id, other.id].sort().map((id) => ({ kind: "asset", id }));
  const inserts: unknown[][] = [];
  const prepare = DatabaseSync.prototype.prepare;
  const statements = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    const statement = prepare.call(this, sql);
    if (sql === "INSERT OR IGNORE INTO resource_references VALUES(?,?,?,?)") {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...args) => {
        if (args[2] === "job-input") inserts.push(args.slice(0, 2));
        return run(...args);
      });
    }
    return statement;
  });
  let pending;
  try {
    pending = await f.current.prepared.request(input);
    // Admission reads its composition and the queue independently pins that revision.
    expect
      .soft(
        statements.mock.calls.filter(
          ([sql]) => sql === "SELECT content FROM project_revisions WHERE projectId=? AND id=?",
        ).length,
      )
      .toBeLessThanOrEqual(2);
    expect
      .soft(inserts.sort((a, b) => String(a[1]).localeCompare(String(b[1]))))
      .toEqual(dependencies.map(({ kind, id }) => [kind, id]));
  } finally {
    vi.restoreAllMocks();
  }
  const job = f.current.jobs.job(pending.jobId!);
  expect(JSON.parse(job.input)).toEqual(expected);
  expect(expected.sources.map(({ clipId }) => clipId)).toEqual(
    revision.document.clips.map(({ id }) => id),
  );
  const references = new ResourceReferences(f.current.catalog);
  expect(references.dependencies({ kind: "job-input", id: job.jobId })).toEqual(dependencies);
  await f.reopen();
  expect(
    new ResourceReferences(f.current.catalog).dependencies({ kind: "job-input", id: job.jobId }),
  ).toEqual(dependencies);
  f.current.jobs.start();
  await f.current.jobs.idle();
  const ready = await f.current.prepared.request(input);
  expect(ready.state).toBe("ready");
  expect(JSON.parse(ready.published!.input)).toEqual(expected);
  const value = JSON.parse(ready.published!.result) as PreparedAudio;
  expect(value.dependencies).toEqual(dependencies);
  expect(value.sampleRange).toEqual({
    startSamples: expected.sampleRange.start,
    endSamples: expected.sampleRange.end,
  });
  expect(
    new ResourceReferences(f.current.catalog).dependencies({ kind: "job-input", id: job.jobId }),
  ).toEqual([]);
  expect(f.reads).toBe(1);
});

test("prepared PCM admission honors the native WAV header capacity before queueing", async () => {
  const f = await fixture([], "unit-test-native-boundary", true);
  const source = join(f.home, "declared-long-source.wav");
  await writeFile(source, wave(1));
  const asset = await f.current.assets.import(source, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "track:1",
        kind: "audio",
        codec: "pcm_f32le",
        decodable: true,
        startUs: 0,
        endUs: 11184800000,
        segments: [{ startUs: 0, endUs: 11184800000, empty: false }],
        sampleRate: 48000,
        channels: 2,
      },
    ],
  }));
  const place = (requestId: string, endUs: number) => {
    const created = f.current.projects.create({
      requestId,
      canvas: f.placed.revision.document.canvas,
    });
    const { revision } = f.current.projects.apply(created.project.id, {
      requestId: "place",
      expectedRevisionId: created.revision.id,
      operations: [
        { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
        {
          operation: "place",
          clip: {
            trackId: { label: "audio" },
            assetId: asset.id,
            streamId: "track:1",
            source: { kind: "range", range: { startUs: 0, endUs } },
            placement: { kind: "project", range: { startUs: 0, endUs } },
          },
        },
      ],
    });
    return { projectId: created.project.id, revisionId: revision.id };
  };
  const supported = place("supported", 11184799980);
  const refused = place("refused", 11184800000);
  for (const [input, end] of [
    [supported, 536870399],
    [refused, 536870400],
  ] as const)
    expect(
      projectComposition(f.current.projects, f.current.assets, input).window(
        {},
        { implementationId: "unit-test-native-boundary" },
        "audio",
      ).window.manifest.sampleRange,
    ).toEqual({ start: 0, end });
  const queued = await f.current.prepared.request(supported);
  expect(queued.state).toBe("queued");
  const job = f.current.jobs.job(queued.jobId!);
  expect(JSON.parse(job.input).sampleRange).toEqual({ start: 0, end: 536870399 });
  const jobs = f.current.catalog.catalog.prepare("SELECT * FROM jobs ORDER BY jobId").all();
  const references = f.current.catalog.catalog
    .prepare("SELECT * FROM resource_references WHERE ownerKind='job-input' ORDER BY resourceId")
    .all();
  expect(
    new ResourceReferences(f.current.catalog).dependencies({ kind: "job-input", id: job.jobId }),
  ).toEqual([{ kind: "asset", id: asset.id }]);
  await expect(f.current.prepared.request(refused)).rejects.toThrow(
    expect.objectContaining({
      code: "LIMIT_EXCEEDED",
      message: "Prepared PCM exceeds the native WAV container limit",
    }),
  );
  expect(f.current.catalog.catalog.prepare("SELECT * FROM jobs ORDER BY jobId").all()).toEqual(
    jobs,
  );
  expect(
    f.current.catalog.catalog
      .prepare("SELECT * FROM resource_references WHERE ownerKind='job-input' ORDER BY resourceId")
      .all(),
  ).toEqual(references);
  expect(f.reads).toBe(0);
});

test("prepared window bindings resolve repeated resources once and retain distinct streams", async () => {
  const f = await fixture([], "unit-test-native-boundary", true);
  const source = join(f.home, "two-streams.wav"),
    bytes = wave(48000);
  bytes.writeFloatLE(-0.99, 44);
  await writeFile(source, bytes);
  const other = await f.current.assets.import(source, { kind: "import" }, async (path) => {
    const probe = await f.current.probe(path);
    return { ...probe, streams: [probe.streams[0], { ...probe.streams[0], id: "track:2" }] };
  });
  const occurrences = [
    { assetId: f.asset.id, streamId: "track:1" },
    { assetId: other.id, streamId: "track:1" },
    { assetId: other.id, streamId: "track:2" },
    { assetId: other.id, streamId: "track:2" },
  ];
  const { revision } = f.current.projects.apply(f.input.projectId, {
    requestId: "repeated-streams",
    expectedRevisionId: f.input.revisionId,
    operations: occurrences.map((selection, index) => ({
      operation: "place",
      clip: {
        ...selection,
        trackId: f.placed.edit.labels.track!,
        source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
        placement: {
          kind: "project",
          range: { startUs: 1000000 + index * 1000, endUs: 1001000 + index * 1000 },
        },
      },
    })),
  });
  const input = { projectId: f.input.projectId, revisionId: revision.id };
  const expected = projectComposition(f.current.projects, f.current.assets, input).window(
    {},
    { implementationId: "unit-test-native-boundary" },
    "audio",
  ).window.manifest;
  const assetPath = f.current.assets.path(f.asset.id),
    otherPath = f.current.assets.path(other.id);
  const expectedAssets = [
    { assetId: f.asset.id, streamId: "track:1", path: assetPath, originUs: 0 },
    { assetId: other.id, streamId: "track:1", path: otherPath, originUs: 0 },
    { assetId: other.id, streamId: "track:2", path: otherPath, originUs: 0 },
  ];
  const statements = vi.spyOn(DatabaseSync.prototype, "prepare");
  let pending;
  try {
    pending = await f.current.prepared.request(input);
    // Two complete asset reads plus one path-header lookup per distinct binding.
    expect
      .soft(
        statements.mock.calls.filter(([sql]) => sql === "SELECT metadata FROM assets WHERE id=?")
          .length,
      )
      .toBeLessThanOrEqual(5);
  } finally {
    statements.mockRestore();
  }
  expect(JSON.parse(f.current.jobs.job(pending.jobId!).input)).toEqual(expected);
  expect(
    expected.sources.map(({ clipId, assetId, streamId }) => ({ clipId, assetId, streamId })),
  ).toEqual(
    revision.document.clips.map((clip) => ({
      clipId: clip.id,
      ...("assetId" in clip ? { assetId: clip.assetId, streamId: clip.streamId } : {}),
    })),
  );
  const movedPath = otherPath + ".moved";
  await rename(otherPath, movedPath);
  f.current.catalog.catalog
    .prepare("UPDATE assets SET metadata=json_set(metadata,'$.fileName',?) WHERE id=?")
    .run(other.fileName + ".moved", other.id);
  f.current.jobs.start();
  await f.current.jobs.idle();
  expect(f.renderedAssets).toEqual([
    expectedAssets.map((binding) =>
      binding.assetId === other.id ? { ...binding, path: movedPath } : binding,
    ),
  ]);
  const ready = await f.current.prepared.request(input);
  expect(ready.state).toBe("ready");
  expect(JSON.parse(ready.published!.input)).toEqual(expected);
});

test("portable prepared recipes retain a complete many-clip execution graph", async () => {
  const f = await fixture();
  let revision = f.current.projects.revision(f.input.projectId, f.input.revisionId);
  for (let batch = 0; batch < 4; batch++)
    revision = f.current.projects.apply(f.input.projectId, {
      requestId: `many-clips-${batch}`,
      expectedRevisionId: revision.id,
      operations: Array.from({ length: 1000 }, (_, index) => ({
        operation: "place" as const,
        clip: {
          trackId: f.placed.edit.labels.track!,
          assetId: f.asset.id,
          streamId: "track:1",
          source: { kind: "range" as const, range: { startUs: 0, endUs: 1000 } },
          placement: {
            kind: "project" as const,
            range: {
              startUs: 1000000 + (batch * 1000 + index) * 1000,
              endUs: 1000000 + (batch * 1000 + index + 1) * 1000,
            },
          },
        },
      })),
    }).revision;
  const input = { projectId: f.input.projectId, revisionId: revision.id };
  await f.current.prepared.request(input);
  await f.current.jobs.idle();
  const status = await f.current.prepared.request(input);
  expect(status.state).toBe("ready");
  const value = JSON.parse(status.published!.result) as PreparedAudio;
  expect(Buffer.byteLength(status.published!.input)).toBeGreaterThan(2 * 1024 ** 2);
  expect(f.current.prepared.portable(value.resourceId).publication.input).toBe(
    status.published!.input,
  );
});

test("retained output resolves without current implementation, survives undo, and rejects changed meaning and non-output taps", async () => {
  const f = await fixture();
  const value = await ready(f);
  await f.reopen("different-current-implementation");
  const composition = (revisionId: string) =>
    projectComposition(f.current.projects, f.current.assets, { ...f.input, revisionId });
  expect((await f.current.prepared.request(f.input)).published?.result).toBe(JSON.stringify(value));
  expect(f.reads).toBe(1);
  expect(
    f.current.prepared.resolve(composition(f.input.revisionId), {
      target: { kind: "output" },
      point: { kind: "dry" },
    }),
  ).toBeNull();
  const changed = f.current.projects.apply(f.input.projectId, {
    requestId: "changed-gain",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 0.25 } }],
      },
    ],
  });
  new ResourceReferences(f.current.catalog).retain(
    "prepared-audio",
    { kind: "revision", id: changed.revision.id },
    [value.resourceId],
  );
  expect(f.current.prepared.resolve(composition(changed.revision.id))).toBeNull();
  const undo = f.current.projects.undo(f.input.projectId, {
    requestId: "undo-gain",
    expectedRevisionId: changed.revision.id,
  });
  expect(f.current.prepared.resolve(composition(undo.id))?.resourceId).toBe(value.resourceId);
  await rm(f.current.assets.path(value.assetId));
  expect(() => f.current.prepared.resolve(composition(undo.id))).toThrow();
  expect(f.reads).toBe(1);
});

test("equivalent retained references share one output; distinct recorded policies refuse ambiguity", async () => {
  const f = await fixture();
  const value = await ready(f);
  const portable = f.current.prepared.portable(value.resourceId);
  const restored = f.current.projects.restore(f.input.projectId, {
    requestId: "restore-same",
    expectedRevisionId: f.input.revisionId,
    targetRevisionId: f.input.revisionId,
  });
  const recipe = { ...JSON.parse(portable.publication.input), revisionId: restored.id };
  const publish = (input: typeof recipe) => {
    const attemptId = randomUUID(),
      resourceId = JSON.stringify([f.input.projectId, attemptId]);
    f.current.jobs.adoptArtifact(
      {
        target: { kind: "project", id: f.input.projectId, revisionId: restored.id },
        artifact: "prepared-audio",
        generation: 1,
        attemptId,
        input: JSON.stringify(input),
        result: JSON.stringify({ ...value, resourceId }),
      },
      [],
    );
    new ResourceReferences(f.current.catalog).retain(
      "prepared-audio",
      { kind: "revision", id: restored.id },
      [resourceId],
    );
    return resourceId;
  };
  publish(recipe);
  const composition = projectComposition(f.current.projects, f.current.assets, {
    ...f.input,
    revisionId: restored.id,
  });
  expect(f.current.prepared.resolve(composition)?.audio.assetId).toBe(value.assetId);
  publish({
    ...recipe,
    requirements: recipe.requirements.map((requirement: object) => ({
      ...requirement,
      implementationId: "different-recorded-policy",
    })),
  });
  expect(() => f.current.prepared.resolve(composition)).toThrow(
    expect.objectContaining({ code: "AMBIGUOUS_PREPARED_AUDIO" }),
  );
});

test.each(["retained", "produced"] as const)(
  "failed %s delivery keeps its pinned mode and releases retained descriptors",
  async (mode) => {
    const f = await fixture();
    const value = await ready(f);
    const cache = new DerivedCache(f.current.catalog, f.home, () => {});
    await cache.reconcile();
    let descriptor: number | undefined;
    const inspection = new MediaAudioInspection({
      assets: f.current.assets,
      acquisitions: new AcquisitionStore(f.current.catalog),
      jobs: f.current.jobs,
      cache,
      sourceRenderer: {
        implementationId: "unused",
        render: async () => {
          throw Error("unused");
        },
      },
      project: {
        projects: f.current.projects,
        prepared: f.current.prepared,
        renderer: {
          implementationId: "delivery-failure",
          render: async ({ prepared }) => {
            if (mode === "retained") {
              expect(prepared).toBeDefined();
              descriptor = prepared!.fd;
              expect(fstatSync(descriptor).size).toBe(value.sizeBytes);
            } else expect(prepared).toBeUndefined();
            throw new Error("delivery failed");
          },
        },
      },
    });
    const job = f.current.jobs.submitDeferred({
      target: { kind: "project", id: f.input.projectId, revisionId: f.input.revisionId },
      artifact: "audio",
      lane: "heavy",
      input: JSON.stringify({
        range: { startUs: 0, endUs: 1000000 },
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
        implementationId: "delivery-failure",
        preparedResourceId: mode === "retained" ? value.resourceId : null,
      }),
    });
    await expect(inspection.execute({ job, signal: new AbortController().signal })).rejects.toThrow(
      "delivery failed",
    );
    if (mode === "retained") {
      expect(descriptor).toBeDefined();
      expect(() => fstatSync(descriptor!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
    const read = f.current.prepared.open(value.resourceId);
    try {
      expect(fstatSync(read.fd).size).toBe(value.sizeBytes);
    } finally {
      read.release();
    }
    await f.current.jobs.drainJob(job.jobId);
  },
);

test("a preview or export pin keeps produced audio when preparation finishes later", async () => {
  const f = await fixture();
  const cache = new DerivedCache(f.current.catalog, f.home, () => {});
  await cache.reconcile();
  const preview = new ProjectPreviewInspection(
    f.current.projects,
    f.current.assets,
    f.current.jobs,
    cache,
    {
      implementationId: "pinned-movie",
      render: async ({ prepared }) => {
        expect(prepared).toBeUndefined();
        throw new Error("pinned produced render reached");
      },
    },
    f.current.prepared,
  );
  const pinned = preview.pin(f.input);
  expect(pinned.preparedResourceId).toBeNull();
  const value = await ready(f);
  expect(preview.pin(f.input).preparedResourceId).toBe(value.resourceId);
  expect(preview.pin(pinned)).toEqual(pinned);
  const job = f.current.jobs.submitDeferred({
    target: { kind: "project", id: f.input.projectId, revisionId: f.input.revisionId },
    artifact: "preview",
    lane: "heavy",
    input: JSON.stringify({
      range: pinned.range,
      settings: pinned.settings,
      implementationId: pinned.implementationId,
      preparedResourceId: pinned.preparedResourceId,
    }),
  });
  await expect(preview.execute({ job, signal: new AbortController().signal })).rejects.toThrow(
    "pinned produced render reached",
  );
  await f.current.jobs.drainJob(job.jobId);
});

test("an explicit prepared output pin refuses an incompatible tap instead of choosing live processing", async () => {
  const f = await fixture();
  const value = await ready(f);
  const composition = projectComposition(f.current.projects, f.current.assets, f.input);
  expect(() =>
    f.current.prepared.resolve(
      composition,
      {
        target: { kind: "output" },
        point: { kind: "dry" },
      },
      value.resourceId,
    ),
  ).toThrow("no longer matches");
  expect(
    f.current.prepared.resolve(composition, {
      target: { kind: "output" },
      point: { kind: "dry" },
    }),
  ).toBeNull();
  expect(f.current.prepared.resolve(composition, undefined, value.resourceId)?.resourceId).toBe(
    value.resourceId,
  );
});

test("an explicit acoustic measurement pin survives PCM admission and retry among multiple retained policies", async () => {
  const f = await fixture();
  const original = await ready(f);
  const portable = f.current.prepared.portable(original.resourceId);
  const attemptId = randomUUID(),
    resourceId = JSON.stringify([f.input.projectId, attemptId]);
  const recipe = JSON.parse(portable.publication.input);
  f.current.jobs.adoptArtifact(
    {
      target: { kind: "project", id: f.input.projectId, revisionId: f.input.revisionId },
      artifact: "prepared-audio",
      generation: 1,
      attemptId,
      input: JSON.stringify({
        ...recipe,
        requirements: recipe.requirements.map((r: object) => ({
          ...r,
          implementationId: "different-policy",
        })),
      }),
      result: JSON.stringify({ ...original, resourceId }),
    },
    [],
  );
  new ResourceReferences(f.current.catalog).retain(
    "prepared-audio",
    { kind: "revision", id: f.input.revisionId },
    [resourceId],
  );
  expect(() =>
    f.current.prepared.resolve(projectComposition(f.current.projects, f.current.assets, f.input)),
  ).toThrow(expect.objectContaining({ code: "AMBIGUOUS_PREPARED_AUDIO" }));
  await f.current.jobs.close();
  const cache = new DerivedCache(f.current.catalog, f.home, () => {});
  await cache.reconcile();
  let audio!: MediaAudioInspection, acoustic!: AcousticInspection;
  const jobs = new JobQueue({
    store: f.current.catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind !== "project") throw new Error("Project expected");
        return { ...target, revisionId: target.revisionId ?? f.input.revisionId };
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: (execution) =>
      execution.job.artifact === "audio" ? audio.execute(execution) : acoustic.execute(execution),
  });
  cleanup.push(() => jobs.close());
  audio = new MediaAudioInspection({
    assets: f.current.assets,
    acquisitions: new AcquisitionStore(f.current.catalog),
    jobs,
    cache,
    sourceRenderer: {
      implementationId: "unused-source",
      render: async () => {
        throw new Error("Wrong audio domain");
      },
    },
    project: {
      projects: f.current.projects,
      prepared: f.current.prepared,
      renderer: {
        implementationId: "fixture-retained-audio",
        render: async ({ prepared, window, output }) => {
          expect(prepared?.value.resourceId).toBe(resourceId);
          const frames = window.manifest.sampleRange.end - window.manifest.sampleRange.start;
          const bytes = wave(frames);
          await writeFile(output, bytes, { flag: "wx" });
          return {
            ...original,
            file: output,
            bytes: bytes.length,
            frames,
            unavailable: [...window.audio()].map((clip) => ({ clipId: clip.clipId, ranges: [] })),
          };
        },
      },
    },
  });
  acoustic = new AcousticInspection({
    audio,
    jobs,
    cache,
    loudness: {
      implementationId: "fixture-meter",
      measure: async () => ({
        integratedLufs: -23,
        loudnessRangeLu: null,
        samplePeakDbfs: -3,
        truePeakDbtp: -2,
        integratedReason: null,
        rangeReason: "insufficient-duration",
        algorithm: "fixture BS1770",
        version: "1",
      }),
    },
  });
  const selection = { ...f.input, preparedResourceId: resourceId, kind: "loudness" as const };
  await acoustic.request(selection);
  await jobs.idle();
  await acoustic.retry(selection);
  await jobs.idle();
  const result = await acoustic.request(selection);
  expect(result.state, result.reason ?? "missing failure reason").toBe("ready");
  expect(result.published?.artifact.analysis).toMatchObject({
    kind: "loudness",
    signalRecipe: { preparedResourceId: resourceId },
    measurement: { integratedLufs: -23 },
  });
});

test("external state recipes bind runtime identity and retain full input support for a short window", async () => {
  const f = await fixture();
  const changed = f.current.projects.apply(f.input.projectId, {
    requestId: "explicit-limiter",
    expectedRevisionId: f.input.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            processor: {
              type: "limiter",
              ceilingDbfs: -3,
              lookaheadMs: 5,
              releaseMs: 50,
            },
          },
        ],
      },
    ],
  });
  const composition = projectComposition(f.current.projects, f.current.assets, {
    ...f.input,
    revisionId: changed.revision.id,
  });
  const support = {
    implementationId: "native-window",
    processors: { limiter: "linked-limiter:runtime-one" },
  };
  const plan = composition.window({ range: { startUs: 700000, endUs: 800000 } }, support, "audio");
  expect(plan.window.manifest.state!.domains).toMatchObject([
    { sampleRange: { start: 0, end: 48000 }, recipe: { type: "limiter" } },
  ]);
  expect(
    plan.window.manifest.requirements.filter((item) => item.kind === "processor"),
  ).toMatchObject([
    { processor: { type: "limiter" }, implementationId: "linked-limiter:runtime-one" },
  ]);
  expect(plan.window.manifest.state!.inputs[0]!.selected).toEqual([{ startUs: 0, endUs: 1000000 }]);
  expect(() => composition.window({}, { implementationId: "native-window" }, "audio")).toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  const next = composition.window(
    {},
    { ...support, processors: { limiter: "linked-limiter:runtime-two" } },
    "audio",
  );
  expect(
    next.window.manifest.requirements.filter((item) => item.kind === "processor"),
  ).toMatchObject([{ implementationId: "linked-limiter:runtime-two" }]);
});
