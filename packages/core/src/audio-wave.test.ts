import { spectralWindows } from "./audio-spectrum.js";
import { expect, test } from "vitest";
import { pauseIntervals, readAudioWave, waveformBuckets } from "./audio-wave.js";
import type { RetainedRead } from "./files.js";
function fixture(values: number[][], start = 0, rate = 48000) {
  const channels = values[0]!.length,
    offset = 62,
    bytes = Buffer.alloc(offset + values.length * channels * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("JUNK", 36);
  bytes.writeUInt32LE(9, 40);
  bytes.write("data", 54);
  bytes.writeUInt32LE(values.length * channels * 4, 58);
  values.forEach((row, i) =>
    row.forEach((sample, c) => bytes.writeFloatLE(sample, offset + (i * channels + c) * 4)),
  );
  const reads: { position: number; bytes: number }[] = [];
  const read: RetainedRead = {
    bytes: bytes.length,
    read(buffer, position) {
      const length = Math.min(buffer.length, bytes.length - position);
      buffer.set(bytes.subarray(position, position + length));
      reads.push({ position, bytes: length });
      return length;
    },
    release() {},
  };
  return {
    read,
    reads,
    bytes,
    audio: {
      bytes: bytes.length,
      sampleRate: rate,
      channels: channels as 1 | 2,
      frames: values.length,
      sampleRange: { start, end: start + values.length },
    },
  };
}
test("absolute buckets preserve independent channels and clipped sample windows despite nonstandard WAV header", async () => {
  const f = fixture(
    [
      [1, -1],
      [2, -2],
      [3, -3],
      [4, -4],
      [5, -5],
      [6, -6],
    ],
    3,
  );
  const result = await waveformBuckets(
    f.read,
    f.audio,
    { bucketFrames: 4 },
    new AbortController().signal,
  );
  expect(result).toEqual({
    sampleRate: 48000,
    channels: 2,
    sampleRange: { start: 3, end: 9 },
    bucketFrames: 4,
    buckets: [
      {
        gridStart: 0,
        partial: true,
        sampleRange: { start: 3, end: 4 },
        channels: [
          { min: 1, max: 1, rms: 1 },
          { min: -1, max: -1, rms: 1 },
        ],
      },
      {
        gridStart: 4,
        partial: false,
        sampleRange: { start: 4, end: 8 },
        channels: [
          { min: 2, max: 5, rms: Math.sqrt(13.5) },
          { min: -5, max: -2, rms: Math.sqrt(13.5) },
        ],
      },
      {
        gridStart: 8,
        partial: true,
        sampleRange: { start: 8, end: 9 },
        channels: [
          { min: 6, max: 6, rms: 6 },
          { min: -6, max: -6, rms: 6 },
        ],
      },
    ],
  });
  const ranged = await waveformBuckets(
    f.read,
    f.audio,
    { bucketFrames: 4, sampleRange: { start: 4, end: 8 } },
    new AbortController().signal,
  );
  expect(ranged.buckets).toEqual([result.buckets[1]]);
});

test("pause intervals report contiguous low-energy windows and skip unavailable support", async () => {
  const f = fixture(
    [
      ...Array.from({ length: 4 }, () => [0.5]),
      ...Array.from({ length: 8 }, () => [0]),
      ...Array.from({ length: 4 }, () => [0.5]),
    ],
    0,
    10,
  );
  const result = await pauseIntervals(
    f.read,
    f.audio,
    { windowFrames: 2, hopFrames: 2, thresholdRMS: 0.1, unavailable: [{ start: 8, end: 10 }] },
    new AbortController().signal,
  );
  expect(result.intervals).toEqual([
    { sampleRange: { start: 4, end: 8 }, rms: 0 },
    { sampleRange: { start: 10, end: 12 }, rms: 0 },
  ]);
});

test("resolution cap refuses before reading and fractional source clocks stay sample based", async () => {
  const f = fixture(
    Array.from({ length: 5000 }, (_, i) => [i === 4409 ? 1 : 0]),
    4409,
    44100,
  );
  await expect(
    waveformBuckets(f.read, f.audio, { bucketFrames: 1 }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", details: { maximumBuckets: 4096 } });
  expect(f.reads).toEqual([]);
  const result = await waveformBuckets(
    f.read,
    f.audio,
    { bucketFrames: 441, sampleRange: { start: 8817, end: 8821 } },
    new AbortController().signal,
  );
  expect(result.buckets).toEqual([
    {
      gridStart: 8379,
      partial: true,
      sampleRange: { start: 8817, end: 8820 },
      channels: [{ min: 0, max: 1, rms: Math.sqrt(1 / 3) }],
    },
    {
      gridStart: 8820,
      partial: true,
      sampleRange: { start: 8820, end: 8821 },
      channels: [{ min: 0, max: 0, rms: 0 }],
    },
  ]);
});

test("yields bounded sample blocks and cancellation does not read the remaining PCM", async () => {
  const f = fixture(Array.from({ length: 20000 }, () => [0.25, -0.5]));
  const abort = new AbortController();
  const read: RetainedRead = {
    ...f.read,
    read(buffer, position) {
      const result = f.read.read(buffer, position);
      if (buffer.length > 64) setImmediate(() => abort.abort());
      return result;
    },
  };
  await expect(
    waveformBuckets(read, f.audio, { bucketFrames: 20000 }, abort.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const samples = f.reads.filter((r) => r.position >= 62);
  expect(samples).toEqual([{ position: 62, bytes: 8192 * 8 }]);
});

test("refuses nonfinite samples and mismatched WAV metadata instead of emitting misleading energy", async () => {
  const f = fixture([[Infinity, 0]]);
  await expect(
    waveformBuckets(f.read, f.audio, { bucketFrames: 1 }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  f.bytes.writeUInt32LE(44100, 24);
  await expect(
    waveformBuckets(f.read, f.audio, { bucketFrames: 1 }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

test("late subset of a >1GiB published WAV uses only positioned bounded reads and holds its lease across yields", async () => {
  const { mkdtemp, open, rm } = await import("node:fs/promises");
  const { Catalog } = await import("./catalog.js");
  const { DerivedCache } = await import("./cache.js");
  const home = await mkdtemp("/tmp/acoustic-cache-"),
    catalog = new Catalog(home + "/catalog.sqlite");
  try {
    const cache = new DerivedCache(catalog, home, () => {});
    await cache.reconcile();
    const output = cache.reserve({ kind: "asset", id: "fixture" });
    const f = fixture([[0, 0]]),
      frames = 144000000,
      total = 62 + frames * 8;
    f.bytes.writeUInt32LE(total - 8, 4);
    f.bytes.writeUInt32LE(frames * 8, 58);
    const file = await open(output.path, "wx");
    try {
      await file.write(f.bytes.subarray(0, 62));
      await file.truncate(total);
      const impulse = Buffer.alloc(8);
      impulse.writeFloatLE(0.75);
      impulse.writeFloatLE(-0.5, 4);
      await file.write(impulse, 0, 8, total - 16);
    } finally {
      await file.close();
    }
    await cache.publish(output.id);
    const lease = cache.acquire(output.id)!;
    expect(lease.bytes).toBeGreaterThan(1024 ** 3);
    const reads: { position: number; bytes: number }[] = [];
    const input: RetainedRead = {
      ...lease,
      read(buffer, position) {
        reads.push({ position, bytes: buffer.length });
        return lease.read(buffer, position);
      },
    };
    try {
      const pending = waveformBuckets(
        input,
        { ...f.audio, bytes: total, frames, sampleRange: { start: 0, end: frames } },
        { bucketFrames: 10, sampleRange: { start: frames - 10, end: frames } },
        new AbortController().signal,
      );
      expect(() => cache.remove(output.id)).toThrow(
        expect.objectContaining({ code: "CACHE_BUSY" }),
      );
      const result = await pending;
      expect(result.buckets).toEqual([
        {
          gridStart: frames - 10,
          sampleRange: { start: frames - 10, end: frames },
          partial: false,
          channels: [
            { min: 0, max: 0.75, rms: Math.sqrt(0.75 ** 2 / 10) },
            { min: -0.5, max: 0, rms: Math.sqrt(0.5 ** 2 / 10) },
          ],
        },
      ]);
      expect(reads.filter((r) => r.position >= 62)).toEqual([{ position: total - 80, bytes: 80 }]);
      reads.length = 0;
      const spectral = await spectralWindows(
        input,
        { ...f.audio, bytes: total, frames, sampleRange: { start: 0, end: frames } },
        {
          fftFrames: 16,
          hopFrames: 16,
          window: "rectangular",
          sampleRange: { start: frames - 16, end: frames },
        },
        new AbortController().signal,
      );
      expect(spectral.columns[0]).toMatchObject({
        sampleRange: { start: frames - 16, end: frames },
        analysis: { start: frames - 16, end: frames },
        available: { start: frames - 16, end: frames },
        partial: false,
      });
      for (let channel = 0; channel < 2; channel++)
        for (let bin = 0; bin < 9; bin++)
          expect(spectral.density[channel * 9 + bin]).toBeCloseTo(
            ((channel === 0 ? 0.75 ** 2 : 0.5 ** 2) / (48000 * 16)) *
              (bin === 0 || bin === 8 ? 1 : 2),
            14,
          );
      expect(reads.filter((r) => r.position >= 62)).toEqual([
        { position: total - 128, bytes: 128 },
      ]);
    } finally {
      lease.release();
    }
    const canceledLease = cache.acquire(output.id)!;
    const abort = new AbortController();
    const canceledRead: RetainedRead = {
      ...canceledLease,
      read(buffer, position) {
        const read = canceledLease.read(buffer, position);
        if (buffer.length > 64) setImmediate(() => abort.abort());
        return read;
      },
    };
    try {
      const pending = waveformBuckets(
        canceledRead,
        { ...f.audio, bytes: total, frames, sampleRange: { start: 0, end: frames } },
        { bucketFrames: 20000, sampleRange: { start: frames - 20000, end: frames } },
        abort.signal,
      );
      expect(() => cache.remove(output.id)).toThrow(
        expect.objectContaining({ code: "CACHE_BUSY" }),
      );
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(() => cache.remove(output.id)).toThrow(
        expect.objectContaining({ code: "CACHE_BUSY" }),
      );
    } finally {
      canceledLease.release();
    }
    cache.remove(output.id);
    expect(cache.acquire(output.id)).toBeNull();
  } finally {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("complete Float32 WAV dimensions come from bytes rather than rounded duration", () => {
  const f = fixture([[0.25], [-0.5], [1]], 0, 44100);
  expect(readAudioWave(f.read)).toMatchObject({
    bytes: f.bytes.length,
    sampleRate: 44100,
    channels: 1,
    frames: 3,
    dataOffset: 62,
    dataBytes: 12,
  });
  expect(f.reads.every((read) => read.position < 62)).toBe(true);
});
