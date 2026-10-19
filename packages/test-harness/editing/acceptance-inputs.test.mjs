import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { bindMarkedSpeech } from "./acceptance-inputs.mjs";
const marks = JSON.parse(
  await readFile(
    new URL(
      "../../../specs/done/agent-editing/assets/12d-human-marks/human-marks.json",
      import.meta.url,
    ),
  ),
);
test("human source marks require original byte identity and clock before projection", () => {
  const source = { assetId: marks.binding.sourceSha256, originUs: 48675 };
  const result = bindMarkedSpeech(marks, source);
  assert.deepEqual(result.contextAssetRange, { startUs: 50470000, endUs: 57610000 });
  assert.deepEqual(
    result.targets.map((v) => v.assetRange),
    [
      { startUs: 50470000, endUs: 50783000 },
      { startUs: 54065000, endUs: 54460000 },
    ],
  );
  assert.deepEqual(
    result.protected.map((v) => v.assetRange),
    [
      { startUs: 52380000, endUs: 52881000 },
      { startUs: 55210000, endUs: 55319000 },
    ],
  );
  assert.throws(() => bindMarkedSpeech(marks, { ...source, assetId: "different WAV" }), /identity/);
  assert.throws(() => bindMarkedSpeech(marks, { ...source, originUs: 48676 }), /clock/);
});

test("fixture bytes refuse a changed authority without changing the input", async () => {
  const { identifyFile } = await import("./acceptance-inputs.mjs");
  const path = new URL(
    "../../../specs/done/agent-editing/assets/19-soft-roomtone-overlap/loop.wav",
    import.meta.url,
  ).pathname;
  const before = await identifyFile(path);
  await assert.rejects(identifyFile(path, { sha256: "0".repeat(64) }), /identity/);
  assert.deepEqual(await identifyFile(path), before);
});

test("fixture ranges cannot claim physical support across an empty gap", async () => {
  const { requireSupport } = await import("./acceptance-inputs.mjs");
  const rows = [
    { startUs: 0, endUs: 1000000, empty: false },
    { startUs: 1000000, endUs: 2000000, empty: true },
    { startUs: 2000000, endUs: 3000000, empty: false },
  ];
  requireSupport(rows, { startUs: 100000, endUs: 900000 });
  assert.throws(() => requireSupport(rows, { startUs: 900000, endUs: 2100000 }), /support/);
});
