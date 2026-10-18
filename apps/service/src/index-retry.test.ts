import { afterEach, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { OperationResult } from "@yap/protocol";
import { projectServiceFixture } from "./project-service.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
const failure = (message: string) => ({
  ok: false as const,
  error: { code: "DECODE_FAILED", message, retryable: true, details: {} },
});
type IndexRead = {
  state: string;
  jobId: string | null;
  retryable?: boolean;
  dependencies: { artifact: string; state: string; jobId: string | null }[];
  /** A ready read flattens its first page beside the status. */
  entries?: unknown[];
  metadata?: { generation: string };
};

/** A one-second video whose native scene sampling and frame decoding each fail once on demand. */
async function fixture(fail: { scenes?: boolean; frames?: boolean }) {
  const calls = { scenes: 0, frames: 0 };
  const f = await projectServiceFixture(cleanups, async (operation, params) => {
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 0,
          streams: [
            {
              id: "v",
              kind: "video",
              codec: "fixture",
              decodable: true,
              startUs: 0,
              endUs: 1_000_000,
              segments: [{ startUs: 0, endUs: 1_000_000, empty: false }],
              width: 1,
              height: 1,
              orientedWidth: 1,
              orientedHeight: 1,
            },
          ],
        },
      };
    const asset = params.asset as { assetId: string; streamId: string; originUs: number };
    if (operation === "media.sourceVisualSamples") {
      if (++calls.scenes === 1 && fail.scenes) return failure("controlled scene failure");
      const available = params.available as { startUs: number; endUs: number }[];
      const at = params.atSourceUs as number[];
      return {
        ok: true,
        data: {
          assetId: asset.assetId,
          streamId: asset.streamId,
          originUs: asset.originUs,
          sourceWidth: 1,
          sourceHeight: 1,
          decodedSamples: 1,
          readerOpens: 1,
          samples: at.map((atUs, i) => {
            const range = available.find((r) => r.startUs <= atUs && atUs < r.endUs);
            if (!range)
              return {
                requestedSourceUs: atUs,
                status: "unavailable",
                reason: "outside_support",
                continuousFromPrevious: false,
              };
            const start = Math.floor(atUs / 200_000) * 200_000;
            return {
              requestedSourceUs: atUs,
              status: "available",
              actualSourceUs: start,
              sample: {
                value: String(start),
                timescale: 1_000_000,
                endValue: String(start + 200_000),
                endTimescale: 1_000_000,
              },
              width: 1,
              height: 1,
              rgbBase64: Buffer.alloc(3, 0).toString("base64"),
              continuousFromPrevious: i > 0 && at[i - 1]! >= range.startUs,
            };
          }),
        },
      };
    }
    expect(operation).toBe("media.sourceFrame");
    if (++calls.frames === 1 && fail.frames) return failure("controlled picture failure");
    const at = Number(params.atUs);
    const start = Math.floor(at / 200_000) * 200_000;
    await writeFile(String(params.output), png, { flag: "wx" });
    return {
      ok: true,
      data: {
        file: params.output,
        mediaType: "image/png",
        assetId: asset.assetId,
        streamId: asset.streamId,
        requestedSourceUs: at,
        actualSourceUs: start,
        sample: {
          value: String(start),
          timescale: 1_000_000,
          endValue: String(start + 200_000),
          endTimescale: 1_000_000,
          originUs: 0,
        },
        width: 1,
        height: 1,
        sourceWidth: 1,
        sourceHeight: 1,
        decodedSamples: 1,
        readerOpens: 1,
        bytes: png.length,
      },
    };
  });
  const imported = await f.call("asset.import", { requestId: "index-source", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const asset = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
    .output;
  const selection = { assetId: asset.assetId, streamId: "v" };
  const read = async () => data<IndexRead>(await f.call("index.get", selection));
  /** Ordinary reads keep requesting, so polling them is how a caller observes progress. */
  const until = async (state: string) => {
    const deadline = performance.now() + 5000;
    for (;;) {
      const value = await read();
      if (value.state === state) return value;
      if (state !== "failed" && value.state === "failed")
        throw new Error(`Unexpected failure: ${JSON.stringify(value)}`);
      if (performance.now() >= deadline)
        throw new Error(`Index never reached ${state}: ${JSON.stringify(value)}`);
      await delay(10);
    }
  };
  return { ...f, calls, selection, read, until };
}
function data<T>(result: OperationResult): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.data as T;
}
async function expectReadable(f: Awaited<ReturnType<typeof fixture>>, ready: IndexRead) {
  expect(ready.entries!.length).toBeGreaterThan(0);
  const frame = data<{ delivery: { token: string; sizeBytes: number } }>(
    await f.call("index.frame", {
      ...f.selection,
      generation: ready.metadata!.generation,
      ordinal: 0,
    }),
  );
  const read = data<{ data: string }>(
    await f.call("artifact.read", {
      token: frame.delivery.token,
      offsetBytes: 0,
      maxBytes: 1 << 16,
    }),
  );
  expect(Buffer.from(read.data, "base64")).toEqual(png);
  expect(await f.call("artifact.close", { token: frame.delivery.token })).toMatchObject({
    ok: true,
  });
}

test("a failed source index recovers through job.retry with the jobId its status returned", async () => {
  const f = await fixture({ frames: true });
  const failed = await f.until("failed");
  expect(failed).toMatchObject({ state: "failed", retryable: true });
  expect(failed).not.toHaveProperty("entries");
  expect(failed.jobId).toEqual(expect.any(String));
  const attempts = f.calls.frames;
  // Ordinary reads report the terminal failure without starting another attempt.
  expect(await f.read()).toMatchObject({ state: "failed", jobId: failed.jobId });
  expect(f.calls.frames).toBe(attempts);
  expect(await f.call("job.retry", { jobId: failed.jobId! })).toMatchObject({
    ok: true,
    data: { jobId: failed.jobId },
  });
  const ready = await f.until("ready");
  expect(ready.jobId).toBe(failed.jobId);
  expect(f.calls.frames).toBeGreaterThan(attempts);
  await expectReadable(f, ready);
});

test("a failed scene prerequisite recovers through job.retry with the dependency jobId the index status returned", async () => {
  const f = await fixture({ scenes: true });
  const failed = await f.until("failed");
  expect(failed).toMatchObject({ state: "failed", retryable: true, jobId: null });
  expect(failed).not.toHaveProperty("entries");
  const [scenes] = failed.dependencies;
  expect(scenes).toMatchObject({ artifact: "source-scenes", state: "failed" });
  expect(scenes!.jobId).toEqual(expect.any(String));
  expect(await f.read()).toMatchObject({ state: "failed" });
  expect(f.calls.scenes).toBe(1);
  expect(await f.call("job.retry", { jobId: scenes!.jobId! })).toMatchObject({
    ok: true,
    data: { jobId: scenes!.jobId },
  });
  const ready = await f.until("ready");
  expect(f.calls.scenes).toBe(2);
  await expectReadable(f, ready);
});
