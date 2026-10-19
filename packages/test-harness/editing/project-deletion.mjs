import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startProjectService } from "../../../apps/service/dist/project-service.js";
if (process.argv.slice(2).join(" ") !== "--transport both")
  throw new Error("Expected --transport both");
const run = promisify(execFile);
const cli = new URL("../../../apps/cli/dist/main.js", import.meta.url).pathname;
const home = await mkdtemp(join(tmpdir(), "sr-d-"));
let service, mcp;
const trace = [];
async function call(operation, params, expected = true) {
  let output;
  try {
    output = (
      await run(
        process.execPath,
        [cli, operation, "--socket", service.socketPath, "--params", JSON.stringify(params)],
        { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout;
  } catch (error) {
    if (!error.stdout) throw error;
    output = error.stdout;
  }
  const result = JSON.parse(output);
  if (
    operation !== "job.get" ||
    !result.ok ||
    ["ready", "failed", "canceled"].includes(result.data.state)
  )
    trace.push({ operation, params, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
  assert.equal(result.ok, expected, JSON.stringify(result));
  return result.ok ? result.data : result.error;
}
async function connectMcp() {
  mcp = new Client({ name: "yap-deletion-journey", version: "1" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
}
try {
  service = await startProjectService({ home });
  const creation = {
    requestId: "create",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  };
  const created = await call("project.create", creation);
  const projectId = created.project.projectId;
  const imported = await call("asset.import", {
    requestId: "asset",
    path: new URL("../../../specs/done/agent-editing/assets/00-corpus/a-audio.wav", import.meta.url)
      .pathname,
  });
  let job;
  const deadline = performance.now() + 30000;
  do {
    job = await call("job.get", { jobId: imported.jobId });
    assert.ok(["ready", "queued", "running"].includes(job.state), JSON.stringify(job));
    assert.ok(performance.now() < deadline, "Import timed out");
    if (job.state !== "ready") await delay(20);
  } while (job.state !== "ready");
  const asset = await call("asset.get", { assetId: job.published.output.assetId });
  const stream = asset.streams.find((s) => s.kind === "audio" && s.decodable);
  assert.ok(stream);
  const edit = {
    projectId,
    requestId: "place",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "voice" },
      {
        operation: "place",
        clip: {
          trackId: { label: "voice" },
          assetId: asset.assetId,
          streamId: stream.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  };
  const placed = await call("edit.apply", edit);
  assert.ok(
    service.assets.references(asset.assetId).some((r) => r.id === placed.revision.revisionId),
  );
  await connectMcp();
  const deletion = { projectId, requestId: "delete" };
  const deleted = await mcp.callTool({ name: "project.delete", arguments: deletion });
  assert.equal(deleted.structuredContent.ok, true);
  const expected = deleted.structuredContent.data;
  assert.equal(expected.projectId, projectId);
  assert.equal(expected.deleted, true);
  trace.push({ transport: "mcp", operation: "project.delete", ok: true });
  assert.deepEqual(await call("project.delete", deletion), expected);
  assert.equal((await call("project.get", { projectId }, false)).code, "NOT_FOUND");
  assert.equal((await call("edit.apply", edit, false)).code, "NOT_FOUND");
  assert.equal(
    (await call("revision.get", { projectId, revisionId: placed.revision.revisionId }, false)).code,
    "NOT_FOUND",
  );
  assert.deepEqual((await call("project.list", {})).projects, []);
  assert.deepEqual(await call("asset.get", { assetId: asset.assetId }), asset);
  assert.ok(!service.assets.references(asset.assetId).some((r) => r.kind === "revision"));
  await mcp.close();
  mcp = undefined;
  await service.close();
  service = await startProjectService({ home });
  assert.deepEqual(await call("project.delete", deletion), expected);
  assert.deepEqual(await call("project.create", creation), created);
  assert.deepEqual((await call("project.list", {})).projects, []);
  assert.deepEqual(await call("asset.get", { assetId: asset.assetId }), asset);
  assert.deepEqual(await call("project.delete", { projectId: "absent", requestId: "absent" }), {
    projectId: "absent",
    deleted: true,
    freedBytes: 0,
  });
  console.log(
    JSON.stringify(
      {
        liveStateJourney: true,
        liveMediaJourney: false,
        checks: [
          "CLI/MCP idempotent deletion",
          "deleted read/edit fences",
          "historical reference retirement",
          "original asset retained",
          "restart replay cannot recreate project",
          "absent deletion succeeds",
        ],
        trace,
      },
      null,
      2,
    ),
  );
} finally {
  await mcp?.close();
  await service?.close();
  await rm(home, { recursive: true, force: true });
}
