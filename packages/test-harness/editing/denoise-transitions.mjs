import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Numerical journey only: independent adapter calls and explicit fixture envelopes, no audition. */
export async function denoiseTransitions({
  asset,
  dry,
  call,
  prepare,
  inspect,
  projectAudio,
  denoise,
  report,
  out,
}) {
  const fraction = (numerator, denominator = 1) => ({ numerator, denominator });
  const curve = {
    keys: [
      { at: fraction(0), value: 0, interpolation: "hold" },
      { at: fraction(1, 5), value: 0, interpolation: "linear" },
      { at: fraction(2, 5), value: 1, interpolation: "hold" },
      { at: fraction(3, 5), value: 0, interpolation: "hold" },
      { at: fraction(4, 5), value: 0.25, interpolation: { cubic: [0.25, 0, 0.75, 1] } },
      { at: fraction(1), value: 1, interpolation: "hold" },
    ],
  };
  function envelope(frame) {
    if (frame < 48000) return 0;
    if (frame < 96000) return (frame - 48000) * (1 / 48000);
    if (frame < 144000) return 1;
    if (frame < 192000) return 0;
    const phase = (frame - 192000) * (1 / 48000);
    let lo = 0,
      hi = 1;
    for (;;) {
      const t = (lo + hi) / 2;
      if (t === lo || t === hi) break;
      const x = ((-0.5 * t + 0.75) * t + 0.75) * t;
      if (x === phase) {
        lo = t;
        hi = t;
        break;
      }
      if (x < phase) lo = t;
      else hi = t;
    }
    const t = (lo + hi) / 2,
      weight = (-2 * t + 3) * t * t;
    return (1 - weight) * 0.25 + weight;
  }
  const scale = (pcm, value) => {
    const result = Buffer.alloc(pcm.length);
    for (let i = 0; i < pcm.length; i += 4)
      result.writeFloatLE(Math.fround(pcm.readFloatLE(i) * value), i);
    return result;
  };
  const blend = (a, b, value) => {
    const result = Buffer.alloc(a.length);
    for (let frame = 0; frame < a.length / 8; frame++) {
      const amount = typeof value === "number" ? value : value(frame);
      for (let c = 0; c < 2; c++) {
        const at = frame * 8 + c * 4;
        if (amount === 0) a.copy(result, at, at, at + 4);
        else if (amount === 1) b.copy(result, at, at, at + 4);
        else
          result.writeFloatLE(
            Math.fround((1 - amount) * a.readFloatLE(at) + amount * b.readFloatLE(at)),
            at,
          );
      }
    }
    return result;
  };
  const prefix = scale(dry, 0.5),
    wet = denoise("transition-prefix", prefix, 2);
  const expected = scale(blend(prefix, wet, envelope), 2);
  const reset = denoise("transition-reset-negative", prefix.subarray(192000 * 8), 2);
  assert(
    !reset.equals(wet.subarray(192000 * 8)),
    "A zero plateau must distinguish reset learned state",
  );
  const wrongPhase = scale(
    blend(prefix, wet, (frame) => envelope(Math.min(239999, frame + 480))),
    2,
  );
  assert(!wrongPhase.equals(expected), "The fixture must detect shifted mix clocks");
  const made = await call("project.create", {
    requestId: "transition-project",
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
  async function edit(name, operations) {
    const result = await call(
      "edit.apply",
      { projectId, expectedRevisionId: revision.revisionId, requestId: name, operations },
      { transport: "mcp" },
    );
    revision = result.revision;
    return result;
  }
  const placed = await edit("transition-place", [
    { operation: "group.add", label: "bus", group: { kind: "audio", order: 0 } },
    {
      operation: "track.add",
      label: "voice",
      track: { kind: "audio", order: 0, parentId: { label: "bus" } },
    },
    {
      operation: "place",
      label: "voiceClip",
      clip: {
        trackId: { label: "voice" },
        assetId: asset.assetId,
        streamId: asset.streams[0].streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 5000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 5000000 } },
      },
    },
    {
      operation: "processing.set",
      target: { kind: "clip", id: { label: "voiceClip" } },
      steps: [
        { processor: { type: "gain", gain: 0.5 } },
        { processor: { type: "rnnoise", mix: curve } },
        { processor: { type: "gain", gain: 2 } },
      ],
    },
  ]);
  const clipId = placed.edit.labels.voiceClip,
    target = { kind: "clip", id: clipId };
  const initial = selection(),
    originalPreparation = await prepare(initial);
  await inspect(originalPreparation, 0, 5000000, "transition-curve-full", 1, expected, 2);
  await projectAudio(
    initial,
    { target: { kind: "output" }, point: { kind: "processed" } },
    "transition-curve-range",
    expected,
    2,
    { startUs: 750000, endUs: 4750000 },
  );
  const stack = (await call("processing.get", { ...selection(), target })).steps;
  const endpointPreparations = [];
  for (const mix of [0, 1, undefined]) {
    await edit(`transition-endpoint-${mix ?? "omitted"}`, [
      {
        operation: "processing.set",
        target,
        steps: stack.map((s) =>
          s.processor.type === "rnnoise"
            ? { ...s, processor: { type: "rnnoise", ...(mix === undefined ? {} : { mix }) } }
            : s,
        ),
      },
    ]);
    const prepared = await prepare(selection());
    assert.notEqual(prepared.jobId, originalPreparation.jobId);
    endpointPreparations.push(prepared);
    await inspect(
      prepared,
      0,
      5000000,
      `transition-endpoint-${mix ?? "omitted"}`,
      1,
      mix === 0 ? scale(prefix, 2) : scale(wet, 2),
      2,
    );
  }
  assert.notEqual(endpointPreparations[1].jobId, endpointPreparations[2].jobId);
  assert.equal(
    endpointPreparations[1].published.output.assetId,
    endpointPreparations[2].published.output.assetId,
  );
  revision = await call("edit.restore", {
    projectId,
    expectedRevisionId: revision.revisionId,
    requestId: "transition-restore",
    targetRevisionId: initial.revisionId,
  });
  const split = await edit("transition-split", [
    { operation: "split", clipIds: [clipId], atUs: 3500000, scope: "selected" },
  ]);
  await inspect(
    await prepare(selection()),
    0,
    5000000,
    "transition-split-zero-plateau",
    1,
    expected,
    2,
  );
  const clipIds = split.revision.document.clips.map((c) => c.id);
  await edit("transition-move", [{ operation: "move", clipIds, atUs: 1000000, ripple: "none" }]);
  const moved = Buffer.concat([Buffer.alloc(48000 * 8), expected]);
  await inspect(await prepare(selection()), 0, 6000000, "transition-moved", 1, moved, 2);
  await edit("transition-trim", [
    { operation: "trim", clipId, range: { startUs: 2000000, endUs: 4500000 }, ripple: "none" },
  ]);
  const trimmedPrefix = prefix.subarray(48000 * 8),
    trimmedWet = denoise("transition-trim", trimmedPrefix, 2);
  const trimmed = Buffer.concat([
    Buffer.alloc(96000 * 8),
    scale(
      blend(trimmedPrefix, trimmedWet, (frame) => envelope(frame + 48000)),
      2,
    ),
  ]);
  await inspect(await prepare(selection()), 0, 6000000, "transition-trimmed", 1, trimmed, 2);
  revision = await call("edit.restore", {
    projectId,
    expectedRevisionId: revision.revisionId,
    requestId: "transition-parent-restore",
    targetRevisionId: initial.revisionId,
  });
  const group = { kind: "group", id: placed.edit.labels.bus },
    window = { kind: "project", range: { startUs: 1000000, endUs: 4000000 } };
  const parentMix = {
    keys: [
      { at: 1000000, value: 0, interpolation: "linear" },
      { at: 4000000, value: 1, interpolation: "hold" },
    ],
  };
  const parent = await edit("transition-parent", [
    { operation: "processing.set", target, steps: [] },
    {
      operation: "track.add",
      label: "other",
      track: { kind: "audio", order: 1, parentId: group.id },
    },
    {
      operation: "place",
      clip: {
        trackId: { label: "other" },
        assetId: asset.assetId,
        streamId: asset.streams[0].streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 3000000 } },
        placement: { kind: "project", range: { startUs: 1000000, endUs: 4000000 } },
      },
    },
    {
      operation: "processing.set",
      target: { kind: "track", id: { label: "other" } },
      steps: [{ processor: { type: "gain", gain: 0.25 } }],
    },
    {
      operation: "processing.set",
      target: group,
      steps: [
        { processor: { type: "gain", gain: 0.5 } },
        { window, processor: { type: "rnnoise", mix: parentMix } },
        { processor: { type: "gain", gain: 2 } },
        { processor: { type: "rnnoise", mix: 0.3 } },
      ],
    },
  ]);
  const summed = Buffer.from(dry);
  for (let frame = 48000; frame < 192000; frame++)
    for (let c = 0; c < 2; c++)
      summed.writeFloatLE(
        Math.fround(
          dry.readFloatLE(frame * 8 + c * 4) +
            Math.fround(dry.readFloatLE((frame - 48000) * 8 + c * 4) * 0.25),
        ),
        frame * 8 + c * 4,
      );
  function firstState(name, pcm) {
    const result = Buffer.from(pcm),
      part = pcm.subarray(48000 * 8, 192000 * 8);
    blend(part, denoise(name, part, 2), (frame) => frame * (1 / 144000)).copy(result, 48000 * 8);
    return result;
  }
  const secondState = (name, pcm) => blend(pcm, denoise(name, pcm, 2), 0.3);
  const firstExpected = firstState("transition-parent-first", scale(summed, 0.5));
  const parentExpected = secondState("transition-parent-second", scale(firstExpected, 2));
  const parentPrepared = await prepare(selection());
  await inspect(parentPrepared, 0, 5000000, "transition-parent-two-states", 1, parentExpected, 2);
  await projectAudio(
    selection(),
    { target: { kind: "output" }, point: { kind: "processed" } },
    "transition-parent-range",
    parentExpected,
    2,
    { startUs: 750000, endUs: 4250000 },
  );
  const parentStack = (await call("processing.get", { ...selection(), target: group })).steps;
  await projectAudio(
    selection(),
    { target: group, point: { kind: "after-step", stepId: parentStack[1].id } },
    "transition-parent-first-window",
    firstExpected,
    2,
  );
  const reordered = [parentStack[1], parentStack[0], parentStack[2], parentStack[3]];
  const reorderedExpected = secondState(
    "transition-reorder-second",
    scale(scale(firstState("transition-reorder-first", summed), 0.5), 2),
  );
  assert(
    !parentExpected.equals(reorderedExpected),
    "The fixture must detect wrong ordered dry input",
  );
  await edit("transition-parent-reorder", [
    { operation: "processing.set", target: group, steps: reordered },
  ]);
  await inspect(
    await prepare(selection()),
    0,
    5000000,
    "transition-parent-reordered",
    1,
    reorderedExpected,
    2,
  );
  await edit("transition-parent-bypass", [
    {
      operation: "processing.set",
      target: group,
      steps: reordered.map((s) => ({ ...s, enabled: s.id !== parentStack[1].id })),
    },
  ]);
  const bypassExpected = secondState("transition-bypass-second", scale(scale(summed, 0.5), 2));
  await inspect(
    await prepare(selection()),
    0,
    5000000,
    "transition-parent-bypass",
    1,
    bypassExpected,
    2,
  );
  revision = await call("edit.undo", {
    projectId,
    expectedRevisionId: revision.revisionId,
    requestId: "transition-parent-undo",
  });
  await projectAudio(
    selection(),
    { target: { kind: "output" }, point: { kind: "processed" } },
    "transition-parent-undo",
    reorderedExpected,
    2,
  );
  await projectAudio(
    initial,
    { target: { kind: "output" }, point: { kind: "processed" } },
    "transition-historical",
    expected,
    2,
  );
  assert.deepEqual(
    (await call("revision.get", { projectId, revisionId: parent.revision.revisionId })).revision
      .document,
    parent.revision.document,
  );
  await writeFile(join(out, "transition-expected.f32"), expected);
  await writeFile(join(out, "transition-wrong-phase.f32"), wrongPhase);
  report.transitions = {
    initial,
    parent: { projectId, revisionId: parent.revision.revisionId },
    current: selection(),
    resetAtZeroDiffers: true,
    wrongPhaseDiffers: true,
    wrongOrderDiffers: true,
    originalPreparation,
  };
  return { initial, expected, current: selection(), currentExpected: reorderedExpected };
}
