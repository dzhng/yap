import { denoiseFollow } from "./denoise-follow.mjs";
import { denoisePostRetime } from "./denoise-post-retime.mjs";
import { denoiseTransitions } from "./denoise-transitions.mjs";
import { createDenoiseReference } from "./denoise-reference.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, stat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { JourneyService, hash, poll, root } from "./source-evidence-fixture.mjs";
import { waveHeader } from "./audio-project-fixture.mjs";

const priorUnavailableOperations = process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    source: { type: "string" },
    reference: { type: "string" },
    "post-retime": { type: "boolean" },
    follow: { type: "boolean" },
  },
});
assert(
  values.out &&
    (values.source || values["post-retime"] || values.follow) &&
    values.reference &&
    process.env.YAP_NATIVE,
);
assert(!(values["post-retime"] && values.follow), "Choose one fixture mode");
const captured = values["post-retime"] || values.follow;
const out = resolve(values.out),
  home = await realpath(await mkdtemp("/tmp/sr-denoise-public-"));
await mkdir(out);
const denoise = createDenoiseReference(resolve(values.reference), out);
const report = {
  passed: false,
  trace: [],
  ...(captured ? { exchanges: [] } : {}),
  checks: {},
  receipts: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  harnessSha256: hash(await readFile(import.meta.filename)),
  referenceSha256: hash(await readFile(resolve(values.reference))),
  scope: values.follow
    ? "Public follow into learned ordinary/prepared audio from authenticated14e dry PCM; matched full/range movie delivery; no listening or quality claim."
    : values["post-retime"]
      ? "Public post-retime overlap, held gain and windowed RNNoise mix-state integration; exact numerical delivery only, no listening, spatial, other-material or pitch-follow claim."
      : "linked independent-channel RNNoise through public CLI/MCP and existing prepared owner; no listening or model-absent binary claim",
};
const service = new JourneyService(home, report, captured ? join(out, "native") : undefined),
  call = service.call.bind(service);
const expected = gunzipSync(
  await readFile(
    join(root, "specs/done/agent-editing/assets/12c-matched-noise/audio/rnnoise-mixture.f32.gz"),
  ),
);
async function prepare(selection) {
  const result = await poll(
    () => call("audio.prepare", selection),
    (v) => v.state === "ready",
    "denoise preparation",
  );
  assert.deepEqual(await call("audio.prepare", selection, { transport: "mcp" }), result);
  report.receipts.push(result);
  return result;
}
async function inspect(
  prepared,
  startUs,
  endUs,
  name,
  factor = 1,
  oracle = expected,
  oracleChannels = 1,
) {
  const asset = await call("asset.get", { assetId: prepared.published.output.assetId });
  const stream = asset.streams.find((s) => s.kind === "audio");
  assert(stream);
  const selection = {
    assetId: asset.assetId,
    streamId: stream.streamId,
    sourceRange: { startUs, endUs },
  };
  await poll(
    () => call("audio.get", selection),
    (v) => v.state === "ready",
    "retained PCM",
  );
  const path = join(out, name + ".wav");
  await call("audio.get", selection, { output: path });
  const bytes = await readFile(path),
    header = waveHeader(bytes, bytes.length);
  const first = (startUs * 48000) / 1000000,
    frames = ((endUs - startUs) * 48000) / 1000000;
  assert.equal(header.frames, frames);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      const value = Math.fround(
        oracle.readFloatLE(
          ((first + frame) * oracleChannels + Math.min(channel, oracleChannels - 1)) * 4,
        ) * factor,
      );
      assert.equal(bytes.readFloatLE(header.offset + frame * 8 + channel * 4), value);
    }
  }
  report.checks[name] = { frames, sha256: hash(bytes), exactPCM: true };
}
async function projectAudio(
  selection,
  tap,
  name,
  expectedPCM,
  oracleChannels = 1,
  range = { startUs: 0, endUs: 5000000 },
) {
  const params = { ...selection, range, tap };
  const ready = await poll(
    () => call("audio.get", params),
    (value) => value.state === "ready",
    name,
  );
  const path = join(out, name + ".wav");
  await call("audio.get", params, { output: path });
  const bytes = await readFile(path),
    header = waveHeader(bytes, bytes.length);
  const first = (range.startUs * 48000) / 1000000;
  assert.equal(header.frames, ((range.endUs - range.startUs) * 48000) / 1000000);
  for (let frame = 0; frame < header.frames; frame++)
    for (let channel = 0; channel < 2; channel++)
      assert.equal(
        bytes.readFloatLE(header.offset + frame * 8 + channel * 4),
        expectedPCM.readFloatLE(
          ((first + frame) * oracleChannels + Math.min(channel, oracleChannels - 1)) * 4,
        ),
      );
  report.checks[name] = {
    params,
    ready,
    frames: header.frames,
    sha256: hash(bytes),
    exactPCM: true,
  };
}
const baseline = gunzipSync(
  await readFile(
    join(root, "specs/done/agent-editing/assets/12c-matched-noise/audio/mixture.f32.gz"),
  ),
);
const outputTap = (point) => ({ target: { kind: "output" }, point });
async function movieDelivery(selection, name) {
  const movie = join(out, name + "full-preview.mp4"),
    rangedMovie = join(out, name + "range-preview.mp4");
  const preview = await poll(
    () =>
      call("preview.get", { ...selection, settings: { preset: "balanced" } }, { output: movie }),
    (v) => v.state === "ready",
    "learned movie",
  );
  const ranged = await poll(
    () =>
      call(
        "preview.get",
        {
          ...selection,
          range: { startUs: 1000000, endUs: 3000000 },
          settings: { preset: "balanced" },
        },
        { output: rangedMovie },
      ),
    (v) => v.state === "ready",
    "learned range movie",
  );
  const { exportId } = await call(
    "export.create",
    {
      ...selection,
      requestId: randomUUID(),
      kind: "video",
      directory: await realpath(out),
      leaf: name + "export.mp4",
      settings: { preset: "balanced" },
    },
    { transport: "mcp" },
  );
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "learned export",
  );
  assert.equal(hash(await readFile(exported.output)), hash(await readFile(movie)));
  return {
    full: preview.published.output,
    range: ranged.published.output,
    exportByteIdenticalToFullPreview: true,
    encodedPCMEqualityClaim: false,
  };
}
async function combinedTemporal(asset) {
  const record = (report.combined = {
    edits: [],
    oracle: "Independent retained samples, offsets, Float32 sum and explicit held intervals",
  });
  const right = gunzipSync(
    await readFile(
      join(root, "specs/done/agent-editing/assets/12c-matched-noise/audio/reference.f32.gz"),
    ),
  );
  const mix = (includeSecond) => {
    const pcm = Buffer.alloc(baseline.length * 2);
    for (let i = 0; i < baseline.length / 4; i++)
      for (let c = 0; c < 2; c++) {
        const lane = c ? right : baseline;
        const b =
          includeSecond && i >= 96000 && i < 192000
            ? Math.fround(lane.readFloatLE((i - 96000) * 4) * 0.25)
            : 0;
        pcm.writeFloatLE(Math.fround(lane.readFloatLE(i * 4) + b), i * 8 + c * 4);
      }
    return pcm;
  };
  const animated = (pcm) => {
    const output = Buffer.from(pcm);
    // Fixture oracle: explicit binary held gains, no shared curve evaluator.
    for (let i = 48000; i < 192000; i++) {
      const gain = i < 120000 ? 0.5 : i < 168000 ? 0.25 : 1;
      for (let c = 0; c < 2; c++)
        output.writeFloatLE(Math.fround(pcm.readFloatLE(i * 8 + c * 4) * gain), i * 8 + c * 4);
    }
    return output;
  };
  const made = await call("project.create", {
    requestId: "combined-project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = made.project.projectId;
  let revision = made.revision;
  const selection = () => ({ projectId, revisionId: revision.revisionId });
  const edit = async (requestId, operations) => {
    const request = { projectId, expectedRevisionId: revision.revisionId, requestId, operations };
    const result = await call("edit.apply", request, { transport: "mcp" });
    record.edits.push({ request, result });
    revision = result.revision;
    return result;
  };
  const window = { kind: "project", range: { startUs: 1000000, endUs: 4000000 } };
  const placed = await edit("combined-first", [
    { operation: "group.add", label: "bus", group: { kind: "audio", order: 0 } },
    {
      operation: "track.add",
      label: "first",
      track: { kind: "audio", order: 0, parentId: { label: "bus" } },
    },
    {
      operation: "track.add",
      label: "second",
      track: { kind: "audio", order: 1, parentId: { label: "bus" } },
    },
    {
      operation: "place",
      clip: {
        trackId: { label: "first" },
        assetId: asset.assetId,
        streamId: asset.streams[0].streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 5000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 5000000 } },
      },
    },
    {
      operation: "processing.set",
      target: { kind: "track", id: { label: "second" } },
      steps: [{ processor: { type: "gain", gain: 0.25 } }],
    },
    {
      operation: "processing.set",
      target: { kind: "group", id: { label: "bus" } },
      steps: [
        {
          label: "automation",
          window,
          processor: {
            type: "gain",
            gain: {
              keys: [
                { at: 1000000, value: 0.5, interpolation: "hold" },
                { at: 2500000, value: 0.25, interpolation: "hold" },
                { at: 3500000, value: 1, interpolation: "hold" },
              ],
            },
          },
        },
        { label: "learned", window, processor: { type: "rnnoise" } },
      ],
    },
    {
      operation: "processing.set",
      target: { kind: "output" },
      steps: [{ processor: { type: "gain", gain: 0.5 } }],
    },
  ]);
  const target = { kind: "group", id: placed.edit.labels.bus };
  const initial = selection(),
    initialPrepared = await prepare(initial);
  await projectAudio(
    initial,
    { target, point: { kind: "dry" } },
    "combined-initial-prefix",
    mix(false),
    2,
  );
  const added = await edit("combined-add", [
    {
      operation: "place",
      label: "newMember",
      clip: {
        trackId: placed.edit.labels.second,
        assetId: asset.assetId,
        streamId: asset.streams[0].streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
        placement: { kind: "project", range: { startUs: 2000000, endUs: 4000000 } },
      },
    },
  ]);
  const stack = await call("processing.get", { ...selection(), target });
  const member = await call("processing.get", {
    ...selection(),
    target: { kind: "clip", id: added.edit.labels.newMember },
  });
  assert.deepEqual(member.steps, []);
  const summed = mix(true),
    prefix = animated(summed);
  await projectAudio(selection(), { target, point: { kind: "dry" } }, "combined-sum", summed, 2);
  await projectAudio(
    selection(),
    { target, point: { kind: "after-step", stepId: stack.steps[0].id } },
    "combined-animated-prefix",
    prefix,
    2,
  );
  const scale = (pcm, factor) => {
    const result = Buffer.alloc(pcm.length);
    for (let i = 0; i < pcm.length; i += 4)
      result.writeFloatLE(Math.fround(pcm.readFloatLE(i) * factor), i);
    return result;
  };
  const wet = (name, pcm) => {
    const result = Buffer.from(pcm);
    denoise(name, pcm.subarray(48000 * 8, 192000 * 8), 2).copy(result, 48000 * 8);
    return result;
  };
  const firstExpected = scale(wet("combined-first", animated(mix(false))), 0.5);
  const beforeOrder = scale(wet("combined-sum", prefix), 0.5);
  const afterOrder = scale(animated(wet("combined-reordered", summed)), 0.5);
  assert(!beforeOrder.equals(afterOrder), "The authored pair must distinguish processing order");
  const current = selection(),
    prepared = await prepare(current);
  assert.notEqual(prepared.jobId, initialPrepared.jobId);
  await inspect(initialPrepared, 0, 5000000, "combined-original-full", 1, firstExpected, 2);
  await inspect(prepared, 0, 5000000, "combined-current-full", 1, beforeOrder, 2);
  await projectAudio(
    current,
    outputTap({ kind: "processed" }),
    "combined-ordinary-full",
    beforeOrder,
    2,
  );
  await projectAudio(
    current,
    outputTap({ kind: "processed" }),
    "combined-ordinary-range",
    beforeOrder,
    2,
    { startUs: 750000, endUs: 4250000 },
  );
  await inspect(prepared, 750000, 1250000, "combined-leading-boundary", 1, beforeOrder, 2);
  await inspect(prepared, 3750000, 4250000, "combined-trailing-boundary", 1, beforeOrder, 2);
  const dry = scale(summed, 0.5);
  assert(beforeOrder.subarray(0, 48000 * 8).equals(dry.subarray(0, 48000 * 8)));
  assert(beforeOrder.subarray(192000 * 8).equals(dry.subarray(192000 * 8)));
  const a = animated(mix(false)),
    b = Buffer.alloc(a.length);
  for (let i = 96000; i < 192000; i++)
    for (let c = 0; c < 2; c++) {
      const lane = c ? right : baseline;
      b.writeFloatLE(Math.fround(lane.readFloatLE((i - 96000) * 4) * 0.25), i * 8 + c * 4);
    }
  const perA = wet("combined-per-contribution-a", a),
    perB = wet("combined-per-contribution-b", animated(b));
  const perContribution = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 4)
    perContribution.writeFloatLE(
      Math.fround(Math.fround(perA.readFloatLE(i) + perB.readFloatLE(i)) * 0.5),
      i,
    );
  assert(
    !perContribution.equals(beforeOrder),
    "Per-contribution state must not stand in for combined state",
  );
  await writeFile(join(out, "combined-expected-before.f32"), beforeOrder);
  await writeFile(join(out, "combined-expected-after.f32"), afterOrder);
  await writeFile(join(out, "combined-per-contribution.f32"), perContribution);
  record.negatives = {
    wrongOrderDiffers: true,
    processBeforeMixDiffers: true,
    beforeHash: hash(beforeOrder),
    afterHash: hash(afterOrder),
    perContributionHash: hash(perContribution),
    scope: "Independent C sensitivity controls, not new public recipes",
  };
  record.dryNeighborsExact = true;
  const reordered = await edit("combined-reorder", [
    { operation: "processing.set", target, steps: [...stack.steps].reverse() },
  ]);
  const reorderedSelection = selection(),
    reorderedStack = await call("processing.get", { ...reorderedSelection, target });
  assert.deepEqual(
    reorderedStack.steps.map((step) => step.id),
    [...stack.steps].reverse().map((step) => step.id),
  );
  const reorderedPrepared = await prepare(reorderedSelection);
  assert.notEqual(reorderedPrepared.jobId, prepared.jobId);
  await inspect(reorderedPrepared, 0, 5000000, "combined-reordered-full", 1, afterOrder, 2);
  await projectAudio(
    reorderedSelection,
    outputTap({ kind: "processed" }),
    "combined-reordered-range",
    afterOrder,
    2,
    { startUs: 750000, endUs: 4250000 },
  );
  await edit("combined-bypass", [
    {
      operation: "processing.set",
      target,
      steps: reorderedStack.steps.map((step) => ({
        ...step,
        enabled: step.processor.type !== "rnnoise",
      })),
    },
  ]);
  const bypassPrepared = await prepare(selection());
  await inspect(bypassPrepared, 0, 5000000, "combined-bypass", 1, scale(prefix, 0.5), 2);
  const undoRequest = {
    projectId,
    expectedRevisionId: revision.revisionId,
    requestId: "combined-undo",
  };
  const undone = await call("edit.undo", undoRequest);
  record.edits.push({ operation: "edit.undo", request: undoRequest, result: undone });
  revision = undone;
  assert.deepEqual(undone.document, reordered.revision.document);
  await projectAudio(selection(), outputTap({ kind: "processed" }), "combined-undo", afterOrder, 2);
  const restoreRequest = {
    projectId,
    expectedRevisionId: revision.revisionId,
    targetRevisionId: initial.revisionId,
    requestId: "combined-restore",
  };
  const restored = await call("edit.restore", restoreRequest, { transport: "mcp" });
  record.edits.push({ operation: "edit.restore", request: restoreRequest, result: restored });
  revision = restored;
  assert.deepEqual(restored.document, placed.revision.document);
  await projectAudio(
    selection(),
    outputTap({ kind: "processed" }),
    "combined-restored-first-member",
    firstExpected,
    2,
  );
  await projectAudio(
    current,
    outputTap({ kind: "processed" }),
    "combined-historical-before-order",
    beforeOrder,
    2,
  );
  await projectAudio(
    reorderedSelection,
    outputTap({ kind: "processed" }),
    "combined-historical-after-order",
    afterOrder,
    2,
  );
  assert.deepEqual(await prepare(current), prepared);
  record.movie = await movieDelivery(current, "combined-");
  record.initial = initial;
  record.initialPreparation = initialPrepared;
  record.added = current;
  record.reordered = reorderedSelection;
  record.restored = selection();
  record.prefixSha256 = hash(prefix);
}
async function unitRateJourney() {
  const imported = await call("asset.import", {
    requestId: "source",
    path: resolve(values.source),
  });
  const job = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: job.published.output.assetId });
  const made = await call("project.create", {
    requestId: "project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = made.project.projectId;
  const placed = await call("edit.apply", {
    projectId,
    expectedRevisionId: made.revision.revisionId,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "audio" },
          assetId: asset.assetId,
          streamId: asset.streams[0].streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 5000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 5000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ enabled: true, processor: { type: "rnnoise" } }],
      },
    ],
  });
  const original = { projectId, revisionId: placed.revision.revisionId },
    first = await prepare(original);
  await inspect(first, 0, 5000000, "full");
  const originalStack = await call("processing.get", { ...original, target: { kind: "output" } });
  await projectAudio(original, outputTap({ kind: "dry" }), "before-state-tap", baseline);
  await projectAudio(
    original,
    outputTap({ kind: "after-step", stepId: originalStack.steps[0].id }),
    "after-state-tap",
    expected,
  );
  report.checks.movie = await movieDelivery(original, "");
  const gained = await call("edit.apply", {
    projectId,
    expectedRevisionId: original.revisionId,
    requestId: "gain",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          { enabled: true, processor: { type: "rnnoise" } },
          { enabled: true, processor: { type: "gain", gain: 0.5 } },
        ],
      },
    ],
  });
  const selected = { projectId, revisionId: gained.revision.revisionId };
  const blocked = await service.arm("media.mixCompositionAudio"),
    pending = await call("audio.prepare", selected);
  await blocked();
  await call("job.cancel", { jobId: pending.jobId });
  const canceled = await call("job.get", { jobId: pending.jobId });
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.published, null);
  await call("audio.prepare", selected);
  assert.deepEqual(await call("job.get", { jobId: pending.jobId }), canceled);
  await call("job.retry", { jobId: pending.jobId });
  const second = await prepare(selected);
  assert.equal(second.jobId, pending.jobId);
  await inspect(second, 1000000, 3000000, "gained-range", 0.5);
  assert.deepEqual(await prepare(original), first);
  const gainedStack = await call("processing.get", { ...selected, target: { kind: "output" } });
  await projectAudio(
    selected,
    outputTap({ kind: "after-step", stepId: gainedStack.steps[0].id }),
    "before-downstream-gain-tap",
    expected,
  );
  const bypassed = await call("edit.apply", {
    projectId,
    expectedRevisionId: selected.revisionId,
    requestId: "bypass-state",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: gainedStack.steps.map((step, index) => ({ ...step, enabled: index !== 0 })),
      },
    ],
  });
  const halfDry = Buffer.from(baseline);
  for (let at = 0; at < halfDry.length; at += 4)
    halfDry.writeFloatLE(Math.fround(halfDry.readFloatLE(at) * 0.5), at);
  await projectAudio(
    { projectId, revisionId: bypassed.revision.revisionId },
    outputTap({ kind: "processed" }),
    "bypassed-state",
    halfDry,
  );
  const undone = await call("edit.undo", {
    projectId,
    expectedRevisionId: bypassed.revision.revisionId,
    requestId: "undo-bypass",
  });
  assert.deepEqual(undone.document, gained.revision.document);
  const halfWet = Buffer.from(expected);
  for (let at = 0; at < halfWet.length; at += 4)
    halfWet.writeFloatLE(Math.fround(halfWet.readFloatLE(at) * 0.5), at);
  await projectAudio(
    { projectId, revisionId: undone.revisionId },
    outputTap({ kind: "processed" }),
    "undo-state",
    halfWet,
  );
  const restored = await call("edit.restore", {
    projectId,
    expectedRevisionId: undone.revisionId,
    targetRevisionId: original.revisionId,
    requestId: "restore-original",
  });
  assert.deepEqual(restored.document, placed.revision.document);
  await projectAudio(
    { projectId, revisionId: restored.revisionId },
    outputTap({ kind: "processed" }),
    "restore-state",
    expected,
  );
  await projectAudio(
    selected,
    outputTap({ kind: "processed" }),
    "historical-gained-state",
    halfWet,
  );
  const stereoImported = await call("asset.import", {
    requestId: "stereo-source",
    path: join(dirname(resolve(values.source)), "differing-stereo.wav"),
  });
  const stereoJob = await poll(
    () => call("job.get", { jobId: stereoImported.jobId }),
    (v) => v.state === "ready",
    "stereo import",
  );
  const stereoAsset = await call("asset.get", { assetId: stereoJob.published.output.assetId });
  assert.equal(stereoAsset.streams[0].channels, 2);
  const stereoMade = await call("project.create", {
    requestId: "stereo-project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const stereoPlaced = await call("edit.apply", {
    projectId: stereoMade.project.projectId,
    expectedRevisionId: stereoMade.revision.revisionId,
    requestId: "stereo-place",
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          assetId: stereoAsset.assetId,
          streamId: stereoAsset.streams[0].streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 5000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 5000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "rnnoise" } }],
      },
    ],
  });
  const stereoPrepared = await prepare({
    projectId: stereoMade.project.projectId,
    revisionId: stereoPlaced.revision.revisionId,
  });
  const rightExpected = gunzipSync(
    await readFile(
      join(
        root,
        "specs/done/agent-editing/assets/12c-matched-noise/audio/rnnoise-reference.f32.gz",
      ),
    ),
  );
  assert.equal(rightExpected.length, expected.length);
  const stereoExpected = Buffer.alloc(expected.length * 2);
  for (let frame = 0; frame < expected.length / 4; frame++) {
    expected.copy(stereoExpected, frame * 8, frame * 4, frame * 4 + 4);
    rightExpected.copy(stereoExpected, frame * 8 + 4, frame * 4, frame * 4 + 4);
  }
  await inspect(stereoPrepared, 0, 5000000, "independent-stereo-full", 1, stereoExpected, 2);
  await inspect(stereoPrepared, 1000000, 3000000, "independent-stereo-range", 1, stereoExpected, 2);
  await combinedTemporal(stereoAsset);
  const transitionDry = Buffer.alloc(baseline.length * 2);
  const transitionRight = gunzipSync(
    await readFile(
      join(root, "specs/done/agent-editing/assets/12c-matched-noise/audio/reference.f32.gz"),
    ),
  );
  for (let frame = 0; frame < baseline.length / 4; frame++) {
    baseline.copy(transitionDry, frame * 8, frame * 4, frame * 4 + 4);
    transitionRight.copy(transitionDry, frame * 8 + 4, frame * 4, frame * 4 + 4);
  }
  const transitions = await denoiseTransitions({
    asset: stereoAsset,
    dry: transitionDry,
    call,
    prepare,
    inspect,
    projectAudio,
    denoise,
    report,
    out,
  });
  report.transitions.movie = await movieDelivery(transitions.current, "transition-");
  const longMade = await call("project.create", {
    requestId: "cancel-project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const longPlaced = await call("edit.apply", {
    projectId: longMade.project.projectId,
    expectedRevisionId: longMade.revision.revisionId,
    requestId: "cancel-domain",
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 0, endUs: 600000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ enabled: true, processor: { type: "rnnoise" } }],
      },
    ],
  });
  const inFlight = await call("audio.prepare", {
    projectId: longMade.project.projectId,
    revisionId: longPlaced.revision.revisionId,
  });
  const workspace = join(home, "library/render");
  const observation = await poll(
    async () => {
      for (const file of await readdir(workspace, { recursive: true })) {
        if (!file.endsWith("output.f32")) continue;
        const bytes = (await stat(join(workspace, file))).size;
        if (bytes > 600 * 48000 * 4 && bytes < 600 * 48000 * 8) return { processing: true, bytes };
      }
      const status = await call("job.get", { jobId: inFlight.jobId });
      assert.notEqual(
        status.state,
        "ready",
        "Cancellation must interrupt native inference, not a finished job",
      );
      return { processing: false };
    },
    (v) => v.processing,
    "in-flight second-channel state spool",
  );
  const cancelAt = performance.now();
  await call("job.cancel", { jobId: inFlight.jobId });
  const canceledInFlight = await call("job.get", { jobId: inFlight.jobId });
  assert.equal(canceledInFlight.state, "canceled");
  assert.equal(canceledInFlight.published, null);
  await poll(
    async () => ({ files: await readdir(workspace, { recursive: true }) }),
    (v) => v.files.length === 0,
    "attempt scratch cleanup",
  );
  report.checks.inFlightCancellation = {
    observedOutputSpoolBytes: observation.bytes,
    declaredFrames: 600 * 48000,
    completedLanes: 1,
    incompleteLane: 1,
    canceled: true,
    noPublishedResult: true,
    scratchRemoved: true,
    cancelAndCleanupMs: performance.now() - cancelAt,
  };
  await service.stop();
  process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify([
    "media.audioCapabilities",
    "media.mixCompositionAudio",
  ]);
  await service.start();
  await inspect(first, 3000000, 4500000, "retained-with-executor-unavailable");
  await projectAudio(
    original,
    outputTap({ kind: "dry" }),
    "dry-tap-with-executor-unavailable",
    baseline,
  );
  await inspect(
    stereoPrepared,
    3000000,
    4500000,
    "stereo-retained-executor-unavailable",
    1,
    stereoExpected,
    2,
  );
  assert.equal((await call("audio.prepare", selected)).state, "ready");
  const unprepared = await call("edit.apply", {
    projectId,
    expectedRevisionId: restored.revisionId,
    requestId: "new-mix-unavailable",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "rnnoise", mix: 0.125 } }],
      },
    ],
  });
  const refusal = await call(
    "audio.prepare",
    { projectId, revisionId: unprepared.revision.revisionId },
    { error: true },
  );
  assert.equal(refusal.code, "NOT_READY");
  await service.stop();
  process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify(["media.audioCapabilities"]);
  await service.start();
  await projectAudio(
    transitions.initial,
    outputTap({ kind: "processed" }),
    "transition-retained-original-unavailable",
    transitions.expected,
    2,
  );
  await projectAudio(
    transitions.current,
    outputTap({ kind: "processed" }),
    "transition-retained-current-unavailable",
    transitions.currentExpected,
    2,
  );
  report.checks.lifecycle = {
    canceledRealNativeReplyNotPublished: true,
    explicitRetry: true,
    historicalRevision: true,
    cliAndMcpRepeat: true,
    retainedPCMWithExecutorUnavailable: true,
    newPreparationRefusedWithoutCapability: true,
  };
}
try {
  await service.start();
  if (values["post-retime"])
    await denoisePostRetime({
      call,
      prepare,
      inspect,
      projectAudio,
      movieDelivery,
      denoise,
      report,
      out,
    });
  else if (values.follow)
    await denoiseFollow({
      call,
      prepare,
      inspect,
      projectAudio,
      movieDelivery,
      denoise,
      report,
      out,
    });
  else await unitRateJourney();
  report.passed = true;
} finally {
  if (priorUnavailableOperations === undefined) delete process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
  else process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = priorUnavailableOperations;
  try {
    await service.stop();
    await writeFile(join(out, "service.log"), service.logs.join("\n"));
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
