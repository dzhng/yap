import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { parakeetModel } from "../../../packages/core/dist/models.js";
import { JourneyService, copyModels, hash, poll, root } from "./source-evidence-fixture.mjs";
import { repairJoinAndRecheck } from "../../../skills/yap/scripts/join-repair.mjs";
import { discoverContextualRepair } from "./contextual-join-replay.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    native: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help) {
  console.log(
    "Usage: YAP_NATIVE=<worker> node contextual-join-fixture.mjs --out EMPTY_DIRECTORY --model PREPARED_PARAKEET_DIRECTORY --native FROZEN_WORKER\nExercises clipped, intact, repaired and intentional-jump audio revisions in an isolated service home. It prepares fresh rendered Parakeet recognition, checks exact prepared sample support and runs read-only join.verify. No personal library or source mutation.",
  );
  process.exit(0);
}

for (const key of ["out", "model", "native"]) assert(values[key], `Missing --${key}`);
process.env.YAP_NATIVE = resolve(values.native);

const out = resolve(values.out);
await mkdir(out, { recursive: true });
const home = await realpath(await mkdtemp(join(out, "home-")));
await mkdir(join(home, "library"), { recursive: true });
await chmod(home, 0o700);
await chmod(join(home, "library"), 0o700);
const report = {
  passed: false,
  scope:
    "slice 12C/12D real audio revisions: clipped, intact, repaired and intentional jump; fresh Parakeet rendered recognition and read-only contextual join evidence",
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  modelManifest: {
    id: parakeetModel.name,
    revision: parakeetModel.revision,
    files: parakeetModel.files,
  },
  fixtures: {},
  trace: [],
};

function wav32(floatBytes, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(floatBytes.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(floatBytes.length, 40);
  return Buffer.concat([header, floatBytes]);
}

const inputDir = join(root, "specs/done/video-editing-feedback/assets/09-local-alignment/inputs");
const intactPCM = gunzipSync(await readFile(join(inputDir, "fortunate-intact.f32.gz")));
const intactDurationUs = (intactPCM.length / 4) * (1_000_000 / 16_000);
const cutUs = Math.round((6262 / 16_000) * 1_000_000);
const secondStartUs = 560_000;
const secondDurationUs = intactDurationUs - secondStartUs;

const service = new JourneyService(home, report);
const call = service.call.bind(service);

async function importFixture() {
  const path = join(out, "fortunate-intact.wav");
  await writeFile(path, wav32(intactPCM));
  const pending = await call("asset.import", { requestId: "fortunate-intact", path });
  const imported = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (value) => value.state === "ready",
    "fixture import",
  );
  const asset = await call("asset.get", { assetId: imported.published.output.assetId });
  const stream = asset.streams.find((value) => value.kind === "audio");
  assert(stream, "fixture must contain an audio stream");
  return { asset, stream };
}

async function makeProject(fixture, name, clips) {
  const created = await call("project.create", {
    requestId: `${name}-create`,
    title: `Contextual join ${name}`,
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const tracked = await call("edit.apply", {
    projectId: created.project.projectId,
    expectedRevisionId: created.revision.id,
    requestId: `${name}-track`,
    operations: [{ operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } }],
  });
  const placed = await call("edit.apply", {
    projectId: created.project.projectId,
    expectedRevisionId: tracked.revision.id,
    requestId: `${name}-place`,
    operations: clips.map((clip, index) => ({
      operation: "place",
      label: `${name}-clip-${index}`,
      clip: {
        trackId: tracked.revision.document.tracks[0].id,
        assetId: fixture.asset.id,
        streamId: fixture.stream.id,
        source: { kind: "range", range: clip.source },
        placement: { kind: "project", range: clip.project },
      },
    })),
  });
  const track = placed.revision.document.tracks.find((value) => value.kind === "audio");
  assert(track, "audio track must be authored");
  return {
    projectId: created.project.projectId,
    revisionId: placed.revision.id,
    trackId: track.id,
    clipIds: placed.revision.document.clips.map((value) => value.id),
  };
}

async function prepareAndVerify(
  name,
  project,
  range,
  boundaryAtUs,
  expectedBoundary,
  { allowRenderedFailure = false } = {},
) {
  const tap = { target: { kind: "output" }, point: { kind: "processed" } };
  const selectionProject = { projectId: project.projectId, revisionId: project.revisionId };
  const selection = {
    ...selectionProject,
    range,
    tap,
    rendition: { sampleRate: 16000, channels: 1 },
  };
  const prepared = await poll(
    () => call("audio.prepare", { ...selectionProject, tap }),
    (value) => value.state === "ready",
    `${name} audio preparation`,
  );
  const audio = prepared.published.output;
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channels, 2);
  assert.equal(audio.frames, Math.round((range.endUs * 48000) / 1_000_000));
  let rendered;
  for (;;) {
    rendered = await call("transcript.render.prepare", selection);
    if (rendered.state === "ready") break;
    if (allowRenderedFailure && rendered.state === "failed") break;
    assert.notEqual(
      rendered.state,
      "failed",
      `${name} rendered recognition: ${JSON.stringify(rendered)}`,
    );
    assert.notEqual(rendered.state, "canceled", `${name} rendered recognition was canceled`);
    await delay(100);
  }
  const speech = rendered.state === "ready" ? rendered.published.output : null;
  if (speech) assert.equal(speech.kind, "rendered-speech");
  const reportData = await call("join.verify", {
    ...selectionProject,
    preparedResourceId: audio.resourceId,
    tap,
    boundary: { trackId: project.trackId, projectAtUs: boundaryAtUs },
    context: { beforeUs: 250000, afterUs: 250000 },
    expectedText: "fortunate",
    thresholdRMS: 0.01,
    ...(speech ? { renderedSpeechGeneration: speech.generation } : {}),
    candidateOffsetsUs: [-100000, 100000],
  });
  assert.equal(reportData.phoneticCompleteness, "unknown");
  assert.equal(reportData.rendered.recognition.state, speech ? "observed" : "missing");
  assert.equal(reportData.audio.dimensions.sampleRate, 48000);
  assert.equal(reportData.audio.dimensions.channels, 2);
  assert.equal(reportData.audio.dimensions.frames, audio.frames);
  assert.deepEqual(reportData.rendered.prepared.sampleRange, audio.sampleRange);
  if (expectedBoundary === "jump") {
    assert.equal(reportData.boundary.before.kind, "range");
    assert.equal(reportData.boundary.after.kind, "range");
    assert.notEqual(reportData.boundary.before.sourceAtUs, reportData.boundary.after.sourceAtUs);
  }
  const evidenceSummary = (value) =>
    value.state === "observed"
      ? {
          state: value.state,
          requestedRange: value.requestedRange,
          coverage: value.coverage,
          metadata: value.metadata
            ? {
                generation: value.metadata.generation,
                source: value.metadata.source,
              }
            : undefined,
          wordCount: value.words?.length ?? value.rows?.filter((row) => row.type === "word").length,
          acousticCount: value.acoustic?.length,
          phoneticCompleteness: value.phoneticCompleteness,
        }
      : { state: value.state, requestedRange: value.requestedRange };
  const joinSummary = {
    projectId: reportData.projectId,
    revisionId: reportData.revisionId,
    preparedResourceId: reportData.preparedResourceId,
    boundary: reportData.boundary,
    context: reportData.context,
    projectRange: reportData.projectRange,
    expectedText: reportData.expectedText,
    thresholdRMS: reportData.thresholdRMS,
    source: {
      before: evidenceSummary(reportData.source.before),
      after: evidenceSummary(reportData.source.after),
    },
    rendered: {
      alignment: evidenceSummary(reportData.rendered.alignment),
      recognition:
        reportData.rendered.recognition.state === "observed"
          ? {
              state: "observed",
              requestedRange: reportData.rendered.recognition.requestedRange,
              coverage: reportData.rendered.recognition.coverage,
              generation: reportData.rendered.recognition.generation,
              textComparison: reportData.rendered.recognition.textComparison,
              wordCount: reportData.rendered.recognition.rows.filter((row) => row.type === "word")
                .length,
              completePage: reportData.rendered.recognition.completePage,
              phoneticCompleteness: reportData.rendered.recognition.phoneticCompleteness,
            }
          : { state: "missing", requestedRange: reportData.rendered.recognition.requestedRange },
    },
    audio: {
      dimensions: reportData.audio.dimensions,
      sampleRange: reportData.rendered.prepared.sampleRange,
      waveformBuckets: reportData.audio.waveform.buckets.length,
      spectrumColumns: reportData.audio.spectrum.columns.length,
      discontinuity: reportData.audio.discontinuity,
    },
    candidates: reportData.candidates,
    phoneticCompleteness: reportData.phoneticCompleteness,
  };
  return {
    range,
    boundaryAtUs,
    prepared: {
      resourceId: audio.resourceId,
      frames: audio.frames,
      sampleRange: audio.sampleRange,
      sha256: audio.sha256,
    },
    rendered: {
      state: rendered.state,
      ...(speech
        ? {
            generation: speech.generation,
            frames: speech.pcm.frames,
            sampleRange: speech.pcm.sampleRange,
            transcript: {
              generation: speech.transcript.generation,
              wordCount: speech.transcript.wordCount,
              segmentCount: speech.transcript.segmentCount,
            },
          }
        : { reason: rendered.reason }),
    },
    join: joinSummary,
  };
}

try {
  await copyModels(home, { directory: resolve(values.model), files: parakeetModel.files });
  await service.start();
  assert.deepEqual(await call("model.status", { modelId: "parakeet" }), {
    modelId: "parakeet",
    purpose: "transcription",
    state: "ready",
    presence: "ready",
    jobId: null,
  });
  const fixture = await importFixture();
  const full = { startUs: 0, endUs: intactDurationUs };
  const clipped = { startUs: 0, endUs: cutUs };
  const repairedProject = await makeProject(fixture, "repaired", [
    { source: clipped, project: clipped },
  ]);
  // This is the caller-authored repair: replace the clipped source range with
  // the intact range, then inspect the advanced revision through the public
  // consumer helper. The helper still makes no editorial decision.
  const repair = await repairJoinAndRecheck(
    {
      projectId: repairedProject.projectId,
      revisionId: repairedProject.revisionId,
      repair: {
        requestId: "repaired-replace-cut",
        operations: [
          { operation: "remove", clipIds: repairedProject.clipIds, ripple: "none" },
          {
            operation: "place",
            clip: {
              trackId: repairedProject.trackId,
              assetId: fixture.asset.id,
              streamId: fixture.stream.id,
              source: { kind: "range", range: full },
              placement: { kind: "project", range: full },
            },
          },
        ],
      },
      recheck: {
        preparedResourceId: "unused-before-preparation",
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
        prepare: { tap: { target: { kind: "output" }, point: { kind: "processed" } } },
        boundary: { trackId: repairedProject.trackId, projectAtUs: intactDurationUs },
        context: { beforeUs: 250000, afterUs: 250000 },
        expectedText: "fortunate",
        thresholdRMS: 0.01,
      },
    },
    (operation, params) => call(operation, params),
  );
  assert.equal(repair.afterRevisionId !== repairedProject.revisionId, true);
  report.repairHelper = {
    beforeRevisionId: repair.beforeRevisionId,
    afterRevisionId: repair.afterRevisionId,
    recheck: {
      revisionId: repair.recheck.revisionId,
      phoneticCompleteness: repair.recheck.phoneticCompleteness,
      renderedRecognition: repair.recheck.rendered?.recognition?.state,
    },
  };
  const repairedRevision = repair.afterRevisionId;
  const intactProject = await makeProject(fixture, "intact", [{ source: full, project: full }]);
  const clippedProject = await makeProject(fixture, "clipped", [
    { source: clipped, project: clipped },
  ]);
  const jumpProject = await makeProject(fixture, "intentional-jump", [
    { source: clipped, project: clipped },
    {
      source: { startUs: secondStartUs, endUs: intactDurationUs },
      project: { startUs: cutUs, endUs: cutUs + secondDurationUs },
    },
  ]);
  const repairedSelection = { ...repairedProject, revisionId: repairedRevision };
  report.fixtures.intact = await prepareAndVerify(
    "intact",
    intactProject,
    full,
    intactDurationUs,
    "end",
  );
  report.fixtures.clipped = await prepareAndVerify(
    "clipped",
    clippedProject,
    clipped,
    cutUs,
    "cut",
  );
  report.fixtures.repaired = await prepareAndVerify(
    "repaired",
    repairedSelection,
    full,
    intactDurationUs,
    "end",
  );
  report.fixtures.intentionalJump = await prepareAndVerify(
    "intentional-jump",
    jumpProject,
    { startUs: 0, endUs: cutUs + secondDurationUs },
    cutUs,
    "jump",
    { allowRenderedFailure: true },
  );

  // A fresh consumer pass reads only the public receipts above, identifies the
  // clipped Parakeet edge, authors one bounded replacement and rechecks the new
  // revision. The product still makes no repair decision.
  const discovery = discoverContextualRepair(report);
  assert.equal(discovery.caseName, "clipped");
  const freshRepair = await repairJoinAndRecheck(
    {
      projectId: clippedProject.projectId,
      revisionId: clippedProject.revisionId,
      repair: {
        requestId: "fresh-agent-replace-clipped-edge",
        operations: [
          { operation: "remove", clipIds: [discovery.clipId], ripple: "none" },
          {
            operation: "place",
            clip: {
              trackId: discovery.trackId,
              assetId: discovery.assetId,
              streamId: discovery.streamId,
              source: { kind: "range", range: discovery.sourceRange },
              placement: { kind: "project", range: discovery.projectRange },
            },
          },
        ],
      },
      recheck: {
        preparedResourceId: "unused-before-preparation",
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
        prepare: { tap: { target: { kind: "output" }, point: { kind: "processed" } } },
        boundary: { trackId: discovery.trackId, projectAtUs: discovery.projectRange.endUs },
        context: { beforeUs: 250000, afterUs: 250000 },
        expectedText: discovery.expectedText,
        thresholdRMS: 0.01,
        candidateOffsetsUs: [-100000, 100000],
      },
    },
    (operation, params) => call(operation, params),
  );
  const freshRevision = freshRepair.afterRevisionId;
  const freshOutput = await prepareAndVerify(
    "fresh-agent-repaired",
    { ...clippedProject, revisionId: freshRevision },
    full,
    intactDurationUs,
    "end",
  );
  report.freshAgentReplay = {
    discovery,
    repair: {
      beforeRevisionId: freshRepair.beforeRevisionId,
      afterRevisionId: freshRepair.afterRevisionId,
      recheckRevisionId: freshRepair.recheck.revisionId,
      recheckRecognition: freshRepair.recheck.rendered?.recognition?.state,
    },
    changedOutput: {
      prepared: freshOutput.prepared,
      rendered: freshOutput.rendered,
      join: freshOutput.join,
    },
  };
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
}

console.log(JSON.stringify({ status: report.passed ? "passed" : "failed", out }, null, 2));
