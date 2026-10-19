import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CaptureStore } from "@yap/core/capture-store";
import { callLocal } from "@yap/client";
import { startProjectService } from "../dist/project-service.js";
import { mediaWorker } from "../dist/worker.js";

const pinFile = process.env.YAP_NATIVE_PINS;
const output = process.env.YAP_LIFETIME_OUTPUT;
assert(pinFile && output, "Supply the native source/binary pins and evidence output directory");
const pins = JSON.parse(await readFile(pinFile, "utf8"));
const binary = pins.binary.path,
  expected = pins.binary.sha256;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(await readFile(binary)), expected);
const sourceFiles = execFileSync(
  "git",
  ["ls-files", "helpers/mac/Sources", "helpers/mac/Package.swift"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
assert.deepEqual(
  sourceFiles.sort(),
  Object.keys(pins.sources).sort(),
  "Native source manifest must cover the complete source tree",
);
const nativeSources = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (file) => [file, digest(await readFile(file))])),
);
assert.deepEqual(
  nativeSources,
  pins.sources,
  "Current native sources differ from the compiled worker pins",
);
const archive = resolve(
  "specs/done/agent-editing/assets/20d6-settled-cleanup/prerecorded-source.tar.xz",
);
const retained = JSON.parse(
  await readFile(
    resolve("specs/done/agent-editing/assets/20d6-settled-cleanup/artifact-hashes.json"),
    "utf8",
  ),
);
assert.equal(digest(await readFile(archive)), retained["prerecorded-source.tar.xz"]);
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "native-pins.json"),
  JSON.stringify(
    {
      binary,
      sha256: expected,
      build: pins,
      nativeSources,
      archive,
      archiveSHA256: retained["prerecorded-source.tar.xz"],
    },
    null,
    2,
  ),
);

async function fixture(t, name) {
  const root = await mkdtemp("/tmp/capture-source-lifetime-");
  const home = join(root, "home"),
    library = join(home, "library");
  await mkdir(library, { recursive: true, mode: 0o700 });
  execFileSync("tar", ["-xJf", archive, "-C", root]);
  const header = JSON.parse(
    (await readFile(join(root, "take", "capture.journal.jsonl"), "utf8")).split("\n")[0],
  ).data;
  let allocated = 0;
  const store = new CaptureStore(join(library, "catalog.sqlite"), {
    now: () => "2026-10-01T00:00:00.000Z",
    newId: () => (++allocated === 2 ? header.sessionID : randomUUID()),
  });
  const recording = store.allocate().recording;
  store.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "interrupted",
    reason: "NO_VIDEO",
    sourceDurationUs: null,
  });
  store.close();
  const source = join(library, "recordings", recording.id, "source");
  await mkdir(source, { recursive: true, mode: 0o700 });
  await cp(join(root, "take"), source, { recursive: true });
  const report = {
    name,
    native: { binary, sha256: expected },
    calls: [],
    nativeOperations: [],
    passed: false,
  };
  const native = mediaWorker({ YAP_NATIVE: binary });
  let service;
  const start = async () => {
    service = await startProjectService({
      home,
      worker: async (operation, params, options) => {
        if (operation === "media.audioCapabilities") return { ok: true, data: {} };
        assert(
          [
            "storage.clearRenderWorkspace",
            "storage.recordingDirectory",
            "storage.removeRecordingDirectory",
            "media.cleanupCapture",
          ].includes(operation),
          `Unapproved native operation: ${operation}`,
        );
        const result = await native(operation, params, options);
        report.nativeOperations.push({
          operation,
          params,
          descriptors: options?.descriptors?.length ?? 0,
          result,
        });
        return result;
      },
    });
  };
  const close = async () => {
    await service?.close();
    service = undefined;
  };
  const call = async (operation, params = {}) => {
    const result = await callLocal(service.socketPath, { id: randomUUID(), operation, params });
    report.calls.push({ operation, params, result });
    assert(result.ok, JSON.stringify(result));
    return result.data;
  };
  const terminal = async (jobId) => {
    for (let i = 0; i < 200; i++) {
      const job = await call("job.get", { jobId });
      if (["ready", "failed", "canceled"].includes(job.state)) return job;
      await delay(10);
    }
    throw new Error("Cleanup job did not settle within its bounded check");
  };
  const hashes = async (
    names = [
      "capture.journal.jsonl",
      "video.mov",
      "narration.mov",
      "system.mov",
      "narration.publication.json",
      "system.publication.json",
    ],
  ) =>
    Object.fromEntries(
      await Promise.all(
        names.map(async (file) => [file, digest(await readFile(join(source, file)))]),
      ),
    );
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
    report.closed = true;
    await writeFile(join(output, `${name}.json`), JSON.stringify(report, null, 2));
  });
  return { source, recording, report, start, close, call, terminal, hashes };
}

test(
  "verified cleanup preserves originals, reports partial operational failure, and retries after reopen",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, "verified-cleanup");
    for (const role of ["narration", "system"]) {
      const receipt = JSON.parse(
        await readFile(join(f.source, `${role}.publication.json`), "utf8"),
      );
      const attempt = join(f.source, `.capture-publication-${role}`);
      await mkdir(attempt, { mode: 0o700 });
      await writeFile(join(attempt, "intent.json"), JSON.stringify(receipt.intent));
      await link(join(f.source, `${role}.mov`), join(attempt, "candidate.mov"));
      await link(join(f.source, `${role}.publication.json`), join(attempt, "prepared.json"));
    }
    const denied = join(f.source, ".capture-publication-narration");
    const before = await f.hashes();
    await chmod(denied, 0o500);
    await f.start();
    const recording = await f.call("recording.get", { recordingId: f.recording.id });
    const admitted = await f.call("recording.cleanup", { recordingId: f.recording.id });
    assert.deepEqual(admitted.target, {
      kind: "recording",
      id: f.recording.id,
      revisionId: null,
    });
    const failed = await f.terminal(admitted.jobId);
    assert.equal(failed.state, "failed", JSON.stringify(failed));
    assert.equal(failed.retryable, true, JSON.stringify(failed));
    assert.equal(failed.errorCode, "CLEANUP_UNAVAILABLE");
    assert.deepEqual(await f.hashes(), before);
    await assert.rejects(readFile(join(f.source, ".capture-publication-system", "candidate.mov")), {
      code: "ENOENT",
    });
    await readFile(join(denied, "candidate.mov"));
    await f.close();
    await chmod(denied, 0o700);
    await f.start();
    assert.equal((await f.call("job.get", { jobId: admitted.jobId })).attemptId, failed.attemptId);
    await f.call("job.retry", { jobId: admitted.jobId });
    const ready = await f.terminal(admitted.jobId);
    assert.equal(ready.state, "ready", JSON.stringify(ready));
    assert.notEqual(ready.attemptId, failed.attemptId);
    assert.deepEqual(ready.published.output.roles, [
      { role: "narration", outcome: "removed", reason: null },
      { role: "system", outcome: "alreadyClear", reason: null },
    ]);
    assert.deepEqual(await f.hashes(), before);
    assert.deepEqual(await f.call("recording.get", { recordingId: f.recording.id }), recording);
    assert.deepEqual((await f.call("project.list")).projects, []);
    assert.equal(
      (await f.call("recording.cleanup", { recordingId: f.recording.id })).attemptId,
      ready.attemptId,
    );
    f.report.before = before;
    f.report.after = await f.hashes();
    await f.call("recording.delete", { recordingId: f.recording.id });
    await assert.rejects(readFile(join(f.source, "video.mov")), { code: "ENOENT" });
    await f.call("recording.delete", { recordingId: f.recording.id });
    f.report.passed = true;
  },
);

test(
  "missing publication proof retains unverified audio and camera working files",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, "unverified-cleanup");
    for (const role of ["narration", "system"]) {
      await rm(join(f.source, `${role}.publication.json`));
      await writeFile(join(f.source, `${role}.packed.mov`), `unverified ${role} input`);
    }
    await mkdir(join(f.source, "camera"));
    await writeFile(join(f.source, "camera", "raw.mov"), "camera input is outside audio cleanup");
    const names = [
      "capture.journal.jsonl",
      "video.mov",
      "narration.mov",
      "system.mov",
      "narration.packed.mov",
      "system.packed.mov",
      "camera/raw.mov",
    ];
    const before = await f.hashes(names);
    await f.start();
    const admitted = await f.call("recording.cleanup", { recordingId: f.recording.id });
    const ready = await f.terminal(admitted.jobId);
    assert.equal(ready.state, "ready", JSON.stringify(ready));
    assert.deepEqual(ready.published.output.roles, [
      { role: "narration", outcome: "retained", reason: "missing-publication" },
      { role: "system", outcome: "retained", reason: "missing-publication" },
    ]);
    assert.deepEqual(await f.hashes(names), before);
    f.report.before = before;
    f.report.after = await f.hashes(names);
    f.report.passed = true;
  },
);
