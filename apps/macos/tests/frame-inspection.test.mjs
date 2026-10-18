import { finishCapture } from "./harness.mjs";
import { ceil, fromTime } from "../../../packages/composition/dist/index.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  launchReady,
  socketPath,
  temporary,
  waitFor,
  requireScreenPermission,
} from "./harness.mjs";

const cli = new URL("../../cli/dist/main.js", import.meta.url).pathname;
test("real clean frames retain edit identity and reach CLI files and MCP pixels", async () => {
  requireScreenPermission();
  const home = temporary("/tmp/scr-frame-delivery-");
  const { instance } = await launchReady(home, { YAP_FIXTURE_WINDOW: "1" });
  const [, window] = await instance.waitFor(/capture fixture window=(\d+)/);
  const call = async (operation, params = {}) => {
    const result = await callLocal(socketPath(home), { id: randomUUID(), operation, params });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const take = await call("capture.start", {
    requestId: randomUUID(),
    source: { kind: "window", windowId: Number(window) },
    microphone: false,
    systemAudio: false,
  });
  await waitFor(async () => (await call("capture.status")).device.elapsedUs >= 1000000, 20000);
  const finished = await finishCapture(call, take.recordingId);
  const source = join(home, "library", "recordings", take.recordingId, "source", "video.mov");
  const hash = async () =>
    createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
  const originalHash = await hash();
  assert.deepEqual((await call("project.list", {})).projects, []);
  const admitted = await waitFor(async () => {
    const facts = await call("recording.get", { recordingId: take.recordingId });
    const primary = facts.sourceAdmissions.find((value) => value.kind === "primary");
    if (["failed", "canceled", "unavailable"].includes(primary?.job?.state))
      throw new Error(JSON.stringify(primary));
    return primary?.job?.state === "ready" && primary;
  }, 20000);
  const acquisition = await call("acquisition.get", { acquisitionId: admitted.acquisitionId });
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
  assert.ok(binding);
  const asset = await call("asset.get", { assetId: binding.assetId });
  const video = asset.streams.find((value) => value.streamId === binding.streamId);
  assert.equal(video.kind, "video");
  assert.deepEqual((await call("project.list", {})).projects, []);
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: video.width,
      height: video.height,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const authored = await call("edit.apply", {
    projectId,
    expectedRevisionId: created.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          assetId: binding.assetId,
          streamId: binding.streamId,
          acquisitionId: acquisition.id,
          trackId: { label: "video" },
          source: { kind: "range", range: { startUs: 0, endUs: finished.sourceDurationUs } },
          placement: { kind: "project", range: { startUs: 0, endUs: finished.sourceDurationUs } },
        },
      },
    ],
  });
  const clipId = authored.edit.labels.clip,
    trackId = authored.edit.labels.video;
  // Keep a full-size reference so the crop oracle compares preceding-image pixels.
  const params = {
    projectId,
    revisionId: authored.revision.revisionId,
    atUs: 400000,
    maxLongEdge: 8192,
  };
  const ready = await waitFor(async () => {
    const result = await call("frame.get", params);
    if (result.state === "failed" || result.state === "unavailable")
      throw new Error(JSON.stringify(result));
    return result.state === "ready" && result;
  }, 20000);
  assert.equal(ready.published.output.pictures[0].status, "available");
  assert.equal(ready.published.output.pictures[0].requestedSourceUs, 400000);
  assert.equal(ready.published.output.frame.sampleAtUs, 400000);
  assert.deepEqual(
    [ready.published.output.width, ready.published.output.height],
    [video.width, video.height],
  );
  assert.ok(ready.published.output.pictures[0].actualSourceUs < finished.sourceDurationUs);
  await call("artifact.close", { token: ready.delivery.token });
  const output = join(home, "delivered.png");
  const command = spawnSync(
    process.execPath,
    [
      cli,
      "frame.get",
      "--socket",
      socketPath(home),
      "--params",
      JSON.stringify(params),
      "--output",
      output,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(command.status, 0, command.stdout + command.stderr);
  const result = JSON.parse(command.stdout);
  assert.equal(result.data.output, output);
  const bytes = await readFile(output);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.equal(bytes.readUInt32BE(16), ready.published.output.width);
  assert.equal(bytes.readUInt32BE(20), ready.published.output.height);
  assert.equal(result.data.published.output.cacheId, ready.published.output.cacheId);
  if (process.env.YAP_FRAME_EVIDENCE) {
    await mkdir(process.env.YAP_FRAME_EVIDENCE, { recursive: true });
    await copyFile(output, join(process.env.YAP_FRAME_EVIDENCE, "delivered.png"));
  }

  const client = new Client({ name: "frame-delivery-proof", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--socket", socketPath(home)],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "frame.get", arguments: params });
    assert.equal(response.isError, false);
    const image = response.content.find((item) => item.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.data, "base64"), bytes);
  } finally {
    await client.close();
  }

  const crop = { x: 20, y: 30, width: 200, height: 100 };
  const cropEdit = await call("edit.apply", {
    projectId,
    expectedRevisionId: authored.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "canvas.set", canvas: { width: 200, height: 100 } },
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [
          {
            processor: {
              type: "geometry",
              crop,
              rect: { x: 0, y: 0, width: 200, height: 100 },
              fit: "contain",
            },
          },
        ],
      },
    ],
  });
  const cropped = await waitFor(async () => {
    const result = await call("frame.get", {
      projectId,
      revisionId: cropEdit.revision.revisionId,
      atUs: 400000,
      maxLongEdge: 8192,
    });
    if (["failed", "unavailable"].includes(result.state)) throw new Error(JSON.stringify(result));
    return result.state === "ready" && result;
  }, 20000);
  if (process.env.YAP_FRAME_EVIDENCE)
    await copyFile(
      cropped.published.output.file,
      join(process.env.YAP_FRAME_EVIDENCE, "cropped.png"),
    );
  assert.equal(cropped.published.output.width, 200);
  assert.equal(cropped.published.output.height, 100);
  assert.equal(
    cropped.published.output.pictures[0].actualSourceUs,
    ready.published.output.pictures[0].actualSourceUs,
  );
  const rgb = (file, filters = []) => {
    const decoded = spawnSync(
      "ffmpeg",
      ["-v", "error", "-i", file, ...filters, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
      { timeout: 20000, maxBuffer: 32 * 1024 ** 2 },
    );
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    return decoded.stdout;
  };
  assert.deepEqual(rgb(cropped.published.output.file), rgb(output, ["-vf", "crop=200:100:20:30"]));
  await call("artifact.close", { token: cropped.delivery.token });
  const outside = await callLocal(socketPath(home), {
    id: randomUUID(),
    operation: "frame.get",
    params: { ...params, atUs: finished.sourceDurationUs },
  });
  // A point outside its source is malformed under the one range rule (packages/composition README).
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, "INVALID_RANGE");
  const outsideSource = await callLocal(socketPath(home), {
    id: randomUUID(),
    operation: "frame.get",
    params: {
      assetId: binding.assetId,
      streamId: binding.streamId,
      acquisitionId: acquisition.id,
      atUs: ceil(fromTime(video.endUs)),
    },
  });
  assert.equal(outsideSource.ok, false);
  assert.equal(outsideSource.error.code, "INVALID_RANGE");

  const revision = await call("edit.apply", {
    projectId,
    expectedRevisionId: cropEdit.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "canvas.set", canvas: { width: video.width, height: video.height } },
      { operation: "processing.set", target: { kind: "clip", id: clipId }, steps: [] },
      {
        operation: "remove",
        clipIds: [clipId],
        ranges: [{ startUs: 0, endUs: 200000 }],
        ripple: { trackIds: [trackId] },
      },
    ],
  });
  const edited = await waitFor(async () => {
    const result = await call("frame.get", {
      projectId,
      revisionId: revision.revision.revisionId,
      atUs: 0,
    });
    if (["failed", "unavailable"].includes(result.state)) throw new Error(JSON.stringify(result));
    return result.state === "ready" && result;
  }, 20000);
  assert.equal(edited.revisionId, revision.revision.revisionId);
  assert.equal(edited.published.output.pictures[0].requestedSourceUs, 200000);
  assert.ok(
    edited.published.output.pictures[0].actualSourceUs >= 0 &&
      edited.published.output.pictures[0].actualSourceUs <= 200000,
  );
  assert.equal(edited.published.output.atUs, 0);
  await call("artifact.close", { token: edited.delivery.token });
  const historical = await call("frame.get", params);
  assert.deepEqual(historical.published, ready.published);
  await call("artifact.close", { token: historical.delivery.token });
  assert.equal(await hash(), originalHash);
});
