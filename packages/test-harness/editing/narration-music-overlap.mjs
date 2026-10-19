import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash, poll } from "./source-evidence-fixture.mjs";

export async function verifyNarrationMusic({
  out,
  call,
  audio,
  frame,
  selection,
  document,
  before,
  inputs,
}) {
  const rate = 48000,
    frames = rate * 3,
    placement = { startUs: 3000000, endUs: 6000000 },
    gain = 0.25;
  const bed = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++) {
      const envelope = Math.max(0, Math.min(1, i / 4800, (frames - 1 - i) / 4800));
      const chord = [220, 275, 330].reduce(
        (sum, hz) => sum + Math.sin((2 * Math.PI * hz * (c + 1) * i) / rate),
        0,
      );
      bed.writeFloatLE((envelope * chord) / 32, i * 8 + c * 4);
    }
  const wav = Buffer.alloc(44 + bed.length);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 8, 28);
  wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(bed.length, 40);
  bed.copy(wav, 44);
  const path = join(out, "synthetic-chord-bed.wav");
  await writeFile(path, wav);
  const report = {
    passed: false,
    scope:
      "Recorded narration plus explicitly authored synthetic musical fixture; no listening judgment",
    gain,
    placement,
    inputSha256: hash(wav),
    requests: [],
    deliveries: [],
  };
  const request = async (operation, params) => {
    const result = await call(operation, params, { transport: "mcp" });
    report.requests.push({ operation, params, result });
    return result;
  };
  const delivered = async (selected, name, range) => {
    report.deliveries.push({
      operation: "audio.get",
      selection: { ...selected },
      name,
      range: range ?? { startUs: 0, endUs: (before.pcm.length / 8 / rate) * 1000000 },
    });
    const result = await audio(selected, name, range);
    return result.pcm;
  };
  const equal = (actual, expected) =>
    assert.equal(
      Buffer.compare(actual, expected),
      0,
      "Every mixed Float32 sample must match the independently authored sum",
    );
  const expected = (level) => {
    const pcm = Buffer.from(before.pcm);
    for (let i = 0; i < bed.length; i += 4) {
      const position = 3 * rate * 8 + i;
      pcm.writeFloatLE(
        Math.fround(before.pcm.readFloatLE(position) + Math.fround(bed.readFloatLE(i) * level)),
        position,
      );
    }
    return pcm;
  };
  try {
    const imported = await request("asset.import", { requestId: "music-source", path });
    const job = await poll(
      () => request("job.get", { jobId: imported.jobId }),
      (v) => v.state === "ready",
      "music import",
    );
    const asset = await request("asset.get", { assetId: job.published.output.assetId });
    const stream = asset.streams.find((s) => s.kind === "audio");
    const pictureBefore = await frame(selection, "music-picture-before");
    const added = await request("edit.apply", {
      projectId: selection.projectId,
      expectedRevisionId: selection.revisionId,
      requestId: "add-music",
      operations: [
        { operation: "track.add", label: "musicTrack", track: { kind: "audio", order: 1 } },
        {
          operation: "place",
          label: "musicClip",
          clip: {
            trackId: { label: "musicTrack" },
            assetId: asset.assetId,
            streamId: stream.streamId,
            source: { kind: "range", range: { startUs: 0, endUs: 3000000 } },
            placement: { kind: "project", range: placement },
            pitch: "preserve",
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "musicClip" } },
          steps: [{ processor: { type: "gain", gain } }],
        },
      ],
    });
    const mixedSelection = {
      projectId: selection.projectId,
      revisionId: added.revision.revisionId,
    };
    for (const clip of document.clips)
      assert.deepEqual(
        added.revision.document.clips.find((c) => c.id === clip.id),
        clip,
      );
    for (const track of document.tracks)
      assert.deepEqual(
        added.revision.document.tracks.find((t) => t.id === track.id),
        track,
      );
    assert.equal(await frame(mixedSelection, "music-picture-after"), pictureBefore);
    const target = expected(gain),
      mixed = await delivered(mixedSelection, "music-mixed-full");
    equal(mixed, target);
    equal(mixed.subarray(0, 3 * rate * 8), before.pcm.subarray(0, 3 * rate * 8));
    equal(mixed.subarray(6 * rate * 8), before.pcm.subarray(6 * rate * 8));
    const range = { startUs: 2500000, endUs: 6500000 };
    equal(
      await delivered(mixedSelection, "music-mixed-range", range),
      target.subarray(120000 * 8, 312000 * 8),
    );
    report.negatives = [];
    for (const [name, level] of [
      ["muted", 0],
      ["wrong-gain", 0.5],
    ]) {
      const changed = await request("edit.apply", {
        projectId: selection.projectId,
        expectedRevisionId: mixedSelection.revisionId,
        requestId: `music-${name}`,
        operations: [
          {
            operation: "processing.set",
            target: { kind: "clip", id: added.edit.labels.musicClip },
            steps: [{ processor: { type: "gain", gain: level } }],
          },
        ],
      });
      const changedSelection = {
        projectId: selection.projectId,
        revisionId: changed.revision.revisionId,
      };
      const negative = await delivered(changedSelection, `music-${name}`);
      equal(negative, expected(level));
      assert.throws(() => equal(negative, target), assert.AssertionError);
      report.negatives.push({
        name,
        gain: level,
        rejectedByExpectedMix: true,
        pcmSha256: hash(negative),
      });
      const undone = await request("edit.undo", {
        projectId: selection.projectId,
        expectedRevisionId: changed.revision.revisionId,
        requestId: `undo-${name}`,
      });
      assert.deepEqual(undone.document, added.revision.document);
      equal(
        await delivered(
          { projectId: selection.projectId, revisionId: undone.revisionId },
          `music-${name}-undo`,
        ),
        target,
      );
      mixedSelection.revisionId = undone.revisionId;
    }
    const undone = await request("edit.undo", {
      projectId: selection.projectId,
      expectedRevisionId: mixedSelection.revisionId,
      requestId: "undo-music",
    });
    assert.deepEqual(undone.document, document);
    equal(
      await delivered(
        { projectId: selection.projectId, revisionId: undone.revisionId },
        "music-removed-undo",
      ),
      before.pcm,
    );
    for (const input of inputs) assert.equal(hash(await readFile(input.path)), input.sha256);
    report.expectedPCMHash = hash(target);
    report.mixedPCMHash = hash(mixed);
    report.checks = {
      everyMixedSample: true,
      dryNeighbors: true,
      rangedDeliveryMatchesFull: true,
      originalClipsAndTracksUnchanged: true,
      videoPixelsUnchanged: true,
      publicGainNegatives: true,
      undoRestoresNarration: true,
      sourceFilesUnchanged: true,
    };
    report.passed = true;
    return report;
  } finally {
    await writeFile(join(out, "music-overlap.json"), JSON.stringify(report, null, 2) + "\n");
  }
}
