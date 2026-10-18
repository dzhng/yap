import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
  realpath,
  rename,
  glob,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { archiveLimits } from "../../../packages/core/dist/package-archive.js";
import { startProjectService } from "../../../apps/service/dist/project-service.js";
import { copyModels } from "./source-evidence-fixture.mjs";
import { cliReply } from "./first-preview-transport.mjs";

const args = process.argv.slice(2);
assert.equal(args[0], "--case");
assert.equal(args[1], "relocate-edit-undo");
assert.ok(args.length === 2 || (args.length === 4 && args[2] === "--out"));
assert.ok(process.env.YAP_NATIVE, "Select a frozen native worker with YAP_NATIVE");
assert.ok(
  process.env.YAP_ASR_REQUEST,
  "Select an existing prepared speech.transcribe request with YAP_ASR_REQUEST",
);
let out = args[3] ? resolve(args[3]) : await mkdtemp("/tmp/sr-package-evidence-");
await mkdir(out, { recursive: true });
out = await realpath(out);
const scratch = await realpath(await mkdtemp("/tmp/sr-package-"));
const cli = new URL("../../../apps/cli/dist/main.js", import.meta.url).pathname;
const corpus = new URL("../../../specs/done/agent-editing/assets/00-corpus/", import.meta.url)
  .pathname;
const run = promisify(execFile),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  passed: false,
  scope:
    "actual CLI/MCP/native project package relocation with retained acquisition, source-scene, source/project screenshot-index and real source-transcript generations; generated-reference metadata fixture, no synthesis/capture/model-quality claim",
  checks: {},
  trace: [],
  separateCoverage: "font dependency closure is verified by captions.mjs --case faces",
};
let service, mcp;
async function start(home) {
  service = await startProjectService({ home });
  mcp = new Client({ name: "portable-project-journey", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
}
async function close() {
  await mcp?.close();
  mcp = undefined;
  await service?.close();
  service = undefined;
}
async function call(operation, params, { transport = "cli", output, error = false } = {}) {
  const reply =
    transport === "mcp"
      ? (await mcp.callTool({ name: operation, arguments: params })).structuredContent
      : await cliReply([
          cli,
          operation,
          "--socket",
          service.socketPath,
          "--params",
          JSON.stringify(params),
          ...(output ? ["--output", output] : []),
        ]);
  assert.ok(reply && typeof reply.ok === "boolean");
  report.trace.push({ operation, transport, ok: reply.ok, state: reply.data?.state });
  assert.equal(reply.ok, !error, `${operation}: ${JSON.stringify(reply)}`);
  return reply.ok ? reply.data : reply.error;
}
async function poll(read, ready) {
  const end = Date.now() + 120000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    assert.ok(!["failed", "unavailable", "canceled"].includes(value.state), JSON.stringify(value));
    assert.ok(Date.now() < end, "Bounded package journey timed out");
    await delay(40);
  }
}
async function asset(name, source = join(corpus, name)) {
  const path = join(scratch, "imports", name);
  await copyFile(source, path);
  const pending = await call("asset.import", { requestId: name, path });
  const done = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (value) => value.state === "ready",
  );
  return call("asset.get", { assetId: done.published.output.assetId }, { transport: "mcp" });
}
async function render(projectId, revisionId, name) {
  const movie = join(out, `${name}.mp4`),
    audio = join(out, `${name}.wav`);
  await poll(
    () => call("preview.get", { projectId, revisionId }, { output: movie }),
    (value) => value.state === "ready",
  );
  await poll(
    () => call("audio.get", { projectId, revisionId }, { output: audio }),
    (value) => value.state === "ready",
  );
  const decoded = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      movie,
      "-map",
      "0:v:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { encoding: "buffer", timeout: 60000, maxBuffer: 32 * 1024 ** 2 },
  );
  return { video: hash(decoded.stdout), audio: hash(await readFile(audio)) };
}
const placed = (asset, trackId, kind, label) => ({
  operation: "place",
  label,
  clip: {
    trackId,
    assetId: asset.id,
    ...(kind === "video" && asset.acquisitionId ? { acquisitionId: asset.acquisitionId } : {}),
    streamId: asset.streams.find((stream) => stream.kind === kind).streamId,
    source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
    placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
  },
});
try {
  await mkdir(join(scratch, "imports"));
  const donor = join(scratch, "donor");
  await start(donor);
  const a = await asset("a.mov"),
    b = await asset("b.mov"),
    reference = await asset("b-audio.wav"),
    revisionOnly = await asset("a-audio.wav");
  const speech = await asset(
    "narration.mov",
    new URL("../../../fixtures/narrated-workbench/narration.mov", import.meta.url).pathname,
  );
  const prepared = JSON.parse(await readFile(process.env.YAP_ASR_REQUEST, "utf8")).params.models;
  const modelPins = await copyModels(donor, prepared);
  assert.equal((await call("model.status", { modelId: "parakeet" })).state, "ready");
  const transcriptParams = {
    assetId: speech.id,
    streamId: speech.streams.find((stream) => stream.kind === "audio").streamId,
    limit: 1000,
  };
  await call("transcript.transcribe", { assetId: speech.id, streamId: transcriptParams.streamId });
  const donorTranscript = await poll(
    () => call("transcript.get", transcriptParams, { transport: "mcp" }),
    (value) => value.state === "ready",
  );
  assert.equal(donorTranscript.page.nextCursor, null);
  assert.ok(donorTranscript.page.rows.some((row) => row.type === "word"));
  report.speech = {
    modelDigest: modelPins.modelDigest,
    engine: donorTranscript.page.transcript.engine,
    raw: donorTranscript.page.transcript.raw,
    rowsSha256: hash(JSON.stringify(donorTranscript.page.rows)),
  };

  const capture = join(scratch, "imports", "capture");
  await mkdir(capture);
  await copyFile(join(corpus, "a.mov"), join(capture, "video.mov"));
  const journal = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: "portable-synthetic-journal",
        source: { kind: "window", windowID: 7 },
        width: 160,
        height: 96,
        microphone: false,
        systemAudio: false,
      },
    },
    { event: "origin", data: { hostUs: 1000000 } },
    {
      event: "cursorSamples",
      data: {
        samples: [
          {
            sourceUs: 500000,
            globalX: 12,
            globalY: 18,
            x: 12,
            y: 18,
            buttons: 0,
            eligibility: "inside",
            geometryEpoch: 1,
          },
        ],
      },
    },
    { event: "finished", data: {} },
    { event: "lifecycle", data: { state: "complete" } },
  ]
    .map((row, index) => JSON.stringify({ ...row, sequence: index + 1 }) + "\n")
    .join("");
  await writeFile(join(capture, "capture.journal.jsonl"), journal);
  const imported = await call("acquisition.import", { requestId: "capture", path: capture });
  const captureJob = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (value) => value.state === "ready",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: captureJob.target.acquisitionId,
  });
  a.acquisitionId = acquisition.id;
  const normalizedHash = hash(await readFile(acquisition.evidence.receipt.file));
  const captureBinding = acquisition.bindings.find((binding) =>
    binding.sourceRoles.includes("video"),
  );
  const cursorParams = {
    acquisitionId: acquisition.id,
    assetId: captureBinding.assetId,
    streamId: captureBinding.streamId,
    sourceRange: { startUs: 0, endUs: 2000000 },
  };
  const originalCursor = await call("cursor.raw", cursorParams, { transport: "mcp" });
  assert.equal(originalCursor.state, "ready");
  assert.equal(originalCursor.page.rows.length, 1);
  const originalEvents = await poll(
    () => call("timeline.events", cursorParams, { transport: "mcp" }),
    (value) => value.state === "ready",
  );

  const indexParams = {
    assetId: captureBinding.assetId,
    streamId: captureBinding.streamId,
    acquisitionId: acquisition.id,
  };
  const donorIndex = await poll(
    () => call("index.get", { ...indexParams, limit: 100 }, { transport: "mcp" }),
    (value) => value.state === "ready",
  );
  assert.equal(donorIndex.page.nextCursor, null);
  assert.ok(donorIndex.page.entries.length);
  const indexReference = { ...indexParams, generation: donorIndex.generation };
  const donorCoverage = await call("index.coverage", { ...indexReference, limit: 100 });
  assert.equal(donorCoverage.nextCursor, null);
  const indexHashes = [];
  for (const entry of donorIndex.page.entries) {
    const output = join(out, `donor-index-${entry.candidate.ordinal}.png`);
    await call("index.frame", { ...indexReference, ordinal: entry.candidate.ordinal }, { output });
    indexHashes.push(hash(await readFile(output)));
  }

  // Explicit generated-origin metadata tests reference closure without running synthesis.
  service.assets.retain({ kind: "asset", id: b.id }, [reference.id]);
  service.assets.retain({ kind: "asset", id: reference.id }, [speech.id]);
  await service.assets.import(
    join(scratch, "imports", "b.mov"),
    { kind: "generated", source: "portable dependency fixture; no synthesis quality claim" },
    async () => {
      throw new Error("Existing fixture bytes must not reprobe");
    },
  );
  const created = await call("project.create", {
    requestId: "create",
    title: "Portable fixture",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  service.assets.retain({ kind: "revision", id: created.revision.revisionId }, [revisionOnly.id]);
  const first = await call("edit.apply", {
    projectId,
    requestId: "first",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "video" },
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      placed(a, { label: "video" }, "video", "videoA"),
      placed(a, { label: "audio" }, "audio", "audioA"),
    ],
  });
  async function projectIndexSnapshot(revisionId, label) {
    const params = { projectId, revisionId };
    const result = await poll(
      () => call("index.get", { ...params, limit: 100 }, { transport: "mcp" }),
      (value) => value.state === "ready",
    );
    assert.equal(result.page.nextCursor, null);
    const reference = {
      projectId,
      revisionId,
      generation: result.generation,
      tap: result.tap,
      maxLongEdge: result.maxLongEdge,
    };
    const coverage = await call("index.coverage", { ...reference, limit: 100 });
    const hashes = [];
    for (const entry of result.page.entries) {
      const output = join(out, `${label}-index-${entry.candidate.ordinal}.png`);
      await call("index.frame", { ...reference, ordinal: entry.candidate.ordinal }, { output });
      hashes.push(hash(await readFile(output)));
    }
    return { result, coverage, hashes };
  }
  const historicalProjectIndex = await projectIndexSnapshot(
    first.revision.revisionId,
    "donor-history",
  );
  const before = await render(projectId, first.revision.revisionId, "donor-history");
  const latest = await call(
    "edit.apply",
    {
      projectId,
      requestId: "replace",
      expectedRevisionId: first.revision.revisionId,
      operations: [
        {
          operation: "remove",
          clipIds: [first.edit.labels.videoA, first.edit.labels.audioA],
          ripple: "none",
        },
        placed(b, first.edit.labels.video, "video", "videoB"),
        placed(b, first.edit.labels.audio, "audio", "audioB"),
      ],
    },
    { transport: "mcp" },
  );
  const current = await render(projectId, latest.revision.revisionId, "donor-current");
  assert.notEqual(current.video, before.video);
  const currentProjectIndex = await projectIndexSnapshot(
    latest.revision.revisionId,
    "donor-current",
  );
  const history = await call("revision.history", { projectId });
  const directory = await realpath(out),
    exportId = randomUUID();
  await call("export.create", {
    projectId,
    exportId,
    directory,
    leaf: "project.zip",
    kind: "processed-package",
  });
  const exported = await poll(
    () => call("export.status", { exportId }, { transport: "mcp" }),
    (value) => value.state === "ready",
  );
  const packagePath = join(out, "relocated.zip");
  await rename(exported.output, packagePath);
  const localAdmission = await call("package.open", { path: packagePath });
  const localReady = await poll(
    () => call("package.status", { admissionId: localAdmission.id }),
    (value) => value.state === "ready",
  );
  const localAdoption = await poll(
    () =>
      call("package.adopt", {
        packageHandle: localReady.packageHandle,
        requestId: "adopt-existing-evidence",
      }),
    (value) => value.state === "ready",
  );
  assert.notEqual(localAdoption.published.output.projectId, projectId);
  await call("package.close", { admissionId: localAdmission.id });
  // Export an older moment after the donor has undone, restored and edited again.
  const donorUndo = await call("edit.undo", {
    projectId,
    requestId: "later-undo",
    expectedRevisionId: latest.revision.revisionId,
  });
  const donorRestore = await call("edit.restore", {
    projectId,
    requestId: "later-restore",
    expectedRevisionId: donorUndo.id,
    targetRevisionId: latest.revision.revisionId,
  });
  const donorLater = await call("edit.apply", {
    projectId,
    requestId: "later-edit",
    expectedRevisionId: donorRestore.id,
    operations: [{ operation: "canvas.set", canvas: { background: "#ff0000ff" } }],
  });
  await projectIndexSnapshot(donorLater.revision.revisionId, "donor-later-excluded");
  const historicalExportId = randomUUID();
  await call(
    "export.create",
    {
      projectId,
      revisionId: latest.revision.revisionId,
      requestId: historicalExportId,
      directory,
      leaf: "historical.zip",
      kind: "processed-package",
    },
    { transport: "mcp" },
  );
  const historicalExport = await poll(
    () => call("export.status", { exportId: historicalExportId }),
    (value) => value.state === "ready",
  );
  const historicalPath = join(out, "relocated-history.zip");
  await rename(historicalExport.output, historicalPath);
  assert.equal(
    (await call("project.get", { projectId })).currentRevisionId,
    donorLater.revision.revisionId,
  );
  const corrupt = join(out, "corrupt.zip"),
    missing = join(out, "missing.zip");
  await run("/usr/bin/python3", [
    "-c",
    `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as source:
    names=source.namelist(); victim=next(n for n in names if n.startswith('assets/'))
    for output,mode in [(sys.argv[2],'corrupt'),(sys.argv[3],'missing')]:
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as dest:
            for name in names:
                if name==victim and mode=='missing': continue
                data=source.read(name)
                if name==victim and mode=='corrupt': data=bytes([data[0]^1])+data[1:]
                dest.writestr(name,data)
`,
    packagePath,
    corrupt,
    missing,
  ]);
  await close();
  await rm(donor, { recursive: true });
  await rm(join(scratch, "imports"), { recursive: true });
  const receiver = join(scratch, "receiver");
  await start(receiver);
  for (const path of [corrupt, missing]) {
    const bad = await call("package.open", { path });
    const failure = await poll(
      () => call("package.status", { admissionId: bad.id }, { transport: "mcp" }),
      (value) => value.state === "failed",
    );
    assert.match(failure.error, /Missing member|mismatch|hash|identity/i);
    await call("package.close", { admissionId: bad.id });
  }
  const cancelAdmission = await call("package.open", { path: packagePath });
  const cancelReady = await poll(
    () => call("package.status", { admissionId: cancelAdmission.id }),
    (value) => value.state === "ready",
  );
  // A deterministic timing barrier after real copying lets public package.close exercise adoption cancellation.
  const originalStage = service.assets.stagePortable.bind(service.assets);
  let stagedHit = false;
  service.assets.stagePortable = async (...input) => {
    const staged = await originalStage(...input),
      signal = input[2];
    stagedHit = true;
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    await staged.close();
    signal.throwIfAborted();
    throw new Error("Cancellation barrier resumed without cancellation");
  };
  await call(
    "package.adopt",
    { packageHandle: cancelReady.packageHandle, requestId: "cancel-adoption" },
    { transport: "mcp" },
  );
  await poll(
    async () => ({ hit: stagedHit }),
    (value) => value.hit,
  );
  await call("package.close", { admissionId: cancelAdmission.id });
  service.assets.stagePortable = originalStage;
  assert.deepEqual((await call("project.list", {})).projects, []);
  assert.deepEqual((await call("asset.list", {})).assets, []);
  await close();
  await start(receiver);

  const admission = await call("package.open", { path: packagePath }, { transport: "mcp" });
  const ready = await poll(
    () => call("package.status", { admissionId: admission.id }),
    (value) => value.state === "ready",
  );
  const adoptedJob = await poll(
    () =>
      call(
        "package.adopt",
        { packageHandle: ready.packageHandle, requestId: "adopt" },
        { transport: "mcp" },
      ),
    (value) => value.state === "ready",
  );
  const adopted = {
    project: await call("project.get", { projectId: adoptedJob.published.output.projectId }),
    revision: { revisionId: adoptedJob.published.output.revisionId },
  };
  const reopened = await call("package.open", { path: packagePath });
  const replayReady = await poll(
    () => call("package.status", { admissionId: reopened.id }),
    (value) => value.state === "ready",
  );
  const replay = await poll(
    () => call("package.adopt", { packageHandle: replayReady.packageHandle, requestId: "adopt" }),
    (value) => value.state === "ready",
  );
  assert.deepEqual(replay.published.output, adoptedJob.published.output);
  await call("package.close", { admissionId: reopened.id });
  await call("package.close", { admissionId: admission.id });
  assert.equal(
    (await call("package.status", { admissionId: admission.id }, { transport: "mcp" })).state,
    "closed",
  );
  await rm(packagePath);
  await close();
  await start(receiver);
  assert.equal((await call("asset.get", { assetId: revisionOnly.id })).id, revisionOnly.id);
  const adoptedHistory = await call("revision.history", { projectId: adopted.project.projectId });
  assert.ok(
    service.assets
      .references(revisionOnly.id)
      .some((owner) => owner.kind === "revision" && owner.id === adoptedHistory.revisions[0].id),
  );
  const adoptedAcquisition = await call(
    "acquisition.get",
    { acquisitionId: acquisition.id },
    { transport: "mcp" },
  );
  assert.equal(adoptedAcquisition.journal.sha256, hash(journal));
  assert.equal(hash(await readFile(adoptedAcquisition.evidence.receipt.file)), normalizedHash);
  assert.deepEqual(adoptedAcquisition.bindings, acquisition.bindings);
  assert.equal(adoptedAcquisition.evidence.sourceId, acquisition.evidence.sourceId);
  assert.equal(adoptedAcquisition.evidence.generation, acquisition.evidence.generation);
  const adoptedCursor = await call("cursor.raw", cursorParams);
  assert.equal(adoptedCursor.state, "ready");
  assert.deepEqual(adoptedCursor.page.rows, originalCursor.page.rows);
  const adoptedEvents = await call("timeline.events", cursorParams, { transport: "mcp" });
  assert.equal(adoptedEvents.state, "ready");
  assert.deepEqual(adoptedEvents.page.rows, originalEvents.page.rows);

  const adoptedIndex = await call(
    "index.get",
    { ...indexParams, limit: 100 },
    { transport: "mcp" },
  );
  assert.equal(adoptedIndex.state, "ready");
  assert.equal(adoptedIndex.generation, donorIndex.generation);
  const normalizeIndex = (page) => ({
    ...page,
    entries: page.entries.map((entry) => ({
      ...entry,
      frame: { ...entry.frame, file: "retained.png" },
    })),
  });
  assert.deepEqual(normalizeIndex(adoptedIndex.page), normalizeIndex(donorIndex.page));
  assert.deepEqual(await call("index.coverage", { ...indexReference, limit: 100 }), donorCoverage);
  for (const entry of adoptedIndex.page.entries) {
    const output = join(out, `adopted-index-${entry.candidate.ordinal}.png`);
    await call("index.frame", { ...indexReference, ordinal: entry.candidate.ordinal }, { output });
    assert.equal(hash(await readFile(output)), indexHashes[entry.candidate.ordinal]);
  }
  report.sourceIndex = {
    generation: donorIndex.generation,
    metadata: donorIndex.page.metadata,
    imageHashes: indexHashes,
  };

  const normalizeProjectIndex = (value) =>
    JSON.parse(
      JSON.stringify(value, (key, value) =>
        key === "projectId"
          ? "project"
          : key === "revisionId"
            ? "revision"
            : key === "file"
              ? "retained.png"
              : value,
      ),
    );
  report.projectIndexes = [];
  for (const original of [historicalProjectIndex, currentProjectIndex]) {
    const ordinal = history.revisions.find(
      (value) => value.id === original.result.revisionId,
    ).ordinal;
    const revisionId = adoptedHistory.revisions.find((value) => value.ordinal === ordinal).id;
    const result = await call(
      "index.get",
      { projectId: adopted.project.projectId, revisionId, limit: 100 },
      { transport: "mcp" },
    );
    assert.equal(result.state, "ready");
    assert.equal(result.generation, original.result.generation);
    assert.deepEqual(normalizeProjectIndex(result), normalizeProjectIndex(original.result));
    const reference = {
      projectId: adopted.project.projectId,
      revisionId,
      generation: result.generation,
      tap: result.tap,
      maxLongEdge: result.maxLongEdge,
    };
    assert.deepEqual(
      normalizeProjectIndex(await call("index.coverage", { ...reference, limit: 100 })),
      normalizeProjectIndex(original.coverage),
    );
    for (const entry of result.page.entries) {
      const output = join(out, `adopted-project-${ordinal}-index-${entry.candidate.ordinal}.png`);
      await call("index.frame", { ...reference, ordinal: entry.candidate.ordinal }, { output });
      assert.equal(hash(await readFile(output)), original.hashes[entry.candidate.ordinal]);
    }
    report.projectIndexes.push({
      revisionId,
      generation: result.generation,
      hashes: original.hashes,
    });
  }

  assert.equal(
    (await call("model.status", { modelId: "parakeet" }, { transport: "mcp" })).state,
    "absent",
  );
  const adoptedTranscript = await call("transcript.get", transcriptParams);
  assert.equal(adoptedTranscript.state, "ready");
  assert.equal(adoptedTranscript.generation, donorTranscript.generation);
  assert.deepEqual(adoptedTranscript.page.rows, donorTranscript.page.rows);
  assert.deepEqual(adoptedTranscript.page.transcript.raw, donorTranscript.page.transcript.raw);
  const rawFiles = await Array.fromAsync(glob("**/raw.jsonl", { cwd: receiver }));
  assert.equal(rawFiles.length, 1);
  assert.equal(
    hash(await readFile(join(receiver, rawFiles[0]))),
    donorTranscript.page.transcript.raw.sha256,
  );
  const actualAssets = (await call("asset.list", {}, { transport: "mcp" })).assets;
  assert.deepEqual(
    actualAssets.map((item) => item.id).sort(),
    [a.id, b.id, reference.id, speech.id, revisionOnly.id].sort(),
  );
  for (const original of [a, b, reference, speech, revisionOnly])
    assert.equal(hash(await readFile(service.assets.path(original.id))), original.id);
  assert.deepEqual(
    (await call("revision.history", { projectId: adopted.project.projectId })).revisions.map(
      (revision) => revision.document,
    ),
    history.revisions.map((revision) => revision.document),
  );
  assert.deepEqual(
    await render(adopted.project.projectId, adopted.revision.revisionId, "adopted-current"),
    current,
  );
  const undo = await call(
    "edit.undo",
    {
      projectId: adopted.project.projectId,
      requestId: "undo",
      expectedRevisionId: adopted.revision.revisionId,
    },
    { transport: "mcp" },
  );
  assert.deepEqual(await render(adopted.project.projectId, undo.id, "adopted-history"), before);
  const edited = await call("edit.apply", {
    projectId: adopted.project.projectId,
    requestId: "edit-adopted",
    expectedRevisionId: undo.id,
    operations: [{ operation: "canvas.set", canvas: { background: "#ff0000ff" } }],
  });
  const undoEdit = await call("edit.undo", {
    projectId: adopted.project.projectId,
    requestId: "undo-edit",
    expectedRevisionId: edited.revision.revisionId,
  });
  assert.deepEqual(undoEdit.document, undo.document);
  const historicalAdmission = await call("package.open", { path: historicalPath });
  const historicalReady = await poll(
    () => call("package.status", { admissionId: historicalAdmission.id }),
    (value) => value.state === "ready",
  );
  const historicalAdoption = await poll(
    () =>
      call("package.adopt", {
        packageHandle: historicalReady.packageHandle,
        requestId: "historical-adopt",
      }),
    (value) => value.state === "ready",
  );
  await call("package.close", { admissionId: historicalAdmission.id });
  await rm(historicalPath);
  await close();
  await start(receiver);
  const historicalProjectId = historicalAdoption.published.output.projectId;
  assert.deepEqual(
    (await call("revision.history", { projectId: historicalProjectId })).revisions.map(
      (r) => r.document,
    ),
    history.revisions.map((r) => r.document),
  );
  assert.deepEqual(
    await render(
      historicalProjectId,
      historicalAdoption.published.output.revisionId,
      "selected-history-head",
    ),
    current,
  );
  const historicalUndo = await call("edit.undo", {
    projectId: historicalProjectId,
    requestId: "historical-undo",
    expectedRevisionId: historicalAdoption.published.output.revisionId,
  });
  assert.deepEqual(
    await render(historicalProjectId, historicalUndo.id, "selected-history-undo"),
    before,
  );
  const historicalEdit = await call("edit.apply", {
    projectId: historicalProjectId,
    requestId: "historical-edit",
    expectedRevisionId: historicalUndo.id,
    operations: [{ operation: "canvas.set", canvas: { background: "#ff0000ff" } }],
  });
  const historicalUndoEdit = await call("edit.undo", {
    projectId: historicalProjectId,
    requestId: "historical-undo-edit",
    expectedRevisionId: historicalEdit.revision.revisionId,
  });
  assert.deepEqual(
    await render(historicalProjectId, historicalUndoEdit.id, "selected-history-edit-undone"),
    before,
  );
  const large = await call("project.create", {
    requestId: "bounded-history",
    canvas: created.revision.document.canvas,
  });
  const expanded = await call("edit.apply", {
    projectId: large.project.projectId,
    requestId: "many-tracks",
    expectedRevisionId: large.revision.revisionId,
    operations: Array.from({ length: 500 }, (_, order) => ({
      operation: "track.add",
      track: { kind: "audio", order },
    })),
  });
  let largeHead = expanded.revision.revisionId,
    historyBytes = Buffer.byteLength(JSON.stringify(expanded.revision));
  for (let ordinal = 0; historyBytes <= archiveLimits.revisionBytes; ordinal++) {
    assert.ok(ordinal < 40, "History fixture failed to cross the recording inline budget");
    const changed = await call("edit.apply", {
      projectId: large.project.projectId,
      requestId: `canvas-${ordinal}`,
      expectedRevisionId: largeHead,
      operations: [{ operation: "canvas.set", canvas: { width: 161 + ordinal } }],
    });
    largeHead = changed.revision.revisionId;
    historyBytes += Buffer.byteLength(JSON.stringify(changed.revision));
  }
  const expandedExportId = randomUUID();
  await call("export.create", {
    projectId: large.project.projectId,
    requestId: expandedExportId,
    directory,
    leaf: "expanded-history.zip",
    kind: "processed-package",
  });
  const expandedExport = await poll(
    () => call("export.status", { exportId: expandedExportId }, { transport: "mcp" }),
    (value) => value.state === "ready" || value.state === "failed",
  );
  assert.equal(expandedExport.state, "ready");
  assert.equal(
    expandedExport.snapshot.historyThroughOrdinal,
    expandedExport.snapshot.revisionCount - 1,
  );
  assert.ok(historyBytes > archiveLimits.revisionBytes);
  report.checks = {
    current,
    history: before,
    donorRemoved: true,
    packageRemoved: true,
    sourceBytesUnchanged: true,
    acquisitionIdentityAndBindingsRetained: true,
    exactNormalizedEvidenceRetained: true,
    retainedSceneEventsReadyWithoutPreparation: true,
    realTranscriptReadyWithModelsAbsent: true,
    sourceIndexPixelsRowsCoverageRetained: true,
    currentAndHistoricalProjectIndexPixelsRowsCoverageRetained: true,
    existingProducedEvidenceAdoption: true,
    revisionOnlyReferenceRestored: true,
    transcriptRawBytesAndWordsRetained: true,
    adoptedLibraryRestartedBeforeInspection: true,
    exactJournalRetained: true,
    historicalOnlyMediaRetained: true,
    generatedReferenceFixtureRetained: true,
    editableUndo: true,
    explicitHistoricalHeadAndPrefixRelocated: true,
    laterDonorUndoRestoreAndEditsExcluded: true,
    historicalPackageNativeEditUndo: true,
    adoptionReplay: true,
    canceledAdoptionInvisible: true,
    corruptAndMissingMembersRejected: true,
    projectHistoryBeyondInlineRecordingBudget: true,
    closedAdmissionStatusRetained: true,
  };
  report.passed = true;
} finally {
  await close();
  await rm(scratch, { recursive: true, force: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ out, passed: report.passed, checks: report.checks }, null, 2));
