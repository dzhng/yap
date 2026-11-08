import { afterEach, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { projectServiceFixture } from "./project-service.fixture.js";
import { operationSchema } from "@yap/protocol";
// Consumer helpers have no runtime dependency on workspace packages.
// @ts-expect-error The distributed helper is plain JavaScript.
import { inspectTimeline } from "../../../skills/yap/scripts/timeline-inspection.mjs";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);
test("timeline helper consumes actual selected-source public frames and preserves VFR and physical gaps", async () => {
  const native: number[] = [];
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
              endUs: 300000,
              segments: [
                { startUs: 0, endUs: 100000, empty: false },
                { startUs: 100000, endUs: 300000, empty: true },
              ],
              width: 1,
              height: 1,
              orientedWidth: 1,
              orientedHeight: 1,
            },
          ],
        },
      };
    expect(operation).toBe("media.sourceFrame");
    const source = params.asset as { assetId: string; streamId: string };
    native.push(Number(params.atUs));
    await writeFile(String(params.output), png, { flag: "wx" });
    return {
      ok: true,
      data: {
        file: params.output,
        mediaType: "image/png",
        ...source,
        requestedSourceUs: Number(params.atUs),
        actualSourceUs: 33333,
        sample: { value: "1", timescale: 30, endValue: "2", endTimescale: 30, originUs: 0 },
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
  const imported = await f.call("asset.import", { requestId: "timeline-source", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const asset = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
    .output;
  const outputs = new Map<string, Buffer>();
  async function delivered(data: Record<string, unknown>) {
    const delivery = data.delivery as { token: string; sizeBytes: number } | null;
    if (!delivery) return data;
    const chunks: Buffer[] = [];
    let offsetBytes = 0;
    try {
      while (offsetBytes < delivery.sizeBytes) {
        const result = await f.call("artifact.read", { token: delivery.token, offsetBytes });
        if (!result.ok) throw new Error(JSON.stringify(result));
        const chunk = result.data as { data: string; nextOffsetBytes: number };
        chunks.push(Buffer.from(chunk.data, "base64"));
        offsetBytes = chunk.nextOffsetBytes;
      }
    } finally {
      await f.call("artifact.close", { token: delivery.token });
    }
    outputs.set(delivery.token, Buffer.concat(chunks));
    return { ...data, output: delivery.token };
  }
  const operations: string[] = [];
  const invoke = async (operation: string, params: Record<string, unknown>) => {
    const wireParams = params;
    operationSchema.parse({ operation, params: wireParams });
    operations.push(operation);
    const reply = await f.call(operation, wireParams);
    if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
    const data = reply.data as Record<string, unknown>;
    if (operation === "frame.batch") {
      const items = data.items as { atUs: number; ok: boolean; data: Record<string, unknown> }[];
      return {
        ...data,
        items: await Promise.all(
          items.map(async (item) =>
            item.ok ? { ...item, data: await delivered(item.data) } : item,
          ),
        ),
      };
    }
    return operation === "frame.get" ? delivered(data) : data;
  };
  const output = await inspectTimeline(
    {
      target: { assetId: asset.assetId, videoStreamId: "v" },
      range: { startUs: 40001, endUs: 250001 },
      frames: 2,
      maxEventPages: 0,
      polls: 20,
      pollMs: 10,
    },
    invoke,
    { readOutput: async (path: string) => outputs.get(path)! },
  );
  expect(output.manifest.frames[0]).toMatchObject({
    atUs: 40001,
    data: {
      state: "ready",
      published: {
        output: {
          requestedSourceUs: 40001,
          actualSourceUs: 33333,
          sample: { value: "1", endValue: "2", timescale: 30 },
        },
      },
    },
  });
  expect(output.manifest.frames[1]).toMatchObject({
    atUs: 250000,
    data: { state: "unavailable", reason: "physical_gap" },
  });
  expect(native).toEqual([40001]);
  expect(output.manifest.work).toEqual({ decodedSamples: 1, readerOpens: 1 });
  expect(operations).not.toContain("transcript.get");
  expect(operations).not.toContain("model.prepare");
  expect(output.svg).toContain("decoded 0.033 s");
});
