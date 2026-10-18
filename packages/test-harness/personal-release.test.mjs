import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("a repeated ready transcript cursor stops the caller before another page request", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-repeat-cursor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.jsonl");
  const editPlan = join(directory, "edit-plan.json");
  const cli = fileURLToPath(new URL("./personal-release-cli-fixture.mjs", import.meta.url));
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [{ intent: "remove", sourceRange: { startUs: 5300000, endUs: 5400000 } }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--recording",
      "fixture-recording",
      "--edit-plan",
      editPlan,
      "--out",
      join(directory, "evidence"),
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, YAP_CALLER_TRACE: trace, YAP_CALLER_REPEAT_CURSOR: "1" },
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transcript.get continuation repeated its cursor/);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    calls
      .filter((call) => ["transcript.transcribe", "transcript.get"].includes(call.operation))
      .map((call) => call.operation),
    ["transcript.transcribe", "transcript.get", "transcript.get"],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.operation === "transcript.get")
      .map((call) => call.params.cursor ?? null),
    [null, "fixture-transcript-cursor"],
  );
  assert.equal(
    calls.some((call) => call.operation === "project.create"),
    false,
  );
});

test("personal release requires an explicit edit plan before calling the CLI", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-plan-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.txt");
  const cli = join(directory, "yap-fixture");
  writeFileSync(
    cli,
    '#!/bin/sh\nprintf "called\\n" >> "$YAP_CALLER_TRACE"\nprintf \'{"ok":false,"error":{"code":"FIXTURE_SENTINEL","message":"CLI must not be called"}}\\n\'\n',
  );
  chmodSync(cli, 0o755);
  const output = join(directory, "evidence");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--out",
      output,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YAP_CALLER_TRACE: trace },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "missing edit intent must not pass release acceptance");
  assert.match(result.stderr, /explicit edit plan/i);
  assert.throws(() => readFileSync(trace), { code: "ENOENT" }, "the CLI must not be called");
});

test("search-only intent cannot authorize an edit or start the CLI journey", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-intent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.txt");
  const cli = join(directory, "yap-fixture");
  const editPlan = join(directory, "search-only.json");
  writeFileSync(
    cli,
    '#!/bin/sh\nprintf "called\\n" >> "$YAP_CALLER_TRACE"\nprintf \'{"ok":false,"error":{"code":"FIXTURE_SENTINEL","message":"CLI must not be called"}}\\n\'\n',
  );
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [{ intent: "remove-search-result", sourceRange: { startUs: 1, endUs: 2 } }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--edit-plan",
      editPlan,
      "--out",
      join(directory, "evidence"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YAP_CALLER_TRACE: trace },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "search evidence alone must not authorize a cut");
  assert.match(result.stderr, /caller-selected remove ranges/i);
  assert.throws(() => readFileSync(trace), { code: "ENOENT" }, "the CLI must not be called");
});

test("a terminal per-frame error is refused without another media poll", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-frame-error-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.jsonl");
  const editPlan = join(directory, "edit-plan.json");
  const cli = fileURLToPath(new URL("./personal-release-cli-fixture.mjs", import.meta.url));
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [{ intent: "remove", sourceRange: { startUs: 5300000, endUs: 5400000 } }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--recording",
      "fixture-recording",
      "--edit-plan",
      editPlan,
      "--out",
      join(directory, "evidence"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        YAP_CALLER_TRACE: trace,
        YAP_CALLER_FRAME_ITEM_ERROR: "1",
      },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRAME_ITEM_ERROR/);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.operation === "frame.batch").length, 1);
});

test("a canceled source job is terminal for readiness polling", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-job-canceled-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.jsonl");
  const editPlan = join(directory, "edit-plan.json");
  const cli = fileURLToPath(new URL("./personal-release-cli-fixture.mjs", import.meta.url));
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [{ intent: "remove", sourceRange: { startUs: 5300000, endUs: 5400000 } }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--recording",
      "fixture-recording",
      "--edit-plan",
      editPlan,
      "--out",
      join(directory, "evidence"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        YAP_CALLER_TRACE: trace,
        YAP_CALLER_JOB_STATE: "canceled",
      },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canceled/i);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.operation === "job.get").length, 1);
});

test("package cleanup failure is terminal for readiness polling", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-cleanup-failed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.jsonl");
  const editPlan = join(directory, "edit-plan.json");
  const cli = fileURLToPath(new URL("./personal-release-cli-fixture.mjs", import.meta.url));
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [{ intent: "remove", sourceRange: { startUs: 5300000, endUs: 5400000 } }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--recording",
      "fixture-recording",
      "--edit-plan",
      editPlan,
      "--out",
      join(directory, "evidence"),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        YAP_CALLER_TRACE: trace,
        YAP_CALLER_PACKAGE_STATE: "cleanup_failed",
      },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cleanup_failed/i);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.operation === "package.status").length, 1);
});

test("asset-clock cuts outside the acquired narration support stop before project creation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-support-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.jsonl");
  const output = join(directory, "evidence");
  const editPlan = join(directory, "outside-support.json");
  const cli = fileURLToPath(new URL("./personal-release-cli-fixture.mjs", import.meta.url));
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [{ intent: "remove", sourceRange: { startUs: 7900000, endUs: 8000000 } }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--recording",
      "fixture-recording",
      "--edit-plan",
      editPlan,
      "--out",
      output,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YAP_CALLER_TRACE: trace, YAP_CALLER_OUT: output },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "an asset-clock range beyond capture support must be rejected");
  assert.match(result.stderr, /outside narration support/i);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(
    calls.some((call) => call.operation === "project.create"),
    false,
  );
  assert.equal(
    calls.some((call) =>
      ["transcript.get", "index.get", "index.frames", "frame.batch", "audio.get"].includes(
        call.operation,
      ),
    ),
    false,
    "invalid caller ranges must be rejected before transcript and media work",
  );
});

test("overlapping caller cuts stop before transcript and media work", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-overlap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.jsonl");
  const output = join(directory, "evidence");
  const editPlan = join(directory, "overlapping-cuts.json");
  const cli = fileURLToPath(new URL("./personal-release-cli-fixture.mjs", import.meta.url));
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [
        { intent: "remove", sourceRange: { startUs: 3000000, endUs: 3200000 } },
        { intent: "remove", sourceRange: { startUs: 3100000, endUs: 3300000 } },
      ],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--recording",
      "fixture-recording",
      "--edit-plan",
      editPlan,
      "--out",
      output,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, YAP_CALLER_TRACE: trace, YAP_CALLER_OUT: output },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "overlapping caller cuts must not reach edit authoring");
  assert.match(result.stderr, /disjoint, non-empty project ranges/i);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(
    calls.some((call) => call.operation === "project.create"),
    false,
  );
  assert.equal(
    calls.some((call) =>
      ["transcript.get", "index.get", "index.frames", "frame.batch", "audio.get"].includes(
        call.operation,
      ),
    ),
    false,
    "overlapping caller ranges must be rejected before transcript and media work",
  );
});

test("personal release keeps search evidence separate from its explicit source-range edit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "yap-caller-flow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = join(directory, "calls.jsonl");
  const output = join(directory, "evidence");
  const editPlan = join(directory, "edit-plan.json");
  const cli = fileURLToPath(new URL("./personal-release-cli-fixture.mjs", import.meta.url));
  chmodSync(cli, 0o755);
  writeFileSync(
    editPlan,
    JSON.stringify({
      cuts: [{ intent: "remove", sourceRange: { startUs: 5300000, endUs: 5400000 } }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./personal-release.mjs", import.meta.url)),
      "--cli",
      cli,
      "--recording",
      "fixture-recording",
      "--phrase",
      "this is free",
      "--edit-plan",
      editPlan,
      "--out",
      output,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        YAP_CALLER_TRACE: trace,
        YAP_CALLER_OUT: output,
      },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /caller journey completed/i);
  assert.doesNotMatch(result.stdout, /keep or undo the edits/i);
  const calls = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.some((call) => call.operation === "transcript.search"));
  const previewCalls = calls.filter((call) => call.operation === "preview.get");
  assert.equal(previewCalls.length, 1, "preview readiness and file delivery must share one lease");
  assert.ok(previewCalls[0].output, "the readiness request must also drain the preview artifact");
  const selectors = calls.filter((call) =>
    [
      "transcript.get",
      "transcript.search",
      "index.get",
      "index.frames",
      "frame.batch",
      "audio.get",
    ].includes(call.operation),
  );
  assert.ok(selectors.length > 0);
  const sourceFrames = calls.filter(
    (call) => call.operation === "frame.batch" && call.params.assetId === "video-asset",
  );
  assert.equal(sourceFrames.length, 1);
  assert.deepEqual(sourceFrames[0].params.atUs, [1000000]);
  assert.ok(
    selectors.every(
      ({ params }) =>
        !("recordingId" in params) &&
        ("projectId" in params || ("assetId" in params && "streamId" in params)),
    ),
  );
  const sourceRows = JSON.parse(readFileSync(join(output, "source-transcript.json"), "utf8"));
  assert.ok(sourceRows.some((row) => row.kind === "filler"));
  const phraseSearch = calls.find(
    (call) => call.operation === "transcript.search" && "assetId" in call.params,
  );
  assert.deepEqual(phraseSearch.response.data.page.entries[0].sourceRange, {
    startUs: 1000000,
    endUs: 1200000,
  });
  assert.equal(
    calls.some((call) => call.operation === "edit.cut"),
    false,
  );
  const removals = calls.flatMap((call) =>
    call.operation === "edit.apply"
      ? call.params.operations.filter((operation) => operation.operation === "remove")
      : [],
  );
  assert.equal(removals.length, 2, "one apply plus one stale-revision refusal control");
  assert.deepEqual(
    removals.map((operation) => operation.ranges),
    [[{ startUs: 5400000, endUs: 5500000 }], [{ startUs: 5400000, endUs: 5500000 }]],
  );
  const projectFrame = calls.find(
    (call) => call.operation === "frame.batch" && call.params.projectId === "fixture-project",
  );
  assert.deepEqual(projectFrame.params.atUs, [1000000]);
  const adoptedFrame = calls.find(
    (call) => call.operation === "frame.batch" && call.params.projectId === "adopted-project",
  );
  assert.deepEqual(adoptedFrame.params.atUs, projectFrame.params.atUs);
  const postCutAudio = calls.find(
    (call) => call.operation === "audio.get" && call.params.projectId === "fixture-project",
  );
  assert.deepEqual(postCutAudio.params.range, { startUs: 3900000, endUs: 7000000 });
  const preCutAudio = calls.find(
    (call) => call.operation === "audio.get" && call.params.assetId === "audio-asset",
  );
  assert.deepEqual(
    preCutAudio.params.sourceRange,
    { startUs: 3800000, endUs: 6900000 },
    "before-cut padding keeps its requested context across an unavailable interval",
  );
  assert.deepEqual(preCutAudio.response.data.published.output.unavailable, [
    { startUs: 4000000, endUs: 5000000 },
  ]);
  const journey = JSON.parse(readFileSync(join(output, "journey.json"), "utf8"));
  const clipStep = journey.steps.find((step) => step.name === "audio clips around explicit cuts");
  assert.deepEqual(clipStep.clips[0].sourceUnavailable, [{ startUs: 4000000, endUs: 5000000 }]);
  assert.ok(
    removals.every(
      (operation) =>
        operation.ranges[0].startUs !==
          phraseSearch.response.data.page.entries[0].sourceRange.startUs &&
        operation.ranges[0].startUs !==
          sourceRows.find((row) => row.kind === "filler").sourceRange.startUs,
    ),
  );
  const adopted = calls.findIndex((call) => call.operation === "package.adopt");
  assert.notEqual(adopted, -1);
  assert.ok(
    calls
      .slice(adopted + 1)
      .some(
        (call) =>
          call.operation === "transcript.get" && call.params.projectId === "adopted-project",
      ),
  );
  assert.equal(
    calls.some(
      (call) =>
        [
          "transcript.get",
          "transcript.search",
          "index.frames",
          "frame.batch",
          "audio.get",
        ].includes(call.operation) && "packageHandle" in call.params,
    ),
    false,
  );
  assert.deepEqual(
    calls.filter((call) => "packageHandle" in call.params).map((call) => call.operation),
    ["package.adopt"],
  );
});
