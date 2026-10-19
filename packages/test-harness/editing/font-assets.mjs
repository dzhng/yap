import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: { out: { type: "string" }, font: { type: "string" }, collection: { type: "string" } },
});
assert.ok(values.out && values.font && values.collection && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await mkdtemp("/tmp/sr-font-");
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report);
async function call(operation, params, options) {
  const result = await service.call(operation, params, options);
  report.exchanges.push({ operation, params, transport: options?.transport ?? "cli", result });
  return result;
}
async function importFont(path, requestId = randomUUID(), transport = "cli") {
  const admitted = await call("asset.import", { path, requestId }, { transport });
  const job = await poll(
    () => call("job.get", { jobId: admitted.jobId }),
    (v) => v.state === "ready",
    "font admission",
  );
  const asset = await call("asset.get", { assetId: job.published.output.assetId });
  assert.equal(asset.assetId, hash(await readFile(path)));
  assert.deepEqual(asset.streams, []);
  assert.equal(asset.originUs, 0);
  assert.ok(asset.fontFaces.length > 0);
  assert.equal(new Set(asset.fontFaces.map((f) => f.postScriptName)).size, asset.fontFaces.length);
  assert.deepEqual(
    await call("asset.get", { assetId: asset.assetId }, { transport: "mcp" }),
    asset,
  );
  return { asset, admitted, requestId, path };
}
try {
  await service.start();
  const singlePath = join(home, "single.ttf");
  await copyFile(resolve(values.font), singlePath);
  const single = await importFont(singlePath, "single");
  report.inputs = [{ path: resolve(values.font), sha256: single.asset.assetId }];
  assert.equal(single.asset.fontFaces.length, 1);
  const copyPath = join(home, "copy-without-extension");
  await copyFile(singlePath, copyPath);
  assert.deepEqual((await importFont(copyPath, "duplicate", "mcp")).asset, single.asset);
  const changedPath = join(home, "different-bytes.ttf");
  await copyFile(singlePath, changedPath);
  await appendFile(changedPath, Buffer.alloc(4));
  const changed = await importFont(changedPath);
  assert.notEqual(changed.asset.assetId, single.asset.assetId);
  assert.deepEqual(changed.asset.fontFaces, single.asset.fontFaces);
  const collectionPath = join(home, "collection-without-extension");
  await copyFile(resolve(values.collection), collectionPath);
  const collection = await importFont(collectionPath, "collection", "mcp");
  assert.ok(collection.asset.fontFaces.length > 1);
  report.inputs.push({ path: resolve(values.collection), sha256: collection.asset.assetId });
  const fontFaces = single.asset.fontFaces;
  await rm(singlePath);
  const replay = await call("asset.import", { requestId: single.requestId, path: single.path });
  assert.equal(replay.jobId, single.admitted.jobId);
  assert.deepEqual(await call("asset.get", { assetId: single.asset.assetId }), single.asset);
  const missing = await call(
    "asset.import",
    { requestId: "missing", path: join(home, "missing.ttf") },
    { error: true },
  );
  assert.equal(missing.code, "NOT_FOUND");
  const corruptPath = join(home, "corrupt.ttf");
  await writeFile(corruptPath, (await readFile(copyPath)).subarray(0, 32));
  const corrupt = await call("asset.import", { requestId: "corrupt", path: corruptPath });
  const failure = await poll(
    () => call("job.get", { jobId: corrupt.jobId }),
    (v) => v.state === "failed",
    "corrupt font refusal",
  );
  assert.equal(failure.errorCode, "NATIVE_DECODE_FAILED");
  const listed = [];
  let cursor;
  do {
    const params = { limit: 1, ...(cursor ? { cursor } : {}) };
    const page = await call("asset.list", params);
    assert.deepEqual(await call("asset.list", params, { transport: "mcp" }), page);
    listed.push(...page.assets);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(
    listed.map((a) => a.assetId).sort(),
    [single.asset.assetId, changed.asset.assetId, collection.asset.assetId].sort(),
  );
  for (const asset of listed) {
    assert.deepEqual(asset.mediaKinds, []);
    assert.equal(asset.streamCount, 0);
    assert.ok(asset.fontFaceCount > 0);
  }
  const project = await call("project.create", {
    requestId: "font-refusal",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const selection = {
    projectId: project.project.projectId,
    expectedRevisionId: project.revision.revisionId,
  };
  const refused = await call(
    "edit.apply",
    {
      ...selection,
      requestId: "place-font",
      operations: [
        { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          clip: {
            trackId: { label: "v" },
            assetId: single.asset.assetId,
            streamId: fontFaces[0].postScriptName,
            source: { kind: "hold", atUs: 0 },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ],
    },
    { error: true },
  );
  assert.equal(refused.code, "INVALID_EDIT");
  await service.stop();
  await service.start();
  assert.deepEqual(
    await call("asset.get", { assetId: single.asset.assetId }, { transport: "mcp" }),
    single.asset,
  );
  assert.deepEqual(
    await call("asset.get", { assetId: collection.asset.assetId }),
    collection.asset,
  );
  assert.equal(
    (await call("asset.import", { requestId: "single", path: singlePath })).published.output
      .assetId,
    single.asset.assetId,
  );
  report.checks = [
    "exact hash identity",
    "CLI/MCP metadata parity",
    "all collection faces",
    "extensionless collection",
    "deduplication",
    "same names in distinct assets",
    "external deletion replay",
    "missing input refusal",
    "corrupt font refusal",
    "paged list parity",
    "font not playable",
    "restart persistence",
  ];
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, out }));
