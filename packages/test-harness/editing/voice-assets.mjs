import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
import { readAudioWaveFile } from "../../core/dist/audio-wave.js";

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    out: { type: "string" },
    home: { type: "string" },
    resume: { type: "string" },
  },
});
assert.equal(values.case, "pronunciation-replacement");
assert(
  values.out && values.home && process.env.YAP_NATIVE,
  "Use an already prepared, released isolated home; this journey never prepares or copies models",
);
const out = resolve(values.out),
  home = await realpath(values.home);
await mkdir(out);
const prior = values.resume ? JSON.parse(await readFile(resolve(values.resume))) : null;
if (prior) assert.equal(await realpath(prior.home), home);
const report = {
  passed: false,
  home,
  trace: [],
  attempts: [],
  receipts: [],
  checks: {},
  prerequisiteRun: values.resume ? resolve(values.resume) : null,
  scope:
    "Real public durable voice jobs and rendered replacement mechanics; no playback/listening acceptance",
};
const service = new JourneyService(home, report, join(out, "native"));
async function call(operation, params, options) {
  const result = await service.call(operation, params, options);
  report.attempts.push({ operation, params, options, result });
  return result;
}
async function settled(jobId) {
  const deadline = performance.now() + 620000;
  for (;;) {
    const result = await call("job.get", { jobId });
    if (["ready", "failed", "canceled", "unavailable"].includes(result.state)) return result;
    assert(performance.now() < deadline, "Bounded voice job deadline");
    await delay(1000);
  }
}
async function generate(request) {
  const requested = await call("voice.generate", request);
  const job = await settled(requested.jobId);
  assert.equal(job.state, "ready", JSON.stringify(job));
  const ready = await call("voice.generate", request);
  assert.deepEqual(await call("voice.generate", request, { transport: "mcp" }), ready);
  report.receipts.push(ready);
  return ready.published.output;
}
async function imported(path, requestId) {
  const pending = await call("asset.import", { path, requestId });
  const job = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  return call("asset.get", { assetId: job.published.output.assetId });
}
async function assetBytes(assetId, leaf) {
  const asset = await call("asset.get", { assetId });
  const bytes = await readFile(join(service.home, "library/assets", asset.fileName));
  assert.equal(hash(bytes), assetId);
  await writeFile(join(out, leaf), bytes);
  return bytes;
}
async function project(name, operations) {
  const made = await call("project.create", {
    requestId: name,
    canvas: {
      width: 64,
      height: 64,
      fps: { numerator: 30, denominator: 1 },
      background: "#203040ff",
    },
  });
  const changed = await call("edit.apply", {
    projectId: made.project.projectId,
    expectedRevisionId: made.revision.revisionId,
    requestId: `${name}-place`,
    operations,
  });
  return {
    projectId: made.project.projectId,
    revision: changed.revision,
    labels: changed.edit.labels,
  };
}
const placed = (asset, track, startUs, endUs, sourceStartUs = 0, label) => ({
  operation: "place",
  ...(label ? { label } : {}),
  clip: {
    trackId: { label: track },
    assetId: asset.assetId,
    streamId: asset.streams[0].streamId,
    source: {
      kind: "range",
      range: { startUs: sourceStartUs, endUs: sourceStartUs + endUs - startUs },
    },
    placement: { kind: "project", range: { startUs, endUs } },
    pitch: "preserve",
  },
});
async function artifact(operation, request, leaf) {
  await poll(
    () => call(operation, request),
    (v) => v.state === "ready",
    operation,
  );
  await call(operation, request, { output: join(out, leaf) });
  return readFile(join(out, leaf));
}
let hiddenModel, modelDirectory;
try {
  if (prior) {
    modelDirectory = join(home, "library/models", prior.receipts[0].modelId);
    hiddenModel = `${modelDirectory}.19f-unavailable-${randomUUID()}`;
    await rename(modelDirectory, hiddenModel);
  }
  await service.start();
  const registry = await call("model.list", {});
  report.registry = registry;
  const entries = Array.isArray(registry) ? registry : registry.models;
  const registered = entries.find((m) => m.generationProfile);
  assert(registered, "Measured generation profile must be registered");
  const cases = JSON.parse(
    await readFile(join(root, "packages/test-harness/editing/voice/cases.json")),
  );
  const frozen = join(root, "specs/done/agent-editing/assets/18-voice");
  const reference = await imported(
    join(frozen, "reference.wav"),
    `voice-reference-${randomUUID()}`,
  );
  const extracted = await poll(
    () =>
      call("audio.extract", {
        assetId: reference.assetId,
        streamId: reference.streams[0].streamId,
        rendition: { sampleRate: 24000, channels: 1 },
      }),
    (v) => v.state === "ready",
    "canonical reference",
  );
  const excerpt = extracted.published.output;
  assert.equal(excerpt.assetId, reference.assetId);
  const donor = await project(`voice-donor-${randomUUID()}`, [
    { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
    placed(reference, "audio", 0, 5000000),
  ]);
  await call("project.delete", { projectId: donor.projectId });
  const base = {
    modelId: registered.modelId,
    reference: { assetId: excerpt.assetId, streamId: excerpt.streamId, origin: excerpt.origin },
    referenceText: cases.reference.text,
    generation: cases.generation,
    seed: String(cases.seed),
  };
  const integerReference = join(out, "integer-reference.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-i",
    join(frozen, "reference.wav"),
    "-c:a",
    "pcm_s16le",
    integerReference,
  ]);
  const integer = await imported(integerReference, `integer-reference-${randomUUID()}`);
  const refusedInteger = await call(
    "voice.generate",
    {
      ...base,
      reference: { assetId: integer.assetId, streamId: integer.streams[0].streamId },
      text: "Integer input must be explicitly converted.",
    },
    { error: true },
  );
  assert.equal(refusedInteger.code, "INVALID_REFERENCE");
  report.checks.integerReferenceActionableRefusal = true;
  const wordRequest = { ...base, text: cases.replacements.find((r) => r.id === "word").text };
  const word = await generate(wordRequest);
  assert.deepEqual(
    await assetBytes(word.assetId, "word.wav"),
    await readFile(join(frozen, "same-take-word.wav")),
  );
  report.checks.fullFrozenWordParity = true;

  const phraseRequest = { ...base, text: cases.replacements.find((r) => r.id === "phrase").text };
  let phrase;
  if (prior) {
    for (const check of [
      "fullFrozenWordParity",
      "cancelFenceRetryAndFullFrozenPhraseParity",
      "crashFenceAndSupportedOverride",
      "incompleteSpeechNotPublished",
    ])
      assert.equal(prior.checks[check], true, `Resume requires recorded ${check}`);
    report.checks = { ...prior.checks, ...report.checks };
    phrase = await generate(phraseRequest);
    assert.deepEqual(
      await assetBytes(phrase.assetId, "phrase.wav"),
      await readFile(join(frozen, "same-take-phrase.wav")),
    );
  } else {
    const beforeCancel = await call("asset.list", {});
    const cancelHit = await service.arm("media.probe");
    const cancellation = await call("voice.generate", phraseRequest);
    await cancelHit();
    const canceled = await call("job.cancel", { jobId: cancellation.jobId });
    assert.equal(canceled.state, "canceled");
    assert.equal(canceled.published, null);
    assert.deepEqual(await call("asset.list", {}), beforeCancel);
    await call("job.retry", { jobId: cancellation.jobId });
    phrase = await generate(phraseRequest);
    assert.deepEqual(
      await assetBytes(phrase.assetId, "phrase.wav"),
      await readFile(join(frozen, "same-take-phrase.wav")),
    );
    report.checks.cancelFenceRetryAndFullFrozenPhraseParity = true;

    const changedRequest = {
      ...phraseRequest,
      seed: "19",
      generation: { ...cases.generation, top_p: 0 },
    };
    const beforeCrash = await call("asset.list", {});
    const crashHit = await service.arm("media.probe");
    const crashing = await call("voice.generate", changedRequest);
    await crashHit();
    await service.stop(true);
    await service.start();
    const recovered = await call("job.get", { jobId: crashing.jobId });
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.published, null);
    assert.deepEqual(await call("asset.list", {}), beforeCrash);
    await call("job.retry", { jobId: crashing.jobId });
    const changed = await generate(changedRequest);
    assert.equal(changed.origin.receipt.seed, "19");
    assert.equal(changed.origin.receipt.generation.top_p, 0);
    assert.equal(changed.origin.receipt.filterModes.nucleus, "disabled");
    await assetBytes(changed.assetId, "changed-settings.wav");
    report.checks.crashFenceAndSupportedOverride = true;

    const beforeFailure = await call("asset.list", {});
    const incomplete = await call("voice.generate", {
      ...phraseRequest,
      generation: { ...cases.generation, max_tokens: 1 },
    });
    const refused = await settled(incomplete.jobId);
    assert.equal(refused.state, "failed");
    assert.equal(refused.errorCode, "VOICE_INCOMPLETE");
    assert.equal(refused.published, null);
    assert.deepEqual(await call("asset.list", {}), beforeFailure);
    report.checks.incompleteSpeechNotPublished = true;
  }

  // Existing completed jobs are the oracle when the execution-only prerequisite disappears.
  await service.stop();
  if (!hiddenModel) {
    modelDirectory = join(home, "library/models", registered.modelId);
    hiddenModel = `${modelDirectory}.19f-unavailable-${randomUUID()}`;
    await rename(modelDirectory, hiddenModel);
  }
  await service.start();
  const saved = await generate(phraseRequest);
  assert.equal(saved.assetId, phrase.assetId);
  const unprepared = await call(
    "voice.generate",
    { ...phraseRequest, text: "A different complete sentence." },
    { error: true },
  );
  assert.equal(unprepared.code, "MODEL_NOT_PREPARED");
  await artifact(
    "audio.get",
    { assetId: phrase.assetId, streamId: phrase.streamId },
    "model-free-delivery.wav",
  );
  report.checks.savedReplayWithoutModel = true;

  const replacementAsset = await call("asset.get", { assetId: phrase.assetId });
  const start = 500000,
    end = start + phrase.durationUs;
  assert(end < 4500000, "Bounded frozen phrase must leave full original context");
  const imagePath = join(out, "picture.png");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x64:rate=1",
    "-frames:v",
    "1",
    imagePath,
  ]);
  const image = await imported(imagePath, `voice-picture-${randomUUID()}`);
  const context = await project(`voice-context-${randomUUID()}`, [
    { operation: "track.add", label: "voice", track: { kind: "audio", order: 1 } },
    { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
    { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
    placed(reference, "audio", 0, start + 5000, 0, "prefix"),
    placed(reference, "voice", start, end, start, "middle"),
    placed(reference, "audio", end - 5000, 5000000, end - 5000, "suffix"),
    {
      operation: "place",
      clip: {
        trackId: { label: "video" },
        assetId: image.assetId,
        streamId: image.streams[0].streamId,
        source: { kind: "hold", atUs: 0 },
        placement: { kind: "project", range: { startUs: 0, endUs: 5000000 } },
      },
    },
    {
      operation: "processing.set",
      target: { kind: "clip", id: { label: "middle" } },
      steps: [{ processor: { type: "gain", gain: 0.5 } }],
    },
  ]);
  const transitionRanges = [
    { startUs: start, endUs: start + 5000 },
    { startUs: end - 5000, endUs: end },
  ];
  const authored = await call("edit.apply", {
    projectId: context.projectId,
    expectedRevisionId: context.revision.revisionId,
    requestId: "voice-context-transitions",
    operations: [
      { label: "prefix", range: transitionRanges[0], from: 1, to: 0 },
      { label: "middle", range: transitionRanges[0], from: 0, to: 1 },
      { label: "middle", range: transitionRanges[1], from: 1, to: 0 },
      { label: "suffix", range: transitionRanges[1], from: 0, to: 1 },
    ].map(({ label, range, from, to }) => ({
      operation: "fade",
      target: { kind: "clip", id: context.labels[label] },
      mediaKind: "audio",
      window: { kind: "project", range },
      from,
      to,
    })),
  });
  context.revision = authored.revision;
  const target = { kind: "clip", id: context.labels.middle };
  const oldSelection = { projectId: context.projectId, revisionId: context.revision.revisionId };
  const baseline = await artifact("audio.get", oldSelection, "context-before.wav");
  const picture = await artifact(
    "frame.get",
    { ...oldSelection, atUs: 1000000 },
    "picture-before.png",
  );
  const processing = await call("processing.get", { ...oldSelection, target });
  const replaced = await call("edit.apply", {
    projectId: context.projectId,
    expectedRevisionId: context.revision.revisionId,
    requestId: "voice-replace",
    operations: [
      {
        operation: "replace",
        clipId: context.labels.middle,
        kind: "audio",
        media: {
          assetId: phrase.assetId,
          streamId: phrase.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: phrase.durationUs } },
        },
        fit: "exact",
        processing: "keep",
      },
    ],
  });
  const replacementSelection = {
    projectId: context.projectId,
    revisionId: replaced.revision.revisionId,
  };
  assert.deepEqual(
    (await call("processing.get", { ...replacementSelection, target })).steps,
    processing.steps,
  );
  await artifact("audio.get", replacementSelection, "context-dry.wav");
  assert.deepEqual(
    await artifact("frame.get", { ...replacementSelection, atUs: 1000000 }, "picture-after.png"),
    picture,
  );

  const tone = await imported(
    join(root, "specs/done/agent-editing/assets/18-voice-roomtone/room-tone.wav"),
    `voice-roomtone-${randomUUID()}`,
  );
  const toneDuration = tone.streams[0].endUs - tone.streams[0].startUs;
  const roomOperations = [
    { operation: "track.add", label: "room", track: { kind: "audio", order: 2 } },
  ];
  for (let at = start, index = 0; at < end; index++) {
    const next = Math.min(end, at + toneDuration);
    roomOperations.push(placed(tone, "room", at, next, 0, `room-${index}`));
    at = next;
  }
  const room = await call("edit.apply", {
    projectId: context.projectId,
    expectedRevisionId: replaced.revision.revisionId,
    requestId: "voice-roomtone",
    operations: roomOperations,
  });
  const roomSelection = { projectId: context.projectId, revisionId: room.revision.revisionId };
  const mixed = await artifact("audio.get", roomSelection, "context-room.wav");
  const beforeInfo = readAudioWaveFile(join(out, "context-before.wav")),
    afterInfo = readAudioWaveFile(join(out, "context-room.wav"));
  assert.equal(beforeInfo.frames, afterInfo.frames);
  const frameBytes = beforeInfo.channels * 4;
  const first = Math.floor(((start - 5000) * beforeInfo.sampleRate) / 1000000),
    last = Math.ceil(((end + 5000) * beforeInfo.sampleRate) / 1000000);
  assert.deepEqual(
    mixed.subarray(afterInfo.dataOffset, afterInfo.dataOffset + first * frameBytes),
    baseline.subarray(beforeInfo.dataOffset, beforeInfo.dataOffset + first * frameBytes),
  );
  assert.deepEqual(
    mixed.subarray(
      afterInfo.dataOffset + last * frameBytes,
      afterInfo.dataOffset + afterInfo.dataBytes,
    ),
    baseline.subarray(
      beforeInfo.dataOffset + last * frameBytes,
      beforeInfo.dataOffset + beforeInfo.dataBytes,
    ),
  );
  report.context = {
    projectId: context.projectId,
    baselineRevision: context.revision.revisionId,
    replacementRevision: replaced.revision.revisionId,
    roomRevision: room.revision.revisionId,
    replacementRange: { startUs: start, endUs: end },
    authoredComplementaryCrossfades: transitionRanges,
    transitionUs: 5000,
    roomToneSource: "18-voice-roomtone/room-tone.wav",
    protectedJoinWindowsIncludingResampling: [
      { startUs: start - 5000, endUs: start + 5000 },
      { startUs: end - 5000, endUs: end + 5000 },
    ],
    unchangedOutsideReplacementAndTransitionsExact: true,
    scope:
      "Complementary voice/original fades are authored inside protected join windows; those windows also contain resampling boundary influence. Inherited room-tone pause is not independently auditioned as speech-free; mechanical continuity only",
  };
  const undoRoom = await call("edit.undo", {
    projectId: context.projectId,
    expectedRevisionId: room.revision.revisionId,
    requestId: "undo-room",
  });
  const undoReplacement = await call("edit.undo", {
    projectId: context.projectId,
    expectedRevisionId: undoRoom.revisionId,
    requestId: "undo-replacement",
  });
  assert.deepEqual(
    await artifact(
      "audio.get",
      { projectId: context.projectId, revisionId: undoReplacement.revisionId },
      "context-undo.wav",
    ),
    baseline,
  );
  report.checks.replacementPictureProcessingRoomToneAndUndo = true;

  const carrier = await project(`voice-carrier-${randomUUID()}`, [
    { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
    placed(replacementAsset, "audio", 0, phrase.durationUs),
  ]);
  const exporting = await call("export.create", {
    projectId: carrier.projectId,
    requestId: randomUUID(),
    kind: "processed-package",
    directory: out,
    leaf: "generated.zip",
  });
  const exportId = exporting.exportId;
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "export",
  );
  await service.stop();
  const receiver = await realpath(await mkdtemp("/tmp/sr-voice-receiver-"));
  report.receiver = receiver;
  service.home = receiver;
  await service.start();
  const opening = await call("package.open", { path: exported.output });
  const opened = await poll(
    () => call("package.status", { admissionId: opening.packageId }),
    (v) => v.state === "ready",
    "package",
  );
  await poll(
    () =>
      call("package.adopt", { packageHandle: opened.packageHandle, requestId: "adopt-generated" }),
    (v) => v.state === "ready",
    "adopt",
  );
  await call("package.close", { admissionId: opening.packageId });
  assert.deepEqual(
    await assetBytes(phrase.assetId, "portable-generated.wav"),
    await readFile(join(out, "phrase.wav")),
  );
  assert.deepEqual(
    await assetBytes(reference.assetId, "portable-reference.wav"),
    await readFile(join(frozen, "reference.wav")),
  );
  assert(
    (await call("asset.origins", { assetId: phrase.assetId })).origins.some(
      (origin) => JSON.stringify(origin) === JSON.stringify(phrase.origin),
    ),
  );
  await artifact(
    "audio.get",
    { assetId: phrase.assetId, streamId: phrase.streamId },
    "portable-playable.wav",
  );
  assert.equal((await call("model.status", { modelId: registered.modelId })).state, "unavailable");
  report.checks.modelFreePortableOutputAndReference = true;
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      if (hiddenModel) await rename(hiddenModel, modelDirectory);
    } finally {
      try {
        await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
        await writeFile(join(out, "service.log"), service.logs.join(""));
      } finally {
        if (report.receiver) await rm(report.receiver, { recursive: true, force: true });
      }
    }
  }
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, out }));
