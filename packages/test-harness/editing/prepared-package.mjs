import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  rm,
  rename,
  copyFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { Catalog } from "../../core/dist/catalog.js";
import { AssetStore } from "../../core/dist/assets.js";
import { AcquisitionStore } from "../../core/dist/acquisitions.js";
import { ProjectStore } from "../../core/dist/projects.js";
import { TranscriptStore } from "../../core/dist/transcript.js";
import { assetTranscriptOwner } from "../../core/dist/transcript-processing.js";
import { JobQueue } from "../../core/dist/jobs.js";
import { PreparedAudioStore, preparedAudioResource } from "../../core/dist/prepared-audio.js";
import { projectAudioRenderer } from "../../../apps/service/dist/project-render.js";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";
import { startProjectService } from "../../../apps/service/dist/project-service.js";
import { writeSourceWave, sourcePeriod, waveHeader } from "./audio-project-fixture.mjs";
import { cliReply } from "./first-preview-transport.mjs";
const run = promisify(execFile),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert(process.env.YAP_NATIVE && process.argv[2] === "--out" && process.argv[3]);
await mkdir(resolve(process.argv[3]), { recursive: true });
const out = await realpath(resolve(process.argv[3]));
const scratch = await realpath(await mkdtemp("/tmp/prepared-package-"));
const donor = join(scratch, "donor"),
  receiver = join(scratch, "receiver");
const occurrences = Number(process.env.YAP_PREPARED_OCCURRENCES ?? 1);
assert(
  Number.isSafeInteger(occurrences) &&
    occurrences > 0 &&
    occurrences <= 10000 &&
    48000 % occurrences === 0 &&
    1000000 % occurrences === 0,
  "Occurrences must divide the one-second source into exact samples and microseconds",
);
const clipUs = 1000000 / occurrences;
const worker = mediaWorker(process.env);
const cli = new URL("../../../apps/cli/dist/main.js", import.meta.url).pathname;
const report = {
  passed: false,
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  scope:
    "historical owner-seeded unit-rate/gain plus public learned preparation; exact portable PCM preservation with processing unavailable; no listening or model-absent binary claim",
  occurrences,
  trace: [],
  checks: {},
  publications: [],
};
let service;
async function start(home) {
  const selected =
    home === receiver
      ? async (operation, ...args) => {
          if (["media.audioCapabilities", "media.mixCompositionAudio"].includes(operation)) {
            report.trace.push({ refusedNativeOperation: operation });
            return {
              ok: false,
              error: {
                code: "NOT_READY",
                message: "Processing unavailable for transfer verification",
                retryable: false,
              },
            };
          }
          return worker(operation, ...args);
        }
      : worker;
  service = await startProjectService({ home, worker: selected });
}
async function close() {
  await service?.close();
  service = undefined;
}
async function call(operation, params, output, expectedError) {
  const reply = await cliReply([
    cli,
    operation,
    "--socket",
    service.socketPath,
    "--params",
    JSON.stringify(params),
    ...(output ? ["--output", output] : []),
  ]);
  report.trace.push({ operation, params, reply });
  assert.equal(reply.ok, expectedError === undefined, JSON.stringify(reply));
  if (expectedError !== undefined) {
    assert.equal(reply.error.code, expectedError);
    return reply.error;
  }
  return reply.data;
}
async function poll(read, done) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const value = await read();
    if (done(value)) return value;
    assert(!["failed", "unavailable"].includes(value.state), JSON.stringify(value));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw Error("Public operation did not settle");
}
async function owner(home, execute, use) {
  const library = join(home, "library"),
    catalog = new Catalog(join(library, "catalog.sqlite"));
  const assets = new AssetStore(catalog, library);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const projects = new ProjectStore(
    catalog,
    assets,
    new TranscriptStore(catalog, library, assetTranscriptOwner(assets, acquisitions)),
    acquisitions,
  );
  let prepared,
    calls = 0;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        assert.equal(target.kind, "project");
        projects.revision(target.projectId, target.revisionId);
        return target;
      },
      isAvailable: (target) => target.kind === "project" && !projects.isDeleting(target.projectId),
      isDeleting: (target) => target.kind === "project" && projects.isDeleting(target.projectId),
      isCapturing: () => false,
    },
    execute: (execution) => prepared.execute(execution),
  });
  const renderer = projectAudioRenderer(worker, join(library, "prepared-workspace"));
  prepared = new PreparedAudioStore({
    catalog,
    assets,
    projects,
    jobs,
    staging: join(library, "staging", "prepared-audio"),
    probe: async (path, signal) => {
      assert(execute, "Retained reads must not probe");
      return nativeResult(await worker("media.probe", { path }, { signal }));
    },
    renderer: {
      ...renderer,
      implementationId: execute ? renderer.implementationId : "original-executor-unavailable",
      render: (request, signal) => {
        calls++;
        assert(execute, "Retained reads must not execute");
        return renderer.render(request, signal);
      },
    },
  });
  try {
    if (execute) await prepared.recover();
    return await use({ assets, projects, jobs, prepared, calls: () => calls });
  } finally {
    await jobs.close();
    catalog.close();
  }
}
function samples(prepared, id, range) {
  const read = prepared.open(id, range);
  try {
    const bytes = Buffer.alloc(read.bytes);
    assert.equal(read.read(bytes, 0), bytes.length);
    assert.equal(read.read(bytes, bytes.length), 0);
    return bytes;
  } finally {
    read.release();
  }
}
try {
  await start(donor);
  const source = join(scratch, "source.wav");
  await writeSourceWave(source, { source: 0, seconds: 1 });
  await copyFile(source, join(out, "source.wav"));
  const imported = await call("asset.import", { requestId: "source", path: source });
  const importedJob = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (value) => value.state === "ready",
  );
  const asset = await call("asset.get", { assetId: importedJob.published.output.assetId });
  const created = await call("project.create", {
    requestId: "create",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  let first = await call("edit.apply", {
    projectId,
    requestId: "place",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          assetId: asset.id,
          streamId: asset.streams[0].id,
          source: { kind: "range", range: { startUs: 0, endUs: clipUs } },
          placement: { kind: "project", range: { startUs: 0, endUs: clipUs } },
        },
      },
    ],
  });
  const trackId = first.edit.labels.audio;
  for (let start = 1; start < occurrences; start += 1000) {
    first = await call("edit.apply", {
      projectId,
      requestId: `place-${start}`,
      expectedRevisionId: first.revision.id,
      operations: Array.from({ length: Math.min(1000, occurrences - start) }, (_, offset) => {
        const range = { startUs: (start + offset) * clipUs, endUs: (start + offset + 1) * clipUs };
        return {
          operation: "place",
          clip: {
            trackId,
            assetId: asset.id,
            streamId: asset.streams[0].id,
            source: { kind: "range", range },
            placement: { kind: "project", range },
          },
        };
      }),
    });
  }
  const latest = await call("edit.apply", {
    projectId,
    requestId: "gain",
    expectedRevisionId: first.revision.id,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 0.5 } }],
      },
    ],
  });
  const originals = [first.revision, latest.revision];
  await close();
  const expected = [sourcePeriod(0), Buffer.from(sourcePeriod(0))];
  for (let at = 0; at < expected[1].length; at += 4)
    expected[1].writeFloatLE(Math.fround(expected[1].readFloatLE(at) * 0.5), at);
  const values = await owner(donor, true, async ({ prepared, jobs, projects }) => {
    const values = [];
    for (const [i, revision] of originals.entries()) {
      await prepared.request({ projectId, revisionId: revision.id });
      await jobs.idle();
      const status = await prepared.request({ projectId, revisionId: revision.id });
      assert.equal(status.state, "ready");
      const value = JSON.parse(status.published.result);
      assert.deepEqual(samples(prepared, value.resourceId), expected[i]);
      assert.deepEqual(projects.revision(projectId, revision.id), revision);
      values.push({ value, portable: prepared.portable(value.resourceId) });
    }
    return values;
  });
  await start(donor);
  const learned = await call("edit.apply", {
    projectId,
    requestId: "learned",
    expectedRevisionId: latest.revision.id,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "rnnoise" } }],
      },
    ],
  });
  const selection = { projectId, revisionId: learned.revision.id };
  const publication = await poll(
    () => call("audio.prepare", selection),
    (value) => value.state === "ready",
  );
  assert.deepEqual(await call("audio.prepare", selection), publication);
  report.learnedPublication = publication;
  const learnedAsset = await call("asset.get", { assetId: publication.published.output.assetId });
  const learnedPath = join(out, "donor-learned.wav");
  await poll(
    () =>
      call(
        "audio.get",
        {
          assetId: learnedAsset.id,
          streamId: learnedAsset.streams[0].id,
          range: { startUs: 0, endUs: 1000000 },
        },
        learnedPath,
      ),
    (value) => value.state === "ready",
  );
  const learnedWave = await readFile(learnedPath),
    header = waveHeader(learnedWave, learnedWave.length);
  const learnedPCM = learnedWave.subarray(header.offset, header.offset + header.bytes);
  assert.equal(learnedPCM.length, 48000 * 8);
  assert.notDeepEqual(
    learnedPCM,
    expected[0],
    "A dry substitution must fail the learned preservation oracle",
  );
  expected.push(Buffer.from(learnedPCM));
  originals.push(learned.revision);
  await close();
  values.push(
    await owner(donor, false, async ({ prepared, projects }) => {
      assert.deepEqual(projects.revision(projectId, learned.revision.id), learned.revision);
      const portable = prepared.portable(publication.published.output.resourceId);
      assert(
        JSON.parse(portable.publication.input).requirements.some((r) =>
          r.implementationId?.startsWith("rnnoise-"),
        ),
      );
      return { value: { assetId: publication.published.output.assetId }, portable };
    }),
  );
  await start(donor);
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    exportId,
    kind: "processed-package",
    directory: out,
    leaf: "prepared.zip",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (value) => value.state === "ready",
  );
  const archive = join(out, "relocated.zip");
  await rename(exported.output, archive);
  await copyFile(archive, join(out, "evidence-only-package.zip"));
  await close();
  await rm(donor, { recursive: true });
  await rm(source);
  await start(receiver);
  const cancelAdmission = await call("package.open", { path: archive });
  const cancelReady = await poll(
    () => call("package.status", { admissionId: cancelAdmission.id }),
    (value) => value.state === "ready",
  );
  const originalStage = service.assets.stagePortable.bind(service.assets);
  let staged = false;
  service.assets.stagePortable = async (...input) => {
    const result = await originalStage(...input),
      signal = input[2];
    staged = true;
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    await result.close();
    signal.throwIfAborted();
    throw Error("Cancellation barrier resumed without cancellation");
  };
  await call("package.adopt", { packageHandle: cancelReady.packageHandle, requestId: "adopt" });
  await poll(
    async () => ({ staged }),
    (value) => value.staged,
  );
  await call("package.close", { admissionId: cancelAdmission.id });
  service.assets.stagePortable = originalStage;
  assert.deepEqual((await call("project.list", {})).projects, []);
  assert.deepEqual((await call("asset.list", {})).assets, []);
  await close();
  await start(receiver);
  const admission = await call("package.open", { path: archive });
  const opened = await poll(
    () => call("package.status", { admissionId: admission.id }),
    (value) => value.state === "ready",
  );
  const adopted = await poll(
    () => call("package.adopt", { packageHandle: opened.packageHandle, requestId: "adopt" }),
    (value) => value.state === "ready",
  );
  assert.deepEqual(
    (await call("package.adopt", { packageHandle: opened.packageHandle, requestId: "adopt" }))
      .published.output,
    adopted.published.output,
  );
  const history = await call("revision.history", { projectId: adopted.published.output.projectId });
  await call("package.close", { admissionId: admission.id });
  await rm(archive);
  const changed = await call("edit.apply", {
    projectId: adopted.published.output.projectId,
    requestId: "changed-learned",
    expectedRevisionId: adopted.published.output.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "rnnoise" } }, { processor: { type: "gain", gain: 0.5 } }],
      },
    ],
  });
  const changedSelection = {
    projectId: adopted.published.output.projectId,
    revisionId: changed.revision.id,
  };
  for (const operation of ["audio.prepare", "audio.get"]) {
    const failure = await call(
      operation,
      {
        ...changedSelection,
        ...(operation === "audio.get" ? { range: { startUs: 0, endUs: 1000000 } } : {}),
      },
      undefined,
      "NOT_READY",
    );
    assert(
      failure.details.requirements.some(
        (r) =>
          r.kind === "processor" && r.processor.type === "rnnoise" && r.implementationId === null,
      ),
    );
  }
  const undone = await call("edit.undo", {
    projectId: adopted.published.output.projectId,
    expectedRevisionId: changed.revision.id,
    requestId: "undo-changed-learned",
  });
  const restored = await call("audio.prepare", {
    projectId: adopted.published.output.projectId,
    revisionId: undone.id,
  });
  assert.equal(restored.state, "ready");
  assert.equal(restored.published.output.assetId, learnedAsset.id);
  await close();
  await owner(receiver, false, async ({ prepared, assets, projects, calls }) => {
    for (const [i, original] of values.entries()) {
      const revisionId = history.revisions.find(
        (revision) => revision.ordinal === originals[i].ordinal,
      ).id;
      const resourceId = preparedAudioResource(
        adopted.published.output.projectId,
        original.portable.publication.attemptId,
      );
      const portable = prepared.portable(resourceId);
      assert.equal(portable.revisionId, revisionId);
      assert.deepEqual(JSON.parse(portable.publication.input), {
        ...JSON.parse(original.portable.publication.input),
        revisionId,
      });
      assert.deepEqual(portable.audio, original.portable.audio);
      assert.deepEqual(samples(prepared, resourceId), expected[i]);
      assert.deepEqual(
        samples(prepared, resourceId, { start: 47743, end: 48000 }),
        expected[i].subarray(47743 * 8),
      );
      assert(
        projects
          .revisionDependencies(adopted.published.output.projectId, revisionId)
          .some((reference) => reference.kind === "prepared-audio" && reference.id === resourceId),
      );
      report.publications.push({
        revisionId,
        resourceId,
        assetId: portable.audio.assetId,
        recipe: JSON.parse(portable.publication.input),
        pcmSha256: hash(expected[i]),
        lateSha256: hash(expected[i].subarray(47743 * 8)),
      });
      assert(assets.path(portable.audio.assetId).startsWith(receiver));
    }
    assert.equal(calls(), 0);
  });
  await start(receiver);
  assert.equal((await call("model.status", { modelId: "parakeet" })).state, "absent");
  for (const [i, original] of values.entries()) {
    const asset = await call("asset.get", { assetId: original.value.assetId });
    const output = join(out, `public-prepared-${i}.wav`);
    await poll(
      () =>
        call(
          "audio.get",
          {
            assetId: asset.id,
            streamId: asset.streams[0].id,
            range: { startUs: 750000, endUs: 1000000 },
          },
          output,
        ),
      (value) => value.state === "ready",
    );
    const decoded = await run(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", output, "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"],
      { encoding: "buffer" },
    );
    assert.deepEqual(decoded.stdout, expected[i].subarray(36000 * 8));
  }
  await close();
  await owner(receiver, false, async ({ prepared, assets, calls }) => {
    await rm(assets.path(values[0].value.assetId));
    assert.throws(() => prepared.open(report.publications[0].resourceId));
    await rm(assets.path(values[1].value.assetId));
    await writeFile(assets.path(values[1].value.assetId), "corrupt PCM");
    assert.throws(() => prepared.open(report.publications[1].resourceId));
    const learnedFile = assets.path(values[2].value.assetId);
    const originalBytes = await readFile(learnedFile);
    const corrupted = Buffer.from(originalBytes);
    corrupted[corrupted.length - 1] ^= 1;
    await rm(learnedFile);
    await writeFile(learnedFile, corrupted);
    assert.throws(() => prepared.open(report.publications[2].resourceId));
    assert.equal(calls(), 0);
  });
  assert.equal(
    report.trace.filter((v) => v.refusedNativeOperation === "media.mixCompositionAudio").length,
    0,
  );
  assert(report.trace.some((v) => v.refusedNativeOperation === "media.audioCapabilities"));
  report.checks = {
    exactNativeUnitRateAndGain: true,
    publicLearnedPreparationAndRepeat: true,
    learnedFullAndLateTransferExact: true,
    receiverProcessingUnavailable: true,
    unchangedRevisionDocuments: true,
    publicRelocationAndReplay: true,
    canceledAdoptionInvisibleAndSameRequestRetry: true,
    donorAndArchiveRemoved: true,
    originalRecipeIdentitiesRetained: true,
    adoptedRevisionReferences: true,
    speechModelAbsentOnly: true,
    learnedTamperedPCMRefused: true,
    unavailableExecutorNotInvoked: true,
    exactHistoricalAndCurrentPCM: true,
    changedRecipeRequiresPreparation: true,
    undoRestoresPreparedOutput: true,
    boundedLatePCM: true,
    publicAssetAudioExact: true,
    missingAndCorruptRetainedPCMRefused: true,
  };
  report.passed = true;
} finally {
  await close();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify(report.checks, null, 2));
