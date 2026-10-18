import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash, poll, run } from "./source-evidence-fixture.mjs";
import { waveHeader } from "./audio-project-fixture.mjs";

export async function verifyAcousticRateAxes({ out, call, delivered }) {
  const nativeRate = 44100,
    duration = 1000000,
    clickTime = 640000,
    frequencies = [4410, 11025];
  const source = Buffer.alloc(44 + nativeRate * 8);
  source.write("RIFF");
  source.writeUInt32LE(source.length - 8, 4);
  source.write("WAVEfmt ", 8);
  source.writeUInt32LE(16, 16);
  source.writeUInt16LE(3, 20);
  source.writeUInt16LE(2, 22);
  source.writeUInt32LE(nativeRate, 24);
  source.writeUInt32LE(nativeRate * 8, 28);
  source.writeUInt16LE(8, 32);
  source.writeUInt16LE(32, 34);
  source.write("data", 36);
  source.writeUInt32LE(nativeRate * 8, 40);
  for (let frame = 0; frame < nativeRate; frame++)
    for (let c = 0; c < 2; c++)
      source.writeFloatLE(
        frame === 28224 && c === 1
          ? 0.75
          : (0.125 / 1024) * Math.cos((2 * Math.PI * frequencies[c] * frame) / nativeRate),
        44 + frame * 8 + c * 4,
      );
  const path = join(out, "rate-44100-reference.wav");
  await writeFile(path, source);
  const imported = await call("asset.import", { requestId: randomUUID(), path });
  await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "rate source import",
  );
  const asset = await call("asset.get", { assetId: hash(source) }),
    stream = asset.streams.find((s) => s.kind === "audio");
  assert.equal(stream.sampleRate, nativeRate);
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const edited = await call("edit.apply", {
    requestId: randomUUID(),
    projectId,
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", label: "track", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: stream.id,
          source: { kind: "range", range: { startUs: 0, endUs: duration } },
          placement: { kind: "project", range: { startUs: 0, endUs: duration } },
        },
      },
    ],
  });
  const report = {
    sourceSHA256: hash(source),
    projectId,
    revisionId: edited.revision.revisionId,
    clickTime,
    frequencies,
    views: [],
    listening: false,
  };
  const range = { startUs: 333333, endUs: 799999 };
  try {
    for (const [name, selection, rate] of [
      ["source", { assetId: asset.id, streamId: stream.id }, nativeRate],
      ["project", { projectId, revisionId: edited.revision.revisionId }, 48000],
    ]) {
      const fullPath = join(out, `rate-${name}-full.wav`),
        rangePath = join(out, `rate-${name}-range.wav`);
      const fullReceipt = await poll(
        () => call("audio.get", selection, { output: fullPath }),
        (v) => v.state === "ready",
        `${name} audio`,
      );
      const rangeReceipt = await poll(
        () => call("audio.get", { ...selection, range }, { output: rangePath }),
        (v) => v.state === "ready",
        `${name} range audio`,
      );
      const full = await readFile(fullPath),
        part = await readFile(rangePath),
        fh = waveHeader(full, full.length, rate),
        ph = waveHeader(part, part.length, rate);
      const start = Math.floor((range.startUs * rate) / 1000000),
        end = Math.floor((range.endUs * rate) / 1000000);
      assert.equal(fh.frames, rate);
      assert.equal(ph.frames, end - start);
      assert.deepEqual(
        part.subarray(ph.offset),
        full.subarray(fh.offset + start * 8, fh.offset + end * 8),
      );
      if (name === "source") assert.deepEqual(full.subarray(fh.offset), source.subarray(44));
      const sample = (i, c) => full.readFloatLE(fh.offset + i * 8 + c * 4);
      let peakIndex = 0;
      for (let i = 0; i < rate; i++)
        if (Math.abs(sample(i, 1)) > Math.abs(sample(peakIndex, 1))) peakIndex = i;
      assert.equal(peakIndex, (rate * clickTime) / 1000000, "Resampling moved the known impulse");
      const bucketFrames = rate === 44100 ? 441 : 480;
      const overview = await delivered("waveform.get", { ...selection, bucketFrames }, rate);
      const detail = await delivered("waveform.get", { ...selection, range, bucketFrames }, rate);
      const checkBuckets = (document, left, right) => {
        assert.deepEqual(document.sampleRange, { start: left, end: right });
        let next = left;
        for (const b of document.buckets) {
          assert.equal(b.sampleRange.start, next);
          const stop = Math.min(right, b.gridStart + bucketFrames);
          assert.equal(b.sampleRange.end, stop);
          assert.equal(b.gridStart, Math.floor(next / bucketFrames) * bucketFrames);
          assert.equal(b.partial, stop - next !== bucketFrames);
          for (let c = 0; c < 2; c++) {
            const values = Array.from({ length: stop - next }, (_, j) => sample(next + j, c));
            assert.deepEqual(b.channels[c], {
              min: Math.min(...values),
              max: Math.max(...values),
              rms: Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length),
            });
          }
          next = stop;
        }
        assert.equal(next, right);
      };
      checkBuckets(overview.document, 0, rate);
      checkBuckets(detail.document, start, end);
      for (const b of detail.document.buckets.filter((b) => !b.partial))
        assert.deepEqual(
          b,
          overview.document.buckets.find((v) => v.gridStart === b.gridStart),
        );
      const waveform = await delivered(
        "waveform.get",
        { ...selection, range, bucketFrames, format: "image" },
        rate,
      );
      const spectrum = await delivered(
        "spectrogram.get",
        { ...selection, range, fftFrames: 1024, hopFrames: 512 },
        rate,
      );
      for (const image of [waveform, spectrum])
        assert.deepEqual(image.metadata.sampleRange, { start, end });
      const imagePixels = async (image) => {
        const { stdout } = await run(
          "ffmpeg",
          ["-v", "error", "-i", join(out, image.name), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
          { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
        );
        const m = image.metadata;
        assert.equal(stdout.length, m.width * m.height * 3);
        return (x, y) => stdout[(Math.floor(y) * m.width + Math.floor(x)) * 3];
      };
      const wp = await imagePixels(waveform),
        w = waveform.metadata;
      const expectedX = w.plotLeft + ((peakIndex - start) / (end - start)) * w.plotWidth;
      const peakY =
        w.plotTop +
        w.panelStride +
        w.panelHeight / 2 -
        ((Math.abs(sample(peakIndex, 1)) / w.amplitudeLimit) * w.panelHeight) / 2;
      const checkImpulse = (x) =>
        assert(wp(x + 1, peakY + 2) < 230, "Waveform image misses known impulse");
      checkImpulse(expectedX);
      const shiftedX = expectedX + ((0.02 * rate) / (end - start)) * w.plotWidth;
      assert.throws(() => checkImpulse(shiftedX), assert.AssertionError);
      assert(wp(expectedX + 1, peakY - 3) > 240, "Waveform image exceeds known amplitude");
      const sp = await imagePixels(spectrum),
        m = spectrum.metadata;
      const x = m.plotLeft + ((0.41 * rate - start) / (end - start)) * m.plotWidth;
      const positions = [];
      for (let c = 0; c < 2; c++) {
        const y = m.plotTop + c * m.panelStride + m.panelHeight * (1 - frequencies[c] / (rate / 2));
        const otherY =
          m.plotTop + c * m.panelStride + m.panelHeight * (1 - frequencies[1 - c] / (rate / 2));
        // Neighbor rows cover rasterized frequency-bin extent, not a changed time/frequency tolerance.
        const strength = Math.max(...[-1, 0, 1].map((d) => sp(x, y + d))),
          wrong = Math.max(...[-1, 0, 1].map((d) => sp(x, otherY + d)));
        assert(strength > wrong + 10, `Known channel tone missing/misplaced (${name}/${c})`);
        const incorrectRate = rate === 44100 ? 48000 : 44100;
        const incorrectY =
          m.plotTop +
          c * m.panelStride +
          m.panelHeight * (1 - frequencies[c] / (incorrectRate / 2));
        const incorrectStrength = Math.max(...[-1, 0, 1].map((d) => sp(x, incorrectY + d)));
        if (c === 1)
          assert.throws(() => assert(incorrectStrength > wrong + 10), assert.AssertionError);
        positions.push({
          incorrectRate,
          incorrectY,
          incorrectStrength,
          frequency: frequencies[c],
          expectedY: y,
          strength,
          wrongChannelFrequencyStrength: wrong,
        });
      }
      report.views.push({
        name,
        rate,
        fullReceipt,
        rangeReceipt,
        fullSHA256: hash(full),
        rangeSHA256: hash(part),
        sampleRange: { start, end },
        peakIndex,
        peakSeconds: peakIndex / rate,
        bucketFrames,
        waveform: waveform.name,
        spectrum: spectrum.name,
        expectedX,
        negativeControls: { shiftedImpulseRejected: true, wrongNyquistRejected: true },
        positions,
        fullRangePCMExact: true,
        fullRangeBucketsExact: true,
      });
    }
    report.passed = true;
    return report;
  } catch (error) {
    report.error = String(error.stack ?? error);
    throw error;
  } finally {
    await writeFile(join(out, "rate-axes.json"), JSON.stringify(report, null, 2) + "\n");
    await call("project.delete", { projectId });
  }
}
