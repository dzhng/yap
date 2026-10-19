import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash, poll } from "./source-evidence-fixture.mjs";
import { waveHeader } from "./audio-project-fixture.mjs";

export async function verifyAcousticRetiming({ out, call, delivered, pixels }) {
  const rate = 48000,
    sourceFrames = 96000,
    occurrenceFrames = 120000;
  const source = Buffer.alloc(44 + sourceFrames * 8);
  source.write("RIFF");
  source.writeUInt32LE(source.length - 8, 4);
  source.write("WAVEfmt ", 8);
  source.writeUInt32LE(16, 16);
  source.writeUInt16LE(3, 20);
  source.writeUInt16LE(2, 22);
  source.writeUInt32LE(rate, 24);
  source.writeUInt32LE(rate * 8, 28);
  source.writeUInt16LE(8, 32);
  source.writeUInt16LE(32, 34);
  source.write("data", 36);
  source.writeUInt32LE(sourceFrames * 8, 40);
  for (let i = 0; i < sourceFrames; i++)
    for (let c = 0; c < 2; c++) {
      const burst = c === 1 && ((i >= 24000 && i < 24240) || (i >= 72000 && i < 72240));
      source.writeFloatLE(
        Math.fround(burst ? 0.75 : 0.01 * Math.cos((2 * Math.PI * (c ? 3750 : 1875) * i) / rate)),
        44 + i * 8 + c * 4,
      );
    }
  const sourcePath = join(out, "retimed-reference.wav");
  await writeFile(sourcePath, source);
  const importing = await call("asset.import", { requestId: randomUUID(), path: sourcePath });
  await poll(
    () => call("job.get", { jobId: importing.jobId }),
    (v) => v.state === "ready",
    "retimed source",
  );
  const asset = await call("asset.get", { assetId: hash(source) });
  const streamId = asset.streams.find((s) => s.kind === "audio").streamId;
  const report = { sourceSha256: hash(source), cases: [], listening: false };
  const audio = async (params, name) => {
    const path = join(out, `${name}.wav`);
    await poll(
      () => call("audio.get", params),
      (v) => v.state === "ready",
      name,
    );
    const receipt = await call("audio.get", params, { output: path });
    const bytes = await readFile(path),
      header = waveHeader(bytes, bytes.length);
    return {
      pcm: bytes.subarray(header.offset),
      receipt,
      sha256: hash(bytes),
      frames: header.frames,
    };
  };
  for (const pitch of ["preserve", "follow"]) {
    const created = await call("project.create", {
      requestId: randomUUID(),
      title: `Acoustic ${pitch}`,
      canvas: {
        width: 32,
        height: 32,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const projectId = created.project.projectId;
    const placed = await call("edit.apply", {
      projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: randomUUID(),
      operations: [
        { operation: "track.add", label: "track", track: { kind: "audio", order: 0 } },
        ...[0, 2500000].map((startUs, i) => ({
          operation: "place",
          label: `clip${i}`,
          clip: {
            trackId: { label: "track" },
            assetId: asset.assetId,
            streamId,
            source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
            placement: { kind: "project", range: { startUs, endUs: startUs + 2000000 } },
          },
        })),
        ...[0, 1].map((i) => ({
          operation: "retime",
          clipIds: [{ label: `clip${i}` }],
          durationUs: 2500000,
          scope: "selected",
          pitch,
          ripple: "none",
        })),
      ],
    });
    const selection = { projectId, revisionId: placed.revision.revisionId };
    const full = await audio(selection, `${pitch}-full`);
    assert.equal(full.frames, occurrenceFrames * 2);
    assert.deepEqual(
      full.pcm.subarray(0, occurrenceFrames * 8),
      full.pcm.subarray(occurrenceFrames * 8),
    );
    const range = { startUs: 333333, endUs: 4199999 };
    const left = Math.floor((range.startUs * rate) / 1000000),
      right = Math.floor((range.endUs * rate) / 1000000);
    const part = await audio({ ...selection, range }, `${pitch}-range`);
    assert.deepEqual(part.pcm, full.pcm.subarray(left * 8, right * 8));
    const bucketFrames = 240;
    const overview = await delivered("waveform.get", { ...selection, bucketFrames });
    const detail = await delivered("waveform.get", { ...selection, range, bucketFrames });
    const verify = (document, start, end) => {
      assert.deepEqual(document.sampleRange, { start, end });
      let next = start;
      for (const b of document.buckets) {
        assert.equal(b.sampleRange.start, next);
        assert.equal(b.gridStart, Math.floor(next / bucketFrames) * bucketFrames);
        const stop = Math.min(end, b.gridStart + bucketFrames);
        assert.equal(b.sampleRange.end, stop);
        assert.equal(b.partial, stop - next !== bucketFrames);
        for (let c = 0; c < 2; c++) {
          const values = Array.from({ length: stop - next }, (_, i) =>
            full.pcm.readFloatLE((next + i) * 8 + c * 4),
          );
          assert.deepEqual(b.channels[c], {
            min: Math.min(...values),
            max: Math.max(...values),
            rms: Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length),
          });
        }
        next = stop;
      }
      assert.equal(next, end);
    };
    verify(overview.document, 0, full.frames);
    verify(detail.document, left, right);
    assert.throws(
      () =>
        verify(
          {
            ...detail.document,
            buckets: detail.document.buckets.map((b) => ({ ...b, partial: true })),
          },
          left,
          right,
        ),
      assert.AssertionError,
    );
    for (const b of detail.document.buckets.filter((b) => !b.partial))
      assert.deepEqual(
        b,
        overview.document.buckets.find((v) => v.gridStart === b.gridStart),
      );
    const images = [];
    for (const [view, bounds] of [
      ["full", undefined],
      ["range", range],
    ]) {
      const params = { ...selection, ...(bounds ? { range: bounds } : {}) };
      const waveform = await delivered("waveform.get", {
        ...params,
        bucketFrames,
        format: "image",
      });
      const spectrum = await delivered("spectrogram.get", {
        ...params,
        fftFrames: 512,
        hopFrames: 512,
      });
      const a = waveform.metadata,
        b = spectrum.metadata;
      const start = bounds ? left : 0,
        end = bounds ? right : full.frames;
      for (const m of [a, b]) {
        assert.deepEqual(m.sampleRange, { startSamples: start, endSamples: end });
        assert.equal(m.revisionId, selection.revisionId);
      }
      const wp = await pixels(waveform),
        sp = await pixels(spectrum);
      const transientChecks = [];
      for (const expected of [30000, 90000, 150000, 210000].filter((i) => i >= start && i < end)) {
        // The accepted stretch owns transient shape; the image must show the actual PCM maximum.
        let peak = expected - 2400;
        for (let i = peak + 1; i < expected + 2400; i++)
          if (
            Math.abs(full.pcm.readFloatLE(i * 8 + 4)) > Math.abs(full.pcm.readFloatLE(peak * 8 + 4))
          )
            peak = i;
        assert(Math.abs(peak - expected) < 1200, "Known event escaped its retimed neighborhood");
        const bucketStart = Math.floor(peak / bucketFrames) * bucketFrames;
        const x =
          a.plotLeft + ((bucketStart + bucketFrames / 2 - start) / (end - start)) * a.plotWidth;
        const amplitude = full.pcm.readFloatLE(peak * 8 + 4);
        const y =
          a.plotTop +
          a.panelStride +
          a.panelHeight / 2 -
          ((amplitude / a.amplitudeLimit) * a.panelHeight) / 2;
        const hit = (at) =>
          assert(
            wp(at, y + Math.sign(amplitude) * 2)[2] < 230,
            "Retimed waveform misses PCM transient",
          );
        hit(x);
        assert.throws(() => hit(x + a.plotWidth * 0.1), assert.AssertionError);
        const spectralCenter = Math.floor(peak / 512) * 512 + 256;
        const spectralX = b.plotLeft + ((spectralCenter - start) / (end - start)) * b.plotWidth;
        const spectralY = b.plotTop + b.panelStride + b.panelHeight / 2;
        const strength = (at) => Math.max(...[-1, 0, 1].map((d) => sp(at, spectralY + d)[0]));
        const signal = strength(spectralX),
          wrongTime = strength(spectralX + b.plotWidth * 0.1);
        const timeHit = (at) =>
          assert(strength(at) > 10, "Spectrogram misses localized PCM transient");
        timeHit(spectralX);
        assert.throws(() => timeHit(spectralX + b.plotWidth * 0.1), assert.AssertionError);
        transientChecks.push({
          expectedSample: expected,
          actualPeakSample: peak,
          expectedX: x,
          spectralCenter,
          spectralX,
          spectralSignal: signal,
          spectralWrongTime: wrongTime,
          wrongTimeRejected: true,
        });
      }
      const toneChecks = [];
      for (const seconds of [1, 3.5])
        for (let c = 0; c < 2; c++) {
          const hz = (c ? 3750 : 1875) * (pitch === "follow" ? 0.8 : 1),
            bin = hz / 93.75;
          const first = Math.floor((seconds * rate) / 512) * 512;
          let re = 0,
            im = 0,
            energy = 0;
          for (let n = 0; n < 512; n++) {
            const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / 512),
              v = full.pcm.readFloatLE((first + n) * 8 + c * 4) * w;
            re += v * Math.cos((2 * Math.PI * bin * n) / 512);
            im -= v * Math.sin((2 * Math.PI * bin * n) / 512);
            energy += w * w;
          }
          const density = (2 * (re * re + im * im)) / (rate * energy);
          const intensity = Math.round(
            255 *
              Math.max(
                0,
                Math.min(
                  1,
                  (10 * Math.log10(density) - b.densityFloorDb) /
                    (b.densityCeilingDb - b.densityFloorDb),
                ),
              ),
          );
          assert(intensity > 10 && intensity < 245, "Tone oracle saturated or invisible");
          const x = b.plotLeft + ((seconds * rate - start) / (end - start)) * b.plotWidth;
          const y = b.plotTop + c * b.panelStride + b.panelHeight * (1 - hz / (rate / 2));
          const actual = sp(x, y)[0];
          assert(
            Math.abs(actual - intensity) <= 3,
            `Retimed spectral power ${pitch}/${view}/${c}: ${actual} != ${intensity}`,
          );
          const wrongHz = hz * (pitch === "follow" ? 1.25 : 0.8);
          const wrongY = b.plotTop + c * b.panelStride + b.panelHeight * (1 - wrongHz / (rate / 2));
          assert.throws(
            () => assert(Math.abs(sp(x, wrongY)[0] - intensity) <= 3),
            assert.AssertionError,
          );
          toneChecks.push({
            seconds,
            channel: c,
            hz,
            expectedIntensity: intensity,
            actualIntensity: actual,
            expectedY: y,
            wrongPitchRejected: true,
          });
        }
      images.push({
        view,
        waveform: waveform.name,
        spectrum: spectrum.name,
        transientChecks,
        toneChecks,
      });
    }
    const split = await call("edit.apply", {
      projectId,
      expectedRevisionId: placed.revision.revisionId,
      requestId: randomUUID(),
      operations: [{ operation: "split", clipIds: [placed.edit.labels.clip0], atUs: 1234567 }],
    });
    const splitSelection = { projectId, revisionId: split.revision.revisionId };
    const splitAudio = await audio(splitSelection, `${pitch}-split`);
    assert.deepEqual(splitAudio.pcm, full.pcm);
    const splitBuckets = await delivered("waveform.get", { ...splitSelection, bucketFrames });
    assert.deepEqual(splitBuckets.document.buckets, overview.document.buckets);
    report.cases.push({
      pitch,
      selection,
      fullSha256: full.sha256,
      rangeSha256: part.sha256,
      frames: full.frames,
      repeatedPCM: true,
      fullRangePCM: true,
      fullRangeBuckets: true,
      splitPCMAndBuckets: true,
      incorrectPartialFlagsRejected: true,
      images,
    });
  }
  return report;
}
