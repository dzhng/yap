import { matchedMovieAudio } from "./matched-movie-audio.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hash, poll, root } from "./source-evidence-fixture.mjs";
import { readAudioWaveFile } from "../../core/dist/audio-wave.js";

/** A retained stretch oracle precedes independent routing and frozen-C learned checks. */
export async function denoisePostRetime({
  call,
  prepare,
  inspect,
  projectAudio,
  movieDelivery,
  denoise,
  report,
  out,
}) {
  const record = (report.postRetime = {
    edits: [],
    sources: [],
    oracle:
      "Accepted retimed PCM plus retained familiar input, explicit Float32 routing/held envelopes, then frozen C RNNoise",
  });
  record.harnessSha256 = hash(await readFile(import.meta.filename));
  const accepted = join(root, "specs/done/agent-editing/assets/13a-corrected-selections");
  const familiar = join(root, "specs/done/agent-editing/assets/12c-familiar-sentence");
  const frozen = JSON.parse(await readFile(join(accepted, "report.json"), "utf8"));
  const listening = JSON.parse(await readFile(join(accepted, "listening.json"), "utf8"));
  const familiarManifest = JSON.parse(await readFile(join(familiar, "manifest.json"), "utf8"));
  const candidate = frozen.results.find((value) => value.path === "internal-slower-0.8x.wav");
  assert(candidate);
  async function retained(path, digest) {
    const bytes = await readFile(path);
    assert.equal(hash(bytes), digest);
    const info = readAudioWaveFile(path);
    assert.equal(info.sampleRate, 48000);
    record.sources.push({
      path,
      sha256: digest,
      channels: info.channels,
      frames: info.dataBytes / info.channels / 4,
    });
    return bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  }
  const bedPath = join(familiar, "original.wav");
  const bed = await retained(
    bedPath,
    familiarManifest.files.find((value) => value.path === "original.wav").sha256,
  );
  const sourcePath = join(accepted, "original.wav");
  await retained(sourcePath, frozen.sourceSha256);
  const acceptedPCM = await retained(
    join(accepted, candidate.path),
    listening.candidates.find((value) => value.path === candidate.path).sha256,
  );
  assert.equal(bed.length, 240000 * 8);
  const [sourceFirst, sourceEnd] = candidate.sourceFrames;
  const sourceRange = {
    startUs: (sourceFirst * 1000000) / 48000,
    endUs: (sourceEnd * 1000000) / 48000,
  };
  const durationUs = Math.round(
    ((sourceRange.endUs - sourceRange.startUs) * candidate.rate.denominator) /
      candidate.rate.numerator,
  );
  const stem = Buffer.alloc(bed.length);
  for (let frame = 0; frame < candidate.declaredOutput.frames; frame++)
    for (let channel = 0; channel < 2; channel++)
      acceptedPCM.copy(
        stem,
        (48000 + frame) * 8 + channel * 4,
        (candidate.declaredOutput.start + frame) * 4,
        (candidate.declaredOutput.start + frame + 1) * 4,
      );
  const scale = (pcm, gain) => {
    const result = Buffer.alloc(pcm.length);
    for (let at = 0; at < pcm.length; at += 4)
      result.writeFloatLE(
        Math.fround(
          pcm.readFloatLE(at) * (typeof gain === "function" ? gain(Math.floor(at / 8)) : gain),
        ),
        at,
      );
    return result;
  };
  const sum = (left, right) => {
    const result = Buffer.alloc(left.length);
    for (let at = 0; at < left.length; at += 4)
      result.writeFloatLE(Math.fround(left.readFloatLE(at) + right.readFloatLE(at)), at);
    return result;
  };
  // Explicit fixture clocks, independent of the production scalar compiler.
  const gainAt = (frame) =>
    frame < 24000 || frame >= 216000 ? 1 : frame < 96000 ? 0.5 : frame < 144000 ? 0.25 : 1;
  const mixAt = (frame) => (frame < 72000 ? 1 : frame < 120000 ? 0 : frame < 168000 ? 0.5 : 1);
  const summed = sum(bed, scale(stem, 0.25));
  const prefix = scale(summed, gainAt);
  async function importAsset(path, requestId) {
    const imported = await call("asset.import", { path, requestId });
    const job = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (value) => value.state === "ready",
      requestId,
    );
    return call("asset.get", { assetId: job.published.output.assetId });
  }
  const bedAsset = await importAsset(bedPath, "post-retime-bed");
  const retimeAsset = await importAsset(sourcePath, "post-retime-source");
  const canvas = {
    width: 16,
    height: 16,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  };
  const made = await call("project.create", { requestId: "post-retime-project", canvas });
  const projectId = made.project.projectId;
  let revision = made.revision;
  const selection = () => ({ projectId, revisionId: revision.revisionId });
  async function edit(requestId, operations) {
    const params = { projectId, expectedRevisionId: revision.revisionId, requestId, operations };
    const result = await call("edit.apply", params, { transport: "mcp" });
    record.edits.push({ params, result });
    revision = result.revision;
    return result;
  }
  const placed = await edit("post-retime-place", [
    { operation: "group.add", label: "bus", group: { kind: "audio", order: 0 } },
    {
      operation: "track.add",
      label: "bed",
      track: { kind: "audio", order: 0, parentId: { label: "bus" } },
    },
    {
      operation: "track.add",
      label: "retimed",
      track: { kind: "audio", order: 1, parentId: { label: "bus" } },
    },
    {
      operation: "place",
      label: "bedClip",
      clip: {
        trackId: { label: "bed" },
        assetId: bedAsset.id,
        streamId: bedAsset.streams[0].streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 5000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 5000000 } },
      },
    },
    {
      operation: "place",
      label: "retimedClip",
      clip: {
        trackId: { label: "retimed" },
        assetId: retimeAsset.id,
        streamId: retimeAsset.streams[0].streamId,
        source: { kind: "range", range: sourceRange },
        placement: {
          kind: "project",
          range: { startUs: 1000000, endUs: 1000000 + sourceRange.endUs - sourceRange.startUs },
        },
      },
    },
  ]);
  await edit("post-retime-stretch", [
    {
      operation: "retime",
      clipIds: [placed.edit.labels.retimedClip],
      durationUs,
      scope: "selected",
      ripple: "none",
      pitch: "preserve",
    },
  ]);
  const retimedTarget = { kind: "clip", id: placed.edit.labels.retimedClip };
  await projectAudio(
    selection(),
    { target: retimedTarget, point: { kind: "dry" } },
    "post-retime-stem",
    stem,
    2,
  );
  await projectAudio(
    selection(),
    { target: { kind: "clip", id: placed.edit.labels.bedClip }, point: { kind: "dry" } },
    "post-retime-bed",
    bed,
    2,
  );
  assert.deepEqual(
    (await call("processing.get", { ...selection(), target: retimedTarget })).steps,
    [],
  );
  const target = { kind: "group", id: placed.edit.labels.bus };
  const window = { kind: "project", range: { startUs: 500000, endUs: 4500000 } };
  await edit("post-retime-processing", [
    {
      operation: "processing.set",
      target: { kind: "track", id: placed.edit.labels.retimed },
      steps: [{ processor: { type: "gain", gain: 0.25 } }],
    },
    {
      operation: "processing.set",
      target,
      steps: [
        {
          window,
          processor: {
            type: "gain",
            gain: {
              keys: [
                { at: 500000, value: 0.5, interpolation: "hold" },
                { at: 2000000, value: 0.25, interpolation: "hold" },
                { at: 3000000, value: 1, interpolation: "hold" },
              ],
            },
          },
        },
        {
          window,
          processor: {
            type: "rnnoise",
            mix: {
              keys: [
                { at: 500000, value: 1, interpolation: "hold" },
                { at: 1500000, value: 0, interpolation: "hold" },
                { at: 2500000, value: 0.5, interpolation: "hold" },
                { at: 3500000, value: 1, interpolation: "hold" },
              ],
            },
          },
        },
      ],
    },
  ]);
  const original = selection();
  const stack = (await call("processing.get", { ...original, target })).steps;
  await projectAudio(original, { target, point: { kind: "dry" } }, "post-retime-sum", summed, 2);
  await projectAudio(
    original,
    { target, point: { kind: "after-step", stepId: stack[0].id } },
    "post-retime-prefix",
    prefix,
    2,
  );
  function learned(name, pcm, resetAtZero = false) {
    const wet = denoise(name, pcm.subarray(24000 * 8, 216000 * 8), 2);
    if (resetAtZero)
      denoise(name + "-reset", pcm.subarray(120000 * 8, 216000 * 8), 2).copy(
        wet,
        (120000 - 24000) * 8,
      );
    const result = Buffer.from(pcm);
    for (let frame = 24000; frame < 216000; frame++)
      for (let channel = 0; channel < 2; channel++) {
        const at = frame * 8 + channel * 4,
          wetAt = (frame - 24000) * 8 + channel * 4,
          amount = mixAt(frame);
        if (amount === 1) wet.copy(result, at, wetAt, wetAt + 4);
        else if (amount !== 0)
          result.writeFloatLE(
            Math.fround((1 - amount) * pcm.readFloatLE(at) + amount * wet.readFloatLE(wetAt)),
            at,
          );
      }
    return result;
  }
  const expected = learned("post-retime-combined", prefix);
  const reorderedExpected = scale(learned("post-retime-reorder", summed), gainAt);
  const resetExpected = learned("post-retime-reset-control", prefix, true);
  const perContribution = sum(
    learned("post-retime-bed-control", scale(bed, gainAt)),
    learned("post-retime-stem-control", scale(scale(stem, 0.25), gainAt)),
  );
  for (const [name, control] of Object.entries({
    reorderedExpected,
    resetExpected,
    perContribution,
  })) {
    assert(!control.equals(expected), name + " must differ");
    await writeFile(join(out, name + ".f32"), control);
  }
  await writeFile(join(out, "post-retime-expected.f32"), expected);
  const output = { target: { kind: "output" }, point: { kind: "processed" } };
  await projectAudio(original, output, "post-retime-late-before-full", expected, 2, {
    startUs: 3500000,
    endUs: 4000000,
  });
  assert.equal(
    report.checks["post-retime-late-before-full"].ready.published.output.preparedResourceId,
    null,
  );
  await call("audio.get", report.checks["post-retime-late-before-full"].params, {
    transport: "mcp",
  });
  const attachment = report.exchanges.at(-1).response.content.find((item) => item.type === "audio");
  assert(attachment);
  assert.equal(
    hash(Buffer.from(attachment.data, "base64")),
    report.checks["post-retime-late-before-full"].sha256,
  );
  record.lateMCPMatchesCLI = true;
  await projectAudio(original, output, "post-retime-ordinary-full", expected, 2);
  await projectAudio(original, output, "post-retime-window-neighbors", expected, 2, {
    startUs: 250000,
    endUs: 4750000,
  });
  const prepared = await prepare(original);
  await inspect(prepared, 0, 5000000, "post-retime-prepared-full", 1, expected, 2);
  await inspect(prepared, 1250000, 3750000, "post-retime-prepared-plateau", 1, expected, 2);
  await edit("post-retime-split", [
    { operation: "split", clipIds: [retimedTarget.id], atUs: 2000000, scope: "selected" },
  ]);
  await projectAudio(selection(), output, "post-retime-split-plateau", expected, 2);
  const reordered = await edit("post-retime-reorder", [
    { operation: "processing.set", target, steps: [...stack].reverse() },
  ]);
  const reorderedSelection = selection();
  const reorderedStack = (await call("processing.get", { ...selection(), target })).steps;
  assert.deepEqual(
    reorderedStack.map((step) => step.id),
    [...stack].reverse().map((step) => step.id),
  );
  const reorderedPrepared = await prepare(selection());
  assert.notEqual(reorderedPrepared.jobId, prepared.jobId);
  await inspect(reorderedPrepared, 0, 5000000, "post-retime-reordered", 1, reorderedExpected, 2);
  await edit("post-retime-bypass", [
    {
      operation: "processing.set",
      target,
      steps: reorderedStack.map((step) => ({
        ...step,
        enabled: step.processor.type !== "rnnoise",
      })),
    },
  ]);
  await projectAudio(selection(), output, "post-retime-bypass", prefix, 2);
  revision = await call("edit.undo", {
    projectId,
    expectedRevisionId: revision.revisionId,
    requestId: "post-retime-undo",
  });
  assert.deepEqual(revision.document, reordered.revision.document);
  await projectAudio(selection(), output, "post-retime-undo", reorderedExpected, 2);
  await projectAudio(original, output, "post-retime-historical", expected, 2);
  assert.deepEqual(await prepare(original), prepared);
  record.movie = await movieDelivery(original, "post-retime-");
  const matched = await matchedMovieAudio({
    call,
    out,
    canvas,
    name: "post-retime-",
    expected,
    wrong: reorderedExpected,
    range: { startUs: 1000000, endUs: 3000000 },
  });
  Object.assign(record.movie, matched, { wrongOrderAACDiffers: matched.control.differs });
  record.original = original;
  record.reordered = reorderedSelection;
  record.current = selection();
  record.controls = {
    wrongOrderDiffers: true,
    resetAtZeroDiffers: true,
    processBeforeMixDiffers: true,
  };
  record.prepared = prepared;
  record.reorderedPrepared = reorderedPrepared;
  record.acceptedStemFrames = candidate.declaredOutput.frames;
  const capabilities = await call("processing.capabilities", {}, { transport: "mcp" });
  const learnedCapability = capabilities.find((value) => value.type === "rnnoise");
  assert.equal(learnedCapability.execution, true);
  record.recipes = {
    retime: report.checks["post-retime-stem"].ready.published.output.retimeImplementationId,
    rnnoise: learnedCapability.implementationId,
  };
  assert.equal(typeof record.recipes.retime, "string");
  let late;
  for (const file of (await readdir(join(out, "native"))).filter((name) =>
    name.startsWith("mix-"),
  )) {
    const mix = JSON.parse(await readFile(join(out, "native", file), "utf8"));
    if (mix.request.range.start === 168000 && mix.request.range.end === 192000) {
      assert.equal(mix.request.retimeImplementationId, record.recipes.retime);
      assert.equal(mix.request.state.implementationId, record.recipes.rnnoise);
      assert(!mix.request.clips.some((clip) => clip.clipId === retimedTarget.id));
      assert(mix.request.state.clips.some((clip) => clip.clipId === retimedTarget.id));
      assert.equal(mix.response.data.sourceWork.preparedRetimeRuns, 1);
      late = { file, preparedRetimeRuns: 1, retimedInputOnlyInState: true };
    }
  }
  assert(late);
  record.lateStatePreparation = late;
}
