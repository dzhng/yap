import { rational, toTime } from "@yap/composition";
import { afterEach, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { JobQueue, type StagedJobResult } from "./jobs.js";
import { Models } from "./models.js";
import { VoiceGenerationJobs, type VoiceGenerationInput } from "./voice-generation.js";
import { resolveVoiceSettings, voiceProfile, voiceProfileSha256 } from "./voice-profile.js";
import type { VoiceReceipt } from "./voice-types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function wave(frames: number, value = 0.125) {
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 4, 40);
  for (let at = 44; at < bytes.length; at += 4) bytes.writeFloatLE(value, at);
  return bytes;
}
async function fixture(outputFrames = 6000) {
  const home = await realpath(await mkdtemp("/tmp/voice-jobs-"));
  let available = true,
    reads = 0,
    executions = 0;
  let hold: ((result: StagedJobResult) => Promise<void>) | undefined;
  let failure: Error | undefined;
  const source = join(home, "reference.wav");
  await writeFile(source, wave(24000));
  async function connect() {
    const catalog = new Catalog(join(home, "catalog.sqlite"));
    const assets = new AssetStore(catalog, home);
    await assets.recover();
    const registry = new Models(home, globalThis.fetch, undefined, catalog);
    const model = registry.list().find((m) => m.id === voiceProfile.id)!;
    const ready = async () => {
      reads++;
      if (!available)
        throw new CatalogError(
          "MODEL_NOT_PREPARED",
          "Controlled execution prerequisite unavailable",
          {},
        );
      return {
        python: "unused",
        entry: "unused",
        model: "unused",
        cache: "unused",
        descriptorDigest: model.descriptorDigest,
        runtimeDigest: model.runtimeDigest!,
        modelDigest: model.modelDigest,
        runtimeRevision: model.pins.runtimeRevision,
        modelRevision: model.pins.modelRevision,
      };
    };
    const probe = async (path: string) => {
      const data = await readFile(path),
        frames = (data.length - 44) / 4;
      const duration = toTime(rational(BigInt(frames) * 1000000n, 24000n));
      return {
        originUs: 0,
        streams: [
          {
            id: "track:1",
            kind: "audio",
            codec: "lpcm",
            decodable: true,
            startUs: 0,
            endUs: duration,
            segments: [{ startUs: 0, endUs: duration, empty: false }],
            sampleRate: 24000,
            channels: 1,
          },
        ],
      };
    };
    let owner!: VoiceGenerationJobs;
    const jobs = new JobQueue({
      store: catalog,
      providers: { newId: randomUUID },
      targets: {
        pin: (target) => {
          if (target.kind !== "asset") throw Error("asset target required");
          assets.get(target.id);
          return target;
        },
        isAvailable: (target) => target.kind === "asset" && assets.has(target.id),
        isDeleting: () => false,
        isCapturing: () => false,
      },
      execute: async (execution) => {
        const result = await owner.execute(execution);
        await hold?.(result);
        return result;
      },
    });
    owner = new VoiceGenerationJobs({
      assets,
      jobs,
      models: { list: () => registry.list(), runtime: ready },
      probe,
      staging: join(home, "staging", "voice"),
      generate: async (modelId, request, signal) => {
        expect(modelId).toBe(model.id);
        await ready();
        signal.throwIfAborted();
        executions++;
        if (failure) throw failure;
        const reference = await readFile(request.reference),
          output = wave(outputFrames, 0.25);
        await writeFile(request.output, output);
        const settings = resolveVoiceSettings(request.generation, request.seed);
        const receipt: VoiceReceipt = {
          file: request.output,
          sha256: hash(output),
          sampleRate: 24000,
          channels: 1,
          frames: outputFrames,
          durationUs: Math.round((outputFrames * 1000000) / 24000),
          referenceSha256: hash(reference),
          referenceFrames: (reference.length - 44) / 4,
          runtimeRevision: model.pins.runtimeRevision,
          modelRevision: model.pins.modelRevision,
          profileId: voiceProfile.id,
          profileSha256: voiceProfileSha256,
          tokenizerIdentity: {
            vocabulary: hash("vocabulary"),
            configuration: hash("configuration"),
          },
          iclSourceSha256: hash("entry"),
          generation: settings.requested,
          effectiveGeneration: settings.effective,
          filterModes: settings.filterModes,
          seed: settings.seed,
          prefill: {
            referenceTextTokens: 2,
            targetTextTokens: 3,
            referenceTextTokenSha256: hash(request.referenceText),
            targetTextTokenSha256: hash(request.text),
            referenceCodes: 12,
            inputTokens: 32,
          },
          stopReason: "eos",
          generatedTokens: 10,
          text: request.text,
          referenceText: request.referenceText,
          descriptorDigest: model.descriptorDigest,
          runtimeDigest: model.runtimeDigest!,
          modelDigest: model.modelDigest,
        };
        return receipt;
      },
    });
    await owner.recover();
    return {
      assets,
      jobs,
      owner,
      probe,
      model,
      close: async () => {
        await jobs.close();
        catalog.close();
      },
    };
  }
  let current = await connect();
  const reference = await current.assets.import(
    source,
    { kind: "import", source: "controlled reference" },
    current.probe,
  );
  const input: VoiceGenerationInput = {
    modelId: current.model.id,
    reference: { assetId: reference.id, streamId: "track:1" },
    referenceText: "Reference transcript.",
    text: "Desired sentence.",
  };
  cleanup.push(async () => {
    await current.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    source,
    reference,
    input,
    get current() {
      return current;
    },
    setAvailable(value: boolean) {
      available = value;
    },
    counts: () => ({ reads, executions }),
    setFailure(value?: Error) {
      failure = value;
    },
    setHold(value?: typeof hold) {
      hold = value;
    },
    async restart() {
      await current.close();
      current = await connect();
    },
  };
}
async function complete(f: Awaited<ReturnType<typeof fixture>>, input = f.input) {
  const started = await f.current.owner.request(input);
  await expect.poll(() => f.current.jobs.job(started.jobId!).state).toBe("ready");
  const status = await f.current.owner.request(input);
  return { status, result: JSON.parse(status.published!.result) };
}

test("saved canonical work replays after restart without prepared model and retains reference bytes", async () => {
  const f = await fixture(),
    first = await complete(f);
  const bytes = await readFile(f.current.assets.path(first.result.assetId));
  expect(f.current.assets.references(f.reference.id)).toContainEqual({
    kind: "asset",
    id: first.result.assetId,
  });
  expect(f.current.assets.portable(first.result.assetId).dependencies).toContainEqual({
    kind: "asset",
    id: f.reference.id,
  });
  expect(first.result.origin.reference.originSha256).toBeNull();
  await f.restart();
  f.setAvailable(false);
  const before = f.counts();
  expect(await f.current.owner.request(f.input)).toEqual(first.status);
  expect(
    await f.current.owner.request({
      ...f.input,
      preset: voiceProfile.id,
      generation: { ...resolveVoiceSettings().requested },
      seed: voiceProfile.defaultSeed,
    }),
  ).toEqual(first.status);
  expect(f.counts()).toEqual(before);
  expect(await readFile(f.current.assets.path(first.result.assetId))).toEqual(bytes);
  await expect(
    f.current.owner.request({ ...f.input, text: "Different sentence." }),
  ).rejects.toMatchObject({ code: "MODEL_NOT_PREPARED" });
});

test("explicit origin is frozen, omission stays none, and added origins never change existing work", async () => {
  const f = await fixture();
  const first = await complete(f);
  const origin = f.current.assets.origins(f.reference.id).origins[0]!;
  const selected = await complete(f, { ...f.input, reference: { ...f.input.reference, origin } });
  expect(selected.status.jobId).not.toBe(first.status.jobId);
  expect(selected.result.origin.reference.originSha256).toBe(hash(JSON.stringify(origin)));
  await f.current.assets.import(
    f.source,
    { kind: "import", source: "later unrelated provenance" },
    f.current.probe,
  );
  expect((await f.current.owner.request(f.input)).jobId).toBe(first.status.jobId);
  expect(
    (
      await f.current.owner.request({
        ...f.input,
        reference: {
          ...f.input.reference,
          origin: { source: "controlled reference", kind: "import" },
        },
      })
    ).jobId,
  ).toBe(selected.status.jobId);
  await expect(
    f.current.owner.request({
      ...f.input,
      reference: { ...f.input.reference, origin: { kind: "import", source: "invented" } },
    }),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
});

test("reference transcript, desired text and requested settings distinguish frozen work", async () => {
  const f = await fixture();
  const a = await complete(f),
    b = await complete(f, { ...f.input, referenceText: "Different transcript." }),
    c = await complete(f, { ...f.input, text: "Another sentence." }),
    d = await complete(f, { ...f.input, generation: { repetition_penalty: 1.5 } });
  expect(new Set([a, b, c, d].map((r) => r.status.jobId)).size).toBe(4);
  expect(a.result.origin.receipt.effectiveGeneration.repetition_penalty).toBe(1.5);
  expect(d.result.origin.receipt.generation.repetition_penalty).toBe(1.5);
});

test("failure has no published asset and explicit retry uses the frozen request", async () => {
  const f = await fixture();
  f.setFailure(new CatalogError("MEDIA_WORKER_FAILED", "controlled", {}));
  const started = await f.current.owner.request(f.input);
  await expect.poll(() => f.current.jobs.job(started.jobId!).state).toBe("failed");
  const frozen = f.current.jobs.job(started.jobId!).input;
  expect((await f.current.owner.request(f.input)).published).toBeNull();
  f.setFailure();
  f.setAvailable(false);
  const beforeReplay = f.counts();
  expect((await f.current.owner.request(f.input)).state).toBe("failed");
  expect(f.counts()).toEqual(beforeReplay);
  f.current.jobs.retry(started.jobId!);
  await expect.poll(() => f.current.jobs.job(started.jobId!).errorCode).toBe("MODEL_NOT_PREPARED");
  f.setAvailable(true);
  f.current.jobs.retry(started.jobId!);
  await expect.poll(() => f.current.jobs.job(started.jobId!).state).toBe("ready");
  expect(f.current.jobs.job(started.jobId!).input).toBe(frozen);
});

test("cancellation after staging fences publication and retry can publish complete bytes", async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let staged = false;
  f.setHold(async () => {
    staged = true;
    await held;
  });
  const started = await f.current.owner.request(f.input);
  await expect.poll(() => staged).toBe(true);
  const draining = f.current.jobs.drainJob(started.jobId!);
  release();
  await draining;
  expect((await f.current.owner.request(f.input)).published).toBeNull();
  expect(f.current.assets.has(hash(wave(6000, 0.25)))).toBe(false);
  f.setHold();
  f.current.jobs.retry(started.jobId!);
  await expect.poll(() => f.current.jobs.job(started.jobId!).state).toBe("ready");
  expect(f.current.assets.has(hash(wave(6000, 0.25)))).toBe(true);
});

test("reordered record keys in a selected generated origin replay the stored request without readiness", async () => {
  const f = await fixture();
  const generated = await complete(f);
  const origin = f.current.assets
    .origins(generated.result.assetId)
    .origins.find((value) => value.kind === "voice-generation")!;
  const input = {
    ...f.input,
    reference: { assetId: generated.result.assetId, streamId: generated.result.streamId, origin },
  };
  const first = await complete(f, input);
  if (origin.kind !== "voice-generation") throw new Error("generated origin");
  const reordered = {
    ...origin,
    receipt: {
      ...origin.receipt,
      tokenizerIdentity: Object.fromEntries(
        Object.entries(origin.receipt.tokenizerIdentity).reverse(),
      ),
    },
  };
  f.setAvailable(false);
  const before = f.counts();
  expect(
    (
      await f.current.owner.request({
        ...input,
        reference: { ...input.reference, origin: reordered },
      })
    ).jobId,
  ).toBe(first.status.jobId);
  expect(f.counts()).toEqual(before);
  await f.current.assets.import(
    f.current.assets.path(generated.result.assetId),
    reordered,
    f.current.probe,
  );
  expect((await f.current.owner.request(input)).jobId).toBe(first.status.jobId);
  expect(f.counts()).toEqual(before);
});

test("published generated duration is exact while the frozen worker duration stays an observation label", async () => {
  const f = await fixture(6001),
    { result } = await complete(f);
  expect(result.durationUs).toEqual({ numerator: 750125, denominator: 3 });
  expect(f.current.assets.get(result.assetId).streams[0]!.endUs).toEqual(result.durationUs);
  expect(result.origin.receipt.durationUs).toBe(250042);
  expect((await readFile(f.current.assets.path(result.assetId))).length).toBe(44 + 6001 * 4);
});
