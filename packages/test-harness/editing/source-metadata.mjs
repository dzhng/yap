import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
import { cardinalityOracle, occurrences, range, rowLimit } from "./source-cardinality-fixture.mjs";

const { values } = parseArgs({
  options: { out: { type: "string" }, prepared: { type: "string" } },
});
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
await mkdir(out, { mode: 0o700 });
const prepared = values.prepared
  ? JSON.parse(await readFile(join(resolve(values.prepared), "report.json"), "utf8"))
  : null;
const home = prepared?.home ?? (await mkdtemp("/tmp/yap-source-metadata-"));
const report = {
  passed: false,
  scope: "Changed-owner functional and metadata work proof; no latency/SLA measurement",
  home,
  exchanges: [],
  trace: [],
  reads: [],
};
const configuration = join(out, "service.json");
const operationsFile = join(out, "native.jsonl");
const metadataReadsFile = join(out, "metadata-reads.jsonl");
await writeFile(operationsFile, "");
await writeFile(metadataReadsFile, "");
await writeFile(
  configuration,
  JSON.stringify({
    sources: [],
    allowedOperations: [
      "media.audioCapabilities",
      "media.probe",
      "media.sourceEvidence",
      "storage.clearRenderWorkspace",
    ],
    operationsFile,
    metadataReadsFile,
  }),
);
const service = new JourneyService(
  home,
  report,
  configuration,
  new URL("./evidence-service.mjs", import.meta.url),
);
let client;
const lines = async (file) =>
  (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const call = (operation, params, options) => service.call(operation, params, options);
async function query(params) {
  const reply = await client.callTool({ name: "cursor.raw", arguments: params });
  report.exchanges.push({
    request: { transport: "default MCP", operation: "cursor.raw", params },
    response: reply,
  });
  assert.equal(reply.structuredContent.ok, true, JSON.stringify(reply));
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  return reply.structuredContent.data;
}
try {
  await service.start();
  client = new Client({ name: "source-metadata-work-proof", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "apps/cli/dist/main.js"), "mcp", "--socket", service.socketPath],
      stderr: "pipe",
    }),
  );
  const retained = join(root, "specs/done/agent-editing/assets/24z-source-cardinality");
  const manifest = JSON.parse(await readFile(join(retained, "manifest.json"), "utf8"));
  const archive = join(retained, "evidence.tar.gz");
  assert.equal(hash(await readFile(archive)), manifest.archive.sha256);
  const extracted = await run("/usr/bin/tar", ["-xOf", archive, "cohort/authored-journal.jsonl"], {
    encoding: "buffer",
  });
  const journal = extracted.stdout;
  assert.equal(hash(journal), manifest.files["cohort/authored-journal.jsonl"].sha256);
  const donor = join(home, "donor");
  await mkdir(donor, { recursive: true });
  const movie = join(root, "specs/done/agent-editing/assets/10d-public-scenes/authored-source.mov");
  const movieBytes = await readFile(movie),
    assetId = hash(movieBytes);
  assert.equal(assetId, "491d34c0c2bff15f01d8be032bafa4ca1a96f6244ddc4ba2738bf7673678b49e");
  if (prepared) {
    assert.deepEqual(await readFile(join(donor, "video.mov")), movieBytes);
    assert.deepEqual(await readFile(join(donor, "capture.journal.jsonl")), journal);
  } else {
    await copyFile(movie, join(donor, "video.mov"));
    await writeFile(join(donor, "capture.journal.jsonl"), journal);
  }
  await writeFile(join(out, "authored-journal.jsonl"), journal);
  const acquisitions = [];
  for (let n = 0; n < 4; n++) {
    const existing = prepared?.exchanges.filter(
      ({ request }) => request.operation === "acquisition.get",
    )[n]?.response.data;
    let acquisitionId = existing?.id;
    if (!acquisitionId) {
      const imported = await call("acquisition.import", {
        requestId: `metadata-source-${n}`,
        path: donor,
      });
      const ready = await poll(
        () => call("job.get", { jobId: imported.jobId }),
        (job) => job.state === "ready",
        "acquisition admission",
      );
      acquisitionId = ready.target.acquisitionId;
    }
    const acquisition = await call("acquisition.get", { acquisitionId });
    assert.equal(acquisition.journal.sha256, hash(journal));
    assert.equal(
      hash(await readFile(acquisition.evidence.receipt.file)),
      manifest.files["cohort/normalized.jsonl"].sha256,
    );
    acquisitions.push(acquisition);
  }
  assert.equal(new Set(acquisitions.map((a) => a.id)).size, 4);
  assert.deepEqual(
    (await call("asset.list", { limit: 10 })).assets.map((a) => a.id),
    [assetId],
  );
  const fixture = { acquisitions, arms: [] };
  for (const cardinality of [2, 4]) {
    const created = await call("project.create", {
      requestId: `metadata-project-${cardinality}`,
      canvas: {
        width: 64,
        height: 48,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const arm = {
      cardinality,
      projectId: created.project.projectId,
      revisionId: created.revision.revisionId,
      clipIds: [],
    };
    async function apply(operations, requestId) {
      const edited = await call("edit.apply", {
        projectId: arm.projectId,
        expectedRevisionId: arm.revisionId,
        requestId,
        operations,
      });
      arm.revisionId = edited.revision.revisionId;
      return edited;
    }
    arm.trackId = (
      await apply(
        [{ operation: "track.add", label: "video", track: { kind: "video", order: 0 } }],
        "track",
      )
    ).edit.labels.video;
    let edited;
    for (let first = 0; first < occurrences; first += 256) {
      edited = await apply(
        Array.from({ length: 256 }, (_, offset) => {
          const i = first + offset;
          return {
            operation: "place",
            label: `clip-${i}`,
            clip: {
              trackId: arm.trackId,
              assetId,
              streamId: "track:1",
              acquisitionId: acquisitions[i % cardinality].id,
              source: {
                kind: "range",
                range: i < 64 ? { startUs: 0, endUs: 100000 } : { startUs: 350000, endUs: 450000 },
              },
              placement: {
                kind: "project",
                range: { startUs: i * 200000, endUs: i * 200000 + 100000 },
              },
            },
          };
        }),
        `place-${first}`,
      );
      for (let i = first; i < first + 256; i++) arm.clipIds.push(edited.edit.labels[`clip-${i}`]);
    }
    arm.revision = edited.revision;
    const oracle = cardinalityOracle(fixture, arm);
    const params = { projectId: arm.projectId, revisionId: arm.revisionId, range, limit: rowLimit };
    await poll(
      () => query(params),
      (reply) => reply.page !== null,
      "evidence preparation",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const beforeReads = (await lines(metadataReadsFile)).length;
    const beforeNative = (await lines(operationsFile)).length;
    const rows = [],
      checkpoints = [],
      pageRows = [];
    let cursor, last;
    for (let page = 0; page < 8 && rows.length < rowLimit; page++) {
      last = await query({
        ...params,
        limit: rowLimit - rows.length,
        ...(cursor ? { cursor } : {}),
      });
      assert.equal(last.state, "ready");
      assert.deepEqual(
        last.dependencies,
        cursor ? { manifestId: cursor.manifestId } : oracle.dependencies,
      );
      if (!cursor) assert.deepEqual(last.coverage.occurrences, oracle.coverage);
      assert(last.page.nextCursor, "The first 250 rows retain continuation");
      pageRows.push(last.page.rows.length);
      rows.push(...last.page.rows);
      cursor = last.page.nextCursor;
      assert(!checkpoints.includes(cursor.checkpointId));
      checkpoints.push(cursor.checkpointId);
    }
    assert.deepEqual(rows, oracle.rows);
    assert.deepEqual(pageRows, [0, 43, 43, 43, 43, 43, 35]);
    const work = (await lines(metadataReadsFile)).slice(beforeReads);
    const counts = Object.fromEntries(
      ["asset.header", "asset.segments", "acquisition"].map((owner) => [
        owner,
        work.filter((entry) => entry.owner === owner).length,
      ]),
    );
    assert.deepEqual(counts, {
      "asset.header": 15,
      "asset.segments": 15,
      acquisition: cardinality * 15,
    });
    assert.equal(
      (await lines(operationsFile)).length,
      beforeNative,
      "Cursor reads perform no native work",
    );
    const cli = await call("cursor.raw", { ...params, limit: 1, cursor });
    const mcp = await query({ ...params, limit: 1, cursor });
    assert.deepEqual(cli.page.rows, mcp.page.rows);
    assert.deepEqual(cli.dependencies, mcp.dependencies);
    assert.deepEqual(cli.coverage, mcp.coverage);
    const refused = await call(
      "cursor.raw",
      { ...params, range: { startUs: 1, endUs: range.endUs }, cursor },
      { error: true },
    );
    assert.equal(refused.code, "ARTIFACT_CHANGED");
    report.reads.push({
      cardinality,
      rows,
      dependencies: last.dependencies,
      coverage: oracle.coverage,
      pageRows,
      checkpoints,
      counts,
      work,
      nativeCallsDuringRead: 0,
    });
    fixture.arms.push(arm);
  }
  const shape = (arm) =>
    JSON.stringify(arm.revision.document, (key, value) =>
      ["id", "trackId", "acquisitionId"].includes(key) ? "identity" : value,
    );
  assert.equal(shape(fixture.arms[0]), shape(fixture.arms[1]));
  assert.deepEqual(await readFile(movie), movieBytes);
  assert.equal(hash(await readFile(join(donor, "video.mov"))), assetId);
  assert.deepEqual(await readFile(join(donor, "capture.journal.jsonl")), journal);
  report.fixture = fixture;
  report.originals = {
    movieSha256: assetId,
    journalSha256: hash(journal),
    archiveSha256: manifest.archive.sha256,
  };
  report.native = await lines(operationsFile);
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await client?.close();
  await service.stop();
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    passed: report.passed,
    out,
    arms: report.reads.map(({ cardinality, counts }) => ({ cardinality, counts })),
  }),
);
