import { afterEach, expect, test } from "vitest";
import { admitReadRange } from "@yap/composition";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { Models, type ModelManifest } from "./models.js";
import { JobQueue } from "./jobs.js";
import { AlignmentEvidenceStore, assetAlignmentOwner } from "./alignment-evidence.js";
import {
  AlignmentProcessing,
  type AlignmentObserver,
  type AlignmentProcessingOptions,
} from "./alignment-processing.js";
import { alignmentOutput, alignmentSource } from "./alignment-evidence.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture() {
  const home = await mkdtemp("/tmp/alignment-processing-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const original = join(home, "external.wav");
  await writeFile(original, "two-channel source");
  const asset = await assets.import(original, { kind: "import" }, async () => ({
    originUs: -250000,
    streams: [
      {
        id: "a1",
        kind: "audio",
        codec: "fixture",
        decodable: true,
        channels: 2,
        sampleRate: 48000,
        startUs: 0,
        endUs: 40000000,
        segments: [{ startUs: 0, endUs: 40000000, empty: false }],
      },
    ],
  }));
  const runtimeSource = join(home, "runtime"),
    modelSource = join(home, "model");
  await mkdir(join(runtimeSource, "execution"), { recursive: true, mode: 0o700 });
  await mkdir(modelSource);
  await writeFile(join(runtimeSource, "execution/worker.py"), "controlled worker", { mode: 0o700 });
  await writeFile(join(modelSource, "model.nemo"), "controlled model");
  const entries = [
    { kind: "directory" as const, path: "execution", mode: 0o700 },
    {
      kind: "file" as const,
      path: "execution/worker.py",
      mode: 0o700,
      bytes: 17,
      sha256: hash("controlled worker"),
    },
  ];
  const manifest: ModelManifest = {
    name: "alignment-control",
    purpose: "alignment",
    modelSourceRequired: true,
    platform: { system: process.platform, architecture: process.arch },
    repo: "fixture/nemo-auxiliary-ctc110-v1",
    revision: "r1",
    folderName: "model",
    engine: {
      runtime: "control",
      runtimeVersion: "1",
      runtimeRevision: "r1",
      decoder: "nemo-auxiliary-ctc110-v1",
    },
    files: [{ path: "model.nemo", bytes: 16, sha256: hash("controlled model") }],
    runtimeArtifact: {
      entries,
      digest: hash(JSON.stringify(entries)),
      python: "execution/worker.py",
      entry: "execution/worker.py",
    },
  };
  const models = new Models(
    home,
    () => {
      throw new Error("network refused");
    },
    [manifest],
    catalog,
  );
  await models.prepare(manifest.name, new AbortController().signal, { runtimeSource, modelSource });
  const evidence = new AlignmentEvidenceStore(catalog, assetAlignmentOwner(assets, acquisitions));
  const requests: Parameters<AlignmentObserver>[0][] = [];
  const control = { hold: false, deleting: false, fail: false, release: () => {} };
  const observe: AlignmentObserver = async (request) => {
    requests.push(request);
    if (control.hold)
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
    const operands = alignmentOutput();
    for (const field of ["nativeReceipt", "report"] as const) {
      const parsed = JSON.parse(operands[field]);
      parsed.modelSha256 = request.engine.modelSha256;
      operands[field] = JSON.stringify(parsed);
    }
    return {
      pcm: alignmentSource.pcm,
      operands,
      ...(control.fail
        ? { failure: new CatalogError("MODEL_CONTRACT_CHANGED", "Controlled failure") }
        : {}),
    };
  };
  let processing: AlignmentProcessing;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (v) => {
        if (v.kind === "asset") assets.get(v.id);
        else if (v.kind !== "project") throw new Error("expected media owner");
        return v;
      },
      isAvailable: () => !control.deleting,
      isDeleting: () => control.deleting,
      isCapturing: () => false,
    },
    execute: (execution) => processing.execute(execution),
  });
  const decoder = { ...alignmentSource.decoder };
  const options: AlignmentProcessingOptions = {
    assets,
    acquisitions,
    models,
    jobs,
    evidence,
    observe,
    decoder,
  };
  processing = new AlignmentProcessing(options);
  cleanup.push(async () => {
    control.release();
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const input = {
    assetId: asset.id,
    streamId: "a1",
    channel: 0,
    sourceRange: alignmentSource.observationRange,
    modelId: manifest.name,
    text: alignmentSource.text,
  };
  return {
    processing,
    jobs,
    models,
    requests,
    evidence,
    input,
    control,
    home,
    decoder,
    options,
    catalog,
  };
}

test("a repeated explicit observation joins the source job and ready reads need no runtime", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.input);
  f.processing.prepareSource(f.input);
  await expect.poll(() => f.processing.sourceStatus(f.input).state).toBe("ready");
  const status = f.processing.sourceStatus(f.input);
  const metadata = status.published!.evidence;
  expect(
    f.evidence
      .page(metadata, "words", -1, 100)
      .rows.map((v) => ("correspondence" in v ? v.correspondence : null)),
  ).toEqual(["unknown", "unmatched", "unknown", "unknown"]);
  expect(
    f.requests.map((v) => ({ channel: v.selected.channel, range: v.selected.sourceRange })),
  ).toEqual([{ channel: 0, range: f.input.sourceRange }]);
  await rm(join(f.home, "models", f.input.modelId), { recursive: true });
  expect(f.processing.sourceStatus(f.input)).toEqual(status);
  const publication = f.processing.portablePublication(metadata);
  expect(publication).toMatchObject({ attemptId: metadata.generation, generation: 1 });
  if (!publication) throw Error("Expected retained publication");
  f.processing.adoptPublication(metadata, publication);
  expect(f.processing.sourceStatus(f.input)).toEqual(status);
  expect(() =>
    f.processing.adoptPublication(metadata, { ...publication, attemptId: "other" }),
  ).toThrow("differs from its source and generation");
});

test("cancellation drains a held worker and explicit retry publishes a fresh generation", async () => {
  const f = await fixture();
  f.control.hold = true;
  f.processing.prepareSource(f.input);
  await expect.poll(() => f.requests.length).toBe(1);
  const jobId = f.processing.sourceStatus(f.input).jobId!;
  const first = f.jobs.job(jobId).attemptId;
  const draining = f.jobs.drainJob(jobId);
  f.control.release();
  await draining;
  expect(f.processing.sourceStatus(f.input).published).toBeNull();
  expect(() =>
    f.evidence.metadata({
      owner: { kind: "asset", id: f.input.assetId },
      generation: first,
      policy: "alignment-v1",
    }),
  ).toThrow("not ready");
  f.control.hold = false;
  f.jobs.retry(jobId);
  await expect.poll(() => f.processing.sourceStatus(f.input).state).toBe("ready");
  expect(f.processing.sourceStatus(f.input).published!.evidence.generation).not.toBe(first);
});

test("retained reads bind the original decoder after native identity replacement", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.input);
  await expect.poll(() => f.processing.sourceStatus(f.input).state).toBe("ready");
  const original = f.processing.sourceStatus(f.input);
  f.decoder.workerSha256 = hash("replacement native executable");
  f.decoder.osBuild = "replacement OS build";
  const replacement = f.processing.sourceStatus(f.input);
  await writeFile(
    join(f.home, "decoder-read-comparison.json"),
    JSON.stringify({ original, replacement }),
  );
  expect(replacement).toEqual(original);
  expect(f.processing.prepareSource(f.input)).toEqual(original);
  expect(f.processing.sourceStatus({ ...f.input, channel: 1 }).published).toBeNull();
  expect(f.requests.length).toBe(1);
  expect(f.requests[0]!.checkpoint).toBe(join(f.requests[0]!.runtime.model, "model.nemo"));
  await rm(join(f.home, "models", f.input.modelId), { recursive: true });
  expect(f.processing.sourceStatus(f.input)).toEqual(original);
});

test("missing native decoder leaves retained reads ready and new observations unavailable", async () => {
  const f = await fixture();
  f.processing.prepareSource(f.input);
  await expect.poll(() => f.processing.sourceStatus(f.input).state).toBe("ready");
  const original = f.processing.sourceStatus(f.input);
  f.options.decoder = null;
  const retained = f.processing.sourceStatus(f.input);
  const unobserved = f.processing.prepareSource({ ...f.input, channel: 1 });
  await writeFile(
    join(f.home, "absent-decoder-comparison.json"),
    JSON.stringify({ original, retained, unobserved }),
  );
  expect(retained).toEqual(original);
  expect(unobserved).toMatchObject({
    state: "unavailable",
    reason: "native_decoder_unavailable",
    published: null,
  });
  expect(f.requests.map((v) => v.selected.channel)).toEqual([0]);
});

test("project alignment uses a project job while retaining the prepared tap source", async () => {
  const f = await fixture();
  f.options.project = {
    resolve(input) {
      return {
        source: f.input,
        projectId: input.projectId,
        revisionId: input.revisionId ?? "revision",
        preparedResourceId: input.preparedResourceId,
      };
    },
  };
  const request = {
    projectId: "project",
    revisionId: "revision",
    preparedResourceId: "prepared",
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    range: f.input.sourceRange,
    channel: f.input.channel,
    text: f.input.text,
    modelId: f.input.modelId,
  } as const;
  const pending = f.processing.prepareProject(request);
  expect(pending).toMatchObject({ projectId: "project", assetId: f.input.assetId });
  expect(pending.state).toMatch(/pending|processing/);
  expect(f.jobs.job(pending.jobId!).target).toEqual({
    kind: "project",
    id: "project",
    revisionId: "revision",
  });
  await expect.poll(() => f.processing.prepareProject(request).state).toBe("ready");
  expect(f.processing.prepareProject(request).published?.evidence.owner).toEqual({
    kind: "asset",
    id: f.input.assetId,
  });
  const beforeCleanup = f.processing.prepareProject(request);
  await f.processing.cleanup(new AbortController().signal);
  expect(f.processing.prepareProject(request)).toEqual(beforeCleanup);
});

test("a project alignment range the resolver clamped shares the applied range's evidence and reports range-clamped", async () => {
  const f = await fixture();
  const clamp = admitReadRange(
    { startUs: f.input.sourceRange.startUs, endUs: 9_000_000 },
    { startUs: 0, endUs: f.input.sourceRange.endUs },
  ).issues[0]!;
  f.options.project = {
    // The resolver admits the range: the source keeps the applied part, the clamp is reported.
    resolve: (input) => ({
      source: f.input,
      projectId: input.projectId,
      revisionId: "revision",
      preparedResourceId: input.preparedResourceId,
      issues: input.range.endUs === 9_000_000 ? [clamp] : [],
    }),
  };
  const request = {
    projectId: "project",
    preparedResourceId: "prepared",
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    range: { startUs: f.input.sourceRange.startUs, endUs: 9_000_000 },
    channel: f.input.channel,
    text: f.input.text,
    modelId: f.input.modelId,
  } as const;
  f.processing.prepareProject(request);
  await expect.poll(() => f.processing.prepareProject(request).state).toBe("ready");
  const clamped = f.processing.prepareProject(request);
  // The clamp belongs to the request, not to the evidence the applied range shares.
  expect(clamped.issues).toEqual([clamp]);
  expect(clamped.published?.issues).toEqual([]);
  expect(f.processing.prepareProject({ ...request, range: f.input.sourceRange })).toMatchObject({
    jobId: clamped.jobId,
    state: "ready",
    issues: [],
  });
});

test("project alignment cancellation drains the pinned tap and retry publishes a fresh generation", async () => {
  const f = await fixture();
  f.options.project = {
    resolve(input) {
      return {
        source: f.input,
        projectId: input.projectId,
        revisionId: input.revisionId!,
        preparedResourceId: input.preparedResourceId,
      };
    },
  };
  const request = {
    projectId: "project",
    revisionId: "revision",
    preparedResourceId: "prepared",
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    range: f.input.sourceRange,
    channel: f.input.channel,
    text: f.input.text,
    modelId: f.input.modelId,
  } as const;
  f.control.hold = true;
  const requested = f.processing.prepareProject(request);
  await expect.poll(() => f.requests.length).toBe(1);
  const firstAttempt = f.jobs.job(requested.jobId!).attemptId;
  const draining = f.jobs.drainJob(requested.jobId!);
  f.control.release();
  await draining;
  expect(f.processing.prepareProject(request).published).toBeNull();
  f.control.hold = false;
  f.jobs.retry(requested.jobId!);
  await expect.poll(() => f.processing.prepareProject(request).state).toBe("ready");
  const ready = f.processing.prepareProject(request);
  expect(ready.published!.evidence.generation).not.toBe(firstAttempt);
  expect(ready.published!.evidence.source.streamId).toBe(f.input.streamId);
  expect(ready.published!.evidence.source.observationRange).toEqual(f.input.sourceRange);
  expect(ready.preparedResourceId).toBe(request.preparedResourceId);
});
