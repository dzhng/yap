import { afterEach, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import type { OperationResult } from "@yap/protocol";
import { captureFixture, settleCapture, sourceWorker } from "./project-capture.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
type Item = {
  atUs: number;
  ok: boolean;
  data: {
    state: string;
    jobId: string | null;
    published: { generation: string } | null;
    delivery?: { token: string };
  };
};
function items(reply: OperationResult) {
  if (!reply.ok) throw new Error(JSON.stringify(reply));
  return (reply.data as { items: Item[] }).items;
}

/** A captured take whose evidence carries an inside-the-picture cursor trail. */
async function cursorTake() {
  const samples = [10, 20, 30, 40];
  const overlays: unknown[] = [];
  let failNext = true;
  const f = await captureFixture(cleanups, undefined, async (operation, params, options) => {
    if (operation === "media.sourceFrame") {
      overlays.push(params.cursorOverlay);
      if (failNext) {
        failNext = false;
        return {
          ok: false,
          error: {
            code: "DECODE_FAILED",
            message: "controlled picture failure",
            retryable: true,
            details: {},
          },
        };
      }
      const asset = params.asset as { assetId: string; streamId: string };
      const at = Number(params.atUs);
      await writeFile(String(params.output), png, { flag: "wx" });
      return {
        ok: true,
        data: {
          file: params.output,
          mediaType: "image/png",
          assetId: asset.assetId,
          streamId: asset.streamId,
          requestedSourceUs: at,
          actualSourceUs: at,
          sample: {
            value: String(at),
            timescale: 1_000_000,
            endValue: String(at + 10),
            endTimescale: 1_000_000,
            originUs: 0,
          },
          // The captured display is 16x16; delivered bytes stay a tiny PNG.
          width: 16,
          height: 16,
          sourceWidth: 16,
          sourceHeight: 16,
          decodedSamples: 1,
          readerOpens: 1,
          bytes: png.length,
        },
      };
    }
    const result = await sourceWorker(operation, params, options);
    if (operation !== "media.sourceEvidence" || !result.ok) return result;
    const records = [
      {
        event: "geometry",
        data: {
          epoch: 1,
          sourceUs: 0,
          hostUs: 0,
          geometry: {
            outputWidth: 16,
            outputHeight: 16,
            contentScale: 1,
            scaleFactor: 1,
            contentRect: { x: 0, y: 0, width: 16, height: 16 },
          },
        },
      },
      ...samples.map((sourceUs) => ({
        event: "cursorSample",
        data: {
          sourceUs,
          x: sourceUs / 10,
          y: 2,
          globalX: sourceUs / 10,
          globalY: 2,
          buttons: 0,
          eligibility: "inside",
          geometryEpoch: 1,
        },
      })),
    ];
    const body = records.map((row) => JSON.stringify(row) + "\n").join("");
    await writeFile(String(params.output), body);
    return {
      ok: true,
      data: {
        ...(result.data as Record<string, unknown>),
        cursorSamples: samples.length,
        geometryRecords: 1,
        firstCursorSourceUs: samples[0],
        lastCursorSourceUs: samples.at(-1),
        lastSequence: records.length,
        bytes: Buffer.byteLength(body),
      },
    };
  });
  const take = await settleCapture(f, "cursor-render");
  await expect
    .poll(async () => {
      const job = await f.call("job.get", { jobId: take.job.id });
      return job.ok && (job.data as { state: string }).state;
    })
    .toBe("ready");
  const acquisition = await f.call("acquisition.get", { acquisitionId: take.acquisitionId });
  if (!acquisition.ok) throw new Error(JSON.stringify(acquisition));
  const { id, bindings } = acquisition.data as {
    id: string;
    bindings: { assetId: string; streamId: string }[];
  };
  return {
    ...f,
    overlays,
    selection: {
      assetId: bindings[0]!.assetId,
      streamId: bindings[0]!.streamId,
      acquisitionId: id,
    },
  };
}

test("a failed cursor.render item recovers through job.retry with the jobId it returned", async () => {
  const f = await cursorTake();
  const request = { ...f.selection, atUs: [40], trailUs: 30 };
  const [first] = items(await f.call("cursor.render", request));
  expect(first).toMatchObject({ atUs: 40, ok: true, data: { jobId: expect.any(String) } });
  const jobId = first!.data.jobId!;
  await expect
    .poll(async () => items(await f.call("cursor.render", request))[0]!.data.state)
    .toBe("failed");
  // Reading a failed item reports the same job and does not start another attempt.
  expect(items(await f.call("cursor.render", request))[0]).toMatchObject({
    ok: true,
    data: { state: "failed", jobId, published: null },
  });
  expect(f.overlays).toHaveLength(1);
  expect(await f.call("job.retry", { jobId })).toMatchObject({ ok: true, data: { id: jobId } });
  await expect
    .poll(async () => items(await f.call("cursor.render", request))[0]!.data.state)
    .toBe("ready");
  const [ready] = items(await f.call("cursor.render", request));
  expect(ready).toMatchObject({
    ok: true,
    data: { state: "ready", jobId, published: { generation: expect.any(String) } },
  });
  // The retried attempt re-rendered with the same captured trail.
  expect(f.overlays).toHaveLength(2);
  expect(f.overlays[1]).toEqual(f.overlays[0]);
  expect(f.overlays[1]).toBeTruthy();
  const token = ready!.data.delivery!.token;
  expect(
    await f.call("artifact.read", { token, offsetBytes: 0, maxBytes: png.length }),
  ).toMatchObject({
    ok: true,
    data: { data: png.toString("base64"), eof: true },
  });
  for (const item of items(await f.call("cursor.render", request)).concat(ready!))
    if (item.data.delivery) await f.call("artifact.close", { token: item.data.delivery.token });
});
