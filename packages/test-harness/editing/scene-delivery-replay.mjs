import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const observedSceneTimes = [1000000, 1200000, 2600000, 3200000];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function replaySceneDelivery(reportPath) {
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes);
  assert.equal(report.passed, true, "scene delivery did not pass");
  assert.equal(report.result?.kind, "delivered-scene-report", "unexpected scene report kind");
  assert.deepEqual(
    report.checks?.observedSceneTimes,
    observedSceneTimes,
    "observed scene times changed",
  );
  assert.deepEqual(
    report.checks?.visualControls?.flash,
    [1000000, 1200000],
    "visualControls.flash changed",
  );
  assert.deepEqual(
    report.checks?.visualControls?.gap,
    [1200000, 2500000],
    "visualControls.gap changed",
  );
  assert.deepEqual(
    report.checks?.visualControls?.hold,
    [2600000, 3200000],
    "visualControls.hold changed",
  );
  assert.equal(report.checks?.sourceBytesUnchanged, true, "source preservation changed");
  assert.equal(report.checks?.nativeExportImport, true, "native export/import check changed");
  assert.equal(
    report.checks?.editorialDecision,
    "none",
    "scene inspection made an editorial decision",
  );
  // Frozen corpus format: this report predates the WorkState rename to ready.
  assert.equal(report.result?.export?.state, "committed", "export is not committed");
  assert.equal(report.result?.export?.immutable, true, "export is not immutable");
  const deliveredRows = report.result?.delivered?.events?.rows;
  assert.ok(Array.isArray(deliveredRows), "delivered scene rows are missing");
  assert.deepEqual(
    deliveredRows.filter((row) => row?.kind === "scene").map((row) => row.sourceAtUs),
    observedSceneTimes,
    "delivered scene rows changed",
  );
  assert.deepEqual(
    report.result?.authored?.cuts
      ?.filter((row) => row?.mediaKind === "video")
      .map((row) => row.projectAtUs),
    [1000000, 2600000],
    "authored video cuts changed",
  );
  assert.deepEqual(
    report.result?.association?.observedTransitions?.map((row) => row.projectAtUs),
    observedSceneTimes,
    "delivered scene association changed",
  );
  assert.deepEqual(
    report.result?.association?.observedTransitions?.map((row) => row.authoredJoins.length),
    [1, 0, 1, 0],
    "delivered scene join association changed",
  );
  assert.deepEqual(
    report.result?.association?.unmatchedAuthoredJoins,
    [],
    "authored joins changed",
  );
  const reportDirectory = dirname(resolve(reportPath));
  const assetRoot = dirname(reportDirectory);
  const exportPath = join(assetRoot, report.result.export.file.path);
  await access(exportPath);
  const bytes = await readFile(exportPath);
  const details = await stat(exportPath);
  assert.equal(details.size, report.result.export.file.bytes, "export byte count changed");
  assert.equal(digest(bytes), report.result.export.file.sha256, "export hash changed");
  return {
    kind: report.result.kind,
    observedSceneTimes,
    exportImmutable: report.result.export.immutable,
    sourceBytesUnchanged: report.checks.sourceBytesUnchanged,
    export: { bytes: details.size, sha256: digest(bytes) },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  assert(process.argv[2], "Usage: node scene-delivery-replay.mjs <report.json>");
  console.log(JSON.stringify(await replaySceneDelivery(process.argv[2])));
}
