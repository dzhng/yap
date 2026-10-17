import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  statfs,
  realpath,
  rename,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { applyBatch, validateComposition, createCompiler } from "../../composition/dist/index.js";
import { Catalog } from "../../core/dist/catalog.js";
import { AssetStore, compositionAsset } from "../../core/dist/assets.js";
import { AcquisitionStore } from "../../core/dist/acquisitions.js";
import { ProjectStore } from "../../core/dist/projects.js";
import { TranscriptStore } from "../../core/dist/transcript.js";
import { assetTranscriptOwner } from "../../core/dist/transcript-processing.js";
import { JobQueue } from "../../core/dist/jobs.js";
import { PreparedAudioStore, preparedAudioResource } from "../../core/dist/prepared-audio.js";
import { projectCompositionFromRevision } from "../../core/dist/project-window.js";
import { mediaWorker } from "../../../apps/service/dist/worker.js";
import { readMediaProbe } from "../../../apps/service/dist/media-probe.js";
import { startProjectService } from "../../../apps/service/dist/project-service.js";
import { cliReply } from "./first-preview-transport.mjs";
import { waveHeader } from "./audio-project-fixture.mjs";

const run = promisify(execFile);
const { values } = parseArgs({
  options: { out: { type: "string" }, "metadata-only": { type: "boolean" } },
});
assert(values.out && process.env.YAP_NATIVE);
const requestedOutput = resolve(values.out);
await mkdir(requestedOutput, { recursive: false, mode: 0o700 });
const out = await realpath(requestedOutput);
const retained = new URL(
  "../../../specs/done/agent-editing/assets/24f-learned-scale/",
  import.meta.url,
).pathname;
await run("tar", [
  "-xJf",
  join(retained, "metadata.tar.xz"),
  "-C",
  out,
  "source.wav",
  "late.wav",
  "report.json",
]);
await rename(join(out, "report.json"), join(out, "original-report.json"));
const original = JSON.parse(await readFile(join(out, "original-report.json")));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function digest(path) {
  const h = createHash("sha256");
  for await (const b of createReadStream(path)) h.update(b);
  return h.digest("hex");
}
const worker = mediaWorker(process.env),
  signal = new AbortController().signal;
const report = {
  passed: false,
  scope:
    "Restored authenticated two-hour checkpoint; public export/adoption without repeated DSP; newly authored receiver edit/undo, not original historical reconstruction",
  checks: {},
  trace: [],
  original: original.receipts[0],
  observations: {},
};
report.nativeSha256 = await digest(process.env.YAP_NATIVE);
const originalJob = original.receipts[0],
  originalAudio = original.receipts[1].published.audio;
const { projectId, revisionId } = originalJob.target;
const probe = await readMediaProbe(worker, out, join(out, "source.wav"), signal, []);
const sourceAsset = compositionAsset({ ...probe, id: await digest(join(out, "source.wav")) });
assert.equal(sourceAsset.id, originalAudio.dependencies[0].id);
let document = {
  canvas: {
    width: 16,
    height: 16,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  },
  tracks: [],
  groups: [],
  clips: [],
  syncGroups: [],
  processing: [],
};
for (let first = 0; first < 10000; first += 500) {
  const operations = [];
  if (!first)
    operations.push({ operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } });
  const trackId = first ? document.tracks[0].id : { label: "audio" };
  for (let i = first; i < first + 500; i++)
    operations.push({
      operation: "place",
      clip: {
        trackId,
        assetId: sourceAsset.id,
        streamId: sourceAsset.streams[0].id,
        source: { kind: "range", range: { startUs: 0, endUs: 720000 } },
        placement: { kind: "project", range: { startUs: i * 720000, endUs: (i + 1) * 720000 } },
      },
    });
  if (first + 500 === 10000)
    operations.push({
      operation: "processing.set",
      target: { kind: "output" },
      steps: [{ processor: { type: "rnnoise" } }],
    });
  document = applyBatch(document, operations, {
    assets: [sourceAsset],
    namespace: hash(JSON.stringify([projectId, `place-${first}`])),
    acquisitions: [],
  }).document;
}
const window = createCompiler(
  validateComposition(document, [sourceAsset], []),
  revisionId,
).audioWindow({
  range: { startUs: 0, endUs: 7200000000 },
  rendition: { sampleRate: 48000, channels: 2 },
  tap: { target: { kind: "output" }, point: { kind: "processed" } },
});
const rnnoise =
  "rnnoise-70f1d256-d6021b7697677c4d2274c912975e143765552b0e6f25500aa660fdb4a9849be5-f480-s32768-flush2-delay960-independent-channels-v2";
const recipe = {
  ...window.manifest,
  requirements: window.manifest.requirements.map((r) => ({
    ...r,
    implementationId:
      r.kind === "executor"
        ? "native-composition-audio-v8"
        : r.kind === "processor" && r.processor.type === "rnnoise"
          ? rnnoise
          : null,
  })),
};
const input = JSON.stringify(recipe);
assert.equal(
  hash(input),
  originalJob.inputSha256,
  "Reconstruction must match the original complete recipe byte hash",
);
assert.deepEqual(
  document.clips.map((c) => c.id),
  originalAudio.unavailable.map((c) => c.clipId),
);
await writeFile(join(out, "recipe.json"), input);
await writeFile(join(out, "document.json"), JSON.stringify(document));
report.observations.recipe = { bytes: Buffer.byteLength(input), sha256: hash(input) };
report.checks.exactOriginalRecipe = true;
if (values["metadata-only"]) {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.observations));
  process.exit(0);
}
// Four independent full-size files coexist during public export publication.
const disk = await statfs(out);
report.observations.disk = {
  availableBytes: disk.bavail * disk.bsize,
  requiredBytes: originalAudio.bytes * 4 + 1024 ** 3,
};
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
assert(
  disk.bavail * disk.bsize > originalAudio.bytes * 4 + 1024 ** 3,
  "Full transfer requires four payload copies plus 1 GiB working margin",
);
const scratch = await realpath(await mkdtemp(join(out, "work-"))),
  donor = join(scratch, "donor"),
  receiver = join(scratch, "receiver");
const restored = join(scratch, "prepared.wav");
let service;
const unavailableWorker = async (operation, ...args) => {
  const params = args[0];
  const plan =
    operation === "media.mixCompositionAudio" && params.planFile
      ? JSON.parse(await readFile(params.planFile, "utf8"))
      : params;
  if (
    operation === "media.audioCapabilities" ||
    (operation === "media.mixCompositionAudio" && !plan.retained)
  ) {
    report.trace.push({ refusedNativeOperation: operation });
    return {
      ok: false,
      error: {
        code: "NOT_READY",
        message: "Original processing unavailable during retained transfer",
        retryable: false,
      },
    };
  }
  return worker(operation, ...args);
};
async function close() {
  await service?.close();
  service = undefined;
}
async function call(operation, params, output) {
  const response = await cliReply([
    new URL("../../../apps/cli/dist/main.js", import.meta.url).pathname,
    operation,
    "--socket",
    service.socketPath,
    "--params",
    JSON.stringify(params),
    ...(output ? ["--output", output] : []),
  ]);
  assert(response.ok, JSON.stringify(response));
  // Keep complete authored documents in their own files, never duplicate them in every trace.
  report.trace.push({ operation, params, state: response.data.state ?? null });
  return response.data;
}
async function poll(read, done) {
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert(!["failed", "canceled", "unavailable"].includes(value.state), JSON.stringify(value));
    assert(Date.now() < deadline, "Transfer observation exceeded 30-minute research guard");
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function owner(home, use) {
  const library = join(home, "library");
  await mkdir(library, { recursive: true, mode: 0o700 });
  const catalog = new Catalog(join(library, "catalog.sqlite")),
    assets = new AssetStore(catalog, library);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog),
    projects = new ProjectStore(
      catalog,
      assets,
      new TranscriptStore(catalog, library, assetTranscriptOwner(assets, acquisitions)),
      acquisitions,
    );
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (t) => t,
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: async () => {
      throw Error("Restoration must not execute a preparation job");
    },
  });
  const prepared = new PreparedAudioStore({
    catalog,
    assets,
    projects,
    jobs,
    staging: join(library, "staging/prepared-audio"),
    probe: async () => {
      throw Error("Restoration must not prepare audio");
    },
    renderer: {
      implementationId: "unavailable",
      render: async () => {
        throw Error("Restoration must not render");
      },
    },
  });
  try {
    return await use({ assets, projects, prepared });
  } finally {
    await jobs.close();
    catalog.close();
  }
}
try {
  await run("python3", [join(retained, "restore.py"), "--wav", restored], { timeout: 30 * 60_000 });
  assert.equal(await digest(restored), originalAudio.assetId);
  const restoredCheckpoint = await owner(donor, async ({ assets, projects, prepared }) => {
    const probeFile = (path, signal) => readMediaProbe(worker, out, path, signal, []);
    const source = await assets.import(
      join(out, "source.wav"),
      { kind: "import", source: "24f retained source" },
      probeFile,
      signal,
    );
    const pcm = await assets.import(
      restored,
      { kind: "import", source: "24f authenticated original prepared output" },
      probeFile,
      signal,
    );
    assert.equal(source.id, sourceAsset.id);
    assert.equal(pcm.id, originalAudio.assetId);
    await rm(restored);
    const createdAt = new Date().toISOString();
    const snapshot = {
      project: {
        projectId,
        currentRevisionId: revisionId,
        createdAt,
        title: "Restored two-hour prepared checkpoint",
      },
      revisions: [
        { id: revisionId, projectId, ordinal: 0, createdAt, operation: "create", document },
      ],
      undo: [],
      references: [],
    };
    const adoption = projects.prepareAdoption({
      requestId: "restore-checkpoint",
      packageIdentity: originalJob.inputSha256,
      snapshot,
    });
    const audio = { ...originalAudio };
    delete audio.identity;
    delete audio.resourceId;
    const portable = {
      projectId,
      revisionId,
      publication: { generation: originalJob.generation, attemptId: originalJob.attemptId, input },
      audio,
    };
    const staged = await prepared.stagePortable(
      portable,
      projectCompositionFromRevision(adoption.revision, assets, []),
      assets.path(pcm.id),
      (r) => r,
      signal,
    );
    adoption.publish(() => {}, { publish: () => staged.publish(), reference: (r) => r });
    const retained = prepared.portable(staged.resourceId);
    assert.deepEqual(JSON.parse(retained.publication.input), {
      ...recipe,
      revisionId: adoption.revision.id,
    });
    await writeFile(join(out, "donor-publication.json"), JSON.stringify(retained));
    return { projectId: adoption.project.projectId, revisionId: adoption.revision.id };
  });
  report.checks.authenticatedOwnerRestoration = true;
  service = await startProjectService({ home: donor, worker: unavailableWorker });
  assert.equal((await call("audio.prepare", restoredCheckpoint)).state, "ready");
  const exportId = randomUUID();
  await call("export.create", {
    projectId: restoredCheckpoint.projectId,
    exportId,
    kind: "processed-package",
    directory: out,
    leaf: "prepared.zip",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
  );
  report.exported = exported;
  report.observations.archiveSha256 = await digest(exported.output);
  await close();
  await rm(donor, { recursive: true });
  service = await startProjectService({ home: receiver, worker: unavailableWorker });
  const admission = await call("package.open", { path: exported.output });
  const opened = await poll(
    () => call("package.status", { admissionId: admission.id }),
    (v) => v.state === "ready",
  );
  // The receiver now owns an authenticated archive snapshot and extracted members.
  await rm(exported.output);
  const adopted = await poll(
    () => call("package.adopt", { packageHandle: opened.packageHandle, requestId: "adopt" }),
    (v) => v.state === "ready",
  );
  report.adopted = adopted.published.output;
  await call("package.close", { admissionId: admission.id });
  const selected = { projectId: adopted.published.output.projectId };
  const audioSelection = { ...selected, revisionId: adopted.published.output.revisionId };
  const prepared = await call("audio.prepare", audioSelection);
  assert.equal(prepared.state, "ready");
  assert.equal(prepared.published.output.assetId, originalAudio.assetId);
  const late = join(out, "adopted-late.wav");
  await poll(
    () =>
      call("audio.get", { ...audioSelection, range: { startUs: 7199000000, endUs: 7200000000 } }),
    (v) => v.state === "ready",
  );
  await call(
    "audio.get",
    { ...audioSelection, range: { startUs: 7199000000, endUs: 7200000000 } },
    late,
  );
  const expected = await readFile(join(out, "late.wav")),
    actual = await readFile(late);
  assert.deepEqual(
    actual.subarray(waveHeader(actual, actual.length).offset),
    expected.subarray(waveHeader(expected, expected.length).offset),
  );
  const before = await call("project.get", selected);
  const edited = await call("edit.apply", {
    ...selected,
    expectedRevisionId: before.currentRevisionId,
    requestId: "new-track",
    operations: [{ operation: "track.add", track: { kind: "video", order: 1 } }],
  });
  const undone = await call("edit.undo", {
    ...selected,
    expectedRevisionId: edited.revision.id,
    requestId: "undo-new-track",
  });
  assert.deepEqual(undone.document, document);
  assert.equal(
    (await call("audio.prepare", { ...selected, revisionId: undone.id })).state,
    "ready",
  );
  await close();
  await owner(receiver, async ({ assets, projects, prepared }) => {
    assert.equal(await digest(assets.path(originalAudio.assetId)), originalAudio.assetId);
    const revision = projects.revision(selected.projectId);
    const portable = prepared.portable(
      preparedAudioResource(selected.projectId, originalJob.attemptId),
    );
    assert.deepEqual(JSON.parse(portable.publication.input), {
      ...recipe,
      revisionId: portable.revisionId,
    });
    assert.deepEqual(revision.document, document);
    await writeFile(join(out, "receiver-publication.json"), JSON.stringify(portable));
  });
  report.checks = {
    ...report.checks,
    publicExportAndAdoption: true,
    fullOriginalWavHash: true,
    exactLatePCM: true,
    retainedProjectPlayback: true,
    newHistoryUndo: true,
    donorAndArchiveRemoved: true,
  };
  report.passed = true;
} catch (e) {
  report.failure = { message: e.message, stack: e.stack };
  throw e;
} finally {
  await close();
  report.scratch = scratch;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  if (report.passed) await rm(scratch, { recursive: true });
}
console.log(JSON.stringify({ passed: report.passed, out, checks: report.checks }));
