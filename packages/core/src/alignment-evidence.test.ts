import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { AlignmentEvidenceStore } from "./alignment-evidence.js";
import { alignmentOperandRows } from "./alignment-operands.js";
import { SourceAlignmentRead } from "./alignment-read.js";
import { Catalog } from "./catalog.js";

import {
  alignmentSource as source,
  alignmentOutput as operands,
} from "./alignment-evidence.fixture.js";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const identity = {
  owner: { kind: "asset" as const, assetId: sha("asset") },
  generation: "g1",
  policy: "alignment-v1" as const,
};
test("repeated textual possibilities remain unknown; ceil cells are retained and never clamped", () => {
  const parsed = alignmentOperandRows(source, operands());
  expect(
    parsed.words
      .filter((v) => v.kind === "supplied")
      .map((v) => [v.text, v.correspondence, v.timing]),
  ).toEqual([
    ["Hi", "unknown", null],
    ["wrong", "unmatched", null],
    ["Hi", "unknown", null],
  ]);
  expect(parsed.words.find((v) => v.kind === "observed")).toMatchObject({
    text: "Hi",
    correspondence: "unknown",
    lexicalIdentity: "unknown",
    timing: {
      startFrame: 0,
      endFrame: 2,
      sourceRange: null,
      physicalAdmission: "refused_unowned_support",
    },
  });
  expect(parsed.scores.at(-1)).toMatchObject({
    endFrame: 2,
    sourceRange: null,
    physicalAdmission: "refused_unowned_support",
  });
  expect(parsed.acoustic.at(-1)).toEqual({
    ordinal: 9,
    startSample: 1440,
    endSample: 1600,
    rms: 0.2,
    peak: 0.3,
    sourceRange: { startUs: 90000, endUs: 100000 },
  });
});
test("conditional token grouping mismatch retains raw operands without inventing supplied timing", () => {
  const values = operands(),
    report = JSON.parse(values.report);
  const native = JSON.parse(values.nativeReceipt);
  native.tokenIds = [1];
  values.nativeReceipt = JSON.stringify(native);
  report.candidate = {
    text: source.text,
    ids: [1],
    status: "forced_path_observation",
    assignmentConfidence: null,
    path: [1, 1],
    frameLogScores: [-0.25, -0.5],
    spans: [
      {
        token: 1,
        startFrame: 0,
        endFrame: 2,
        nativeMeanTokenProbability: (Math.exp(-0.25) + Math.exp(-0.5)) / 2,
      },
    ],
    nativePathMeanLogScore: -0.375,
    nativeNonblankMeanLogScore: -0.375,
  };
  values.report = JSON.stringify(report);
  const parsed = alignmentOperandRows(source, values);
  expect(
    parsed.words.filter((v) => v.kind === "supplied").map((v) => [v.timing, v.timingReason]),
  ).toEqual([
    [null, "supplied_grouping_mismatch"],
    [null, "supplied_grouping_mismatch"],
    [null, "supplied_grouping_mismatch"],
  ]);
});
test("only settlement publishes; pagination binds exact threshold and exposes complete raw bytes", async () => {
  const catalog = new Catalog(":memory:");
  try {
    const records = new AlignmentEvidenceStore(catalog, () => {}),
      values = operands();
    const staged = records.stage(identity, source, values);
    expect(() => records.metadata(identity)).toThrow("not ready");
    catalog.transaction(() => staged.publish());
    expect(records.operands(identity)).toEqual(values);
    const read = new SourceAlignmentRead(records, staged.metadata);
    const first = read.page({ view: "acoustic", thresholdRMS: 0.1, limit: 3 });
    if (!("rows" in first)) throw new Error("Expected acoustic page");
    expect(first.rows.map((v) => ("activity" in v ? v.activity : null))).toEqual([
      "quiet",
      "quiet",
      "quiet",
    ]);
    expect(() =>
      read.page({ view: "acoustic", thresholdRMS: 0.2, limit: 3, cursor: first.nextCursor! }),
    ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    const next = read.page({
      view: "acoustic",
      thresholdRMS: 0.1,
      limit: 3,
      cursor: first.nextCursor!,
    });
    if (!("rows" in next)) throw new Error("Expected acoustic continuation");
    expect(next.rows.map((v) => ("activity" in v ? v.activity : null))).toEqual([
      "quiet",
      "quiet",
      "active",
    ]);
    expect(() => read.page({ view: "acoustic" })).toThrow("threshold");
    const raw = read.page({ view: "raw", operand: "nativeReceipt" });
    if (!("bytesBase64" in raw)) throw new Error("Expected raw page");
    expect(Buffer.from(raw.bytesBase64, "base64").toString()).toEqual(values.nativeReceipt);
    await staged.close();
    expect(records.metadata(identity)).toEqual(staged.metadata);
  } finally {
    catalog.close();
  }
});
test("source, report, vocabulary and native Float32 operands must agree", () => {
  const values = operands(),
    report = JSON.parse(values.report);
  report.pcmSha256 = sha("other");
  values.report = JSON.stringify(report);
  expect(() => alignmentOperandRows(source, values)).toThrow("pin");
});
