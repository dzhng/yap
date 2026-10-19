import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { callLocal } from "@yap/client";
import { mediaWorker } from "../dist/worker.js";
import { startProjectService } from "../dist/project-service.js";

// The caller lowers only this disposable process's descriptor limit before exec.
const home = process.env.YAP_PRESSURE_HOME;
const source = join(home, "source.wav");
const frames = 4800;

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
  bytes.writeFloatLE(0.8 * Math.sin(i * 0.17), 44 + i * 8);
  bytes.writeFloatLE(0.3 * Math.cos(i * 0.21), 48 + i * 8);
}
await writeFile(source, bytes);
const calls = [];
const execute = mediaWorker({ YAP_NATIVE: process.env.YAP_NATIVE });
const service = await startProjectService({
  worker: async (operation, params, options) => {
    const record = {
      operation,
      descriptors: options?.descriptors?.length ?? 0,
      held: params.held?.length ?? 0,
      clips: params.clips?.length,
      stateClips: params.state?.clips?.length,
      requestBytes:
        Buffer.byteLength(JSON.stringify({ id: "worker-" + operation, operation, params })) + 1,
    };
    calls.push(record);
    const result = await execute(operation, params, options);
    record.result = result;

    return result;
  },
  home,
  nativeExecutable: process.env.YAP_NATIVE,
  ffmpeg: {
    directory: process.env.YAP_FFMPEG_DIRECTORY,
    receiptSha256:
      process.env.YAP_FFMPEG_RECEIPT ??
      "27350ff2f953bbd4d6ca8bfe0f6808b99b9752192657d289146b50319099f66a",
  },
});
let sequence = 0;
const call = async (operation, params = {}) => {
  const result = await callLocal(service.socketPath, {
    id: `pressure-${++sequence}`,
    operation,
    params,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const settled = async (jobId) => {
  const deadline = performance.now() + 30000;
  for (;;) {
    const result = await call("job.get", { jobId });
    if (["ready", "failed", "unavailable", "canceled"].includes(result.state)) return result;
    assert.ok(performance.now() < deadline, JSON.stringify(result));
    await delay(20);
  }
};
try {
  const imported = await settled(
    (await call("asset.import", { requestId: "source", path: source })).jobId,
  );
  assert.equal(imported.state, "ready", JSON.stringify(imported));
  const created = await call("project.create", {
    requestId: "project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const processor = { type: "limiter", ceilingDbfs: -6, lookaheadMs: 5, releaseMs: 50 };
  const operations = [
    { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
  ];
  for (let i = 0; i < 80; i++) {
    operations.push({
      operation: "place",
      label: `clip-${i}`,
      clip: {
        trackId: { label: "audio" },
        assetId: imported.published.output.assetId,
        streamId: "track:1",
        source: { kind: "range", range: { startUs: 0, endUs: 100000 } },
        placement: { kind: "project", range: { startUs: i * 100000, endUs: (i + 1) * 100000 } },
      },
    });
    operations.push({
      operation: "processing.set",
      target: { kind: "clip", id: { label: `clip-${i}` } },
      steps: [{ enabled: true, processor }],
    });
  }
  const edited = await call("edit.apply", {
    projectId: created.project.projectId,
    expectedRevisionId: created.revision.revisionId,
    requestId: "pressure",
    operations,
  });
  const selection = {
    projectId: created.project.projectId,
    revisionId: edited.revision.revisionId,
  };
  const preparation = await call("audio.prepare", selection);
  const failed = await settled(preparation.jobId);
  await writeFile(join(home, "native-calls.json"), JSON.stringify(calls, null, 2));
  let recovered = failed;
  if (process.env.YAP_PRESSURE_EXPECT_FAILURE === "1") {
    assert.equal(failed.state, "failed", JSON.stringify(failed));
    assert.equal(failed.retryable, true, JSON.stringify(failed));
    assert.match(
      failed.reason,
      /Too many open files|EMFILE|ENFILE|error -42/i,
      JSON.stringify(failed),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.operation === "media.prepareCompositionAudioDomain" &&
          call.held > 0 &&
          call.result.ok,
      ),
    );
    assert.ok(
      calls.some(
        (call) => call.operation === "media.prepareCompositionAudioDomain" && !call.result.ok,
      ),
    );
    assert.equal(failed.published, null);
    assert.equal((await call("audio.prepare", selection)).published, null);
    assert.deepEqual(await readdir(join(home, "library", "render")), []);
    assert.deepEqual(await readFile(source), bytes);
    await call("service.health");
    const revised = await call("edit.apply", {
      projectId: selection.projectId,
      expectedRevisionId: selection.revisionId,
      requestId: "recover",
      operations: Object.entries(edited.edit.labels)
        .filter(([label]) => label.startsWith("clip-"))
        .map(([, id]) => ({
          operation: "processing.set",
          target: { kind: "clip", id },
          steps: [],
        }))
        .concat([
          {
            operation: "remove",
            clipIds: Object.entries(edited.edit.labels)
              .filter(([label]) => label.startsWith("clip-") && label !== "clip-0")
              .map(([, id]) => id),
            scope: "selected",
            ripple: "none",
          },
          {
            operation: "processing.set",
            target: { kind: "output" },
            steps: [{ enabled: true, processor }],
          },
        ]),
    });
    recovered = await settled(
      (await call("audio.prepare", { ...selection, revisionId: revised.revision.revisionId }))
        .jobId,
    );
  }
  await writeFile(join(home, "all-native-calls.json"), JSON.stringify(calls, null, 2));
  assert.equal(recovered.state, "ready", JSON.stringify(recovered));
  assert.deepEqual(await readdir(join(home, "library", "render")), []);
  assert.deepEqual(await readFile(source), bytes);
  process.stdout.write(
    JSON.stringify({
      failed,
      recovered,
      maximumHeld: Math.max(...calls.map((call) => call.held)),
      completedPrefixes: calls.filter(
        (call) => call.operation === "media.prepareCompositionAudioDomain" && call.result.ok,
      ).length,
    }) + "\n",
  );
} finally {
  await service.close();
}
