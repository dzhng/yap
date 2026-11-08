import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DerivedCache } from "@yap/core/cache";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { launchReady, socketPath, temporary, waitFor } from "./harness.mjs";

const cli = new URL("../../cli/dist/main.js", import.meta.url).pathname;
const width = 2048,
  height = 1152;

function ffmpeg(args) {
  const run = spawnSync("ffmpeg", ["-v", "error", ...args], {
    timeout: 20000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr.toString());
  return run.stdout;
}

// Independent source truth: three large, labelled frames with binary blocks. The fixture's
// numbered pixels are drawn before encoding; no decoder metadata participates in this oracle.
async function fixture(home) {
  const glyphs = ["111101101101111", "010110010010111", "111001111100111"];
  for (let index = 0; index < 3; index++) {
    const rgb = Buffer.alloc(width * height * 3, 32);
    const fill = (x, y, w, h, color) => {
      for (let row = y; row < y + h; row++)
        for (let column = x; column < x + w; column++) {
          const at = (row * width + column) * 3;
          rgb[at] = color[0];
          rgb[at + 1] = color[1];
          rgb[at + 2] = color[2];
        }
    };
    fill(0, 0, 80, 80, [255, 20, 20]);
    fill(width - 80, height - 80, 80, 80, [20, 20, 255]);
    for (let bit = 0; bit < 3; bit++)
      fill(120 + bit * 100, 100, 80, 80, Array(3).fill((index >> bit) & 1 ? 240 : 0));
    for (let cell = 0; cell < 15; cell++)
      if (glyphs[index][cell] === "1")
        fill(800 + (cell % 3) * 100, 300 + Math.floor(cell / 3) * 100, 90, 90, [230, 245, 230]);
    await writeFile(
      join(home, `source-${index}.ppm`),
      Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]),
    );
  }
  const source = join(home, "video.mov");
  ffmpeg([
    "-framerate",
    "1/2",
    "-i",
    join(home, "source-%d.ppm"),
    "-frames:v",
    "3",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-bf",
    "0",
    source,
  ]);
  const truth = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "json",
      source,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(truth.status, 0, truth.stderr);
  assert.deepEqual(
    JSON.parse(truth.stdout).frames.map((frame) => Number(frame.pts_time)),
    [0, 2, 4],
  );
  const library = join(home, "library");
  await mkdir(library, { recursive: true, mode: 0o700 });
  const catalog = new Catalog(join(library, "catalog.sqlite"));
  try {
    const assets = new AssetStore(catalog, library);
    await assets.recover();
    const asset = await assets.import(source, { kind: "generated" }, async () => ({
      originUs: 0,
      streams: [
        {
          id: "track:1",
          kind: "video",
          codec: "h264",
          decodable: true,
          startUs: 0,
          endUs: 6000000,
          segments: [{ startUs: 0, endUs: 6000000, empty: false }],
          width,
          height,
          orientedWidth: width,
          orientedHeight: height,
        },
      ],
    }));
    return { selection: { assetId: asset.id, streamId: "track:1" }, source };
  } finally {
    catalog.close();
  }
}

function assertNumberedPixels(file, expected) {
  const rgb = ffmpeg([
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  assert.equal(rgb.length, width * height * 3);
  let actual = 0;
  for (let bit = 0; bit < 3; bit++) {
    const at = (140 * width + 160 + bit * 100) * 3;
    if (rgb[at] > 128) actual |= 1 << bit;
  }
  assert.equal(
    actual,
    expected,
    "delivered pixels must carry the independently expected frame number",
  );
  assert.ok(rgb[0] > 200 && rgb[1] < 60, "red corner must remain top-left");
  const bottom = ((height - 1) * width + width - 1) * 3;
  assert.ok(rgb[bottom + 2] > 200 && rgb[bottom] < 60, "blue corner must remain bottom-right");
}

test("sparse source pictures preserve containing-sample timing, full resolution and regeneration after restart", async () => {
  const home = temporary("/tmp/scr-sparse-public-");
  const { selection, source } = await fixture(home);
  const hash = async () =>
    createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
  const originalHash = await hash();
  let { instance } = await launchReady(home);
  const call = async (operation, params = {}) => {
    const response = await callLocal(socketPath(home), { id: randomUUID(), operation, params });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const frame = async (params) =>
    waitFor(async () => {
      const response = await call("frame.get", params);
      if (["failed", "unavailable"].includes(response.state))
        throw new Error(JSON.stringify(response));
      if (response.state !== "ready") return false;
      await call("artifact.close", { token: response.delivery.token });
      return response;
    }, 20000);
  const params = {
    ...selection,
    atUs: 1000000,
    maxLongEdge: 8192,
  };
  const tie = await frame(params);
  assert.equal(tie.published.output.requestedSourceUs, 1000000);
  assert.equal(tie.published.output.actualSourceUs, 0);
  assert.deepEqual([tie.published.output.width, tie.published.output.height], [width, height]);
  assert.deepEqual(
    [tie.published.output.sourceWidth, tie.published.output.sourceHeight],
    [width, height],
  );
  const start = await frame({ ...params, atUs: 0 });
  assert.equal(start.published.output.actualSourceUs, 0);
  const end = await frame({ ...params, atUs: 5999999 });
  assert.equal(end.published.output.actualSourceUs, 4000000);
  const resized = await frame({ ...params, maxLongEdge: 1600 });
  assert.deepEqual([resized.published.output.width, resized.published.output.height], [1600, 900]);

  const boundaryParams = { ...params, atUs: 3000000 };
  const boundary = await frame(boundaryParams);
  assert.equal(boundary.published.output.requestedSourceUs, 3000000);
  assert.equal(boundary.published.output.actualSourceUs, 2000000);
  const sample = boundary.published.output.sample;
  assert.equal(Number(sample.value) / sample.timescale, 2);
  assert.equal(Number(sample.endValue) / sample.endTimescale, 4);
  assert.equal(sample.originUs, 0);

  const output = join(home, "full-resolution.png");
  const cliResult = spawnSync(
    process.execPath,
    [
      cli,
      "frame.get",
      "--socket",
      socketPath(home),
      "--params",
      JSON.stringify(boundaryParams),
      "--output",
      output,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(cliResult.status, 0, cliResult.stdout + cliResult.stderr);
  assert.deepEqual(JSON.parse(cliResult.stdout).data.published, boundary.published);
  const png = await readFile(output);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height]);
  assertNumberedPixels(output, 1);
  const client = new Client({ name: "sparse-frame-proof", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--socket", socketPath(home)],
        stderr: "pipe",
      }),
    );
    const response = await client.callTool({ name: "frame.get", arguments: boundaryParams });
    assert.equal(response.isError, false);
    assert.deepEqual(response.structuredContent.data.published, boundary.published);
    assert.deepEqual(
      Buffer.from(response.content.find((item) => item.type === "image").data, "base64"),
      png,
    );
  } finally {
    await client.close();
  }

  const batchParams = {
    ...boundaryParams,
    atUs: [3000000, 0, 3000000, 5999999, 0, 3000000, 5999999, 0],
  };
  const batch = await waitFor(async () => {
    const value = await call("frame.batch", batchParams);
    for (const item of value.items) {
      assert.equal(item.ok, true, JSON.stringify(item));
      if (item.data.delivery) await call("artifact.close", { token: item.data.delivery.token });
    }
    return value.items.every((item) => item.data.state === "ready") ? value : false;
  }, 20000);
  assert.deepEqual(
    batch.items.map((item) => item.data.published.output.actualSourceUs),
    [2000000, 0, 2000000, 4000000, 0, 2000000, 4000000, 0],
  );
  const batchOutput = join(home, "batch-output");
  const batchCli = (output) =>
    spawnSync(
      process.execPath,
      [
        cli,
        "frame.batch",
        "--socket",
        socketPath(home),
        "--params",
        JSON.stringify(batchParams),
        "--output",
        output,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
  const delivered = batchCli(batchOutput);
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  const deliveredItems = JSON.parse(delivered.stdout).data.items;
  const images = await Promise.all(deliveredItems.map((item) => readFile(item.data.output)));
  for (const [index, item] of deliveredItems.entries())
    assertNumberedPixels(
      item.data.output,
      [1, 4, 7].includes(index) ? 0 : [3, 6].includes(index) ? 2 : 1,
    );
  const colliding = JSON.parse(batchCli(batchOutput).stdout);
  assert.ok(colliding.data.items.every((item) => !item.ok));
  assert.deepEqual(await readFile(deliveredItems[0].data.output), images[0]);
  const batchClient = new Client({ name: "batch-frame-proof", version: "1" });
  try {
    await batchClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--socket", socketPath(home)],
        stderr: "pipe",
      }),
    );
    const result = await batchClient.callTool({ name: "frame.batch", arguments: batchParams });
    assert.equal(result.isError, false);
    for (const [index, item] of result.structuredContent.data.items.entries()) {
      assert.equal(item.atUs, batchParams.atUs[index]);
      assert.deepEqual(
        Buffer.from(result.content[item.data.contentIndex].data, "base64"),
        images[index],
      );
    }
  } finally {
    await batchClient.close();
  }

  instance.kill("SIGTERM");
  await waitFor(() => !instance.running, 15000);
  assert.equal((await instance.exited).code, 0);
  // Exercise actual cache eviction under a smaller budget while the service is stopped.
  const library = join(home, "library");
  const catalog = new Catalog(join(library, "catalog.sqlite"));
  const assets = new AssetStore(catalog, library);
  const ownerCheck = (owner) => {
    assert.equal(owner.kind, "asset");
    assert.ok(assets.has(owner.id));
  };
  try {
    const cache = new DerivedCache(catalog, library, ownerCheck);
    await cache.reconcile();
    // Other producers may retain observations too. Make the target frame the oldest item
    // explicitly so this test controls eviction independently of background admission timing.
    for (const row of catalog.catalog
      .prepare("SELECT id FROM derived_cache WHERE id != ? ORDER BY id")
      .all(boundary.published.output.cacheId)) {
      const read = cache.acquire(row.id);
      assert.ok(read);
      read.release();
    }
    const constrained = new DerivedCache(
      catalog,
      library,
      ownerCheck,
      cache.bytes - boundary.published.output.sizeBytes,
    );
    await constrained.reconcile();
    assert.equal(constrained.acquire(boundary.published.output.cacheId), null);
    await assert.rejects(readFile(boundary.published.output.file), { code: "ENOENT" });
  } finally {
    catalog.close();
  }
  ({ instance } = await launchReady(home));
  const regenerated = await frame(boundaryParams);
  assert.equal(regenerated.assetId, selection.assetId);
  assert.equal(regenerated.streamId, selection.streamId);
  assert.equal(regenerated.jobId, boundary.jobId);
  assert.equal(Number(regenerated.published.generation), Number(boundary.published.generation) + 1);
  assert.notEqual(regenerated.published.output.cacheId, boundary.published.output.cacheId);
  assert.equal(regenerated.published.output.actualSourceUs, 2000000);

  assert.deepEqual(await readFile(regenerated.published.output.file), png);
  const replay = await frame(boundaryParams);
  assert.deepEqual(replay.published, regenerated.published);
  assert.deepEqual((await frame(params)).published, tie.published);
  assert.equal(await hash(), originalHash);
  instance.kill("SIGTERM");
  await waitFor(() => !instance.running, 15000);
  assert.equal((await instance.exited).code, 0);
});
