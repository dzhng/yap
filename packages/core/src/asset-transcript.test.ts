import {
  round,
  fromTime,
  add,
  subtract,
  compare,
  type SignedTimeValue,
  type TimeValue,
} from "@yap/composition";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { JobQueue } from "./jobs.js";
import { SourceTranscriptRead } from "./transcript-read.js";
import {
  TranscriptStore,
  type SpeechTranscriber,
  type SpeechTranscriptionReceipt,
} from "./transcript.js";
import {
  TranscriptProcessing,
  assetTranscriptOwner,
  type TranscriptionModels,
} from "./transcript-processing.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  timing: { originUs: SignedTimeValue; startUs: TimeValue; endUs: TimeValue } = {
    originUs: 250000,
    startUs: 100,
    endUs: 1000,
  },
  native?: SpeechTranscriber,
) {
  const home = await mkdtemp("/tmp/asset-transcript-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const path = join(home, "external.mov");
  await writeFile(path, "two audio streams and one picture");
  const asset = await assets.import(path, { kind: "import" }, async () => ({
    originUs: timing.originUs,
    streams: ["track:1", "track:2", "track:3"].map((id) => ({
      id,
      kind: id === "track:3" ? "video" : "audio",
      codec: "fixture",
      decodable: true,
      startUs: timing.startUs,
      endUs: timing.endUs,
      segments: [{ startUs: timing.startUs, endUs: timing.endUs, empty: false }],
    })),
  }));
  let modelDigest = "a".repeat(64);
  const models: TranscriptionModels & { state: "absent" | "ready" | "preparing" | "failed" } = {
    state: "ready",
    status: () =>
      models.state === "preparing"
        ? { state: "preparing", receivedBytes: 0, totalBytes: 1, etaMs: null }
        : models.state === "failed"
          ? { state: "failed", code: "fixture", message: "fixture", retryable: true }
          : { state: models.state },
    nativeRequest: async () => ({ directory: join(home, "models"), files: [] }),
    get modelDigest() {
      return modelDigest;
    },
    pins: {
      runtime: "FluidAudio",
      runtimeVersion: "0.15.7",
      runtimeRevision: "runtime",
      decoder: "parakeet-tdt-batch",
      model: "model",
      modelRevision: "revision",
    },
  };
  const transcripts = new TranscriptStore(
    catalog,
    home,
    assetTranscriptOwner(assets, acquisitions),
  );
  let processing: TranscriptProcessing;
  const requests: Parameters<SpeechTranscriber>[0][] = [];
  const control = { fail: false, hold: false };
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind !== "asset") throw new Error("Unexpected owner");
        assets.get(target.assetId);
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: (job) => processing.execute(job),
  });
  processing = new TranscriptProcessing({
    jobs,
    transcripts,
    models,
    asset: { assets, acquisitions },
    transcribe: async (request, signal) => {
      requests.push(request);
      if (native) return native(request, signal);
      if (control.hold)
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      if (control.fail) throw new Error("fixture transcription failure");
      const spans = request.track.available.flatMap((available) => {
        const execution = request.execution?.executionRange;
        if (!execution) return [{ source: available, owned: available }];
        const owned = {
          startUs:
            compare(fromTime(available.startUs), fromTime(execution.startUs)) > 0
              ? available.startUs
              : execution.startUs,
          endUs:
            compare(fromTime(available.endUs), fromTime(execution.endUs)) < 0
              ? available.endUs
              : execution.endUs,
        };
        if (compare(fromTime(owned.startUs), fromTime(owned.endUs)) >= 0) return [];
        const before = round(
          subtract(fromTime(owned.startUs), fromTime(request.execution!.context.beforeUs)),
        );
        const after = round(
          add(fromTime(owned.endUs), fromTime(request.execution!.context.afterUs)),
        );
        return [
          {
            owned,
            source: {
              startUs:
                compare(fromTime(available.startUs), fromTime(before)) > 0
                  ? available.startUs
                  : before,
              endUs:
                compare(fromTime(available.endUs), fromTime(after)) < 0 ? available.endUs : after,
            },
          },
        ];
      });
      const lines = spans.map(({ source, owned }, ordinal) => ({
        ordinal,
        source,
        owned,
        state: "transcribed" as const,
        words: [
          {
            text: request.track.streamId!,
            source: {
              startUs: round(add(fromTime(source.startUs), fromTime(10))),
              endUs: round(subtract(fromTime(source.endUs), fromTime(10))),
            },
            confidence: 0.8,
          },
        ],
      }));
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
        wordCount: lines.length,
        execution: request.execution,
        available: request.track.available,
      };
    },
  });
  cleanup.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    catalog,
    assets,
    acquisitions,
    asset,
    jobs,
    models,
    processing,
    transcripts,
    requests,
    control,
    changeModel: (value: string) => {
      modelDigest = value;
    },
    selection: { assetId: asset.id, streamId: "track:2" },
  };
}

test("selected source admission retains its real asset and publishes normalized words without a recording", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const status = f.processing.sourceStatus(f.selection);
  expect(f.requests[0]!.track).toEqual({
    source: f.assets.path(f.asset.id),
    streamId: "track:2",
    sourceOffsetUs: -250000,
    available: [{ startUs: 100, endUs: 1000 }],
  });
  expect(f.assets.references(f.asset.id)).toContainEqual({ kind: "job", id: status.jobId });
  expect(
    f.transcripts
      .wordRecords(status.published!.transcript, { limit: 5 })
      .map((word) => ({ text: word.text, startUs: word.startUs, endUs: word.endUs })),
  ).toEqual([{ text: "track:2", startUs: 110, endUs: 990 }]);
  const raw = await readFile(f.requests[0]!.output, "utf8");
  expect(raw).toContain('"track:2"');
  f.processing.prepareSource(f.selection);
  expect(f.requests).toHaveLength(1);
  expect(
    f.catalog.catalog.prepare("SELECT name FROM sqlite_master WHERE name='recordings'").all(),
  ).toEqual([]);
});

test("retained transcript inspection never starts first-time inference", async () => {
  const f = await fixture();
  expect(f.processing.sourceStatus(f.selection)).toMatchObject({
    state: "not_requested",
    reason: null,
    jobId: null,
    published: null,
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.catalog.catalog.prepare("SELECT artifact FROM jobs").all()).toEqual([]);
  expect(f.requests).toEqual([]);
});

test("bounded preparation retains whole-source identity, unobserved coverage and an explicit reusable generation", async () => {
  const f = await fixture();
  const preparation = {
    ...f.selection,
    executionRange: { startUs: 300, endUs: 700 },
    context: { beforeUs: 100, afterUs: 100 },
  };
  f.processing.prepareSource(preparation);
  await f.jobs.idle();
  const status = f.processing.sourceStatus(preparation),
    metadata = status.published!.transcript;
  expect(metadata.source).toMatchObject({ durationUs: 1000, streamId: "track:2" });
  expect(
    f.transcripts
      .wordRecords(metadata, { limit: 10 })
      .map(({ text, startUs, endUs }) => ({ text, startUs, endUs })),
  ).toEqual([{ text: "track:2", startUs: 210, endUs: 790 }]);
  expect(f.transcripts.gapRecords(metadata, { limit: 10 })).toEqual([
    { startUs: 0, endUs: 100, reason: "not_acquired" },
    { startUs: 100, endUs: 300, reason: "not_observed" },
    { startUs: 700, endUs: 1000, reason: "not_observed" },
  ]);
  expect(f.processing.sourceStatus(f.selection)).toMatchObject({
    state: "not_requested",
    published: null,
  });
  f.models.state = "absent";
  expect(
    f.processing.sourceStatus({ ...f.selection, generation: metadata.generation }).published!
      .transcript,
  ).toEqual(metadata);
  expect(
    new SourceTranscriptRead(f.transcripts, metadata).page({ range: { startUs: 300, endUs: 700 } })
      .rows,
  ).toMatchObject([{ type: "word", sourceRange: { startUs: 210, endUs: 790 }, partial: true }]);
  f.models.state = "ready";
  f.processing.prepareSource(preparation);
  expect(f.requests).toHaveLength(1);
  expect(() =>
    f.processing.sourceStatus({
      ...f.selection,
      streamId: "track:1",
      generation: metadata.generation,
    }),
  ).toThrow("another selected source");
});

test("an execution range past the source end transcribes the part inside it and reports the clamp", async () => {
  const f = await fixture();
  const overrun = { ...f.selection, executionRange: { startUs: 600, endUs: 1500 } };
  const applied = { ...f.selection, executionRange: { startUs: 600, endUs: 1000 } };
  f.processing.prepareSource(overrun);
  await f.jobs.idle();
  const clamped = f.processing.sourceStatus(overrun);
  expect(clamped.state).toBe("ready");
  expect(f.requests.map((request) => request.execution?.executionRange)).toEqual([
    applied.executionRange,
  ]);
  expect(clamped.issues).toEqual([
    expect.objectContaining({
      code: "range-clamped",
      evidence: {
        requested: overrun.executionRange,
        applied: applied.executionRange,
        bounds: { startUs: 0, endUs: 1000 },
      },
    }),
  ]);
  // The applied range is the same request: it joins the same generation and reports nothing.
  f.processing.prepareSource(applied);
  const exact = f.processing.sourceStatus(applied);
  expect(f.requests).toHaveLength(1);
  expect(exact.published!.generation).toBe(clamped.published!.generation);
  expect(exact.issues).toEqual([]);
  expect(() =>
    f.processing.prepareSource({ ...f.selection, executionRange: { startUs: 1000, endUs: 1500 } }),
  ).toThrow(expect.objectContaining({ code: "INVALID_RANGE" }));
});

test("source phrase search crosses an accepted ownership seam without changing either estimate", async () => {
  const f = await fixture({ originUs: 0, startUs: 0, endUs: 40_000_000 }, async (request) => {
    const lines = [
      {
        ordinal: 0,
        source: { startUs: 0, endUs: 24_000_000 },
        owned: { startUs: 0, endUs: 20_000_000 },
        state: "transcribed" as const,
        words: [
          { text: "Hello", source: { startUs: 19_800_000, endUs: 20_100_000 }, confidence: 0.8 },
        ],
      },
      {
        ordinal: 1,
        source: { startUs: 16_000_000, endUs: 40_000_000 },
        owned: { startUs: 20_000_000, endUs: 40_000_000 },
        state: "transcribed" as const,
        words: [
          { text: "world.", source: { startUs: 20_200_000, endUs: 20_400_000 }, confidence: 0.9 },
        ],
      },
    ];
    const raw = lines.map((line) => JSON.stringify(line) + "\n").join("");
    await writeFile(request.output, raw);
    return {
      output: {
        file: request.output,
        bytes: Buffer.byteLength(raw),
        sha256: createHash("sha256").update(raw).digest("hex"),
      },
      engine: {
        runtime: "FluidAudio",
        runtimeVersion: "0.15.7",
        decoder: "parakeet-tdt-batch",
        encoderPrecision: "int8",
        computeUnits: "cpuAndNeuralEngine",
      },
      execution: request.execution,
      available: request.track.available,
      segments: lines.map(({ words, ...line }) => ({ ...line, wordCount: words.length })),
      wordCount: 2,
    };
  });
  f.processing.prepareSource(f.selection);
  await f.jobs.idle();
  const metadata = f.processing.sourceStatus(f.selection).published!.transcript;
  expect(
    new SourceTranscriptRead(f.transcripts, metadata).search({ text: "hello world" }).entries,
  ).toEqual([{ wordIds: ["w0", "w1"], sourceRange: { startUs: 19_800_000, endUs: 20_400_000 } }]);
  expect(
    f.transcripts
      .portableReceipt(f.transcripts.portableGenerations(f.asset.id).generations[0]!)
      .segments.map(({ owned, wordCount }) => ({ owned, wordCount })),
  ).toEqual([
    { owned: { startUs: 0, endUs: 20_000_000 }, wordCount: 1 },
    { owned: { startUs: 20_000_000, endUs: 40_000_000 }, wordCount: 1 },
  ]);
});

test("native execution receipt must match the requested bounded preparation", async () => {
  const f = await fixture(
    { originUs: 0, startUs: 0, endUs: 10_000_000 },
    nativeTranscript((_, receipt) => {
      Object.assign(receipt, {
        execution: {
          executionRange: { startUs: 0, endUs: 9_000_000 },
          context: { beforeUs: 0, afterUs: 0 },
          recipe: "source-windows-20s-context4s-guard1s-v2",
        },
      });
    }),
  );
  f.processing.prepareSource(f.selection);
  await f.jobs.idle();
  expect(f.processing.sourceStatus(f.selection)).toMatchObject({
    state: "failed",
    published: null,
    reason: "Transcription execution differs from requested preparation",
  });
});

test("model readiness and failure stay explicit, reads never retry and explicit retry creates a fresh attempt", async () => {
  const f = await fixture();
  for (const state of ["absent", "preparing", "failed"] as const) {
    f.models.state = state;
    expect(f.processing.sourceStatus(f.selection)).toMatchObject({
      state: "unavailable",
      reason: "model_not_prepared",
      jobId: null,
      models: { state },
    });
    expect(() => f.processing.retrySource(f.selection)).toThrow("model_not_prepared");
  }
  expect(f.requests).toEqual([]);
  f.models.state = "ready";
  f.control.fail = true;
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("failed");
  const failed = f.processing.sourceStatus(f.selection);
  const attempt = f.jobs.job(failed.jobId!).attemptId;
  f.processing.sourceStatus(f.selection);
  expect(f.requests).toHaveLength(1);
  f.control.fail = false;
  f.processing.retrySource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  expect(f.processing.sourceStatus(f.selection).published!.generation).not.toBe(attempt);
  expect(f.requests).toHaveLength(2);
  await expect(readFile(f.requests[0]!.output)).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancelled attempts are not revived by reads; cleanup preserves other published source generations", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const retained = f.processing.sourceStatus(f.selection).published!.transcript;
  f.control.hold = true;
  const first = {
    ...f.selection,
    executionRange: { startUs: 300, endUs: 700 },
    context: { beforeUs: 100, afterUs: 100 },
  };
  f.processing.prepareSource(first);
  await expect.poll(() => f.requests.length).toBe(2);
  const id = f.processing.sourceStatus(first).jobId!;
  const attempt = f.jobs.job(id).attemptId;
  expect(f.processing.retrySource(first)).toMatchObject({ state: "processing", jobId: id });
  expect(f.jobs.job(id).attemptId).toBe(attempt);
  expect(f.requests).toHaveLength(2);
  await f.jobs.drainJob(id);
  f.processing.sourceStatus(first);
  expect(f.requests).toHaveLength(2);
  f.control.hold = false;
  f.processing.retrySource(first);
  await expect.poll(() => f.processing.sourceStatus(first).state).toBe("ready");
  await f.processing.cleanup(new AbortController().signal);
  expect(f.transcripts.wordRecords(retained, { limit: 10 }).map((word) => word.text)).toEqual([
    "track:2",
  ]);
  const resumed = f.processing.sourceStatus(first).published!.transcript;
  expect(resumed.generation).not.toBe(retained.generation);
  expect(resumed.execution.executionRange).toEqual(first.executionRange);
  expect(
    f.transcripts
      .wordRecords(resumed, { limit: 10 })
      .map(({ text, startUs, endUs }) => ({ text, startUs, endUs })),
  ).toEqual([{ text: "track:2", startUs: 210, endUs: 790 }]);
  expect(f.processing.sourceStatus(f.selection).published!.transcript).toEqual(retained);
  expect(() => f.processing.prepareSource({ ...f.selection, streamId: "track:3" })).toThrow(
    "audio stream",
  );
});

test("explicit acquisition masks separate jobs for the same bytes and retain the context", async () => {
  const f = await fixture();
  // Immutable acquisition metadata is seeded at the import boundary; acquisition tests exercise
  // actual journal adoption. This test isolates the selected support passed to inference.
  for (const [id, available] of [
    [
      "masked",
      [
        { startUs: 200, endUs: 400 },
        { startUs: 600, endUs: 800 },
      ],
    ],
    ["empty", []],
  ] as const) {
    f.catalog.catalog
      .prepare("INSERT INTO acquisitions VALUES(?,?,?,?)")
      .run(
        id,
        id,
        JSON.stringify({ kind: "import", path: "fixture", files: {} }),
        JSON.stringify({ id, bindings: [{ assetId: f.asset.id, streamId: "track:2", available }] }),
      );
  }
  const masked = { ...f.selection, acquisitionId: "masked" };
  f.processing.prepareSource(masked);
  await expect.poll(() => f.processing.sourceStatus(masked).state).toBe("ready");
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const status = f.processing.sourceStatus(masked);
  expect(status.jobId).not.toBe(f.processing.sourceStatus(f.selection).jobId);
  expect(f.requests[0]!.track.available).toEqual([
    { startUs: 200, endUs: 400 },
    { startUs: 600, endUs: 800 },
  ]);
  expect(f.acquisitions.references("masked")).toEqual([{ kind: "job", id: status.jobId }]);
  expect(f.processing.sourceStatus({ ...f.selection, acquisitionId: "empty" })).toMatchObject({
    state: "unavailable",
    reason: "no_audio",
    jobId: null,
  });
  expect(f.requests).toHaveLength(2);
  expect(f.jobs.job(status.jobId!).input).not.toContain('"available"');
});

test("a new model digest creates new immutable work while cleanup retains the earlier published words", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const original = f.processing.sourceStatus(f.selection);
  f.changeModel("b".repeat(64));
  expect(f.processing.sourceStatus(f.selection).state).toBe("not_requested");
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const latest = f.processing.sourceStatus(f.selection);
  expect(latest.jobId).not.toBe(original.jobId);
  expect(latest.published!.transcript.engine.modelDigest).toBe("b".repeat(64));
  await f.processing.cleanup(new AbortController().signal);
  expect(
    f.transcripts
      .wordRecords(original.published!.transcript, { limit: 10 })
      .map((word) => word.text),
  ).toEqual(["track:2"]);
});

test("current decoder work separates source recipes while retained evidence stays readable", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const previous = f.processing.sourceStatus(f.selection);
  const metadata = previous.published!.transcript;
  const original = f.transcripts.wordRecords(metadata, { limit: 100 });
  const row = f.catalog.catalog
    .prepare("SELECT input FROM jobs WHERE jobId=?")
    .get(previous.jobId) as { input: string };
  const oldRecipe = JSON.parse(row.input);
  delete oldRecipe.decoderExecution;
  const oldInput = JSON.stringify(oldRecipe);
  f.catalog.catalog
    .prepare("UPDATE jobs SET input=?,inputSha256=? WHERE jobId=?")
    .run(oldInput, createHash("sha256").update(oldInput).digest("hex"), previous.jobId);
  f.catalog.catalog
    .prepare(
      "UPDATE artifacts SET input=?,inputSha256=? WHERE targetId=? AND artifact='transcript'",
    )
    .run(oldInput, createHash("sha256").update(oldInput).digest("hex"), f.asset.id);
  expect(f.processing.sourceStatus(f.selection).state).toBe("not_requested");
  f.processing.prepareSource(f.selection);
  await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
  const current = f.processing.sourceStatus(f.selection);
  expect(current.jobId).not.toBe(previous.jobId);
  expect(current.published!.transcript.generation).not.toBe(metadata.generation);
  expect(f.requests).toHaveLength(2);
  await f.processing.cleanup(new AbortController().signal);
  expect(f.transcripts.wordRecords(metadata, { limit: 100 })).toEqual(original);
});

// 0.1.33 produced every transcript under this recipe and policy; slice 03 replaced both.
const release0133 = { recipe: "source-windows-20s-context4s-guard1s-v2", policy: "transcript-v3" };
test.each(["recipe", "policy", "0.1.33 identity"] as const)(
  "a published transcript with a foreign %s is skipped, regenerated by the next request and reclaimed",
  async (kind) => {
    const f = await fixture();
    f.processing.prepareSource(f.selection);
    await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
    const previous = f.processing.sourceStatus(f.selection);
    const old = previous.published!.transcript;
    // What an older version left behind: its job key, publication and row all name its identity.
    const foreign = (value: { execution: { recipe: string }; policy?: string }) =>
      kind === "recipe"
        ? { ...value, execution: { ...value.execution, recipe: "foreign-recipe-v0" } }
        : kind === "policy"
          ? { ...value, policy: "transcript-v0" }
          : {
              ...value,
              execution: { ...value.execution, recipe: release0133.recipe },
              policy: release0133.policy,
            };
    const job = f.catalog.catalog
      .prepare("SELECT input FROM jobs WHERE jobId=?")
      .get(previous.jobId) as { input: string };
    const input = JSON.stringify(foreign(JSON.parse(job.input)));
    const digest = createHash("sha256").update(input).digest("hex");
    const row = f.catalog.catalog
      .prepare("SELECT execution,engine FROM transcript_generations WHERE generation=?")
      .get(old.generation) as { execution: string; engine: string };
    const stored = foreign({ ...JSON.parse(row.engine), execution: JSON.parse(row.execution) });
    const result = JSON.stringify({
      ...old,
      execution: stored.execution,
      engine: { ...old.engine, policy: stored.policy ?? old.engine.policy },
    });
    f.catalog.catalog
      .prepare("UPDATE jobs SET input=?,inputSha256=? WHERE jobId=?")
      .run(input, digest, previous.jobId);
    f.catalog.catalog
      .prepare("UPDATE artifacts SET input=?,inputSha256=?,result=? WHERE attemptId=?")
      .run(input, digest, result, old.generation);
    f.catalog.catalog
      .prepare("UPDATE transcript_generations SET execution=?,engine=? WHERE generation=?")
      .run(
        JSON.stringify(stored.execution),
        JSON.stringify({ ...JSON.parse(row.engine), policy: stored.policy }),
        old.generation,
      );
    expect(() => f.processing.sourceStatus({ ...f.selection, generation: old.generation })).toThrow(
      expect.objectContaining({
        code: "NOT_FOUND",
        details: expect.objectContaining({ stale: true }),
      }),
    );
    expect(f.processing.sourceStatus(f.selection).state).toBe("not_requested");
    f.processing.prepareSource(f.selection);
    await expect.poll(() => f.processing.sourceStatus(f.selection).state).toBe("ready");
    const fresh = f.processing.sourceStatus(f.selection).published!.transcript;
    expect(fresh.generation).not.toBe(old.generation);
    expect(fresh.execution.recipe).not.toBe("foreign-recipe-v0");
    expect(fresh.engine.policy).not.toBe("transcript-v0");
    expect(fresh.execution.recipe).not.toBe(release0133.recipe);
    expect(fresh.engine.policy).not.toBe(release0133.policy);
    await f.processing.cleanup(new AbortController().signal);
    expect(
      f.catalog.catalog.prepare("SELECT generation FROM transcript_generations").all(),
    ).toEqual([{ generation: fresh.generation }]);
    expect(
      f.catalog.catalog
        .prepare("SELECT attemptId FROM artifacts WHERE artifact='transcript'")
        .all(),
    ).toEqual([{ attemptId: fresh.generation }]);
    expect(f.jobs.job(f.processing.sourceStatus(f.selection).jobId!).state).toBe("ready");
    expect(() => f.jobs.job(previous.jobId!)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    await expect(readdir(join(f.home, "transcripts", "assets", f.asset.id))).resolves.toEqual([
      fresh.generation,
    ]);
  },
);

test("portable transcripts retain raw bytes and words with models absent in the recipient", async () => {
  const donor = await fixture(),
    receiver = await fixture();
  donor.processing.prepareSource(donor.selection);
  await expect.poll(() => donor.processing.sourceStatus(donor.selection).state).toBe("ready");
  const original = donor.processing.sourceStatus(donor.selection).published!.transcript;
  const value = donor.transcripts.portableGenerations(donor.asset.id).generations[0]!;
  const raw = donor.transcripts.portableFile(value),
    receipt = donor.transcripts.portableReceipt(value);
  const input = donor.processing.portable(value);
  receiver.models.state = "absent";
  expect(receiver.processing.sourceStatus(receiver.selection).reason).toBe("model_not_prepared");
  const track = {
    ...value.track,
    source: receiver.assets.path(receiver.asset.id),
    available: input.available,
  };
  await expect(
    receiver.transcripts.stagePortable(
      { ...value, generation: value.generation.toUpperCase() },
      receipt,
      raw,
      track,
      new AbortController().signal,
    ),
  ).rejects.toThrow(/Invalid portable transcript/);
  const reserved = await receiver.transcripts.reserve(value);
  await writeFile(reserved, "existing generation bytes");
  await expect(
    receiver.transcripts.stagePortable(value, receipt, raw, track, new AbortController().signal),
  ).rejects.toThrow(/EEXIST/);
  expect(await readFile(reserved, "utf8")).toBe("existing generation bytes");
  await receiver.transcripts.remove(value);
  const stage = await receiver.transcripts.stagePortable(
    value,
    receipt,
    raw,
    track,
    new AbortController().signal,
  );
  expect(receiver.processing.sourceStatus(receiver.selection).reason).toBe("model_not_prepared");
  receiver.catalog.transaction(() => {
    stage.publish();
    receiver.processing.adoptPublication(
      stage.metadata,
      input.available,
      input.publication,
      stage.issues,
    );
  });
  await stage.close();
  const adopted = receiver.processing.sourceStatus(receiver.selection);
  expect(adopted).toMatchObject({ state: "ready", jobId: null, models: { state: "absent" } });
  expect(adopted.published!.transcript.track.source).toBe(receiver.assets.path(receiver.asset.id));
  expect(adopted.published!.transcript.track.source).not.toBe(original.track.source);
  expect(receiver.transcripts.wordRecords(adopted.published!.transcript, { limit: 100 })).toEqual(
    donor.transcripts.wordRecords(original, { limit: 100 }),
  );
  expect(await readFile(receiver.transcripts.portableFile(value).path)).toEqual(
    await readFile(raw.path),
  );
  expect(receiver.requests).toEqual([]);
  await receiver.transcripts.recoverPendingAssets(new AbortController().signal);
  await receiver.processing.cleanup(new AbortController().signal);
  expect(receiver.processing.sourceStatus(receiver.selection).state).toBe("ready");
  expect(receiver.requests).toEqual([]);
});

test("pending transcript recovery covers unpublished owners and cancellation leaves no visible generation", async () => {
  const donor = await fixture(),
    receiver = await fixture();
  donor.processing.prepareSource(donor.selection);
  await expect.poll(() => donor.processing.sourceStatus(donor.selection).state).toBe("ready");
  const value = donor.transcripts.portableGenerations(donor.asset.id).generations[0]!;
  const raw = donor.transcripts.portableFile(value),
    receipt = donor.transcripts.portableReceipt(value);
  const input = donor.processing.portable(value),
    track = {
      ...value.track,
      source: receiver.assets.path(receiver.asset.id),
      available: input.available,
    };
  const orphanHome = await mkdtemp("/tmp/portable-orphan-transcript-");
  const orphanCatalog = new Catalog(join(orphanHome, "catalog.sqlite"));
  cleanup.push(async () => {
    orphanCatalog.close();
    await rm(orphanHome, { recursive: true, force: true });
  });
  const orphan = new TranscriptStore(orphanCatalog, orphanHome, () => {
    throw new Error("Asset is unpublished");
  });
  const path = await orphan.reserve(value);
  await writeFile(path, "crash before index admission");
  await orphan.recoverPendingAssets(new AbortController().signal);
  await orphan.stagePortable(value, receipt, raw, track, new AbortController().signal);
  await orphan.recoverPendingAssets(new AbortController().signal);
  expect(orphan.portableGenerations(donor.asset.id).generations).toEqual([]);
  const retry = await orphan.stagePortable(
    value,
    receipt,
    raw,
    track,
    new AbortController().signal,
  );
  await retry.close();
  const controller = new AbortController();
  setImmediate(() => controller.abort(new Error("canceled transcript adoption")));
  await expect(
    receiver.transcripts.stagePortable(value, receipt, raw, track, controller.signal),
  ).rejects.toThrow(/canceled|aborted/i);
  expect(receiver.transcripts.portableGenerations(receiver.asset.id).generations).toEqual([]);
  const staged = await receiver.transcripts.stagePortable(
    value,
    receipt,
    raw,
    track,
    new AbortController().signal,
  );
  expect(() =>
    receiver.catalog.transaction(() => {
      staged.publish();
      receiver.processing.adoptPublication(
        staged.metadata,
        input.available,
        input.publication,
        staged.issues,
      );
      throw new Error("project rollback");
    }),
  ).toThrow("project rollback");
  await staged.close();
  expect(receiver.transcripts.portableGenerations(receiver.asset.id).generations).toEqual([]);
  expect(receiver.processing.sourceStatus(receiver.selection).state).toBe("not_requested");
});

test("portable transcripts preserve historical model recipes independently of recipient defaults", async () => {
  const donor = await fixture(),
    receiver = await fixture();
  receiver.models.state = "absent";
  for (const digest of ["a".repeat(64), "b".repeat(64)]) {
    donor.changeModel(digest);
    donor.processing.prepareSource(donor.selection);
    await expect.poll(() => donor.processing.sourceStatus(donor.selection).state).toBe("ready");
    const original = donor.processing.sourceStatus(donor.selection).published!.transcript;
    const value = donor.transcripts
      .portableGenerations(donor.asset.id)
      .generations.find((entry) => entry.generation === original.generation)!;
    const input = donor.processing.portable(value);
    const stage = await receiver.transcripts.stagePortable(
      value,
      donor.transcripts.portableReceipt(value),
      donor.transcripts.portableFile(value),
      {
        ...value.track,
        source: receiver.assets.path(receiver.asset.id),
        available: input.available,
      },
      new AbortController().signal,
    );
    receiver.catalog.transaction(() => {
      stage.publish();
      receiver.processing.adoptPublication(
        stage.metadata,
        input.available,
        input.publication,
        stage.issues,
      );
    });
    await stage.close();
    receiver.changeModel(digest);
    expect(receiver.processing.sourceStatus(receiver.selection)).toMatchObject({
      state: "ready",
      jobId: null,
      models: { state: "absent" },
      published: {
        transcript: { generation: original.generation, engine: { modelDigest: digest } },
      },
    });
  }
  await receiver.processing.cleanup(new AbortController().signal);
  expect(receiver.transcripts.portableGenerations(receiver.asset.id).generations).toHaveLength(2);
  expect(receiver.requests).toEqual([]);
});

test.each([false, true])(
  "fractional source portable receipts retain execution ownership (bounded=%s)",
  async (bounded) => {
    const timing = {
      originUs: { numerator: 1, denominator: 3 },
      startUs: { numerator: 201, denominator: 2 },
      endUs: { numerator: 2001, denominator: 2 },
    };
    const donor = await fixture(timing),
      receiver = await fixture(timing);
    const preparation = {
      ...donor.selection,
      ...(bounded
        ? { executionRange: { startUs: 300, endUs: 700 }, context: { beforeUs: 100, afterUs: 100 } }
        : {}),
    };
    donor.processing.prepareSource(preparation);
    await expect.poll(() => donor.processing.sourceStatus(preparation).state).toBe("ready");
    const value = donor.transcripts.portableGenerations(donor.asset.id).generations[0]!;
    const receipt = donor.transcripts.portableReceipt(value);
    expect(receipt.segments[0]!.source).toEqual(
      bounded ? { startUs: 200, endUs: 800 } : { startUs: timing.startUs, endUs: timing.endUs },
    );
    expect(receipt.segments[0]!.owned).toEqual(
      bounded ? { startUs: 300, endUs: 700 } : { startUs: timing.startUs, endUs: timing.endUs },
    );
    expect(donor.transcripts.segmentRecords(value, { limit: 5 })).toMatchObject([
      bounded ? { startUs: 200, endUs: 800 } : { startUs: 101, endUs: 1001 },
    ]);
    expect(donor.transcripts.wordRecords(value, { limit: 5 })).toMatchObject([
      bounded ? { startUs: 210, endUs: 790 } : { startUs: 111, endUs: 991 },
    ]);
    expect(value.track.sourceOffsetUs).toEqual({ numerator: -1, denominator: 3 });
    receiver.models.state = "absent";
    const input = donor.processing.portable(value);
    const stage = await receiver.transcripts.stagePortable(
      value,
      receipt,
      donor.transcripts.portableFile(value),
      {
        ...value.track,
        source: receiver.assets.path(receiver.asset.id),
        available: input.available,
      },
      new AbortController().signal,
    );
    try {
      receiver.catalog.transaction(() => {
        stage.publish();
        receiver.processing.adoptPublication(
          stage.metadata,
          input.available,
          input.publication,
          stage.issues,
        );
      });
      expect(receiver.transcripts.portableReceipt(value).segments).toEqual(receipt.segments);
      expect(
        receiver.processing.sourceStatus({ ...receiver.selection, generation: value.generation })
          .published!.transcript.execution,
      ).toEqual(value.execution);
      expect(receiver.transcripts.portableReceipt(value).available).toEqual(receipt.available);
      expect(receiver.transcripts.gapRecords(value, { limit: 20 })).toEqual(
        donor.transcripts.gapRecords(value, { limit: 20 }),
      );
      expect(receiver.requests).toEqual([]);
    } finally {
      await stage.close();
    }
  },
);

async function retainOutput(name: string, value: unknown) {
  const directory = process.env.YAP_TRANSCRIPT_TEST_OUTPUT;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}
type NativeWord = {
  text: string;
  source: { startUs: number; endUs: number };
  confidence: number | null;
};
type NativeLine = SpeechTranscriptionReceipt["segments"][number] & {
  words: NativeWord[];
  issues?: unknown[];
};
function nativeTranscript(
  corrupt?: (lines: NativeLine[], receipt: SpeechTranscriptionReceipt) => void,
  label = "positive",
): SpeechTranscriber {
  return async (request) => {
    const lines: NativeLine[] = [
      {
        ordinal: 0,
        source: { startUs: 500000, endUs: 4000000 },
        owned: { startUs: 500000, endUs: 4000000 },
        state: "transcribed",
        wordCount: 4,
        words: [
          { text: "Um,", source: { startUs: 1000000, endUs: 1300000 }, confidence: null },
          { text: "hello", source: { startUs: 1400000, endUs: 1900000 }, confidence: 0.75 },
          { text: "world.", source: { startUs: 2000000, endUs: 2600000 }, confidence: 0.75 },
          { text: "uh-huh", source: { startUs: 3000000, endUs: 3400000 }, confidence: 0.75 },
        ],
      },
      {
        ordinal: 1,
        source: { startUs: 5500000, endUs: 8000000 },
        owned: { startUs: 5500000, endUs: 8000000 },
        state: "transcribed",
        wordCount: 3,
        words: [
          { text: "Hello", source: { startUs: 6000000, endUs: 6500000 }, confidence: null },
          { text: "World", source: { startUs: 6600000, endUs: 7000000 }, confidence: 0.75 },
          { text: "Uhm.", source: { startUs: 7200000, endUs: 7200000 }, confidence: 0.75 },
        ],
      },
      {
        ordinal: 2,
        source: { startUs: 8500000, endUs: 8600000 },
        owned: { startUs: 8500000, endUs: 8600000 },
        state: "skipped",
        reason: "too_short",
        wordCount: 0,
        words: [],
      },
    ];
    const receipt: SpeechTranscriptionReceipt = {
      output: { file: request.output, bytes: 0, sha256: "" },
      engine: {
        runtime: "FluidAudio",
        runtimeVersion: "0.15.7",
        decoder: "parakeet-tdt-batch",
        encoderPrecision: "int8",
        computeUnits: "cpuAndNeuralEngine",
      },
      // Receipt segments carry everything but their words.
      segments: lines.map((line) => {
        const segment: Omit<typeof line, "words"> & { words?: unknown } = structuredClone(line);
        delete segment.words;
        return segment;
      }),
      wordCount: 7,
      execution: request.execution,
      available: lines.map((line) => line.source),
    };
    corrupt?.(lines, receipt);
    const raw = lines.map((line) => JSON.stringify(line) + "\n").join("");
    await writeFile(request.output, raw);
    receipt.output.bytes = Buffer.byteLength(raw);
    if (!receipt.output.sha256)
      receipt.output.sha256 = createHash("sha256").update(raw).digest("hex");
    await retainOutput(`native-${label}`, { request, raw, receipt });
    return receipt;
  };
}
test("selected transcript native refusal leaves no generation, indexed row or output", async () => {
  const cases: [string, (lines: NativeLine[], receipt: SpeechTranscriptionReceipt) => void][] = [
    [
      "Raw transcript ownership differs from its receipt",
      (lines) => {
        lines[0]!.owned = { startUs: 1_000_000, endUs: 4_000_000 };
      },
    ],
    [
      "Transcript word lies outside its segment",
      (lines) => {
        lines[0]!.words[0]!.source.startUs = 100000;
      },
    ],
    [
      "Transcript word range is reversed",
      (lines) => {
        lines[0]!.words[1]!.source.endUs = 1000000;
      },
    ],
    [
      "Transcript words must be ordered by start",
      (lines) => {
        const words = lines[0]!.words;
        [words[1], words[2]] = [words[2]!, words[1]!];
      },
    ],
    [
      "Transcription segment ordinals must be unique and ordered",
      (lines, receipt) => {
        lines[1]!.ordinal = 0;
        receipt.segments[1]!.ordinal = 0;
      },
    ],
    [
      "Transcription segment ordinals must be unique and ordered",
      (lines, receipt) => {
        [lines[0], lines[1]] = [lines[1]!, lines[0]!];
        [receipt.segments[0], receipt.segments[1]] = [receipt.segments[1]!, receipt.segments[0]!];
      },
    ],
    [
      "Raw transcript segment differs from its receipt",
      (lines) => {
        [lines[0], lines[1]] = [lines[1]!, lines[0]!];
      },
    ],
    [
      "Transcription segment does not lie in an acquired source interval",
      (...[, receipt]) => {
        receipt.segments[0]!.source = { startUs: 0, endUs: 4000000 };
      },
    ],
    [
      "Raw transcript does not match its receipt",
      (...[, receipt]) => {
        receipt.output.sha256 = "f".repeat(64);
      },
    ],
    [
      "Raw transcript issue is malformed",
      (lines) => {
        lines[0]!.issues = [{ ...clampedIssue, word: 4 }];
      },
    ],
    [
      "Raw transcript issue is malformed",
      (lines) => {
        lines[0]!.issues = [{ ...clampedIssue, code: "seam-refused" }];
      },
    ],
  ];
  for (const [index, [reason, corrupt]] of cases.entries()) {
    const f = await fixture(
      { originUs: 250000, startUs: 500000, endUs: 10000000 },
      nativeTranscript(corrupt, String(index)),
    );
    f.processing.prepareSource(f.selection);
    await f.jobs.idle();
    const status = f.processing.sourceStatus(f.selection);
    await retainOutput(`state-${index}`, {
      expected: { state: "failed", reason, retryable: false, published: null },
      status,
      tables: Object.fromEntries(
        [
          "transcript_generations",
          "transcript_words",
          "transcript_segments",
          "transcript_gaps",
        ].map((name) => [name, f.catalog.catalog.prepare(`SELECT * FROM ${name}`).all()]),
      ),
    });
    expect(status, reason).toMatchObject({
      state: "failed",
      reason,
      retryable: false,
      published: null,
    });
    expect(
      f.catalog.catalog
        .prepare(
          "SELECT (SELECT COUNT(*) FROM transcript_generations)+(SELECT COUNT(*) FROM transcript_words)+(SELECT COUNT(*) FROM transcript_segments)+(SELECT COUNT(*) FROM transcript_gaps) AS n",
        )
        .get(),
      reason,
    ).toEqual({ n: 0 });
    expect(await readdir(join(f.home, "transcripts", "assets", f.asset.id)), reason).toEqual([]);
    await expect(readFile(f.requests[0]!.output)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

// Raw issue lines as native writes them (helpers/mac/Tests/YapSpeechTests/main.swift pins the wire).
const clampedIssue = {
  code: "timing-clamped",
  message:
    "The engine estimate [16.560, 16.720] s runs past its decoded window; it is clamped to the window edge.",
  word: 2,
  evidence: {
    window: 1,
    observation: 2,
    decoded: { startUs: 5500000, endUs: 8000000 },
    startSeconds: 16.56,
    endSeconds: 16.72,
  },
};
const unresolvedIssue = {
  code: "boundary-unresolved",
  message:
    "'hello' has no unique peer across the 2.000 s seam; the window whose core holds its start publishes it.",
  word: 1,
  evidence: { boundaryUs: 2000000, window: 0, observation: 1, text: "hello", published: true },
};
const droppedIssue = {
  code: "word-dropped",
  message:
    "Token 6 of 'bad' has a malformed engine estimate; the word is dropped and its neighbours publish.",
  range: { startUs: 5500000, endUs: 8000000 },
  evidence: {
    window: 1,
    token: 6,
    text: "bad",
    startSeconds: "NaN",
    endSeconds: 5.2,
    confidence: 1,
  },
};
test("local transcription problems publish as issues on the words they touch", async () => {
  const f = await fixture(
    { originUs: 250000, startUs: 500000, endUs: 10000000 },
    nativeTranscript((lines) => {
      lines[0]!.issues = [unresolvedIssue];
      lines[1]!.issues = [clampedIssue, droppedIssue];
    }, "issues"),
  );
  f.processing.prepareSource(f.selection);
  await f.jobs.idle();
  const status = f.processing.sourceStatus(f.selection);
  const issue = ({ word, range, ...value }: Record<string, unknown>) => ({
    ...value,
    at: word === undefined ? { range } : { word },
  });
  // Word positions are line-local in raw evidence and transcript ordinals once published.
  const expected = [
    issue(unresolvedIssue),
    {
      ...issue(clampedIssue),
      at: { word: 6 },
      evidence: {
        window: 1,
        observation: 2,
        decoded: { startUs: 5500000, endUs: 8000000 },
        startUs: 16560000,
        endUs: 16720000,
      },
    },
    {
      ...issue(droppedIssue),
      evidence: {
        window: 1,
        token: 6,
        text: "bad",
        startSeconds: "NaN",
        endUs: 5200000,
        confidence: 1,
      },
    },
  ];
  expect(status).toMatchObject({ state: "ready", published: { issues: expected } });
  const rows = new SourceTranscriptRead(f.transcripts, status.published!.transcript)
    .page({})
    .rows.filter((row) => row.type === "word");
  expect(rows.map((row) => [row.text, row.issues?.map((value) => value.code) ?? []])).toEqual([
    ["Um,", []],
    ["hello", ["boundary-unresolved"]],
    ["world.", []],
    ["uh-huh", []],
    ["Hello", []],
    ["World", []],
    ["Uhm.", ["timing-clamped"]],
  ]);
  expect(rows[1]!.issues).toEqual([expected[0]]);
  expect("issues" in rows[0]!).toBe(false);
  expect(
    new SourceTranscriptRead(f.transcripts, status.published!.transcript).page({
      range: { startUs: 7_000_000, endUs: 7_500_000 },
    }).rows,
  ).toMatchObject([{ text: "Uhm.", issues: [expected[1]] }]);
});

test("selected decoded segments retain gaps, kinds, null confidence and instantaneous words", async () => {
  const f = await fixture(
    { originUs: 250000, startUs: 500000, endUs: 10000000 },
    nativeTranscript(),
  );
  f.processing.prepareSource(f.selection);
  await f.jobs.idle();
  const status = f.processing.sourceStatus(f.selection);
  expect(status).toMatchObject({
    state: "ready",
    published: { transcript: { segmentCount: 3, wordCount: 7, gapCount: 5 } },
  });
  const metadata = status.published!.transcript;
  const read = new SourceTranscriptRead(f.transcripts, metadata);
  const rows = read.page({}).rows;
  expect(rows.map((row) => (row.type === "word" ? row.text : row.reason))).toEqual([
    "not_acquired",
    "Um,",
    "hello",
    "world.",
    "uh-huh",
    "not_acquired",
    "Hello",
    "World",
    "Uhm.",
    "not_acquired",
    "too_short",
    "not_acquired",
  ]);
  expect(rows[1]).toEqual({
    type: "word",
    wordId: "w0",
    ordinal: 0,
    text: "Um,",
    kind: "filler",
    confidence: null,
    segment: 0,
    sourceRange: { startUs: 1000000, endUs: 1300000 },
    partial: false,
  });
  expect(rows[4]).toMatchObject({ wordId: "w3", kind: "vocalization", confidence: 0.75 });
  expect(rows[8]).toMatchObject({
    wordId: "w6",
    text: "Uhm.",
    kind: "filler",
    instant: true,
    sourceRange: { startUs: 7200000, endUs: 7200000 },
    segment: 1,
  });
  expect(
    rows.filter((row) => row.type === "gap").map((row) => [row.reason, row.sourceRange]),
  ).toEqual([
    ["not_acquired", { startUs: 0, endUs: 500000 }],
    ["not_acquired", { startUs: 4000000, endUs: 5500000 }],
    ["not_acquired", { startUs: 8000000, endUs: 8500000 }],
    ["too_short", { startUs: 8500000, endUs: 8600000 }],
    ["not_acquired", { startUs: 8600000, endUs: 10000000 }],
  ]);
  const raw = await readFile(f.requests[0]!.output);
  expect(metadata.raw).toEqual({
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
  expect(f.requests).toHaveLength(1);
});
