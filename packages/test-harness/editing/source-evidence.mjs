import { historicalWholeSupportRecords } from "./speech-parity-records.mjs";
import assert from "node:assert/strict";
import { projectMasks } from "./source-evidence-project.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  acquisitionDonor,
  copyModels,
  hash,
  JourneyService,
  poll,
  root,
  run,
} from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: {
    fixture: { type: "string", default: "selected-streams" },
    out: { type: "string" },
  },
});
assert.equal(values.fixture, "selected-streams");
assert.ok(process.env.YAP_NATIVE, "Use an isolated frozen YAP_NATIVE binary");
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "source-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-source-"));
const frozen = join(root, "specs/done/agent-editing/assets/10b-native-selection/selected");
const report = {
  passed: false,
  scope:
    "Actual public source transcript selection through CLI/MCP with real retained narration; no listening or timing-quality claim",
  trace: [],
  checks: {},
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const save = (name, value) =>
  writeFile(
    join(out, name),
    JSON.stringify(value, (_, item) => (typeof item === "bigint" ? String(item) : item), 2) + "\n",
  );
try {
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/selected-audio-fixture.swift"),
      "-o",
      join(out, "fixture"),
    ],
    { timeout: 120000 },
  );
  const source = join(root, "fixtures/narrated-workbench/narration.mov");
  const originalHash = hash(await readFile(source));
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      source,
      "-map",
      "0:a:0",
      "-c:a",
      "pcm_f32le",
      join(out, "narration.wav"),
    ],
    { timeout: 30000 },
  );
  await run(join(out, "fixture"), [join(out, "narration.wav"), out], { timeout: 30000 });
  await service.start();
  const imported = await call("asset.import", {
    requestId: "two-speech-streams",
    path: join(out, "multi.mov"),
  });
  const admitted = await poll(
    () => call("job.get", { jobId: imported.jobId }, { transport: "mcp" }),
    (v) => v.state === "ready",
    "asset import",
  );
  await save("import.json", admitted);
  const assetId = hash(await readFile(join(out, "multi.mov")));
  const asset = await call("asset.get", { assetId });
  const streams = asset.streams.filter((s) => s.kind === "audio");
  assert.equal(streams.length, 2);
  assert.equal(asset.originUs, 250000);
  const selections = streams.map((s) => ({ assetId, streamId: s.id }));
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  const absent = await call("transcript.get", selections[0]);
  assert.equal(absent.state, "unavailable");
  assert.equal(absent.reason, "model_not_prepared");
  assert.partialDeepStrictEqual(
    await call("model.status", { modelId: "parakeet" }, { transport: "mcp" }),
    { state: "unavailable", presence: "absent" },
  );
  report.checks.noImplicitDownload = true;
  const {
    params: { models },
  } = JSON.parse(await readFile(join(frozen, "first-physical-selected-request.json"), "utf8"));
  report.models = await copyModels(home, models);
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "ready",
    presence: "ready",
  });
  report.fixture = {
    asset,
    originalHash,
    nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  };
  const transcripts = [];
  for (const [index, selection] of selections.entries()) {
    await call("transcript.transcribe", selection);
    const first = await poll(
      () => call("transcript.get", { ...selection, limit: 1 }),
      (v) => v.state === "ready",
      "source transcript",
    );
    const rows = [...first.page.rows];
    let cursor = first.page.nextCursor;
    let pages = 1;
    while (cursor) {
      const params = { ...selection, limit: 1, cursor };
      const cli = await call("transcript.get", params);
      const mcp = await call("transcript.get", params, { transport: "mcp" });
      assert.deepEqual(cli, mcp);
      assert.equal(cli.generation, first.generation);
      assert.ok(cli.page.rows.length <= 1);
      rows.push(...cli.page.rows);
      cursor = cli.page.nextCursor;
      assert.ok(++pages < 200, "Pagination must advance");
    }
    const whole = await call("transcript.get", { ...selection, limit: 1000 }, { transport: "mcp" });
    assert.deepEqual(rows, whole.page.rows);
    const name = index === 0 ? "first" : "second";
    const baseline = (await readFile(join(frozen, `${name}-physical-selected.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const words = rows.filter((r) => r.type === "word");
    assert.deepEqual(
      words.map((w) => ({ text: w.text, source: w.sourceRange, confidence: w.confidence })),
      baseline.flatMap((line) =>
        line.words.map((w) => ({ text: w.text, source: w.source, confidence: w.confidence })),
      ),
    );
    assert.deepEqual(
      rows.filter((r) => r.type === "gap").map((r) => r.sourceRange),
      [{ startUs: 6000000, endUs: 6500000 }],
    );
    const phrase = words
      .slice(0, 2)
      .map((w) => w.text)
      .join(" ");
    const search = await call("transcript.search", { ...selection, text: phrase, limit: 1 });
    assert.deepEqual(
      search,
      await call(
        "transcript.search",
        { ...selection, text: phrase, limit: 1 },
        { transport: "mcp" },
      ),
    );
    assert.deepEqual(
      search.page.entries[0].wordIds,
      words.slice(0, 2).map((w) => w.id),
    );
    const before = words.filter((w) => w.sourceRange.endUs <= 6000000).at(-1);
    const after = words.find((w) => w.sourceRange.startUs >= 6500000);
    const gapSearch = await call("transcript.search", {
      ...selection,
      text: `${before.text} ${after.text}`,
    });
    assert.deepEqual(gapSearch.page.entries, []);
    const foreign = await call(
      "transcript.get",
      { ...selections[1 - index], cursor: first.page.nextCursor },
      { error: true },
    );
    assert.equal(foreign.code, "ARTIFACT_CHANGED");
    await save(`${name}-public.json`, { first, rows, search, gapSearch });
    transcripts.push(whole);
  }
  assert.notDeepEqual(transcripts[0].page.rows, transcripts[1].page.rows);
  const normalize = (lines) =>
    historicalWholeSupportRecords(Buffer.from(lines.map(JSON.stringify).join("\n") + "\n"));
  for (let index = 0; index < 2; index++) {
    const parseLines = async (path) =>
      (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
    const actual = await parseLines(join(out, "native", `speech-${index}.jsonl`));
    const baseline = await parseLines(
      join(frozen, `${index === 0 ? "first" : "second"}-physical-selected.jsonl`),
    );
    assert.deepEqual(normalize(actual), normalize(baseline));
    const request = JSON.parse(
      await readFile(join(out, "native", `speech-${index}-request.json`), "utf8"),
    );
    assert.equal(request.track.streamId, streams[index].id);
    assert.equal(request.track.sourceOffsetUs, -asset.originUs);
    assert.equal(request.track.role, undefined);
  }
  const searchWhole = await call("transcript.search", {
    ...selections[0],
    text: "going",
    limit: 500,
  });
  assert.ok(
    searchWhole.page.entries.length > 1,
    "Fixture needs repeated literal words for search pagination",
  );
  const searchEntries = [];
  let searchCursor;
  const searchCursors = new Set();
  let searchPages = 0;
  do {
    const page = await call(
      "transcript.search",
      {
        ...selections[0],
        text: "going",
        limit: 1,
        ...(searchCursor ? { cursor: searchCursor } : {}),
      },
      { transport: searchCursor ? "mcp" : "cli" },
    );
    assert.ok(page.page.entries.length <= 1);
    searchEntries.push(...page.page.entries);
    searchCursor = page.page.nextCursor;
    assert.ok(++searchPages <= 200, "Search pagination must finish within its page budget");
    if (searchCursor) {
      const key = JSON.stringify(searchCursor);
      assert.ok(!searchCursors.has(key), "Search continuation repeated without progress");
      searchCursors.add(key);
    }
    assert.ok(searchEntries.length <= searchWhole.page.entries.length);
  } while (searchCursor);
  assert.deepEqual(searchEntries, searchWhole.page.entries);
  const contexts = [];
  for (const [name, available] of [
    [
      "a",
      [
        { startUs: 250000, endUs: 2250000 },
        { startUs: 3250000, endUs: 12250000 },
      ],
    ],
    ["b", [{ startUs: 250000, endUs: 12750000 }]],
  ]) {
    const donor = join(home, `donor-${name}`);
    const journalHash = await acquisitionDonor(donor, join(out, "first.mov"), available);
    const pending = await call("acquisition.import", { requestId: `context-${name}`, path: donor });
    const job = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === "ready",
      "synthetic acquisition",
    );
    const context = await call(
      "acquisition.get",
      { acquisitionId: job.target.acquisitionId },
      { transport: "mcp" },
    );
    assert.equal(context.journal.sha256, journalHash);
    const binding = context.bindings.find((b) => b.sourceRoles.includes("narration"));
    assert.ok(binding);
    await rm(donor, { recursive: true });
    contexts.push({
      context,
      binding,
      selection: {
        assetId: binding.assetId,
        streamId: binding.streamId,
        acquisitionId: context.id,
      },
    });
  }
  assert.equal(contexts[0].binding.assetId, contexts[1].binding.assetId);
  assert.notDeepEqual(contexts[0].binding.available, contexts[1].binding.available);
  const hit = await service.arm("speech.transcribe");
  const preparing = await call("transcript.transcribe", contexts[0].selection);
  await hit();
  assert.ok(preparing.jobId);
  await call("job.cancel", { jobId: preparing.jobId }, { transport: "mcp" });
  await poll(
    () => call("job.get", { jobId: preparing.jobId }),
    (v) => v.state === "canceled",
    "cancel transcript",
  );
  const canceled = await call("transcript.get", contexts[0].selection);
  assert.equal(canceled.state, "idle");
  assert.equal(canceled.reason, "canceled");
  assert.equal(canceled.published, null);
  assert.equal(canceled.jobId, preparing.jobId);
  await call("job.retry", { jobId: preparing.jobId }, { transport: "mcp" });
  for (const [index, item] of contexts.entries()) {
    await call("transcript.transcribe", item.selection);
    const result = await poll(
      () => call("transcript.get", { ...item.selection, limit: 1000 }),
      (v) => v.state === "ready",
      "context transcript",
    );
    assert.deepEqual(
      result,
      await call("transcript.get", { ...item.selection, limit: 1000 }, { transport: "mcp" }),
    );
    const baseline = (
      await readFile(
        join(frozen, `first-${index === 0 ? "acquired" : "physical"}-selected.jsonl`),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      result.page.rows
        .filter((r) => r.type === "word")
        .map((w) => ({ text: w.text, source: w.sourceRange, confidence: w.confidence })),
      baseline.flatMap((line) =>
        line.words.map((w) => ({ text: w.text, source: w.source, confidence: w.confidence })),
      ),
    );
    await save(`context-${index}-public.json`, result);
    item.result = result;
  }
  const physicalSingle = {
    assetId: contexts[0].binding.assetId,
    streamId: contexts[0].binding.streamId,
  };
  await call("transcript.transcribe", physicalSingle);
  const unmasked = await poll(
    () => call("transcript.get", { ...physicalSingle, limit: 1000 }),
    (v) => v.state === "ready",
    "physical single-stream transcript",
  );
  assert.deepEqual(unmasked.page.rows, contexts[1].result.page.rows);
  assert.notEqual(contexts[0].result.generation, contexts[1].result.generation);
  assert.notEqual(contexts[1].result.generation, unmasked.generation);
  report.checks.acquisitions = {
    syntheticJournals: true,
    physicalCaptureClaim: false,
    sameBytesDifferentMasks: true,
    donorDeleted: true,
    maskedWordsMatchFrozenInference: true,
    physicalEqualsFullContext: true,
    canceledAfterNativeSuccess: true,
    retryPublished: true,
  };
  for (const [ordinal, mask] of [
    [2, "acquired"],
    [3, "acquired"],
    [4, "physical"],
    [5, "physical"],
  ]) {
    const lines = async (path) => (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      normalize(await lines(join(out, "native", `speech-${ordinal}.jsonl`))),
      normalize(await lines(join(frozen, `first-${mask}-selected.jsonl`))),
    );
  }
  await save("contexts.json", contexts);
  await save("source-pass.json", { passed: true, checks: report.checks });
  report.project = await projectMasks(service, contexts, unmasked, out);
  const advanced = await call(
    "edit.apply",
    {
      projectId: report.project.projectId,
      expectedRevisionId: report.project.revisionId,
      requestId: "advance-head-before-history-read",
      operations: [
        {
          operation: "processing.set",
          target: { kind: "output" },
          steps: [{ processor: { type: "gain", gain: 0 } }],
        },
      ],
    },
    { transport: "mcp" },
  );
  assert.notEqual(advanced.revision.id, report.project.revisionId);
  assert.notDeepEqual(advanced.revision.document, report.project.document);
  assert.equal(
    (await call("project.get", { projectId: report.project.projectId })).currentRevisionId,
    advanced.revision.id,
  );
  report.project.newHeadRevisionId = advanced.revision.id;
  await save("project.json", report.project);
  await service.stop();
  await service.start();
  for (const [index, selection] of selections.entries())
    assert.deepEqual(
      await call("transcript.get", { ...selection, limit: 1000 }),
      transcripts[index],
    );
  assert.equal(
    (await call("project.get", { projectId: report.project.projectId }, { transport: "mcp" }))
      .currentRevisionId,
    report.project.newHeadRevisionId,
  );
  const historical = await call(
    "revision.get",
    { projectId: report.project.projectId, revisionId: report.project.revisionId },
    { transport: "mcp" },
  );
  assert.equal(historical.revision.id, report.project.revisionId);
  assert.deepEqual(historical.revision.document, report.project.document);
  assert.deepEqual(
    historical.revision.document.clips.map((c) => c.acquisitionId ?? null),
    [contexts[0].context.id, contexts[1].context.id, null],
  );
  const historicalFile = join(out, "different-contexts-after-restart.mp4");
  await poll(
    () =>
      call(
        "preview.get",
        { projectId: report.project.projectId, revisionId: report.project.revisionId },
        { output: historicalFile },
      ),
    (v) => v.state === "ready",
    "historical masks after restart",
  );
  assert.equal(hash(await readFile(historicalFile)), report.project.movieSha256);
  assert.equal(hash(await readFile(source)), originalHash);
  report.checks.selectedStreams = {
    completeRawParity: true,
    completePublicWordsParity: true,
    boundedPagesBothTransports: true,
    searchCannotCrossPhysicalGap: true,
    foreignCursorRejected: true,
    restartGenerationStable: true,
  };
  report.runtime = Object.fromEntries(
    await Promise.all(
      [
        "apps/service/dist/project-service.js",
        "apps/service/dist/worker.js",
        "apps/cli/dist/main.js",
        "packages/protocol/dist/operations.js",
        "packages/core/dist/transcript-processing.js",
        "packages/core/dist/transcript-read.js",
        "packages/core/dist/transcript.js",
        "packages/core/dist/source-selection.js",
        "packages/core/dist/models.js",
        "packages/core/dist/acquisitions.js",
        "packages/composition/dist/source-projection.js",
        "packages/test-harness/editing/source-evidence.mjs",
        "packages/test-harness/editing/source-evidence-fixture.mjs",
        "packages/test-harness/editing/source-evidence-project.mjs",
        "packages/test-harness/editing/source-acquisition-service.mjs",
      ].map(async (file) => [file, hash(await readFile(join(root, file)))]),
    ),
  );
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await service.stop().catch((error) => {
    report.shutdownError = error.message;
    report.passed = false;
    process.exitCode = 1;
  });
  await save("report.json", report);
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ out, passed: report.passed, error: report.error?.message }));
