import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("rate-driven fixtures are deterministic and survive the production Swift and TS paths", () => {
  const root = mkdtempSync(join(tmpdir(), "long-take-test-"));
  const buildOptions = process.env.YAP_LONG_TAKE_BUILD
    ? ["--build", process.env.YAP_LONG_TAKE_BUILD]
    : [];
  try {
    execFileSync(
      process.execPath,
      [
        new URL("./probe.mjs", import.meta.url).pathname,
        "--output",
        root,
        "--seconds",
        "2.0000000000000004",
        "--profiles",
        "combined-typical",
        "--stroke-seconds",
        "1",
        "--pcm-hz",
        "94",
        "--cursor-hz",
        "60",
        "--camera-hz",
        "30",
        ...buildOptions,
      ],
      { stdio: "inherit", timeout: 180000 },
    );
    const report = JSON.parse(readFileSync(join(root, "report.json")));
    const generated = report.results.find((r) => r.stage === "generate");
    assert.equal(generated.status, "pass");
    assert.equal(generated.detail.pcmAppends, 188);
    assert.equal(generated.detail.cursorSamples, 120);
    assert.equal(generated.detail.cursorChanges, 30); // floor(119 transitions × 26%).
    const streamed = report.results.find((r) => r.stage === "stream");
    assert.equal(streamed.detail.cursorSamples, 120);
    assert.equal(streamed.detail.markEvents, 3);
    assert.equal(streamed.detail.invalidAtSequence, undefined);
    assert.equal(report.results.find((r) => r.stage === "export").status, "pass");
    // The ordinary 5-minute stroke intentionally exceeds TS's current 64 KiB bound;
    // this one-second tracer reaches successful catalog admission instead.
    assert.equal(report.results.find((r) => r.stage === "ts-read").status, "pass");
    const ingest = report.results.find((r) => r.stage === "ingest");
    assert.equal(ingest.status, "pass");
    assert.equal(ingest.detail.records, 125);
    assert.equal(ingest.detail.firstCursor.sourceUs, 0);
    assert.equal(ingest.detail.firstCursor.x, 0.125);
    assert.equal(ingest.detail.lastCursor.sourceUs, 1983333);
    assert.equal(ingest.detail.lastCursor.x, 510.125);
    const build = process.env.YAP_LONG_TAKE_BUILD ?? join(root, "build");
    const binary = join(build, "long-take");
    const run = (folder) => {
      execFileSync(binary, ["generate", folder, "combined-typical", "2", "1", "94", "60", "30"], {
        stdio: "pipe",
      });
      return readFileSync(join(folder, "capture.journal.jsonl"));
    };
    assert.deepEqual(run(join(root, "repeat-a")), run(join(root, "repeat-b")));
    assert.deepEqual(
      readFileSync(join(root, "repeat-a", "camera.mapping.jsonl")),
      readFileSync(join(root, "repeat-b", "camera.mapping.jsonl")),
    );
    const longStroke = join(root, "stroke");
    execFileSync(
      process.execPath,
      [
        new URL("./probe.mjs", import.meta.url).pathname,
        "--output",
        longStroke,
        "--seconds",
        "300",
        "--profiles",
        "events",
        "--cursor-hz",
        "60",
        "--build",
        build,
      ],
      { stdio: "pipe", timeout: 30000 },
    );
    const strokeReport = JSON.parse(readFileSync(join(longStroke, "report.json"))).results;
    assert.equal(strokeReport.find((r) => r.stage === "stream").status, "pass");
    assert.ok(strokeReport.find((r) => r.stage === "generate").files.journal.maxLineBytes > 65536);
    assert.equal(strokeReport.find((r) => r.stage === "export").status, "pass");
    assert.equal(strokeReport.find((r) => r.stage === "ts-read").code, "INVALID_EVIDENCE");
    const stopped = join(root, "stopped");
    execFileSync(
      process.execPath,
      [
        new URL("./probe.mjs", import.meta.url).pathname,
        "--output",
        stopped,
        "--seconds",
        "43200",
        "--profiles",
        "combined-worst",
        "--budget-seconds",
        "0.1",
        "--build",
        build,
      ],
      { stdio: "pipe", timeout: 10000 },
    );
    const stopReport = JSON.parse(readFileSync(join(stopped, "report.json"))).results;
    assert.equal(stopReport[0].status, "stopped");
    assert.ok(stopReport[0].wallSeconds < 5);
    assert.ok(stopReport[0].peakRSSBytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
