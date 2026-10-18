import { PreparedAudioStore } from "./prepared-audio.js";
import { projectComposition, projectCompositionFromRevision } from "./project-window.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { spectralWindows } from "./audio-spectrum.js";
import { AcousticInspection } from "./acoustic-inspection.js";
import { waveformBuckets } from "./audio-wave.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { JobQueue } from "./jobs.js";
import { DerivedCache } from "./cache.js";
import { MediaAudioInspection, type ProjectAudioRenderer } from "./audio-inspection.js";
import { normalizationTolerance } from "./audio-measurement.js";
import type { ProcessingTap } from "@yap/composition";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function wave(file: string, frames: number, channels: 1 | 2 | 4 = 2) {
  const bytes = Buffer.alloc(44 + frames * channels * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(48000 * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * channels * 4, 40);
  for (let i = 0; i < frames; i++) {
    bytes.writeFloatLE(0.25, 44 + i * channels * 4);
    if (channels === 2) bytes.writeFloatLE(-0.125, 48 + i * channels * 4);
  }
  await writeFile(file, bytes, { flag: "wx" });
  return bytes.length;
}
const render: ProjectAudioRenderer["render"] = async ({ window, output }, signal) => {
  signal.throwIfAborted();
  const frames = window.manifest.sampleRange.end - window.manifest.sampleRange.start;
  return {
    file: output,
    bytes: await wave(output, frames),
    sampleRate: 48000,
    channels: 2,
    frames,
    peak: 0.25,
    clippedSamples: 0,
    maximumBlockFrames: 1024,
    peakResidentBytes: 1,
    decoderContext: {
      policy: "bounded-current-retained-run",
      sampleRate: 48000,
      maximumPrerollFrames: 0,
      maximumTailFrames: 0,
    },
    unavailable: [...window.audio()]
      .filter((clip) => clip.source.kind === "range")
      .map((clip) => ({ clipId: clip.clipId, ranges: [] })),
  };
};
async function fixture(
  renderer = render,
  budget?: number,
  durationUs = 1000000,
  sourceChannels: 1 | 2 | 4 | null = 2,
  processors?: Record<string, string>,
) {
  const home = await mkdtemp("/tmp/project-audio-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const projects = projectStoreFixture(catalog, assets, home, acquisitions);
  const cache = new DerivedCache(
    catalog,
    home,
    (owner) => {
      if (owner.kind !== "project") throw new Error("project expected");
      projects.get(owner.projectId);
    },
    budget,
  );
  await cache.reconcile();
  let inspection!: MediaAudioInspection;
  let waveform!: AcousticInspection;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin(target) {
        if (target.kind !== "project") throw new Error("project expected");
        return {
          ...target,
          revisionId: projects.revision(target.projectId, target.revisionId).revisionId,
        };
      },
      isAvailable: (owner) => owner.kind === "project" && !projects.isDeleting(owner.projectId),
      isDeleting: (owner) => owner.kind === "project" && projects.isDeleting(owner.projectId),
      isCapturing: () => false,
    },
    execute: (execution) =>
      execution.job.artifact === "waveform"
        ? waveform.execute(execution)
        : inspection.execute(execution),
  });
  const prepared = new PreparedAudioStore({
    catalog,
    assets,
    projects,
    jobs,
    staging: join(home, "prepared"),
    renderer: {
      implementationId: "fixture-audio",
      render: renderer,
      ...(processors ? { processors, validateAudio: async () => {} } : {}),
    },
    probe: async () => {
      throw new Error("unused preparation");
    },
  });
  inspection = new MediaAudioInspection({
    assets,
    acquisitions,
    cache,
    jobs,
    sourceRenderer: {
      implementationId: "unused-source",
      render: async () => {
        throw new Error("no source executor");
      },
    },
    project: {
      projects,
      prepared,
      renderer: {
        implementationId: "fixture-audio",
        render: renderer,
        ...(processors ? { processors, validateAudio: async () => {} } : {}),
      },
    },
  });
  waveform = new AcousticInspection({ audio: inspection, jobs, cache });
  cleanups.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const source = join(home, "source.wav");
  await wave(source, 48000, sourceChannels ?? 2);
  const asset = await assets.import(source, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "track:1",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: durationUs,
        segments: [{ startUs: 0, endUs: durationUs, empty: false }],
        sampleRate: 48000,
        ...(sourceChannels === null ? {} : { channels: sourceChannels }),
      },
      {
        id: "picture",
        kind: "video",
        codec: "not-audio",
        decodable: true,
        startUs: 0,
        endUs: durationUs,
        segments: [{ startUs: 0, endUs: durationUs, empty: false }],
        width: 32,
        height: 32,
        orientedWidth: 32,
        orientedHeight: 32,
      },
    ],
  }));
  const created = projects.create({
    requestId: "project",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const ref = (label: string) => ({ label });
  const placed = projects.apply(created.project.projectId, {
    requestId: "clips",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "group.add", label: "outer", group: { kind: "audio", order: 0 } },
      {
        operation: "group.add",
        label: "inner",
        group: { kind: "audio", order: 0, parentId: ref("outer") },
      },
      {
        operation: "track.add",
        label: "voice",
        track: { kind: "audio", order: 0, parentId: ref("inner") },
      },
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      ...["voice", "video"].map((label) => ({
        operation: "place",
        label: `${label}-clip`,
        clip: {
          trackId: ref(label),
          assetId: asset.id,
          streamId: label === "voice" ? "track:1" : "picture",
          source: { kind: "range", range: { startUs: 0, endUs: durationUs } },
          placement: { kind: "project", range: { startUs: 0, endUs: durationUs } },
        },
      })),
      ...[
        ["clip", "voice-clip", 2],
        ["track", "voice", 3],
        ["group", "inner", 5],
        ["group", "outer", 7],
        ["output", "output", 11],
      ].map(([kind, label, gain]) => ({
        operation: "processing.set",
        target: kind === "output" ? { kind } : { kind, id: ref(String(label)) },
        steps: [
          { label: `step-${label}`, processor: { type: "gain", gain } },
          { enabled: false, processor: { type: "gain", gain: 99 } },
          { processor: { type: "gain", gain: 0.5 } },
        ],
      })),
    ],
  });
  return {
    home,
    assets,
    projects,
    cache,
    jobs,
    inspection,
    waveform,
    asset,
    source,
    placed,
    projectId: created.project.projectId,
  };
}

test("surrounding project audio preserves the pinned revision and requested processing tap", async () => {
  const f = await fixture();
  const input = {
    projectId: f.projectId,
    revisionId: f.placed.revision.revisionId,
    range: { startUs: 500000, endUs: 999999 },
    tap: {
      target: { kind: "track" as const, id: f.placed.edit.labels.voice! },
      point: { kind: "dry" as const },
    },
  };
  const context = f.inspection.context(input, { start: 23968, end: 48032 });
  expect(context.selection).toEqual({
    ...input,
    preparedResourceId: null,
    range: { startUs: 499334, endUs: 1000000 },
  });
  expect(context.sampleClock).toMatchObject({ sampleRange: { start: 23968, end: 48000 } });
  await f.inspection.request(context.selection);
  await f.jobs.idle();
  expect((await f.inspection.request(context.selection)).published!.audio).toMatchObject({
    revisionId: input.revisionId,
    tap: input.tap,
    sampleRange: { startSamples: 23968, endSamples: 48000 },
  });
});

test("project audio taps bind only their descendants and target-owned processing, with absolute sample clocks", async () => {
  const requests: Parameters<ProjectAudioRenderer["render"]>[0][] = [];
  const f = await fixture(async (request, signal) => {
    requests.push(request);
    return render(request, signal);
  });
  const targets = [
    { kind: "clip", id: f.placed.edit.labels["voice-clip"]! },
    { kind: "track", id: f.placed.edit.labels.voice! },
    { kind: "group", id: f.placed.edit.labels.inner! },
    { kind: "group", id: f.placed.edit.labels.outer! },
    { kind: "output" },
  ] as const;
  const expected = [2, 3, 5, 7, 11];
  for (const [index, target] of targets.entries()) {
    for (const point of [
      { kind: "dry" },
      { kind: "processed" },
      {
        kind: "after-step",
        stepId:
          f.placed.edit.labels[
            `step-${["voice-clip", "voice", "inner", "outer", "output"][index]}`
          ]!,
      },
    ] as const) {
      const input = {
        projectId: f.projectId,
        range: { startUs: 333, endUs: 999000 },
        tap: { target, point },
      };
      const pending = await f.inspection.request(input);
      await f.jobs.idle();
      const ready = await f.inspection.request(input);
      expect(ready.state).toBe("ready");
      expect(ready.jobId).toBe(pending.jobId);
      expect(ready.published!.audio.sampleRange).toEqual({ startSamples: 15, endSamples: 47952 });
      const request = requests.at(-1)!;
      expect(request.assets.map((asset) => asset.streamId)).toEqual(["track:1"]);
      expect([...request.window.frames()]).toEqual([]);
      expect(
        request.window.manifest.requirements
          .filter((r) => r.kind === "executor")
          .map((r) => r.mediaKind),
      ).toEqual(["audio"]);
      const nodes = request.window.manifest.processing;
      expect(nodes.map((n) => n.target)).toEqual(targets.slice(0, index + 1));
      expect(
        nodes
          .slice(0, -1)
          .map((n) =>
            n.steps[0]!.processor.type === "gain" ? n.steps[0]!.processor.gain : undefined,
          ),
      ).toEqual(expected.slice(0, index));
      expect(
        nodes
          .at(-1)!
          .steps.map((step) => (step.processor.type === "gain" ? step.processor.gain : undefined)),
      ).toEqual(
        point.kind === "dry"
          ? []
          : point.kind === "processed"
            ? [expected[index], 99, 0.5]
            : [expected[index]],
      );
      const bytes = await readFile(ready.published!.audio.file);
      expect(bytes.readFloatLE(44)).toBe(0.25);
      expect(bytes.readFloatLE(48)).toBe(-0.125);
    }
  }
});

test("an unmeetable output normalization never blocks reads; only reads that include it carry its issue", async () => {
  // The FEEDBACK §4 probe: receipt 05's gain-only request (+6.4 dB on a +0.3 dBTP program).
  const measured = (integratedLufs: number, truePeakDbtp: number) => ({
    integratedLufs,
    loudnessRangeLu: 8,
    samplePeakDbfs: truePeakDbtp,
    truePeakDbtp,
    integratedReason: null,
    rangeReason: null,
    algorithm: "meter",
    version: "1",
  });
  const normalizing: Parameters<ProjectAudioRenderer["render"]>[0][] = [];
  const f = await fixture(
    async (request, signal) => {
      const domains = request.window.audioState()?.domains ?? [];
      const processingEvidence = domains.flatMap((domain, domainIndex) =>
        domain.recipe.type === "normalization"
          ? [
              {
                domainIndex,
                recipe: domain.recipe,
                sampleRange: domain.sampleRange,
                implementationId: "normalization-v2",
                normalization: {
                  before: measured(-20.4, 0.3),
                  after: measured(-21.7, -1),
                  attempts: [{ offsetDb: null, after: measured(-21.7, -1) }],
                  selectedAttempt: 0,
                  meterImplementationId: "meter",
                  tolerances: normalizationTolerance,
                },
              },
            ]
          : [],
      );
      if (processingEvidence.length) normalizing.push(request);
      return {
        ...((await render(request, signal)) as object),
        ...(processingEvidence.length ? { processingEvidence } : {}),
      };
    },
    undefined,
    4000000,
    2,
    { normalization: "normalization-v2" },
  );
  const mastered = f.projects.apply(f.projectId, {
    requestId: "master",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          { label: "level", processor: { type: "gain", gain: 0.5 } },
          {
            processor: {
              type: "normalization",
              mode: "gain-only",
              targetIntegratedLufs: -14,
              truePeakCeilingDbtp: -1,
              maxLoudnessRangeLu: 20,
            },
          },
        ],
      },
    ],
  });
  const read = async (tap: ProcessingTap, range = { startUs: 0, endUs: 4000000 }) => {
    const input = { projectId: f.projectId, revisionId: mastered.revision.revisionId, range, tap };
    await f.inspection.request(input);
    await f.jobs.idle();
    const status = await f.inspection.request(input);
    expect(status).toMatchObject({ state: "ready", reason: null });
    return status.published!.issues.map((issue) => issue.code);
  };
  const output = { kind: "output" } as const;
  expect(
    await read({
      target: { kind: "track", id: f.placed.edit.labels.voice! },
      point: { kind: "processed" },
    }),
  ).toEqual([]);
  expect(await read({ target: output, point: { kind: "dry" } })).toEqual([]);
  expect(
    await read({
      target: output,
      point: { kind: "after-step", stepId: mastered.edit.labels.level! },
    }),
  ).toEqual([]);
  expect(normalizing).toHaveLength(0);
  // A ranged processed read still treats the whole domain, so it carries the domain's issue.
  expect(
    await read(
      { target: output, point: { kind: "processed" } },
      { startUs: 1000000, endUs: 2000000 },
    ),
  ).toEqual(["normalization-target-unmet"]);
  expect(normalizing).toHaveLength(1);
});
test("audio history and cache recovery keep revision, tap and byte source pinned", async () => {
  const f = await fixture();
  const old = await f.inspection.request({ projectId: f.projectId });
  await f.jobs.idle();
  const pinned = { projectId: f.projectId, revisionId: old.revisionId };
  const first = (await f.inspection.request(pinned)).published!.audio;
  f.projects.apply(f.projectId, {
    requestId: "change",
    expectedRevisionId: old.revisionId,
    operations: [{ operation: "processing.set", target: { kind: "output" }, steps: [] }],
  });
  expect((await f.inspection.request(pinned)).published!.audio).toEqual(first);
  expect((await f.inspection.request({ projectId: f.projectId })).jobId).not.toBe(old.jobId);
  f.cache.remove(first.cacheId);
  await f.inspection.request(pinned);
  await f.jobs.idle();
  expect((await f.inspection.request(pinned)).published!.audio.cacheId).not.toBe(first.cacheId);
});

test("project full-WAV capacity refuses before admission and malformed WAV cannot publish", async () => {
  const f = await fixture(render, 1000);
  await expect(f.inspection.request({ projectId: f.projectId })).rejects.toThrow(
    expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
  );

  const bad = await fixture(async (request, signal) => {
    const result = (await render(request, signal)) as { frames: number };
    return { ...result, frames: result.frames - 1 };
  });
  const pending = await bad.inspection.request({ projectId: bad.projectId });
  await bad.jobs.idle();
  expect(bad.jobs.job(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "INVALID_RESPONSE",
  });
  expect((await bad.inspection.request({ projectId: bad.projectId })).published).toBeNull();
  expect(bad.cache.bytes).toBe(0);
});

test("full project PCM reserves the native WAV header allowance before queue admission", async () => {
  let calls = 0;
  const f = await fixture(
    async () => {
      calls++;
      throw new Error("Oversized PCM must refuse before rendering");
    },
    5 * 1024 ** 3,
    Math.ceil((536870900 * 1000000) / 48000),
  );
  await expect(f.inspection.prepareExport({ projectId: f.projectId })).rejects.toThrow(
    expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
  );
  await f.jobs.idle();
  expect(calls).toBe(0);
  expect(f.cache.bytes).toBe(0);
});

test("audio taps reject a picture target, retiming and sub-sample output before rendering", async () => {
  let calls = 0;
  const f = await fixture(async (request, signal) => {
    calls++;
    return render(request, signal);
  });
  await expect(
    f.inspection.request({
      projectId: f.projectId,
      tap: { target: { kind: "track", id: f.placed.edit.labels.video! }, point: { kind: "dry" } },
    }),
  ).rejects.toThrow(expect.objectContaining({ code: "INVALID_COMPOSITION" }));
  await expect(
    f.inspection.request({ projectId: f.projectId, range: { startUs: 0, endUs: 1 } }),
  ).rejects.toThrow(expect.objectContaining({ code: "INVALID_RANGE" }));
  f.projects.apply(f.projectId, {
    requestId: "retime",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      {
        operation: "retime",
        clipIds: [f.placed.edit.labels["voice-clip"]!],
        durationUs: 500000,
        ripple: "none",
      },
    ],
  });
  await expect(f.inspection.request({ projectId: f.projectId })).rejects.toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  expect(calls).toBe(0);
});

test.runIf(Boolean(process.env.YAP_NATIVE))(
  "native mixer serves every project audio tap without parent leakage or clock reset",
  async () => {
    const native: ProjectAudioRenderer["render"] = async ({ window, assets, output }, signal) => {
      signal.throwIfAborted();
      const result = spawnSync(process.env.YAP_NATIVE!, [], {
        encoding: "utf8",
        timeout: 30000,
        input:
          JSON.stringify({
            id: "project-core-tap",
            operation: "media.mixCompositionAudio",
            params: {
              output,
              range: window.manifest.sampleRange,
              clips: [...window.audio()],
              processing: window.manifest.processing,
              assets,
            },
          }) + "\n",
      });
      expect(result.status, result.stderr).toBe(0);
      const reply = JSON.parse(result.stdout);
      expect(reply.ok, JSON.stringify(reply)).toBe(true);
      return reply.data;
    };
    const f = await fixture(native);
    const targets = [
      { kind: "clip", id: f.placed.edit.labels["voice-clip"]! },
      { kind: "track", id: f.placed.edit.labels.voice! },
      { kind: "group", id: f.placed.edit.labels.inner! },
      { kind: "group", id: f.placed.edit.labels.outer! },
      { kind: "output" },
    ] as const;
    const gains = [2, 3, 5, 7, 11];
    for (const [index, target] of targets.entries()) {
      for (const mode of ["dry", "after-step", "processed"] as const) {
        const point =
          mode === "after-step"
            ? {
                kind: mode,
                stepId:
                  f.placed.edit.labels[
                    `step-${["voice-clip", "voice", "inner", "outer", "output"][index]}`
                  ]!,
              }
            : { kind: mode };
        const input = {
          projectId: f.projectId,
          tap: { target, point },
          range: { startUs: 333, endUs: 999000 },
        };
        await f.inspection.request(input);
        await f.jobs.idle();
        const ready = await f.inspection.request(input);
        expect(ready.state, JSON.stringify(ready)).toBe("ready");
        const receipt = ready.published!.audio;
        expect(receipt.sampleRange).toEqual({ start: 15, end: 47952 });
        const bytes = await readFile(receipt.file);
        let at = 12;
        while (bytes.toString("ascii", at, at + 4) !== "data") {
          const size = bytes.readUInt32LE(at + 4);
          at += 8 + size + (size % 2);
        }
        const data = bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at + 4));
        const gain =
          gains.slice(0, index).reduce((value, next) => value * next * 0.5, 1) *
          (mode === "dry" ? 1 : gains[index]! * (mode === "processed" ? 0.5 : 1));
        const expectedPCM = Buffer.alloc(receipt.frames * 8);
        for (let frame = 0; frame < receipt.frames; frame++) {
          expectedPCM.writeFloatLE(0.25 * gain, frame * 8);
          expectedPCM.writeFloatLE(-0.125 * gain, frame * 8 + 4);
        }
        expect(data.equals(expectedPCM), `${target.kind}/${mode} complete stereo PCM`).toBe(true);
        await f.waveform.request({ ...input, bucketFrames: 480 });
        await f.jobs.idle();
        const acoustic = await f.waveform.request({ ...input, bucketFrames: 480 });
        expect(acoustic.state).toBe("ready");
        const document = JSON.parse(await readFile(acoustic.published!.artifact.file, "utf8"));
        expect(document).toMatchObject({
          domain: "project",
          projectId: f.projectId,
          revisionId: ready.revisionId,
          tap: input.tap,
          sampleRange: receipt.sampleRange,
          range: input.range,
          bucketFrames: 480,
          audio: { jobId: ready.jobId, generation: ready.published!.generation },
        });
        for (const bucket of document.buckets)
          expect(bucket.channels).toEqual([
            { min: 0.25 * gain, max: 0.25 * gain, rms: 0.25 * gain },
            { min: -0.125 * gain, max: -0.125 * gain, rms: 0.125 * gain },
          ]);
        const lease = f.cache.acquire(receipt.cacheId)!;
        try {
          const waveform = await waveformBuckets(
            lease,
            receipt,
            { bucketFrames: 480 },
            new AbortController().signal,
          );
          expect(waveform.buckets[0]!.sampleRange).toEqual({ start: 15, end: 480 });
          expect(waveform.buckets.at(-1)!.sampleRange).toEqual({ start: 47520, end: 47952 });
          const spectrum = await spectralWindows(
            lease,
            receipt,
            {
              fftFrames: 32,
              hopFrames: 32,
              window: "rectangular",
              sampleRange: { start: 480, end: 512 },
            },
            new AbortController().signal,
          );
          expect(spectrum.columns[0]).toMatchObject({
            sampleRange: { start: 480, end: 512 },
            analysis: { start: 480, end: 512 },
            partial: false,
          });
          for (let channel = 0; channel < 2; channel++)
            for (let bin = 0; bin < 17; bin++)
              expect(spectrum.density[channel * 17 + bin]).toBeCloseTo(
                bin === 0 ? (((channel === 0 ? 0.25 : -0.125) * gain) ** 2 * 32) / 48000 : 0,
                12,
              );
          for (const bucket of waveform.buckets)
            expect(bucket.channels).toEqual([
              { min: 0.25 * gain, max: 0.25 * gain, rms: 0.25 * gain },
              { min: -0.125 * gain, max: -0.125 * gain, rms: 0.125 * gain },
            ]);
        } finally {
          lease.release();
        }
      }
    }
  },
  30000,
);

test("cancel and retry discard unpublished project WAV bytes and retire deletion targets", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let attempts = 0;
  const f = await fixture(async (request, signal) => {
    const result = await render(request, signal);
    if (++attempts === 1) {
      entered();
      await held;
    }
    return result;
  });
  const input = { projectId: f.projectId, revisionId: f.placed.revision.revisionId };
  const pending = await f.inspection.request(input);
  await started;
  f.jobs.cancel(pending.jobId!);
  release();
  await f.jobs.idle();
  expect((await f.inspection.request(input)).published).toBeNull();
  expect(f.cache.bytes).toBe(0);
  await f.inspection.retry(input);
  await f.jobs.idle();
  expect((await f.inspection.request(input)).state).toBe("ready");
  expect(attempts).toBe(2);
  f.projects.markDeleting(f.projectId);
  await expect(f.inspection.request(input)).rejects.toThrow();
});

test("RNNoise metadata stays unavailable before job admission while dry inspection remains authorable", async () => {
  let calls = 0;
  const f = await fixture(async (request, signal) => {
    calls++;
    return render(request, signal);
  });
  const clipId = f.placed.edit.labels["voice-clip"]!;
  f.projects.apply(f.projectId, {
    requestId: "noise-state",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [{ processor: { type: "rnnoise" } }],
      },
    ],
  });
  await expect(f.inspection.request({ projectId: f.projectId })).rejects.toThrow(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  expect(calls).toBe(0);
  await expect(
    f.inspection.request({
      projectId: f.projectId,
      tap: { target: { kind: "clip", id: clipId }, point: { kind: "dry" } },
    }),
  ).resolves.toBeDefined();
});

test("parent RNNoise inside an internal audio gap refuses before renderer admission", async () => {
  let calls = 0;
  const f = await fixture(async (request, signal) => {
    calls++;
    return render(request, signal);
  });
  const clipId = f.placed.edit.labels["voice-clip"]!;
  const split = f.projects.apply(f.projectId, {
    requestId: "gap-split",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [{ operation: "split", clipIds: [clipId], atUs: 500000, scope: "selected" }],
  });
  const right = split.edit.clipLineage[0]!.clipIds[1]!;
  f.projects.apply(f.projectId, {
    requestId: "gap-state",
    expectedRevisionId: split.revision.revisionId,
    operations: [
      {
        operation: "move",
        clipIds: [right],
        atUs: 2000000,
        scope: "selected",
        ripple: "none",
        tracks: [],
      },
      {
        operation: "processing.set",
        target: { kind: "track", id: f.placed.edit.labels["voice"]! },
        steps: [{ processor: { type: "rnnoise" } }],
      },
    ],
  });
  await expect(
    f.inspection.request({ projectId: f.projectId, range: { startUs: 1000000, endUs: 1500000 } }),
  ).rejects.toThrow(expect.objectContaining({ code: "NOT_READY" }));
  expect(calls).toBe(0);
});

test("a narrow parent-state plan binds mono sources outside its requested output", async () => {
  const f = await fixture(render, undefined, 1000000, 1);
  const other = join(f.home, "other.wav");
  await wave(other, 24000, 1);
  const asset = await f.assets.import(other, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "sound",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 500000,
        segments: [{ startUs: 0, endUs: 500000, empty: false }],
        sampleRate: 48000,
        channels: 1,
      },
    ],
  }));
  const added = f.projects.apply(f.projectId, {
    requestId: "state-sources",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      {
        operation: "place",
        clip: {
          trackId: f.placed.edit.labels.voice!,
          assetId: asset.id,
          streamId: "sound",
          source: { kind: "range", range: { startUs: 0, endUs: 500000 } },
          placement: { kind: "project", range: { startUs: 2000000, endUs: 2500000 } },
        },
      },
      {
        operation: "place",
        clip: {
          trackId: f.placed.edit.labels.voice!,
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 2500000, endUs: 3000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "track", id: f.placed.edit.labels.voice! },
        steps: [{ processor: { type: "rnnoise" } }],
      },
    ],
  });
  const plan = projectComposition(f.projects, f.assets, {
    projectId: f.projectId,
    revisionId: added.revision.revisionId,
  }).window(
    { range: { startUs: 2000000, endUs: 2500000 } },
    { implementationId: "fixture" },
    "audio",
    "retained",
  );
  expect(plan.assets.map((a) => a.assetId).sort()).toEqual([f.asset.id, asset.id].sort());
  expect(plan.window.manifest.state!.inputs.map((i) => i.channels)).toEqual([1, 1, undefined]);
  expect(plan.window.manifest.state!.inputs[0]!.selected).toEqual([{ startUs: 0, endUs: 1000000 }]);
  await expect(
    f.inspection.request({ projectId: f.projectId, range: { startUs: 2000000, endUs: 2500000 } }),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "NOT_READY",
      details: expect.objectContaining({ requirements: expect.any(Array) }),
    }),
  );
});

test("state channel admission refuses wider and unknown probes without blocking retained metadata", async () => {
  for (const channels of [4, null] as const) {
    const f = await fixture(render, undefined, 1000000, channels);
    const revision = f.projects.apply(f.projectId, {
      requestId: "channel-state",
      expectedRevisionId: f.placed.revision.revisionId,
      operations: [
        {
          operation: "processing.set",
          target: { kind: "output" },
          steps: [{ processor: { type: "rnnoise" } }],
        },
      ],
    });
    await expect(f.inspection.request({ projectId: f.projectId })).rejects.toThrow(
      expect.objectContaining({
        code: "PREREQUISITE_MISSING",
        details: {
          stateInputs: [
            {
              kind: "unverified-audio-channels",
              clipId: f.placed.edit.labels["voice-clip"],
              channels,
              sampleRate: 48000,
            },
          ],
        },
      }),
    );
    const retained = projectComposition(f.projects, f.assets, {
      projectId: f.projectId,
      revisionId: revision.revision.revisionId,
    }).window({}, { implementationId: "fixture" }, "audio", "retained");
    expect(retained.window.manifest.state!.inputs[0]!.channels ?? null).toBe(channels);
  }
});

test("an acquisition hole splits state at the gap and names support-gap for its output", async () => {
  const f = await fixture(render, undefined, 1000000, 1);
  const original = f.placed.revision,
    clipId = f.placed.edit.labels["voice-clip"]!;
  const revision = {
    ...original,
    document: {
      ...original.document,
      clips: original.document.clips.map((c) =>
        c.id === clipId ? { ...c, acquisitionId: "capture" } : c,
      ),
      processing: [
        {
          target: { kind: "output" as const },
          steps: [{ id: "noise", enabled: true, processor: { type: "rnnoise" as const } }],
        },
      ],
    },
  };
  const contexts = [
    {
      id: "capture",
      bindings: [
        {
          assetId: f.asset.id,
          streamId: "track:1",
          available: [
            { startUs: 0, endUs: 250000 },
            { startUs: 500000, endUs: 1000000 },
          ],
        },
      ],
    },
  ];
  const composition = projectCompositionFromRevision(revision, f.assets, contexts);
  // The hole splits the output's denoise state: the read after it gets its own run and an issue.
  const produced = composition.window(
    { range: { startUs: 750000, endUs: 1000000 } },
    { implementationId: "fixture", rnnoise: "rnnoise-fixture" },
    "audio",
  );
  expect(produced.window.manifest.state!.domains.map((d) => d.range)).toEqual([
    { startUs: 500000, endUs: 1000000 },
  ]);
  expect(produced.window.manifest.state!.inputs[0]).toMatchObject({
    clip: { acquisitionId: "capture" },
    channels: 1,
    selected: [{ startUs: 500000, endUs: 1000000 }],
    unavailable: [],
  });
  expect(produced.issues).toEqual([]);
  expect(produced.outputIssues).toEqual([
    {
      code: "support-gap",
      message: expect.any(String),
      at: { range: { startUs: 250000, endUs: 500000 } },
      evidence: { clipId, unavailable: { startUs: 250000, endUs: 500000 }, stepIds: ["noise"] },
    },
  ]);
  const narrowed = {
    ...revision,
    document: {
      ...revision.document,
      processing: [
        {
          ...revision.document.processing[0]!,
          steps: [
            {
              ...revision.document.processing[0]!.steps[0]!,
              window: { kind: "project" as const, range: { startUs: 750000, endUs: 1000000 } },
            },
          ],
        },
      ],
    },
  };
  const selected = projectCompositionFromRevision(narrowed, f.assets, contexts);
  expect(
    selected.window({}, { implementationId: "fixture" }, "audio", "retained").window.manifest.state!
      .inputs[0]!.unavailable,
  ).toEqual([]);
  expect(() => selected.window({}, { implementationId: "fixture" }, "audio")).toThrow(
    expect.objectContaining({
      code: "NOT_READY",
      details: expect.objectContaining({ requirements: expect.any(Array) }),
    }),
  );
  expect(
    composition
      .window({}, { implementationId: "fixture" }, "audio", "retained")
      .window.manifest.state!.domains.map((d) => d.range),
  ).toEqual([
    { startUs: 0, endUs: 250000 },
    { startUs: 500000, endUs: 1000000 },
  ]);
});

test("stateful processing over a source gap publishes its audio with support-gap", async () => {
  const states: ReturnType<
    Parameters<ProjectAudioRenderer["render"]>[0]["window"]["audioState"]
  >[] = [];
  const f = await fixture(
    async (request, signal) => {
      states.push(request.window.audioState());
      return render(request, signal);
    },
    undefined,
    1000000,
    1,
    { rnnoise: "rnnoise-fixture" },
  );
  const gapped = join(f.home, "gapped.wav");
  await wave(gapped, 48001, 1); // distinct bytes: assets are content-addressed
  const asset = await f.assets.import(gapped, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "sound",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [
          { startUs: 0, endUs: 250000, empty: false },
          { startUs: 250000, endUs: 500000, empty: true },
          { startUs: 500000, endUs: 1000000, empty: false },
        ],
        sampleRate: 48000,
        channels: 1,
      },
    ],
  }));
  const placed = f.projects.apply(f.projectId, {
    requestId: "gapped",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      {
        operation: "place",
        label: "gapped",
        clip: {
          trackId: f.placed.edit.labels.voice!,
          assetId: asset.id,
          streamId: "sound",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 2000000, endUs: 3000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: { label: "gapped" } },
        steps: [{ label: "denoise", processor: { type: "rnnoise" } }],
      },
    ],
  });
  const input = { projectId: f.projectId, revisionId: placed.revision.revisionId };
  await f.inspection.request(input);
  await f.jobs.idle();
  const status = await f.inspection.request(input);
  expect(status).toMatchObject({ state: "ready", issues: [] });
  const gap = { startUs: 2250000, endUs: 2500000 };
  expect(status.published!.issues).toEqual([
    {
      code: "support-gap",
      message: expect.any(String),
      at: { range: gap },
      evidence: {
        clipId: placed.edit.labels.gapped,
        unavailable: gap,
        stepIds: [placed.edit.labels.denoise],
      },
    },
  ]);
  // The renderer received one domain per available run; nothing spans the gap.
  expect(states.at(-1)!.domains.map((d) => d.sampleRange)).toEqual([
    { start: 96000, end: 108000 },
    { start: 120000, end: 144000 },
  ]);
});
