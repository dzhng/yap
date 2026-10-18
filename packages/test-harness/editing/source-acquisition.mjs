import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cliReply } from "./first-preview-transport.mjs";

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--out"),
  "Expected [--out DIRECTORY]",
);
assert.ok(process.env.YAP_NATIVE, "YAP_NATIVE must name an isolated frozen native build");
const out = args[1] ? resolve(args[1]) : await mkdtemp(join(tmpdir(), "acquisition-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-acq-"));
const donor = join(home, "donor");
const fixture = new URL("../../../fixtures/narrated-workbench/", import.meta.url).pathname;
const cli = new URL("../../../apps/cli/dist/main.js", import.meta.url).pathname;
const run = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  scope:
    "Actual CLI/MCP capture adoption, immutable bindings and native preview/export; no transcript, listening or differing-mask acceptance",
  passed: false,
  checks: {},
  trace: [],
};
let service, mcp, socketPath;
const serviceLog = [];
const barriers = new Map();
async function poll(read, done, label) {
  const deadline = performance.now() + 120000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(
      !["failed", "unavailable", "canceled"].includes(value.state),
      `${label}: ${JSON.stringify(value)}`,
    );
    assert.ok(performance.now() < deadline, `${label}: deadline`);
    await delay(50);
  }
}
async function start() {
  service = fork(new URL("./source-acquisition-service.mjs", import.meta.url), [home], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  service.stdout.on("data", (b) => serviceLog.push(b.toString()));
  service.stderr.on("data", (b) => serviceLog.push(b.toString()));
  service.on("message", (message) => {
    if (message.type) barriers.set(`${message.id}/${message.type}`, message);
  });
  const [ready] = await Promise.race([
    once(service, "message"),
    once(service, "exit").then(([code]) => {
      throw new Error(`Service exited ${code}: ${serviceLog.join("")}`);
    }),
    delay(30000, undefined, { ref: false }).then(() => {
      throw new Error("Service startup deadline");
    }),
  ]);
  assert.equal(ready.error, undefined, JSON.stringify(ready));
  socketPath = ready.socketPath;
  mcp = new Client({ name: "source-acquisition-journey", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--socket", socketPath],
      stderr: "pipe",
    }),
  );
}
async function stop(crash = false) {
  await mcp?.close();
  mcp = undefined;
  if (!service || service.exitCode !== null || service.signalCode !== null) return;
  const current = service;
  const exited = once(current, "exit");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      current.kill("SIGKILL");
      reject(new Error("Service shutdown deadline"));
    }, 15000);
    timer.unref();
  });
  if (crash) current.kill("SIGKILL");
  else current.send("close");
  let code, signal;
  try {
    [code, signal] = await Promise.race([exited, timeout]);
  } catch (error) {
    await exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (crash) assert.equal(signal, "SIGKILL");
  else assert.equal(code, 0, serviceLog.join(""));
}
async function call(operation, params, { transport = "cli", error = false, output } = {}) {
  const response =
    transport === "mcp"
      ? (await mcp.callTool({ name: operation, arguments: params })).structuredContent
      : await cliReply([
          cli,
          operation,
          "--socket",
          socketPath,
          "--params",
          JSON.stringify(params),
          ...(output ? ["--output", output] : []),
        ]);
  assert.ok(response && typeof response.ok === "boolean", `${operation}: missing response`);
  report.trace.push({
    operation,
    transport,
    ok: response.ok,
    state: response.data?.state,
    ...(response.ok ? {} : { error: response.error }),
  });
  assert.equal(response.ok, !error, `${operation}: ${JSON.stringify(response)}`);
  return response.ok ? response.data : response.error;
}
async function arm(operation, remaining = 1) {
  const id = randomUUID();
  service.send({ type: "barrier.arm", id, operation, remaining });
  await poll(
    () => barriers.get(`${id}/barrier.armed`) ?? {},
    (v) => v.type === "barrier.armed",
    "arm native barrier",
  );
  return () =>
    poll(
      () => barriers.get(`${id}/barrier.hit`) ?? {},
      (v) => v.nativeSucceeded === true,
      "real native reply",
    );
}
const jobReady = (jobId) =>
  poll(
    () => call("job.get", { jobId }, { transport: "mcp" }),
    (v) => v.state === "ready",
    "acquisition ready",
  );
async function adopt(requestId) {
  const pending = await call("acquisition.import", { requestId, path: donor });
  const ready = await jobReady(pending.jobId);
  const id = ready.target.acquisitionId;
  const value = await call("acquisition.get", { acquisitionId: id });
  assert.deepEqual(
    await call("acquisition.get", { acquisitionId: id }, { transport: "mcp" }),
    value,
  );
  return { job: ready, value };
}
function retainedState(acquisitionId) {
  const db = new DatabaseSync(join(home, "library", "catalog.sqlite"), { readOnly: true });
  try {
    return {
      evidence: db
        .prepare(
          "SELECT generation,receipt FROM source_evidence_generations WHERE ownerKind='acquisition' AND ownerId=?",
        )
        .all(acquisitionId),
      references: db
        .prepare("SELECT * FROM resource_references WHERE ownerKind='acquisition' AND ownerId=?")
        .all(acquisitionId),
    };
  } finally {
    db.close();
  }
}
async function decoded(file) {
  const exec = async (args) =>
    (
      await run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, ...args, "pipe:1"], {
        encoding: "buffer",
        timeout: 30000,
        maxBuffer: 32 * 1024 ** 2,
      })
    ).stdout;
  const video = await exec(["-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo"]);
  const audio = await exec(["-map", "0:a:0", "-acodec", "pcm_f32le", "-f", "f32le"]);
  assert.ok(video.length > 0 && audio.length > 0);
  const samples = new Float32Array(audio.buffer, audio.byteOffset, audio.byteLength / 4);
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  assert.ok(rms > 0.001, "The delivered real narration excerpt must contain audible sample energy");
  assert.ok(
    video.some((value) => value > 64),
    "Delivered pictures must not all be black",
  );
  return {
    video: hash(video),
    audio: hash(audio),
    audioRms: rms,
    videoBytes: video.length,
    audioBytes: audio.length,
  };
}
try {
  const members = ["capture.journal.jsonl", "video.mov", "narration.mov"];
  const original = Object.fromEntries(
    await Promise.all(
      members.map(async (name) => [name, hash(await readFile(join(fixture, name)))]),
    ),
  );
  await mkdir(donor);
  for (const name of members) await cp(join(fixture, name), join(donor, name));
  await start();
  const canceledHit = await arm("media.sourceEvidence");
  const canceled = await call("acquisition.import", {
    requestId: "cancel-after-source",
    path: donor,
  });
  await canceledHit();
  await call("job.cancel", { jobId: canceled.jobId }, { transport: "mcp" });
  await poll(
    () => call("job.get", { jobId: canceled.jobId }),
    (v) => v.state === "canceled",
    "cancel acquisition",
  );
  assert.equal(
    (
      await call(
        "acquisition.get",
        { acquisitionId: canceled.target.acquisitionId },
        { error: true },
      )
    ).code,
    "NOT_READY",
  );
  const crashHit = await arm("media.probe", 2);
  const interrupted = await call("job.retry", { jobId: canceled.jobId });
  assert.notEqual(interrupted.attemptId, canceled.attemptId);
  await crashHit();
  const beforeCrash = retainedState(interrupted.target.acquisitionId);
  assert.equal(beforeCrash.evidence.length, 1);
  assert.ok(
    beforeCrash.references.length > 0,
    "Video asset must actually publish before interruption",
  );
  const interruptedDirectory = join(
    home,
    "library",
    "acquisitions",
    interrupted.target.acquisitionId,
    interrupted.attemptId,
  );
  assert.ok((await lstat(interruptedDirectory)).isDirectory());
  assert.ok((await lstat(join(interruptedDirectory, "source", "capture.journal.jsonl"))).isFile());
  assert.ok((await lstat(join(interruptedDirectory, "source.jsonl"))).isFile());
  await stop(true);
  await start();
  const failed = await call("job.get", { jobId: interrupted.jobId });
  assert.equal(failed.state, "failed");
  assert.equal(failed.errorCode, "JOB_INTERRUPTED");
  assert.deepEqual(retainedState(interrupted.target.acquisitionId), {
    evidence: [],
    references: [],
  });
  await assert.rejects(lstat(interruptedDirectory), { code: "ENOENT" });
  await call("job.retry", { jobId: interrupted.jobId }, { transport: "mcp" });
  const a = await jobReady(interrupted.jobId);
  assert.notEqual(a.attemptId, interrupted.attemptId);
  const contextA = await call("acquisition.get", { acquisitionId: a.target.acquisitionId });
  const second = await adopt("same-journal-second-context");
  const contextB = second.value;
  assert.notEqual(contextA.id, contextB.id);
  assert.deepEqual(
    contextA.bindings,
    contextB.bindings,
    "Same retained journal must preserve equivalent support across independent contexts",
  );
  report.checks.recovery = {
    canceledAttempt: canceled.attemptId,
    retryAttempt: interrupted.attemptId,
    interruptedAttempt: interrupted.attemptId,
    restartedAttempt: a.attemptId,
    preCrashIndexed: true,
    preCrashAssetRetained: true,
    orphanStateRemoved: true,
    orphanAttemptFilesRemoved: true,
  };
  for (const context of [contextA, contextB]) {
    assert.equal(context.journal.sha256, original["capture.journal.jsonl"]);
    assert.equal(
      hash(
        await readFile(join(home, "library", "acquisitions", context.id, context.journal.fileName)),
      ),
      context.journal.sha256,
    );
    assert.deepEqual(
      await call("acquisition.get", { acquisitionId: context.id }),
      await call("acquisition.get", { acquisitionId: context.id }, { transport: "mcp" }),
    );
    for (const binding of context.bindings) {
      const role = binding.sourceRoles[0];
      assert.equal(binding.assetId, original[`${role}.mov`]);
      const asset = await call("asset.get", { assetId: binding.assetId });
      assert.equal(binding.sourceToAssetOffsetUs, -asset.originUs || 0);
    }
  }
  await rm(donor, { recursive: true });
  assert.equal(
    (
      await call(
        "acquisition.import",
        { requestId: "cancel-after-source", path: donor },
        { transport: "mcp" },
      )
    ).jobId,
    a.jobId,
  );
  assert.equal(
    (
      await call(
        "acquisition.import",
        { requestId: "cancel-after-source", path: donor + "-other" },
        { error: true },
      )
    ).code,
    "REQUEST_CONFLICT",
  );
  report.checks.adoption = {
    contextA,
    contextB,
    sourceHashes: original,
    donorRemoved: true,
    requestReplayWithoutDonor: true,
  };
  const voice = contextA.bindings.find((b) => b.sourceRoles.includes("narration"));
  const picture = contextA.bindings.find((b) => b.sourceRoles.includes("video"));
  assert.ok(voice && picture);
  const durationUs = 2000000;
  const audioInterval = voice.available.find((r) => r.endUs - r.startUs > durationUs + 200000);
  assert.ok(audioInterval, "Real narration must contain a common two-second supported excerpt");
  const sourceStartUs =
    audioInterval.startUs +
    Math.min(7000000, audioInterval.endUs - audioInterval.startUs - durationUs - 100000) -
    voice.sourceToAssetOffsetUs;
  const sourceRange = (binding) => ({
    startUs: sourceStartUs + binding.sourceToAssetOffsetUs,
    endUs: sourceStartUs + binding.sourceToAssetOffsetUs + durationUs,
  });
  assert.ok(
    picture.available.some(
      (r) => r.startUs <= sourceRange(picture).startUs && r.endUs >= sourceRange(picture).endUs,
    ),
  );
  const created = await call("project.create", {
    requestId: "acquired-project",
    title: "Acquisition journey",
    canvas: {
      width: 320,
      height: 200,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  let head = created.revision.revisionId;
  const media = (binding, acquisitionId) => ({
    assetId: binding.assetId,
    streamId: binding.streamId,
    source: { kind: "range", range: sourceRange(binding) },
    ...(acquisitionId ? { acquisitionId } : {}),
  });
  const operations = [
    { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
    { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
    ...[
      ["picture", picture, "video"],
      ["voice", voice, "audio"],
    ].map(([label, binding, track]) => ({
      operation: "place",
      label,
      clip: {
        trackId: { label: track },
        ...media(binding, contextA.id),
        placement: { kind: "project", range: { startUs: 0, endUs: durationUs } },
      },
    })),
  ];
  const placed = await call("edit.apply", {
    projectId,
    requestId: "place-acquired",
    expectedRevisionId: head,
    operations,
  });
  head = placed.revision.revisionId;
  const revisionA = head;
  const render = async (name, revisionId) => {
    const file = join(out, `${name}.mp4`);
    const status = await poll(
      () => call("preview.get", { projectId, revisionId }, { output: file }),
      (v) => v.state === "ready",
      "native preview",
    );
    assert.equal(status.published.output.revisionId, revisionId);
    return { file, status, decoded: await decoded(file), sha256: hash(await readFile(file)) };
  };
  const renderedA = await render("context-a", revisionA);
  const replacement = (binding, label, acquisitionId) => ({
    operation: "replace",
    clipId: placed.edit.labels[label],
    kind: label === "picture" ? "video" : "audio",
    media: media(binding, acquisitionId),
  });
  const replace = async (requestId, acquisitionId) => {
    const result = await call("edit.apply", {
      projectId,
      requestId,
      expectedRevisionId: head,
      operations: [
        replacement(picture, "picture", acquisitionId),
        replacement(voice, "voice", acquisitionId),
      ],
    });
    head = result.revision.revisionId;
    return result;
  };
  const replacedB = await replace("select-context-b", contextB.id);
  const renderedB = await render("context-b", head);
  assert.deepEqual(renderedB.decoded, renderedA.decoded);
  const physical = await replace("select-physical", undefined);
  assert.ok(physical.revision.document.clips.every((c) => c.acquisitionId === undefined));
  const renderedPhysical = await render("physical", head);
  assert.deepEqual(
    renderedPhysical.decoded,
    renderedA.decoded,
    "Common supported source excerpt must be identical for physical-only and both captured contexts",
  );
  const undone = await call(
    "edit.undo",
    { projectId, requestId: "undo-physical", expectedRevisionId: head },
    { transport: "mcp" },
  );
  head = undone.id;
  assert.ok(undone.document.clips.every((c) => c.acquisitionId === contextB.id));
  const directory = await realpath(out);
  const exportId = randomUUID();
  await call(
    "export.create",
    { projectId, revisionId: revisionA, kind: "video", exportId, directory, leaf: "exported.mp4" },
    { transport: "mcp" },
  );
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "native publication",
  );
  assert.equal(hash(await readFile(join(out, "exported.mp4"))), renderedA.sha256);
  await stop();
  await start();
  for (const context of [contextA, contextB])
    assert.deepEqual(
      await call("acquisition.get", { acquisitionId: context.id }, { transport: "mcp" }),
      context,
    );
  assert.deepEqual(
    (await render("historical-after-restart", revisionA)).decoded,
    renderedA.decoded,
  );
  const historical = await call(
    "revision.get",
    { projectId, revisionId: revisionA },
    { transport: "mcp" },
  );
  assert.ok(historical.revision.document.clips.every((c) => c.acquisitionId === contextA.id));
  report.checks.project = {
    projectId,
    revisionA,
    revisionB: replacedB.revision.revisionId,
    physicalRevision: physical.revision.revisionId,
    undoRevision: head,
    commonSourceClockRange: { startUs: sourceStartUs, endUs: sourceStartUs + durationUs },
    decoded: renderedA.decoded,
    threeSelectionsEqual: true,
    exportReceipt: exported.receipt,
    historicalAfterRestart: true,
  };
  assert.deepEqual(
    Object.fromEntries(
      await Promise.all(
        members.map(async (name) => [name, hash(await readFile(join(fixture, name)))]),
      ),
    ),
    original,
  );
  report.runtime = {
    native: process.env.YAP_NATIVE,
    nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
    modules: Object.fromEntries(
      await Promise.all(
        [
          "apps/service/dist/project-service.js",
          "packages/core/dist/acquisitions.js",
          "packages/core/dist/catalog.js",
          "packages/core/dist/assets.js",
          "packages/core/dist/files.js",
          "packages/core/dist/references.js",
          "packages/core/dist/jobs.js",
          "packages/protocol/dist/operations.js",
          "apps/cli/dist/main.js",
          "packages/test-harness/editing/source-acquisition.mjs",
          "packages/test-harness/editing/source-acquisition-service.mjs",
          "packages/core/dist/evidence.js",
          "packages/core/dist/projects.js",
          "packages/core/dist/project-preview.js",
          "packages/composition/dist/model.js",
          "packages/composition/dist/replace.js",
          "packages/composition/dist/compiler.js",
          "packages/composition/dist/audio-context.js",
        ].map(async (file) => [
          file,
          hash(await readFile(new URL(`../../../${file}`, import.meta.url))),
        ]),
      ),
    ),
  };
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await stop().catch((error) => {
    report.shutdownError = error.message;
    report.passed = false;
  });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), serviceLog.join(""));
  await rm(home, { recursive: true, force: true });
}
assert.equal(report.passed, true, "Acquisition journey failed during teardown");
console.log(JSON.stringify({ passed: report.passed, out }));
