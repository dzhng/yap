import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { registeredModels } from "../../core/dist/model-registry.js";
import { verifyRuntime } from "../../core/dist/model-files.js";
import { Models } from "../../core/dist/models.js";
import { identifyFile } from "./acceptance-inputs.mjs";
import { JourneyService, poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["inputs", "out", "runtime", "model", "preserved-home"].map((key) => [key, { type: "string" }]),
  ),
});
for (const key of ["inputs", "out", "runtime", "model", "preserved-home"])
  assert(values[key], `Missing --${key}`);
assert(process.env.YAP_NATIVE, "Pin the frozen native worker");
const out = resolve(values.out);
await mkdir(out, { mode: 0o700 }); // New directory only; never overwrite previous producer evidence.
const inputsPath = resolve(values.inputs);
const inputs = JSON.parse(await readFile(inputsPath, "utf8"));
for (const name of ["caller-inputs.json", "report.json", "fixture-brief.md"])
  await copyFile(join(inputsPath, "..", name), join(out, "prior-" + name));
const manifest = registeredModels.find((v) => v.name === "qwen3-tts-icl-v1");
assert(manifest?.runtimeArtifact);
const modelSource = resolve(values.model),
  runtimeSource = resolve(values.runtime);
const report = {
  passed: false,
  scope:
    "25a registered voice preparation and literal occurrence-anchor capability only; no inference or external caller acceptance",
  inputsPath,
  home: inputs.libraryHome,
  modelSource,
  runtimeSource,
  trace: [],
  exchanges: [],
  processes: [],
};
const service = new JourneyService(
  inputs.libraryHome,
  report,
  out,
  new URL("./first-preview-service.mjs", import.meta.url),
);
const call = service.call.bind(service);
async function identity(path) {
  const s = await lstat(path, { bigint: true });
  return {
    path,
    bytes: String(s.size),
    mode: String(s.mode),
    dev: String(s.dev),
    inode: String(s.ino),
    modifiedNs: String(s.mtimeNs),
    changedNs: String(s.ctimeNs),
    ...(s.isSymbolicLink() ? { target: await readlink(path) } : {}),
  };
}
async function preserved() {
  await verifyRuntime(runtimeSource, manifest.runtimeArtifact);
  const runtime = [];
  for (const entry of manifest.runtimeArtifact.entries)
    runtime.push(await identity(join(runtimeSource, entry.path)));
  const model = [];
  for (const pin of manifest.files)
    model.push({
      ...(await identifyFile(join(modelSource, pin.path), pin)),
      identity: await identity(join(modelSource, pin.path)),
    });
  const root = join(
    resolve(values["preserved-home"]),
    "library/models",
    manifest.name,
    manifest.revision,
  );
  const receipt = {
    ...(await identifyFile(join(root, "receipt.json"))),
    identity: await identity(join(root, "receipt.json")),
  };
  const worker = {
    ...(await identifyFile(process.env.YAP_NATIVE)),
    identity: await identity(process.env.YAP_NATIVE),
  };
  const installed = [];
  for (const pin of manifest.files)
    installed.push(await identity(join(root, manifest.folderName, pin.path)));
  for (const entry of manifest.runtimeArtifact.entries)
    installed.push(await identity(join(root, "runtime", entry.path)));
  return { runtime, model, receipt, installed, worker };
}
async function stop() {
  const child = service.child;
  await service.stop();
  if (child && !report.processes.some((v) => v.pid === child.pid))
    report.processes.push({
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    });
}
try {
  report.before = await preserved();
  await service.start();
  report.discovery = await call("model.list", {});
  assert.deepEqual(await call("model.list", {}, { transport: "mcp" }), report.discovery);
  const declared = report.discovery.find((v) => v.modelId === manifest.name);
  assert.equal(declared.runtimeDigest, manifest.runtimeArtifact.digest);
  report.initial = await call("model.status", { modelId: manifest.name });
  assert(
    ["absent", "ready"].includes(report.initial.presence),
    "Reuse only a ready or absent fixture model",
  );
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  if (report.initial.presence === "absent") {
    await call("model.prepare", { modelId: manifest.name });
    report.refusal = await poll(
      () => call("model.status", { modelId: manifest.name }),
      (v) => v.state === "failed",
      "missing explicit runtime",
    );
    assert.equal(report.refusal.code, "MODEL_SOURCE_REQUIRED");
    const params = { modelId: manifest.name, runtimeSource, modelSource };
    assert.equal((await call("model.prepare", params)).state, "running");
    assert.equal((await call("model.prepare", params, { transport: "mcp" })).state, "running");
    report.ready = await poll(
      () => call("model.status", { modelId: manifest.name }, { transport: "mcp" }),
      (v) => v.state === "ready",
      "registered voice adoption",
    );
  } else report.ready = report.initial;
  assert.partialDeepStrictEqual(await call("model.prepare", { modelId: manifest.name }), {
    state: "ready",
    presence: "ready",
  });
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  await stop();
  await service.start();
  assert.partialDeepStrictEqual(await call("model.status", { modelId: manifest.name }), {
    state: "ready",
    presence: "ready",
  });
  assert.partialDeepStrictEqual(
    await call("model.status", { modelId: manifest.name }, { transport: "mcp" }),
    { state: "ready", presence: "ready" },
  );
  report.reopened = true;
  // Capability proof uses an admitted reference clip, not a substitute for newly generated speech.
  const audio = inputs.inputs.find((v) => v.key === "voiceReference");
  const font = inputs.inputs.find((v) => v.key === "font");
  assert(audio && font);
  const created = await call("project.create", {
    requestId: randomUUID(),
    title: "Literal occurrence anchor capability",
    canvas: {
      width: 1280,
      height: 720,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const range = { startUs: 0, endUs: 500000 };
  const ref = (label) => ({ label });
  const caption = { kind: "content", clipId: ref("occurrence"), sourceRange: range };
  const edited = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: created.revision.id,
      requestId: randomUUID(),
      operations: [
        { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
        { operation: "track.add", track: { kind: "video", order: 1 }, label: "text" },
        {
          operation: "place",
          label: "occurrence",
          clip: {
            trackId: ref("audio"),
            ...audio.selected,
            source: { kind: "range", range },
            placement: { kind: "project", range },
          },
        },
        {
          operation: "place",
          label: "paid",
          clip: {
            trackId: ref("text"),
            source: {
              kind: "text",
              text: "paid",
              font: { assetId: font.assetId, postScriptName: "ArialMT" },
              width: 600,
              height: 100,
              size: 48,
              color: "#ffffffff",
              alignment: "left",
              wrap: true,
            },
            placement: caption,
          },
        },
      ],
    },
    { transport: "mcp" },
  );
  const doc = edited.revision.document;
  const parent = doc.clips.find((v) => v.assetId === audio.assetId);
  const text = doc.clips.find((v) => v.source.kind === "text");
  assert.equal(text.source.text, "paid");
  assert.deepEqual(text.placement, { kind: "content", clipId: parent.id, sourceRange: range });
  const moved = await call("edit.apply", {
    projectId,
    expectedRevisionId: edited.revision.id,
    requestId: randomUUID(),
    operations: [{ operation: "move", clipIds: [parent.id], atUs: 1000000, ripple: "none" }],
  });
  assert.deepEqual(
    moved.revision.document.clips.find((v) => v.id === text.id).placement,
    text.placement,
  );
  report.literalAnchor = {
    projectId,
    revisionId: moved.revision.id,
    clipId: parent.id,
    textClipId: text.id,
    sourceRange: range,
    proofSource: audio.selected,
    limitation:
      "Reference clip proves public anchor capability only. Eventual caller must bind its actual generated paid clip/source interval; no paid word or synthesis claim.",
  };
  const main = await call("project.get", { projectId: inputs.projectId });
  assert.equal(main.currentRevisionId, inputs.revisionId);
  assert.deepEqual(
    (await call("revision.get", { projectId: inputs.projectId, revisionId: inputs.revisionId }))
      .revision.document.clips,
    [],
  );
  await stop();
  const models = new Models(join(inputs.libraryHome, "library"));
  report.preparedVoice = await models.runtime(manifest.name, "voice");
  await models.settled();
  assert.equal(report.preparedVoice.runtimeDigest, declared.runtimeDigest);
  assert.equal(report.preparedVoice.modelDigest, declared.modelDigest);
  report.after = await preserved();
  assert.deepEqual(report.after, report.before);
  const operations = (await readFile(join(out, "operations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    operations.every((v) =>
      ["media.audioCapabilities", "storage.clearRenderWorkspace"].includes(v.operation),
    ),
    "No native inference/media work allowed",
  );
  report.nativeOperations = operations;
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await stop();
  report.logs = service.logs;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
}
