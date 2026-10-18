import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { DerivedCache } from "@yap/core/cache";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callLocal } from "@yap/client";
import { launchReady, socketPath, temporary, waitFor } from "./harness.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("bundled source index retains selected images, pinned continuation and cache-independent restart", async () => {
  const home = temporary("/tmp/scr-index-public-");
  const video = join(home, "video.mov");
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:r=1:d=12",
      "-an",
      "-c:v",
      "libx264",
      "-bf",
      "0",
      video,
    ],
    { timeout: 20000, encoding: "utf8" },
  );
  assert.equal(encoded.status, 0, encoded.stderr);
  const library = join(home, "library");
  await mkdir(library, { recursive: true, mode: 0o700 });
  const catalog = new Catalog(join(library, "catalog.sqlite"));
  let selection;
  try {
    const assets = new AssetStore(catalog, library);
    await assets.recover();
    const asset = await assets.import(video, { kind: "generated" }, async () => ({
      originUs: 0,
      streams: [
        {
          id: "track:1",
          kind: "video",
          codec: "h264",
          decodable: true,
          startUs: 0,
          endUs: 12_000_000,
          segments: [{ startUs: 0, endUs: 12_000_000, empty: false }],
          width: 320,
          height: 180,
          orientedWidth: 320,
          orientedHeight: 180,
        },
      ],
    }));
    selection = { assetId: asset.id, streamId: "track:1" };
  } finally {
    catalog.close();
  }
  const sourceHash = digest(await readFile(video));
  let { instance } = await launchReady(home);
  const call = async (operation, params) => {
    const response = await callLocal(socketPath(home), { id: randomUUID(), operation, params });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const ready = await waitFor(async () => {
    const result = await call("index.get", { ...selection, limit: 1 });
    if (["failed", "unavailable"].includes(result.state)) throw new Error(JSON.stringify(result));
    return result.state === "ready" && result;
  }, 30000);
  assert.equal(ready.metadata.candidateCount, 2);
  const reference = ready.entries[0].reference;
  assert.equal(ready.entries[0].candidate.requestedSourceUs, 0);
  const read = async (ref) => {
    const result = await call("index.frame", ref);
    try {
      const chunk = await call("artifact.read", {
        token: result.delivery.token,
        offsetBytes: 0,
        maxBytes: 524288,
      });
      assert.equal(chunk.eof, true);
      const bytes = Buffer.from(chunk.data, "base64");
      assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return { bytes, frame: result.published.output };
    } finally {
      await call("artifact.close", { token: result.delivery.token });
    }
  };
  const first = await read(reference);
  const cli = new URL("../../cli/dist/main.js", import.meta.url).pathname;
  const output = join(home, "selected.png");
  const command = spawnSync(
    process.execPath,
    [
      cli,
      "index.frame",
      "--socket",
      socketPath(home),
      "--params",
      JSON.stringify(reference),
      "--output",
      output,
    ],
    { timeout: 20000, encoding: "utf8" },
  );
  assert.equal(command.status, 0, command.stdout + command.stderr);
  assert.deepEqual(await readFile(output), first.bytes);
  const client = new Client({ name: "retained-index-proof", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--socket", socketPath(home)],
      }),
    );
    const tool = await client.callTool({ name: "index.frame", arguments: reference });
    const image = tool.content.find((item) => item.type === "image");
    assert.ok(image, "MCP returns selected PNG bytes as image content");
    assert.deepEqual(Buffer.from(image.data, "base64"), first.bytes);
  } finally {
    await client.close();
  }
  assert.equal(first.frame.actualSourceUs, 0);
  const next = await call("index.get", {
    ...selection,
    cursor: ready.nextCursor,
    limit: 1,
  });
  assert.equal(next.assetId, selection.assetId);
  assert.equal(next.streamId, selection.streamId);
  assert.equal(next.generation, ready.generation);
  assert.equal(next.entries[0].candidate.requestedSourceUs, 11_999_999);
  assert.equal(next.nextCursor, null);
  const batch = await call("index.frames", {
    ...selection,
    generation: reference.generation,
    ordinals: [0, 2, 0],
  });
  assert.deepEqual(
    batch.items.map((item) => [item.ordinal, item.ok]),
    [
      [0, true],
      [2, false],
      [0, true],
    ],
  );
  for (const item of batch.items)
    if (item.ok) await call("artifact.close", { token: item.data.delivery.token });
  assert.deepEqual(await instance.reap(), []);
  const reopened = new Catalog(join(library, "catalog.sqlite"));
  const reopenedAssets = new AssetStore(reopened, library);
  assert.ok(
    reopened.catalog.prepare("SELECT COUNT(*) AS count FROM derived_cache").get().count > 0,
  );
  await new DerivedCache(
    reopened,
    library,
    (owner) => {
      assert.equal(owner.kind, "asset");
      assert.ok(reopenedAssets.has(owner.assetId));
    },
    1,
  ).reconcile();
  assert.equal(
    reopened.catalog.prepare("SELECT COUNT(*) AS count FROM derived_cache").get().count,
    0,
  );
  reopened.close();
  ({ instance } = await launchReady(home));
  assert.deepEqual((await read(reference)).bytes, first.bytes);
  const historical = await call("index.get", {
    ...selection,
    limit: 1,
  });
  assert.equal(historical.generation, ready.generation);
  assert.deepEqual(historical, ready);
  assert.equal(digest(await readFile(video)), sourceHash);
  assert.deepEqual(await instance.reap(), []);
});
