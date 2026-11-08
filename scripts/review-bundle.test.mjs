import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewBundle } from "../skills/yap/scripts/review-bundle.mjs";

function fixture(cuts = {}) {
  const calls = [];
  let head = "old";
  const invoke = async (operation, params) => {
    calls.push({ operation, params });
    if (operation === "revision.get") {
      const id = params.revisionId ?? head;
      head = "concurrent-head";
      return {
        projectId: "p",
        revision: {
          id,
          document: { clips: id === "old" ? [{ id: "whole" }] : [{ id: "left" }, { id: "right" }] },
        },
      };
    }
    assert.ok(["old", "new"].includes(params.revisionId));
    if (operation === "timeline.events")
      return {
        projectId: "p",
        revisionId: params.revisionId,
        state: "ready",
        coverage: { cuts: { state: "ready", basis: "revision" } },
        rows: cuts[params.revisionId] ?? [],
        nextCursor: null,
      };
    assert.ok(["waveform.get", "transcript.get"].includes(operation));
    if (operation === "transcript.get") assert.equal(params.prepare, false);
    return {
      projectId: "p",
      revisionId: params.revisionId,
      state: "unavailable",
      reason: "controlled_missing_audio",
    };
  };
  return { calls, invoke };
}
const base = {
  projectId: "p",
  revisions: [
    {
      revisionId: "old",
      range: { startUs: 0, endUs: 1000000 },
      extentProvenance: "explicit fixture selection",
    },
    {
      revisionId: "new",
      range: { startUs: 0, endUs: 1000000 },
      extentProvenance: "explicit fixture selection",
    },
  ],
  boundaryUs: 100000,
  contextUs: 1000,
  timeline: { frames: 0, maxEventPages: 0 },
};

test("a split-only document change preserves owner cut evidence and pins review windows despite a moving head", async () => {
  const f = fixture();
  const output = await reviewBundle(base, f.invoke);
  assert.equal(output.comparison.authoredDocumentChanged, true);
  assert.equal(output.comparison.cutEvidenceChanged, false);
  assert.equal(output.comparison.state, "complete");
  assert.deepEqual(
    output.revisions.map((r) => r.revisionId),
    ["old", "new"],
  );
  assert.deepEqual(
    output.revisions[0].windows.map((w) => w.range),
    [
      { startUs: 0, endUs: 100000 },
      { startUs: 900000, endUs: 1000000 },
    ],
  );
  assert.equal(output.revisions[0].extentBasis, "caller-selection");
  assert.equal(output.revisions[0].wholeRevisionExtentVerified, false);
  assert.ok(output.revisions[0].windows.every((w) => w.checks.sound === "not_listened"));
  assert.ok(
    f.calls.every(
      (c) =>
        !["edit.apply", "model.prepare", "transcript.retry", "index.get"].includes(c.operation),
    ),
  );
});

const cut = (sourceAtUs = 40) => ({
  kind: "cut",
  projectAtUs: { numerator: 1000001, denominator: 3 },
  trackId: "track",
  trackRank: 0,
  mediaKind: "video",
  before: {
    kind: "range",
    clipId: "left",
    assetId: "asset",
    streamId: "video",
    sourceAtUs: 40,
    rate: { numerator: 1, denominator: 1 },
  },
  after: {
    kind: "range",
    clipId: "right",
    assetId: "asset",
    streamId: "video",
    sourceAtUs,
    rate: { numerator: 1, denominator: 1 },
  },
});
test("mapping changes differ within the same selected extent and retain fractional joins with outward query context", async () => {
  const f = fixture({ old: [cut()], new: [cut(80)] });
  const result = await reviewBundle(base, f.invoke);
  assert.equal(result.comparison.cutEvidenceChanged, true);
  const join = result.revisions[1].windows.find((window) => window.origins[0].kind === "join");
  assert.deepEqual(join.range, { startUs: 332333, endUs: 334334 });
  assert.deepEqual(join.origins[0].cut.projectAtUs, { numerator: 1000001, denominator: 3 });
  assert.equal(join.inspection.manifest.waveform.reason, "controlled_missing_audio");
  assert.equal(join.checks.sound, "not_listened");
});

test("incomplete cut pagination never reports unchanged and preserves pending evidence and skipped windows", async () => {
  const f = fixture();
  const invoke = async (op, params) =>
    op === "timeline.events"
      ? {
          projectId: "p",
          revisionId: params.revisionId,
          state: "running",
          dependencies: [{ jobId: "pending-scenes" }],
          coverage: { cuts: { state: "ready", basis: "revision" } },
          rows: [],
          nextCursor: "opaque-next",
        }
      : f.invoke(op, params);
  const result = await reviewBundle({ ...base, maxEventPages: 1, maxWindows: 1 }, invoke);
  assert.equal(result.comparison.state, "partial");
  assert.equal(result.comparison.cutEvidenceChanged, null);
  assert.equal(result.revisions[0].events.nextCursor, "opaque-next");
  assert.deepEqual(result.revisions[0].events.observations[0].dependencies, [
    { jobId: "pending-scenes" },
  ]);
  assert.deepEqual(result.revisions[0].skipped[0].range, { startUs: 900000, endUs: 1000000 });
  assert.equal(result.revisions[0].skipped[0].reason, "Total window budget exhausted");
});

test("cut occurrence identifiers are provenance while changed revision receipts remain partial", async () => {
  const old = cut(),
    next = {
      ...cut(),
      before: { ...cut().before, clipId: "new-left" },
      after: { ...cut().after, clipId: "new-right" },
    };
  const f = fixture({ old: [old], new: [next] });
  const result = await reviewBundle(base, f.invoke);
  assert.equal(result.comparison.cutEvidenceChanged, false);
  assert.equal(result.revisions[1].events.rows[0].after.clipId, "new-right");
  const wrong = await reviewBundle(base, async (op, params) =>
    op === "timeline.events"
      ? {
          revisionId: "concurrent-head",
          coverage: { cuts: { state: "ready" } },
          rows: [],
          nextCursor: null,
        }
      : f.invoke(op, params),
  );
  assert.equal(wrong.comparison.cutEvidenceChanged, null);
  assert.equal(wrong.revisions[0].events.error.error.code, "ARTIFACT_CHANGED");
});

test("a pending event read without a returned page never completes the cut scan", async () => {
  const f = fixture();
  const invoke = async (op, params) =>
    op === "timeline.events"
      ? {
          projectId: "p",
          revisionId: params.revisionId,
          state: "running",
          jobId: "pending-scenes",
          coverage: { cuts: { state: "ready", basis: "revision" } },
        }
      : f.invoke(op, params);
  const result = await reviewBundle({ ...base, timeline: { frames: 0, maxEventPages: 1 } }, invoke);
  assert.equal(result.revisions[0].events.complete, false);
  assert.equal(result.comparison.state, "partial");
});
