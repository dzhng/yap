import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  startPublicService,
  publicCommand,
  connectPublicMcp,
  until,
} from "./fixtures/public-service.mjs";
import { temporary } from "./harness.mjs";

// Generated sparse native pixels remain an explicit execution gate.
test("selected-source scenes retain sparse actual-time transitions across transports and restart", async () => {
  const home = temporary("/tmp/scr-scenes-public-");
  const video = join(home, "video.mov");
  const generated = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgb24",
      "-video_size",
      "64x64",
      "-framerate",
      "1/40",
      "-i",
      "pipe:0",
      "-frames:v",
      "3",
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-bf",
      "0",
      video,
    ],
    {
      input: Buffer.concat([
        Buffer.alloc(64 * 64 * 3),
        Buffer.alloc(64 * 64 * 3, 255),
        Buffer.alloc(64 * 64 * 3),
      ]),
      timeout: 15000,
    },
  );
  assert.equal(generated.status, 0, generated.stderr.toString());
  const hash = async () =>
    createHash("sha256")
      .update(await readFile(video))
      .digest("hex");
  const original = await hash();
  let service = await startPublicService(home, process.env.YAP_NATIVE);
  try {
    const pending = await service.call("asset.import", { requestId: randomUUID(), path: video });
    assert.equal(pending.ok, true, JSON.stringify(pending));
    const imported = await until(async () => {
      const response = await service.call("job.get", { jobId: pending.data.jobId });
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.ok(
        !["failed", "canceled", "unavailable"].includes(response.data.state),
        JSON.stringify(response),
      );
      return response.data.state === "ready" && response.data;
    }, "Sparse video import");
    const asset = await service.call("asset.get", { assetId: imported.published.output.assetId });
    assert.equal(asset.ok, true, JSON.stringify(asset));
    const streams = asset.data.streams.filter((stream) => stream.kind === "video");
    assert.equal(streams.length, 1);
    const params = {
      assetId: asset.data.assetId,
      streamId: streams[0].streamId,
      sourceRange: { startUs: 0, endUs: 120_000_000 },
      limit: 2,
    };
    const ready = await until(async () => {
      const response = await service.call("timeline.events", params);
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.ok(!["failed", "unavailable"].includes(response.data.state), JSON.stringify(response));
      return response.data.state === "ready" && response.data;
    }, "Sparse source scenes");
    assert.equal(ready.context.scene.evidence.chunkCount, 12);
    const transitions = [];
    let cursor;
    do {
      const response = cursor
        ? await service.call("timeline.events", { ...params, cursor })
        : { ok: true, data: ready };
      assert.equal(response.ok, true, JSON.stringify(response));
      transitions.push(
        ...response.data.rows.filter((row) => row.kind === "scene").map((row) => row.sourceAtUs),
      );
      cursor = response.data.nextCursor;
    } while (cursor);
    assert.deepEqual(transitions, [40_000_000, 80_000_000]);
    assert.deepEqual(publicCommand(service.socket, "timeline.events", params), ready);
    const client = await connectPublicMcp(service.socket, "scene-processing-proof");
    try {
      const response = await client.callTool({ name: "timeline.events", arguments: params });
      assert.equal(response.structuredContent.ok, true, JSON.stringify(response));
      assert.deepEqual(response.structuredContent.data, ready);
    } finally {
      await client.close();
    }
    await service.close();
    service = await startPublicService(home, process.env.YAP_NATIVE);
    const again = await service.call("timeline.events", params);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(again.data, ready);
    assert.equal(await hash(), original);
  } finally {
    await service.close();
  }
});
