import { portHistoricalSpeechRaw } from "../speech/reference-raw.mjs";
import { speechExecution, transcriptPolicy } from "../../core/dist/transcript.js";
import { wordKindPolicy } from "../../core/dist/word-kind.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { readAudioWaveFile } from "../../core/dist/audio-wave.js";
import { parakeetModel } from "../../core/dist/models.js";
import { modelWorkState } from "../../protocol/dist/index.js";
import { existingSpeechModelSnapshot } from "./existing-speech-model.mjs";
import { historicalWholeSupportRecords } from "./speech-parity-records.mjs";
import { changedTranscriptGeneration } from "./generation-evidence.mjs";
import { hash, JourneyService, poll, root, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: {
    reference: { type: "string" },
    out: { type: "string" },
    "existing-models": { type: "string" },
  },
});
assert.ok(values.reference, "Pass --reference with the retained speech baseline");
assert.ok(process.env.YAP_NATIVE, "Select an isolated native worker");
const actualInference = !!values["existing-models"];
const existingModels = actualInference
  ? { directory: resolve(values["existing-models"]), files: parakeetModel.files }
  : undefined;
const reference = resolve(values.reference);
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "speech-parity-"));
await mkdir(out, { recursive: true });
assert.deepEqual(await readdir(out), [], "Use a fresh evidence directory");
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const baseline = await json(join(reference, "manifest.json"));
const frozen = join(root, "specs/done/agent-editing/assets/10b-native-selection/selected");
const prior = await json(
  join(root, "specs/done/agent-editing/assets/10c-public-phrases/project.json"),
);
const engine = prior.transcript.dependencies[0].transcript.engine;
assert.equal(engine.modelDigest, baseline.models.digest);
for (const [key, value] of Object.entries(baseline.models.pins)) assert.equal(engine[key], value);
const home = await mkdtemp(join(tmpdir(), "sr-speech-parity-"));
const report = {
  passed: false,
  scope: actualInference
    ? "Declared scratch readiness with actual native inference from existing read-only prepared files; actual public source processing, queries, explicit cuts, restart and generation fencing"
    : "Declared model readiness and retained ASR responses; actual native admission/audio and public CLI/MCP ingestion, queries, edits and restart",
  actualModelParity: actualInference
    ? "pending: current native inference must match complete retained selected-source records excluding measured result.processingTime and validated additive whole-support ownership/candidate fields; every original lexical/token/source operand remains exact; actual Models-owner readiness/preparation is not tested"
    : "not exercised: declared readiness and frozen ASR cannot certify current native inference; recreated container bytes and current decoder differ from historical inputs",
  listening: "not performed; no quality verdict changed",
  trace: [],
  exchanges: [],
  checks: {},
  baseline: { manifestSha256: hash(await readFile(join(reference, "manifest.json"))), engine },
};
const configFile = join(out, "fixture.json");
const service = new JourneyService(
  home,
  report,
  configFile,
  new URL("./transcript-fixture-service.mjs", import.meta.url),
);
const call = service.call.bind(service);
try {
  report.runtimeResolution = [];
  for (const [from, specifier, expected] of [
    ["apps/service/dist/project-service.js", "@yap/core/models", "packages/core/dist/models.js"],
    [
      "apps/service/dist/project-service.js",
      "@yap/core/transcript-processing",
      "packages/core/dist/transcript-processing.js",
    ],
    ["apps/service/dist/project-service.js", "@yap/protocol", "packages/protocol/dist/index.js"],
    [
      "packages/core/dist/transcript-processing.js",
      "@yap/composition",
      "packages/composition/dist/index.js",
    ],
    ["apps/cli/dist/main.js", "@yap/client", "packages/client/dist/index.js"],
    ["apps/cli/dist/main.js", "@yap/protocol", "packages/protocol/dist/index.js"],
    ["packages/client/dist/index.js", "@yap/protocol", "packages/protocol/dist/index.js"],
  ]) {
    const resolved = await realpath(createRequire(join(root, from)).resolve(specifier));
    assert.equal(
      resolved,
      await realpath(join(root, expected)),
      "Owned runtime must resolve to this worktree",
    );
    report.runtimeResolution.push({
      from,
      specifier,
      resolved,
      sha256: hash(await readFile(resolved)),
    });
  }
  const narration = join(root, "fixtures/narrated-workbench/narration.mov");
  const originalHash = hash(await readFile(narration));
  assert.equal(originalHash, baseline.sourceSha256);
  if (actualInference) {
    report.existingModelsBefore = await existingSpeechModelSnapshot(
      existingModels.directory,
      existingModels.files,
    );
    assert.equal(report.existingModelsBefore.receipt.contents.modelDigest, engine.modelDigest);
    const archive = join(root, "specs/done/agent-editing/assets/12b-public-parity/media.tar.xz");
    report.fixtureArchiveSha256 = hash(await readFile(archive));
    await run("tar", ["-xJf", archive, "-C", out, "first.mov"]);
  } else {
    await run("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-i",
      narration,
      "-map",
      "0:a:0",
      "-c:a",
      "pcm_f32le",
      join(out, "narration.wav"),
    ]);
    await run("swiftc", [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/selected-audio-fixture.swift"),
      "-o",
      join(out, "fixture"),
    ]);
    await run(join(out, "fixture"), [join(out, "narration.wav"), out]);
  }
  const source = join(out, "first.mov");
  const rawFile = join(frozen, "first-physical-selected.jsonl");
  const raw = await readFile(rawFile);
  const receiptFile = join(frozen, "first-physical-selected-response.json");
  const receipt = (await json(receiptFile)).data;
  assert.equal(hash(raw), receipt.output.sha256);
  const words = raw
    .toString("utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .flatMap((line) => line.words);
  const definition = {
    sha256: hash(await readFile(source)),
    streamId: "track:1",
    sourceOffsetUs: -250000,
    available: receipt.segments.map((segment) => segment.source),
    rawFile,
    rawSha256: hash(raw),
    receiptFile,
    receiptSha256: hash(await readFile(receiptFile)),
  };
  if (actualInference) {
    const retainedFixture = await json(
      join(root, "specs/done/agent-editing/assets/12b-public-parity/fixture.json"),
    );
    assert.equal(definition.sha256, retainedFixture.sources[0].sha256);
  }
  const config = {
    ...(actualInference ? { existingModels, rawOutputsDirectory: out } : {}),
    sources: [definition],
    engine,
    observationsFile: join(out, "native-requests.json"),
  };
  await save(
    "fixture.json",
    actualInference ? config : { ...config, modelState: { state: "absent" } },
  );
  await service.start();
  const importing = await call("asset.import", { requestId: "retained-speech", path: source });
  await poll(
    () => call("job.get", { jobId: importing.jobId }),
    (value) => value.state === "ready",
    "source admission",
  );
  const asset = await call("asset.get", { assetId: definition.sha256 });
  assert.equal(asset.id, definition.sha256);
  assert.equal(asset.originUs, 250000);
  const selection = { assetId: asset.id, streamId: "track:1" };
  report.readiness = [];
  for (const state of actualInference
    ? []
    : [
        { state: "absent" },
        { state: "preparing", receivedBytes: 0, totalBytes: 1 },
        {
          state: "failed",
          code: "fixture",
          message: "Declared preparation failure",
          retryable: true,
        },
      ]) {
    await service.stop();
    await save("fixture.json", { ...config, modelState: state });
    await service.start();
    for (const transport of ["cli", "mcp"]) {
      // The fixture declares the stored model status; the public edge reports it as WorkState.
      assert.partialDeepStrictEqual(
        await call("model.status", { modelId: "parakeet" }, { transport }),
        {
          ...state,
          state: modelWorkState[state.state],
        },
      );
      const unavailable = await call("transcript.get", selection, { transport });
      assert.equal(unavailable.state, "unavailable");
      assert.equal(unavailable.reason, "model_not_prepared");
      assert.equal(unavailable.jobId, null);
      report.readiness.push({ transport, state, unavailable });
    }
    assert.equal(
      await readFile(config.observationsFile).then(
        () => true,
        (error) => {
          assert.equal(error.code, "ENOENT");
          return false;
        },
      ),
      false,
    );
  }
  if (!actualInference) {
    await service.stop();
    await save("fixture.json", config);
    await service.start();
  } else {
    for (const transport of ["cli", "mcp"]) {
      const state = await call("model.status", { modelId: "parakeet" }, { transport });
      assert.partialDeepStrictEqual(state, { state: "ready", presence: "ready" });
      report.readiness.push({
        transport,
        state,
        scope: "Declared scratch readiness; not actual Models-owner status",
      });
    }
  }
  await call("transcript.transcribe", selection);
  const full = await poll(
    () => call("transcript.get", { ...selection, limit: 1000 }),
    (value) => value.state === "ready",
    "retained ASR ingestion",
  );
  assert.deepEqual(
    await call("transcript.get", { ...selection, limit: 1000 }, { transport: "mcp" }),
    full,
  );
  assert.deepEqual(full.page.transcript.engine, {
    ...engine,
    policy: transcriptPolicy,
    kindPolicy: wordKindPolicy,
  });
  const actualRaw = actualInference
    ? await readFile(join(out, "native-1.jsonl"))
    : portHistoricalSpeechRaw(raw, {
        execution: speechExecution(),
        available: receipt.segments.map((segment) => segment.source),
      }).body;
  if (actualInference)
    assert.deepEqual(historicalWholeSupportRecords(actualRaw), historicalWholeSupportRecords(raw));
  assert.deepEqual(full.page.transcript.raw, { bytes: actualRaw.length, sha256: hash(actualRaw) });
  assert.deepEqual(
    full.page.rows
      .filter((row) => row.type === "word")
      .map((row) => ({
        text: row.text,
        source: row.sourceRange,
        confidence: row.confidence,
        kind: row.kind,
      })),
    words.map((word) => ({
      text: word.text,
      source: word.source,
      confidence: word.confidence,
      kind: "speech",
    })),
  );
  const retainedRaw = join(
    home,
    "library/transcripts/assets",
    asset.id,
    full.generation,
    "raw.jsonl",
  );
  assert.deepEqual(await readFile(retainedRaw), actualRaw);
  const made = await call("project.create", {
    requestId: "explicit-speech-fixture",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 1, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = made.project.projectId;
  const placed = await call(
    "edit.apply",
    {
      projectId,
      requestId: "repeat-fixture",
      expectedRevisionId: made.revision.id,
      operations: [
        { operation: "track.add", label: "speech", track: { kind: "audio", order: 0 } },
        ...[0, 8000000].map((atUs, i) => ({
          operation: "place",
          label: `clip${i}`,
          clip: {
            trackId: { label: "speech" },
            ...selection,
            source: { kind: "range", range: { startUs: 0, endUs: 6000000 } },
            placement: { kind: "project", range: { startUs: atUs, endUs: atUs + 6000000 } },
          },
        })),
      ],
    },
    { transport: "mcp" },
  );
  const query = { projectId, revisionId: placed.revision.id };
  const projected = await poll(
    () => call("transcript.get", { ...query, limit: 1000 }),
    (value) => value.state === "ready",
    "repeated occurrences",
  );
  const projectedWords = projected.page.rows.filter((row) => row.type === "word");
  const firstWords = words.filter((word) => word.source.endUs <= 6000000);
  assert.deepEqual(
    projectedWords.map((row) => row.text),
    [...firstWords, ...firstWords].map((word) => word.text),
  );
  for (const transport of ["cli", "mcp"]) {
    const matches = await poll(
      () => call("transcript.search", { ...query, text: "Okay so", limit: 500 }, { transport }),
      (value) => value.state === "ready",
      "repeated phrase search",
    );
    assert.equal(matches.page.entries.length, 2);
    assert.deepEqual(
      matches.page.entries.map((entry) => entry.words[0].clipId).sort(),
      Object.values(placed.edit.labels)
        .filter((id) => id !== placed.edit.labels.speech)
        .sort(),
    );
  }
  const audio = async (revisionId, name) => {
    const params = { projectId, revisionId, range: { startUs: 0, endUs: 14000000 } };
    await poll(
      () => call("audio.get", params),
      (value) => value.state === "ready",
      name,
    );
    const file = join(out, name + ".wav");
    await call("audio.get", params, { output: file });
    const info = readAudioWaveFile(file);
    assert.equal(info.sampleRate, 48000);
    assert.equal(info.channels, 2);
    assert.equal(info.frames, 672000, "The complete requested 14 seconds must be delivered");
    const bytes = await readFile(file);
    return bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  };
  const before = await audio(query.revisionId, "original-fixture");
  // The fixture requests this exact interval; the engine must not choose another occurrence.
  const cut = { startUs: 1120000, endUs: 1440000 };
  const removed = await call("edit.apply", {
    projectId,
    requestId: "explicit-one-occurrence-cut",
    expectedRevisionId: query.revisionId,
    operations: [
      {
        operation: "remove",
        clipIds: [placed.edit.labels.clip0],
        ranges: [cut],
        ripple: "none",
        scope: "selected",
      },
    ],
  });
  const after = await audio(removed.revision.id, "explicit-cut");
  const expectedPCM = Buffer.from(before);
  expectedPCM.fill(0, ((cut.startUs * 48000) / 1000000) * 8, ((cut.endUs * 48000) / 1000000) * 8);
  assert.deepEqual(after, expectedPCM, "Only the exact supplied interval may change");
  assert.notDeepEqual(after, before, "Control cut must alter audible source samples");
  const remaining = await poll(
    () =>
      call("transcript.search", {
        projectId,
        revisionId: removed.revision.id,
        text: "Okay so",
        limit: 500,
      }),
    (value) => value.state === "ready",
    "remaining phrase occurrence",
  );
  assert.equal(remaining.page.entries.length, 1);
  assert.equal(remaining.page.entries[0].words[0].clipId, placed.edit.labels.clip1);
  await service.stop();
  await service.start();
  assert.deepEqual(await audio(query.revisionId, "historical-restart"), before);
  assert.deepEqual(await readFile(retainedRaw), actualRaw);
  const undone = await call(
    "edit.undo",
    { projectId, requestId: "undo-explicit-cut", expectedRevisionId: removed.revision.id },
    { transport: "mcp" },
  );
  assert.deepEqual(undone.document, placed.revision.document);
  assert.deepEqual(await audio(undone.id, "undo-fixture"), before);
  report.checks.explicitCutProtectedPCMAndUndo = {
    cut,
    beforeSha256: hash(before),
    afterSha256: hash(after),
  };
  report.initialNativeRequests = await json(config.observationsFile);
  report.generation = await changedTranscriptGeneration({
    service,
    query,
    text: "Okay so",
    poll,
    actualInference,
  });
  assert.deepEqual(await readFile(retainedRaw), actualRaw);
  assert.equal(hash(await readFile(narration)), originalHash);
  report.nativeRequests = await json(config.observationsFile);
  if (actualInference) {
    assert.equal(
      report.nativeRequests.calls.length,
      2,
      "Exactly initial and replacement actual speech calls",
    );
    const replacementRaw = await readFile(join(out, "native-2.jsonl"));
    assert.deepEqual(
      historicalWholeSupportRecords(replacementRaw),
      historicalWholeSupportRecords(raw),
    );
    report.actualModelParity =
      "Complete current native raw records match retained selected-source reference excluding measured result.processingTime and validated additive whole-support ownership/candidate fields; every original lexical/token/source operand remains exact; scratch readiness declared; actual Models-owner preparation/readiness not exercised";
  }
  report.checks.rawAndSourcePreserved = true;
  report.runtime = Object.fromEntries(
    await Promise.all(
      [
        "packages/core/dist/transcript-processing.js",
        "packages/core/dist/transcript.js",
        "apps/service/dist/project-service.js",
        "apps/cli/dist/main.js",
        "packages/test-harness/editing/speech-parity.mjs",
        "packages/test-harness/editing/evidence-service.mjs",
        "packages/test-harness/editing/transcript-fixture-service.mjs",
        "packages/test-harness/editing/existing-speech-model.mjs",
        "packages/test-harness/editing/speech-parity-records.mjs",
        "packages/test-harness/editing/generation-transcript-service.mjs",
      ].map(async (path) => [path, hash(await readFile(join(root, path)))]),
    ),
  );
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await service.stop().catch((error) => {
    report.shutdownError = error.message;
    report.passed = false;
    process.exitCode = 1;
  });
  if (actualInference && report.existingModelsBefore) {
    try {
      report.existingModelsAfter = await existingSpeechModelSnapshot(
        existingModels.directory,
        existingModels.files,
      );
      assert.deepEqual(report.existingModelsAfter, report.existingModelsBefore);
    } catch (error) {
      report.modelPreservationError = { message: error.message, stack: error.stack };
      report.passed = false;
      process.exitCode = 1;
    }
  }
  await save("report.json", report);
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ out, passed: report.passed, error: report.error?.message }));
