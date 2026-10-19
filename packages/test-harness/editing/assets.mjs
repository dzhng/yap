import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startProjectService } from "../../../apps/service/dist/project-service.js";

if (process.argv.slice(2).join(" ") !== "--fixture imports")
  throw new Error("Expected --fixture imports");
const run = promisify(execFile);
const cli = new URL("../../../apps/cli/dist/main.js", import.meta.url).pathname;
const home = await mkdtemp(join(tmpdir(), "yap-assets-cli-"));
let service;
let mcp;
const observations = [];
try {
  const path = join(home, "source.mov"),
    duplicate = join(home, "duplicate.mov");
  await copyFile(
    new URL("../../../specs/done/agent-editing/assets/00-corpus/orientation.mov", import.meta.url),
    path,
  );
  await copyFile(path, duplicate);
  service = await startProjectService({ home });
  async function call(operation, params) {
    const result = await run(
      process.execPath,
      [cli, operation, "--socket", service.socketPath, "--params", JSON.stringify(params)],
      { timeout: 15_000 },
    );
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    return answer.data;
  }
  async function settled(jobId, expectedState = "ready") {
    const deadline = performance.now() + 30_000;
    for (;;) {
      const job = await call("job.get", { jobId });
      if (job.state === expectedState) return job;
      assert.ok(!["failed", "unavailable", "canceled"].includes(job.state), JSON.stringify(job));
      assert.ok(performance.now() < deadline, "Import did not progress before deadline");
      await delay(20);
    }
  }
  const submitted = await call("asset.import", { requestId: "original", path });
  const result = await settled(submitted.jobId);
  const asset = await call("asset.get", { assetId: result.published.output.assetId });
  assert.equal(asset.streams.find((s) => s.kind === "video").orientedWidth, 96);
  await rm(path);
  const replay = await call("asset.import", { requestId: "original", path });
  assert.equal(replay.jobId, submitted.jobId);
  assert.equal(replay.published.output.assetId, asset.assetId);
  const another = await call("asset.import", { requestId: "same-bytes", path: duplicate });
  assert.equal((await settled(another.jobId)).published.output.assetId, asset.assetId);
  const unsupported = join(home, "unsupported.avi");
  await run(
    process.env.FFMPEG ?? "ffmpeg",
    ["-v", "error", "-nostdin", "-y", "-i", duplicate, "-an", "-c:v", "ffv1", unsupported],
    { timeout: 30_000 },
  );
  const rejected = await call("asset.import", { requestId: "unsupported", path: unsupported });
  const failure = await settled(rejected.jobId, "failed");
  assert.equal(failure.errorCode, "UNSUPPORTED_MEDIA");
  assert.equal(failure.errorDetails.streams[0].codec, "FFV1");
  assert.deepEqual(Object.keys(failure.errorDetails.streams[0]).sort(), [
    "codec",
    "decodable",
    "id",
    "kind",
  ]);
  const finalAsset = await call("asset.get", { assetId: asset.assetId });
  const origins = [];
  let cursor;
  do {
    const page = await call("asset.origins", {
      assetId: asset.assetId,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    origins.push(...page.origins);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(origins.map((origin) => origin.source).sort(), [path, duplicate].sort());
  const page = await call("asset.list", { limit: 1 });
  assert.deepEqual(
    page.assets.map((a) => a.assetId),
    [asset.assetId],
  );
  assert.equal(page.nextCursor, null);
  mcp = new Client({ name: "yap-asset-acceptance", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
  const viaMcp = await mcp.callTool({ name: "asset.get", arguments: { assetId: asset.assetId } });
  assert.equal(viaMcp.structuredContent.ok, true);
  assert.deepEqual(viaMcp.structuredContent.data, finalAsset);
  const mcpOrigins = await mcp.callTool({
    name: "asset.origins",
    arguments: { assetId: asset.assetId, limit: 1 },
  });
  assert.deepEqual(
    mcpOrigins.structuredContent.data,
    await call("asset.origins", { assetId: asset.assetId, limit: 1 }),
  );
  const mcpFailure = await mcp.callTool({ name: "job.get", arguments: { jobId: rejected.jobId } });
  assert.deepEqual(mcpFailure.structuredContent.data, failure);
  await mcp.close();
  mcp = undefined;
  await service.close();
  service = await startProjectService({ home });
  const reopened = await call("asset.import", { requestId: "original", path });
  assert.equal(reopened.jobId, submitted.jobId);
  assert.equal(reopened.published.output.assetId, asset.assetId);
  assert.deepEqual(await call("asset.get", { assetId: asset.assetId }), finalAsset);
  observations.push({
    assetId: asset.assetId,
    jobId: submitted.jobId,
    duplicateJobId: another.jobId,
    checks: [
      "CLI import/get/list/origins",
      "real native probe",
      "unsupported-codec job diagnostics",
      "MCP parity",
      "deduplication",
      "removed external source",
      "restart replay",
    ],
  });
  process.stdout.write(JSON.stringify({ passed: true, observations }, null, 2) + "\n");
} finally {
  await mcp?.close();
  await service?.close();
  await rm(home, { recursive: true, force: true });
}
