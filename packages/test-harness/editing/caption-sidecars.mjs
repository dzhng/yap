import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(
  values.out && process.env.YAP_NATIVE,
  "usage: YAP_NATIVE=... node caption-sidecars.mjs --out NEW_EVIDENCE_DIRECTORY",
);
const out = resolve(values.out),
  home = await mkdtemp("/tmp/yap-sidecar-");
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  checks: [],
};
const service = new JourneyService(home, report);
const unavailable = process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify([
  "media.renderCompositionMovie",
  "media.validateOutput",
  "speech.transcribe",
]);
const call = service.call.bind(service);
try {
  await service.start();
  const fontPath = "/System/Library/Fonts/Supplemental/Arial.ttf";
  report.fontSha256 = hash(await readFile(fontPath));
  const imported = await call("asset.import", { requestId: randomUUID(), path: fontPath });
  const fontJob = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (job) => job.state === "ready",
    "font",
  );
  const font = await call("asset.get", { assetId: fontJob.published.output.assetId });
  assert.ok(font.fontFaces.some((face) => face.postScriptName === "ArialMT"));
  const initial = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 320,
      height: 80,
      fps: { numerator: 8, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = initial.project.projectId;
  const source = (text) => ({
    kind: "text",
    text,
    font: { assetId: font.id, postScriptName: "ArialMT" },
    width: 320,
    height: 80,
    size: 32,
    color: "#ffffffff",
    alignment: "left",
    wrap: true,
  });
  const edited = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: initial.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "captions" },
      ...[
        ["first", "Café & x < y\n二", 999, 1500],
        ["second", "Next", 1500, 2501],
        ["empty", "", 3000, 4000],
        ["malformed", "one\n\ntwo", 5000, 6000],
        ["literal", "<b>literal</b>", 7000, 8000],
        ["timing", "Before\n00:00:10,000 --> 00:00:20,000\nAfter", 9000, 10000],
        ["spaced-tag", "hello < b>bold", 11000, 12000],
      ].map(([label, text, startUs, endUs]) => ({
        operation: "place",
        label,
        clip: {
          trackId: { label: "captions" },
          source: source(text),
          placement: { kind: "project", range: { startUs, endUs } },
        },
      })),
    ],
  });
  const placementIds = [edited.edit.labels.second, edited.edit.labels.first];
  const base = { projectId, revisionId: edited.revision.id, placementIds, directory: out };
  const request = { ...base, kind: "srt", exportId: randomUUID(), leaf: "captions.srt" };
  const held = await service.arm("publication.allocate");
  const admitted = await call("export.create", request);
  assert.equal(admitted.snapshot.revisionId, edited.revision.id);
  assert.equal(admitted.snapshot.cueCount, 2);
  assert.ok(!("content" in admitted.snapshot) && !("cues" in admitted.snapshot));
  await held();
  await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: edited.revision.id,
    operations: [
      {
        operation: "text.set",
        clipId: edited.edit.labels.first,
        source: source("Later corrected revision"),
      },
    ],
  });
  assert.equal(
    (await call("export.create", { ...request, placementIds: [...placementIds].reverse() }))
      .snapshot.revisionId,
    edited.revision.id,
  );
  assert.equal(
    (await call("export.create", { ...request, leaf: "changed.srt" }, { error: true })).code,
    "REQUEST_CONFLICT",
  );
  await service.stop(true);
  await service.start();
  await call("job.retry", {
    jobId: (await call("export.status", { exportId: request.exportId })).jobId,
  });
  const committed = await poll(
    () => call("export.status", { exportId: request.exportId }),
    (value) => value.state === "ready" && !value.cleanupPending,
    "SRT publication",
  );
  assert.equal(
    committed.issues.filter((issue) => issue.code === "caption-overlap-added").length,
    1,
  );
  const srt = await readFile(committed.output);
  assert.equal(hash(srt), committed.receipt.sha256);
  assert.equal(
    srt.toString("utf8"),
    "1\n00:00:00,000 --> 00:00:00,002\nCafé & x < y\n二\n\n2\n00:00:00,001 --> 00:00:00,003\nNext\n\n",
  );
  assert.equal((await call("export.create", request)).receipt.sha256, committed.receipt.sha256);
  const retried = await call("job.retry", {
    jobId: (await call("export.status", { exportId: request.exportId })).jobId,
  });
  assert.equal(retried.state, "ready");
  assert.equal(
    (await call("export.status", { exportId: request.exportId })).receipt.sha256,
    committed.receipt.sha256,
  );
  report.srt = committed;
  const vttRequest = { ...base, kind: "vtt", exportId: randomUUID(), leaf: "captions.vtt" };
  await call("export.create", vttRequest, { transport: "mcp" });
  report.vtt = await poll(
    () => call("export.status", { exportId: vttRequest.exportId }),
    (value) => value.state === "ready" && !value.cleanupPending,
    "VTT publication",
  );
  assert.equal(
    await readFile(report.vtt.output, "utf8"),
    "WEBVTT\n\n00:00:00.000 --> 00:00:00.002\nCafé &amp; x &lt; y\n二\n\n00:00:00.001 --> 00:00:00.003\nNext\n\n",
  );
  report.independent = {};
  for (const [kind, file] of [
    ["srt", committed.output],
    ["vtt", report.vtt.output],
  ]) {
    const parsed = JSON.parse(
      (await run("ffprobe", ["-v", "error", "-show_packets", "-of", "json", file])).stdout,
    );
    report.independent[kind] = { parsed };
    assert.deepEqual(
      parsed.packets.map(({ pts_time, duration_time }) => [pts_time, duration_time]),
      [
        ["0.000000", "0.002000"],
        ["0.001000", "0.002000"],
      ],
    );
    const decoded = (await run("ffmpeg", ["-v", "error", "-i", file, "-f", "ass", "-"])).stdout;
    report.independent[kind].decoded = decoded;
    assert.ok(decoded.includes("Café & x < y\\N二"), decoded);
  }
  for (const [suffix, ids, code] of [
    ["bad", [edited.edit.labels.malformed], "INVALID_COMPOSITION"],
    ["unknown", ["unknown-placement"], "UNKNOWN_CLIP"],
    ["timing", [edited.edit.labels.timing], "UNSUPPORTED_FORMAT"],
  ]) {
    assert.equal(
      (
        await call(
          "export.create",
          {
            ...base,
            exportId: randomUUID(),
            kind: "srt",
            leaf: suffix + ".srt",
            placementIds: ids,
          },
          { error: true },
        )
      ).code,
      code,
    );
  }
  // Output by default: SRT markup is written unchanged and reported as an issue.
  for (const label of ["literal", "spaced-tag"]) {
    const markup = {
      ...base,
      exportId: randomUUID(),
      kind: "srt",
      leaf: `${label}.srt`,
      placementIds: [edited.edit.labels[label]],
    };
    await call("export.create", markup);
    const written = await poll(
      () => call("export.status", { exportId: markup.exportId }),
      (value) => value.state === "ready" && !value.cleanupPending,
      `${label} SRT`,
    );
    assert.ok(
      written.issues.some((issue) => issue.code === "srt-literal-markup"),
      label,
    );
  }
  const literalRequest = {
    ...base,
    exportId: randomUUID(),
    kind: "vtt",
    leaf: "literal.vtt",
    placementIds: [edited.edit.labels.literal],
  };
  await call("export.create", literalRequest);
  const literal = await poll(
    () => call("export.status", { exportId: literalRequest.exportId }),
    (value) => value.state === "ready" && !value.cleanupPending,
    "literal VTT",
  );
  const literalDecoded = (
    await run("ffmpeg", ["-v", "error", "-i", literal.output, "-f", "ass", "-"])
  ).stdout;
  assert.ok(literalDecoded.includes(",,<b>literal</b>"), literalDecoded);
  report.literalVtt = { status: literal, decoded: literalDecoded };
  const syntaxRequest = {
    ...base,
    exportId: randomUUID(),
    kind: "vtt",
    leaf: "syntax.vtt",
    placementIds: [edited.edit.labels.timing, edited.edit.labels["spaced-tag"]],
  };
  await call("export.create", syntaxRequest);
  const syntax = await poll(
    () => call("export.status", { exportId: syntaxRequest.exportId }),
    (value) => value.state === "ready" && !value.cleanupPending,
    "literal subtitle syntax VTT",
  );
  const syntaxPackets = JSON.parse(
    (await run("ffprobe", ["-v", "error", "-show_packets", "-of", "json", syntax.output])).stdout,
  );
  const syntaxDecoded = (
    await run("ffmpeg", ["-v", "error", "-i", syntax.output, "-f", "ass", "-"])
  ).stdout;
  report.syntaxVtt = { status: syntax, parsed: syntaxPackets, decoded: syntaxDecoded };
  assert.deepEqual(
    syntaxPackets.packets.map(({ pts_time, duration_time }) => [pts_time, duration_time]),
    [
      ["0.009000", "0.001000"],
      ["0.011000", "0.001000"],
    ],
  );
  assert.ok(
    syntaxDecoded.includes("Before\\N00:00:10,000 --> 00:00:20,000\\NAfter"),
    syntaxDecoded,
  );
  assert.ok(syntaxDecoded.includes(",,hello < b>bold"), syntaxDecoded);
  const emptyRequest = {
    ...base,
    exportId: randomUUID(),
    kind: "srt",
    leaf: "empty.srt",
    placementIds: [edited.edit.labels.empty],
  };
  await call("export.create", emptyRequest);
  const empty = await poll(
    () => call("export.status", { exportId: emptyRequest.exportId }),
    (value) => value.state === "ready" && !value.cleanupPending,
    "empty SRT",
  );
  assert.deepEqual(
    empty.issues.filter((issue) => issue.code === "caption-omitted").map((issue) => issue.evidence),
    [{ placementId: edited.edit.labels.empty, reason: "empty-text" }],
  );
  assert.equal((await readFile(empty.output)).length, 0);
  await writeFile(join(out, "taken.srt"), "foreign content", { flag: "wx" });
  const collision = { ...base, exportId: randomUUID(), kind: "srt", leaf: "taken.srt" };
  await call("export.create", collision);
  let failed;
  for (let i = 0; i < 100; i++) {
    failed = await call("export.status", { exportId: collision.exportId });
    if (failed.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(failed.state, "failed");
  assert.equal(await readFile(join(out, "taken.srt"), "utf8"), "foreign content");
  await call("export.abandon", { exportId: collision.exportId });
  assert.ok(!(await readdir(out)).some((name) => name.startsWith(".yap-export-")));
  report.checks.push(
    "CLI/MCP same owner",
    "exact UTF8 text and format-specific escaping independently decoded",
    "outward timing with overlap",
    "pinned revision survives edit/crash/replay",
    "malformed/unknown selection refusal",
    "empty payload omission",
    "no overwrite and cleanup",
    "media and ASR work unavailable",
    "SRT timestamp syntax refuses and markup publishes with an issue; VTT preserves literal text and original timing",
  );
  report.passed = true;
} finally {
  await service.stop();
  report.logs = service.logs;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
  if (unavailable === undefined) delete process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
  else process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = unavailable;
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, evidence: out }));
