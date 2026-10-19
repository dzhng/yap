import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import type { OperationResult } from "@yap/protocol";
import { projectServiceFixture } from "./project-service.fixture.js";
import type { MediaWorker } from "./worker.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

// One Float32 mono sample at 0.25, 48 kHz.
const wave = Buffer.from(
  "524946462800000057415645666d7420100000000300010080bb000000ee02000400200064617461040000000000803e",
  "hex",
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
const failure = (message: string) => ({
  ok: false as const,
  error: { code: "MEDIA_WORKER_FAILED", message, retryable: true, details: {} },
});

/** A one-sample audio asset whose native PCM and acoustic-image calls can each fail once. */
async function fixture(fail: { audio?: boolean; image?: boolean }) {
  const calls: string[] = [];
  const worker: MediaWorker = async (operation, params) => {
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 0,
          streams: [
            {
              id: "audio:1",
              kind: "audio",
              codec: "pcm",
              decodable: true,
              startUs: 0,
              endUs: 21,
              sampleRate: 48000,
              channels: 1,
              segments: [{ startUs: 0, endUs: 21, empty: false }],
            },
          ],
        },
      };
    calls.push(operation);
    if (operation === "media.sourceAudio") {
      if (fail.audio) {
        fail.audio = false;
        return failure("controlled PCM failure");
      }
      await writeFile(params.output as string, wave, { flag: "wx" });
      return {
        ok: true,
        data: {
          file: params.output,
          mediaType: "audio/wav",
          bytes: wave.length,
          sampleRate: 48000,
          channels: 1,
          layout: "mono",
          range: params.range,
          sampleRange: { start: 0, end: 1 },
          frames: 1,
          decodedFrames: 1,
          unavailable: [],
        },
      };
    }
    if (operation === "media.acousticImage") {
      if (fail.image) {
        fail.image = false;
        return failure("controlled acoustic image failure");
      }
      const request = JSON.parse(await readFile(params.input as string, "utf8")) as {
        output: string;
        provenance: string[];
      };
      await writeFile(request.output, png, { flag: "wx" });
      // Geometry is the native renderer's; this edge proves recovery, not plot layout.
      return {
        ok: true,
        data: {
          file: request.output,
          mediaType: "image/png",
          width: 1,
          height: 1,
          bytes: png.length,
          provenance: request.provenance,
          plotLeft: 0,
          plotWidth: 1,
          plotTop: 0,
          panelHeight: 1,
          panelStride: 1,
        },
      };
    }
    throw new Error(`Unexpected native operation ${operation}`);
  };
  const f = await projectServiceFixture(cleanups, worker);
  const imported = await f.call("asset.import", { requestId: "acoustic-source", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const assetId = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
    .output.assetId;
  return { ...f, calls, params: { assetId, streamId: "audio:1" } };
}
type Acoustic = {
  state: string;
  jobId: string | null;
  retryable?: boolean;
  dependency: { jobId: string | null; state: string };
  published: { artifact: unknown } | null;
  delivery: { token: string } | null;
};
function data(result: OperationResult) {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data as Acoustic;
}
/** Polls an acoustic read until it reaches `state`, failing fast on any other terminal state. */
async function until(
  f: Awaited<ReturnType<typeof fixture>>,
  operation: string,
  state: "ready" | "failed",
) {
  const deadline = performance.now() + 3000;
  for (;;) {
    const status = data(await f.call(operation, f.params));
    if (status.state === state) return status;
    if (status.state === (state === "ready" ? "failed" : "ready"))
      throw new Error(`${operation} became ${status.state}: ${JSON.stringify(status)}`);
    if (performance.now() >= deadline)
      throw new Error(`${operation} never reached ${state}: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a waveform whose audio prerequisite failed recovers through job.retry on the jobId its status returns", async () => {
  const f = await fixture({ audio: true });
  const pending = data(await f.call("waveform.get", f.params));
  expect(pending.jobId).toEqual(expect.any(String));
  const failed = await until(f, "waveform.get", "failed");
  // Until audio publishes there is no measurement job; the status names the failed audio job.
  expect(failed).toMatchObject({
    jobId: pending.jobId,
    retryable: true,
    dependency: { jobId: pending.jobId, state: "failed" },
    published: null,
  });
  // Ordinary reads never restart terminal work.
  data(await f.call("waveform.get", f.params));
  expect(f.calls.filter((call) => call === "media.sourceAudio")).toHaveLength(1);
  expect(await f.call("job.retry", { jobId: failed.jobId! })).toMatchObject({
    ok: true,
    data: { id: failed.jobId },
  });
  const ready = await until(f, "waveform.get", "ready");
  expect(ready).toMatchObject({ dependency: { jobId: failed.jobId, state: "ready" } });
  expect(ready.jobId).not.toBe(failed.jobId);
  const read = await f.call("artifact.read", { token: ready.delivery!.token, offsetBytes: 0 });
  if (!read.ok) throw new Error(JSON.stringify(read));
  expect(
    JSON.parse(Buffer.from((read.data as { data: string }).data, "base64").toString()),
  ).toMatchObject({
    sampleRange: { start: 0, end: 1 },
    buckets: [{ gridStart: 0, channels: [{ min: 0.25, max: 0.25, rms: 0.25 }] }],
  });
  expect(await f.call("artifact.close", { token: ready.delivery!.token })).toMatchObject({
    ok: true,
  });
  expect(f.calls.filter((call) => call === "media.sourceAudio")).toHaveLength(2);
});

test("a spectrogram whose image render failed recovers through job.retry and delivers its picture", async () => {
  const f = await fixture({ image: true });
  data(await f.call("spectrogram.get", f.params));
  const failed = await until(f, "spectrogram.get", "failed");
  expect(failed).toMatchObject({ jobId: expect.any(String), retryable: true, published: null });
  // The failed job is the spectrogram's own image render, not its measured audio.
  expect(await f.call("job.get", { jobId: failed.jobId! })).toMatchObject({
    ok: true,
    data: { state: "failed", errorCode: "MEDIA_WORKER_FAILED" },
  });
  expect(failed.jobId).not.toBe(failed.dependency.jobId);
  expect(f.calls.filter((call) => call === "media.acousticImage")).toHaveLength(1);
  expect(await f.call("job.retry", { jobId: failed.jobId! })).toMatchObject({
    ok: true,
    data: { id: failed.jobId },
  });
  const ready = await until(f, "spectrogram.get", "ready");
  expect(ready).toMatchObject({ jobId: failed.jobId, published: { generation: "2" } });
  expect(f.calls.filter((call) => call === "media.acousticImage")).toHaveLength(2);
  expect(f.calls.filter((call) => call === "media.sourceAudio")).toHaveLength(1);
  const read = await f.call("artifact.read", {
    token: ready.delivery!.token,
    offsetBytes: 0,
    maxBytes: png.length,
  });
  expect(read).toMatchObject({ ok: true, data: { data: png.toString("base64"), eof: true } });
  expect(await f.call("artifact.close", { token: ready.delivery!.token })).toMatchObject({
    ok: true,
  });
});

test("a spectrogram whose audio prerequisite failed recovers through job.retry on the jobId its status returns", async () => {
  const f = await fixture({ audio: true });
  data(await f.call("spectrogram.get", f.params));
  const failed = await until(f, "spectrogram.get", "failed");
  expect(failed).toMatchObject({
    retryable: true,
    dependency: { jobId: failed.jobId, state: "failed" },
    published: null,
  });
  expect(await f.call("job.retry", { jobId: failed.jobId! })).toMatchObject({ ok: true });
  const ready = await until(f, "spectrogram.get", "ready");
  expect(ready.delivery).not.toBeNull();
  expect(f.calls.filter((call) => call === "media.sourceAudio")).toHaveLength(2);
  expect(f.calls.filter((call) => call === "media.acousticImage")).toHaveLength(1);
  expect(await f.call("artifact.close", { token: ready.delivery!.token })).toMatchObject({
    ok: true,
  });
});
