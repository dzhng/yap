import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, hash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { ProjectStore } from "@yap/core/projects";
import { TranscriptStore } from "@yap/core/transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";
import { DerivedCache } from "@yap/core/cache";
import { temporary, waitFor } from "./harness.mjs";
import { startPublicService, importAcquisition } from "./fixtures/public-service.mjs";
import { journalRows } from "./fixtures/generated-capture.mjs";
const native =
  process.env.YAP_NATIVE ??
  new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url).pathname;
const cli = new URL("../../cli/dist/main.js", import.meta.url).pathname;
function run(command, args, encoding = "utf8") {
  const result = spawnSync(command, args, {
    encoding,
    timeout: 20000,
    maxBuffer: 8 * 1024 ** 2,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function pointerPixels(file, second, x, y) {
  const rgb = run(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      file,
      "-ss",
      String(second),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    null,
  );
  assert.equal(rgb.length, 320 * 180 * 3);
  let bright = 0;
  for (let yy = y; yy < y + 16; yy++)
    for (let xx = x; xx < x + 12; xx++) if (rgb[(yy * 320 + xx) * 3] > 200) bright++;
  return bright;
}

test("public project preview pins an explicitly authored pointer movie through edits, delivery and restart", async () => {
  const home = temporary("/tmp/yap-public-preview-");
  const sourceId = randomUUID();
  const source = join(home, "authored-capture");
  await mkdir(source, { recursive: true });
  run("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=320x180:r=1:d=4",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    join(source, "video.mov"),
  ]);
  const samples = [
    [500000, 40, 50],
    [1500000, 100, 90],
    [3100000, 200, 40],
  ].map(([sourceUs, x, y]) => ({
    sourceUs,
    x,
    y,
    globalX: x,
    globalY: y,
    buttons: 0,
    eligibility: "inside",
    geometryEpoch: 1,
  }));
  const rows = journalRows({
    sourceId,
    width: 320,
    height: 180,
    samples,
    pauses: [{ kind: "pause", atSourceUs: 2500000, elapsedPauseUs: 60000000 }],
  });
  await writeFile(
    join(source, "capture.journal.jsonl"),
    rows.map((row, i) => JSON.stringify({ sequence: i + 1, ...row }) + "\n").join(""),
  );
  const before = hash("sha256", await readFile(join(source, "video.mov")));
  let service = await startPublicService(home, native);
  const call = async (operation, params = {}) => {
    const result = await service.call(operation, params);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const preview = (params) =>
    waitFor(async () => {
      const result = await call("preview.get", params);
      if (["failed", "unavailable"].includes(result.state)) throw new Error(JSON.stringify(result));
      return result.state === "ready" && result;
    }, 20000);
  try {
    const { acquisition } = await importAcquisition(service, source);
    const binding = acquisition.bindings.find((binding) => binding.sourceRoles.includes("video"));
    assert.ok(binding);
    const created = await call("project.create", {
      requestId: "pointer-project",
      canvas: {
        width: 320,
        height: 180,
        fps: { numerator: 10, denominator: 1 },
        background: "#000000ff",
      },
    });
    const projectId = created.project.projectId;
    const authored = await call("edit.apply", {
      projectId,
      requestId: "pointer-clip",
      expectedRevisionId: created.revision.id,
      operations: [
        { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "clip",
          clip: {
            trackId: { label: "video" },
            assetId: binding.assetId,
            streamId: binding.streamId,
            acquisitionId: acquisition.id,
            source: { kind: "range", range: { startUs: 0, endUs: 4000000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 4000000 } },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "clip" } },
          steps: [{ processor: { type: "pointer", trailUs: 0 } }],
        },
      ],
    });
    const initial = await call("preview.get", { projectId, revisionId: authored.revision.id });
    const cut = await call("edit.apply", {
      projectId,
      requestId: "cut",
      expectedRevisionId: authored.revision.id,
      operations: [
        {
          operation: "remove",
          clipIds: [authored.edit.labels.clip],
          ranges: [{ startUs: 1000000, endUs: 2000000 }],
          ripple: { trackIds: [authored.edit.labels.video] },
        },
      ],
    });
    const params = { projectId, revisionId: initial.revisionId };
    const ready = await preview(params);
    assert.equal(ready.published.output.revisionId, authored.revision.id);
    assert.equal(ready.published.output.durationUs, 4_000_000);
    await call("artifact.close", { token: ready.delivery.token });
    const output = join(home, "preview.mp4");
    const result = JSON.parse(
      run(process.execPath, [
        cli,
        "preview.get",
        "--socket",
        service.socket,
        "--params",
        JSON.stringify(params),
        "--output",
        output,
      ]),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.output, output);
    const info = JSON.parse(
      run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", output]),
    );
    assert.equal(Number(info.format.duration), 4);
    assert.equal(pointerPixels(output, 0, 40, 50), 0);
    assert.ok(pointerPixels(output, 0.5, 40, 50) > 10);
    assert.ok(pointerPixels(output, 1.5, 100, 90) > 10);
    assert.equal(pointerPixels(output, 1.5, 40, 50), 0, "old pointer is not a trail");
    assert.equal(pointerPixels(output, 2.5, 100, 90), 0, "pause clears held pointer");
    assert.ok(pointerPixels(output, 3.1, 200, 40) > 10);
    const client = new Client({ name: "preview-proof", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "mcp", "--socket", service.socket],
          stderr: "pipe",
        }),
      );
      const response = await client.callTool({ name: "preview.get", arguments: params });
      assert.equal(response.isError, false);
      const delivered = response.structuredContent.data;
      assert.deepEqual(delivered.published, ready.published);
      const renewal = await client.callTool({
        name: "artifact.renew",
        arguments: { token: delivered.delivery.token },
      });
      assert.equal(renewal.isError, false);
      assert.equal(renewal.structuredContent.data.token, delivered.delivery.token);
      assert.equal(renewal.structuredContent.data.sizeBytes, delivered.delivery.sizeBytes);
      assert.ok(renewal.structuredContent.data.expiresAtMs >= delivered.delivery.expiresAtMs);
      const chunks = [];
      for (let offsetBytes = 0; offsetBytes < delivered.delivery.sizeBytes;) {
        const response = await client.callTool({
          name: "artifact.read",
          arguments: {
            token: delivered.delivery.token,
            offsetBytes,
            maxBytes: 1024,
          },
        });
        assert.equal(response.isError, false);
        const part = response.structuredContent.data;
        const bytes = Buffer.from(part.data, "base64");
        assert.equal(part.offsetBytes, offsetBytes);
        assert.ok(bytes.length > 0 && bytes.length <= 1024);
        offsetBytes += bytes.length;
        assert.equal(part.nextOffsetBytes, offsetBytes);
        assert.equal(part.eof, offsetBytes === delivered.delivery.sizeBytes);
        chunks.push(bytes);
      }
      assert.deepEqual(Buffer.concat(chunks), await readFile(output));
      await client.callTool({
        name: "artifact.close",
        arguments: { token: delivered.delivery.token },
      });
    } finally {
      await client.close();
    }
    assert.equal((await call("revision.get", { projectId })).revision.id, cut.revision.id);
    assert.equal(hash("sha256", await readFile(join(source, "video.mov"))), before);
    const editedParams = { projectId, revisionId: cut.revision.id };
    const edited = await preview(editedParams);
    assert.equal(edited.published.output.durationUs, 3_000_000);
    await call("artifact.close", { token: edited.delivery.token });
    const editedFile = join(home, "edited.mp4");
    const download = JSON.parse(
      run(process.execPath, [
        cli,
        "preview.get",
        "--socket",
        service.socket,
        "--params",
        JSON.stringify(editedParams),
        "--output",
        editedFile,
      ]),
    );
    assert.equal(download.ok, true, JSON.stringify(download));
    assert.ok(pointerPixels(editedFile, 0.5, 40, 50) > 10);
    assert.equal(
      pointerPixels(editedFile, 1, 40, 50),
      0,
      "the mapped source instant has a later pointer",
    );
    assert.ok(pointerPixels(output, 2, 100, 90) > 10);
    assert.ok(
      pointerPixels(editedFile, 1, 100, 90) > 10,
      "cut retains the selected source instant's pointer history",
    );
    assert.equal(pointerPixels(editedFile, 1.5, 100, 90), 0, "source pause clears held pointer");
    assert.ok(pointerPixels(editedFile, 2.1, 200, 40) > 10);
    await service.close();
    const library = join(home, "library"),
      catalog = new Catalog(join(library, "catalog.sqlite"));
    try {
      const assets = new AssetStore(catalog, library),
        acquisitions = new AcquisitionStore(catalog);
      const projects = new ProjectStore(
        catalog,
        assets,
        new TranscriptStore(catalog, library, assetTranscriptOwner(assets, acquisitions)),
        acquisitions,
      );
      const cache = new DerivedCache(
        catalog,
        library,
        (owner) => {
          if (owner.kind === "project") projects.get(owner.projectId);
          else if (owner.kind === "asset") assert.ok(assets.has(owner.assetId));
          else acquisitions.get(owner.acquisitionId);
        },
        1,
      );
      await cache.reconcile();
      assert.equal(cache.acquire(edited.published.output.cacheId), null);
    } finally {
      catalog.close();
    }
    await writeFile(join(library, "render", "abandoned.mp4"), "unverified abandoned attempt");
    service = await startPublicService(home, native);
    const regenerated = await preview(editedParams);
    assert.equal(Number(regenerated.published.generation), Number(edited.published.generation) + 1);
    assert.equal(regenerated.revisionId, editedParams.revisionId);
    assert.equal(regenerated.jobId, edited.jobId);
    assert.deepEqual(await readdir(join(library, "render")), []);
    const regeneratedFile = join(home, "regenerated.mp4");
    const regeneratedDownload = JSON.parse(
      run(process.execPath, [
        cli,
        "preview.get",
        "--socket",
        service.socket,
        "--params",
        JSON.stringify(editedParams),
        "--output",
        regeneratedFile,
      ]),
    );
    assert.equal(regeneratedDownload.ok, true, JSON.stringify(regeneratedDownload));
    // The MP4 container can change bookkeeping; the decoded edited pointer must not change.
    assert.ok(pointerPixels(regeneratedFile, 2.1, 200, 40) > 10);
    assert.equal(hash("sha256", await readFile(join(source, "video.mov"))), before);
    await call("project.delete", { projectId, requestId: randomUUID() });
    const revoked = await callLocal(service.socket, {
      id: randomUUID(),
      operation: "artifact.read",
      params: { token: regenerated.delivery.token, offsetBytes: 0, maxBytes: 1 },
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.error.code, "ARTIFACT_EXPIRED");
    const renewal = await callLocal(service.socket, {
      id: randomUUID(),
      operation: "artifact.renew",
      params: { token: regenerated.delivery.token, requestId: randomUUID() },
    });
    assert.equal(renewal.ok, false);
    assert.equal(renewal.error.code, "ARTIFACT_EXPIRED");
  } finally {
    await service.close();
  }
});
