import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";
import { pointerFixture } from "./pointer-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
await mkdir(out);
const home = await mkdtemp(join(tmpdir(), "sr-pointer-lifecycle-"));
const report = {
  passed: false,
  trace: [],
  checks: {},
  scope: "Public pointer edit lifecycle PNGs; encoded color gates remain separate",
};
const service = new JourneyService(home, report, join(out, "native")),
  call = service.call.bind(service);
const canvas = {
  width: 256,
  height: 160,
  fps: { numerator: 10, denominator: 1 },
  background: "#000000ff",
};
const pointerSteps = [
  { processor: { type: "pointer", trailUs: 600000 } },
  {
    processor: {
      type: "geometry",
      rect: { x: 8, y: 8, width: 240, height: 144 },
      fit: "stretch",
    },
  },
];
const range = { kind: "range", range: { startUs: 0, endUs: 2000000 } };
async function edit(selection, operations, options = {}) {
  return call(
    "edit.apply",
    {
      projectId: selection.projectId,
      expectedRevisionId: selection.revisionId,
      requestId: randomUUID(),
      operations,
    },
    { transport: "mcp", ...options },
  );
}
function selected(projectId, result) {
  return { projectId, revisionId: result.revision?.revisionId ?? result.id };
}
async function project(source, steps = pointerSteps, sourceRange = range) {
  const initial = await call("project.create", {
    requestId: randomUUID(),
    canvas,
  });
  const projectId = initial.project.projectId;
  const result = await edit(selected(projectId, initial), [
    {
      operation: "group.add",
      label: "outer",
      group: { kind: "video", order: 0 },
    },
    {
      operation: "group.add",
      label: "group",
      group: { kind: "video", order: 0, parentId: { label: "outer" } },
    },
    {
      operation: "track.add",
      label: "track",
      track: { kind: "video", order: 0, parentId: { label: "group" } },
    },
    {
      operation: "place",
      label: "clip",
      clip: {
        ...source,
        trackId: { label: "track" },
        source: sourceRange,
        placement: { kind: "project", range: range.range },
      },
    },
    {
      operation: "processing.set",
      target: { kind: "clip", id: { label: "clip" } },
      steps,
    },
  ]);
  return {
    selection: selected(projectId, result),
    labels: result.edit.labels,
    revision: result.revision,
  };
}
async function picture(selection, atUs, name) {
  const file = join(out, name + ".png");
  const receipt = await poll(
    () => call("frame.get", { ...selection, atUs, maxLongEdge: 256 }, { output: file }),
    (value) => value.state === "ready",
    name,
  );
  return { atUs, file, sha256: hash(await readFile(file)), receipt };
}
async function importPointer(directory, mirrored) {
  await mkdir(directory);
  const { donor, records } = await pointerFixture(directory);
  if (mirrored) {
    records[0].data.sessionID = "authored-mirrored-pointer";
    for (const row of records.find((row) => row.event === "cursorSamples").data.samples) {
      row.x = 256 - row.x;
      row.globalX = 256 - row.globalX;
    }
    await writeFile(
      join(donor, "capture.journal.jsonl"),
      records.map((row, i) => JSON.stringify({ ...row, sequence: i + 1 }) + "\n").join(""),
    );
  }
  const pending = await call("acquisition.import", {
    requestId: randomUUID(),
    path: donor,
  });
  const imported = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (value) => value.state === "ready",
    "pointer acquisition",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: imported.target.acquisitionId,
  });
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
  return {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
  };
}
try {
  await service.start();
  const originalSource = await importPointer(join(home, "first"), false),
    replacementSource = await importPointer(join(home, "second"), true);
  assert.equal(
    originalSource.assetId,
    replacementSource.assetId,
    "Control must share the exact media asset",
  );
  assert.notEqual(originalSource.acquisitionId, replacementSource.acquisitionId);
  const original = await project(originalSource),
    reference = await project(replacementSource);
  const clipId = original.labels.clip,
    target = { kind: "clip", id: clipId };
  const before = await call("processing.get", {
    ...original.selection,
    target,
  });
  const replaced = await edit(original.selection, [
    {
      operation: "replace",
      clipId,
      kind: "video",
      media: { ...replacementSource, source: range },
      fit: "exact",
    },
  ]);
  let current = selected(original.selection.projectId, replaced);
  assert.deepEqual((await call("processing.get", { ...current, target })).steps, before.steps);
  const comparisons = [];
  for (const atUs of [700000, 1000000, 1500000]) {
    const a = await picture(original.selection, atUs, `original-${atUs}`),
      b = await picture(reference.selection, atUs, `replacement-reference-${atUs}`),
      actual = await picture(current, atUs, `replaced-${atUs}`);
    assert.notEqual(a.sha256, b.sha256, "Wrong-acquisition control must visibly differ");
    assert.equal(actual.sha256, b.sha256, "Replacement did not select its new pointer history");
    comparisons.push({
      original: a,
      reference: b,
      actual,
      wrongAcquisitionRejected: true,
    });
  }
  report.checks.acquisitionReplacement = {
    originalSource,
    replacementSource,
    before,
    replaced,
    comparisons,
  };
  const physical = {
    assetId: replacementSource.assetId,
    streamId: replacementSource.streamId,
  };
  const rollback = [];
  for (const enabled of [true, false]) {
    if (!enabled) {
      const disabled = await edit(current, [
        {
          operation: "processing.set",
          target,
          steps: before.steps.map((step) => ({
            ...step,
            enabled: step.processor.type === "pointer" ? false : step.enabled,
          })),
        },
      ]);
      current = selected(current.projectId, disabled);
    }
    const state = await call("revision.get", { projectId: current.projectId });
    const beforePicture = await picture(current, 1000000, `rollback-before-${enabled}`);
    const error = await edit(
      current,
      [
        { operation: "canvas.set", canvas: { width: 320 } },
        {
          operation: "replace",
          clipId,
          kind: "video",
          media: { ...physical, source: range },
          fit: "exact",
        },
      ],
      { error: true },
    );
    assert.equal(error.code, "INVALID_EDIT");
    assert.equal(error.details.cause, "INVALID_COMPOSITION");
    assert.match(error.message, /explicit clip acquisition/);
    assert.deepEqual(
      await call("revision.get", { projectId: current.projectId }),
      state,
      "Rejected batch changed the project head or document",
    );
    const afterPicture = await picture(current, 1000000, `rollback-after-${enabled}`);
    assert.equal(afterPicture.sha256, beforePicture.sha256);
    rollback.push({ enabled, error, state, beforePicture, afterPicture });
  }
  report.checks.atomicIncompatibility = rollback;
  const reset = await edit(current, [
    {
      operation: "replace",
      clipId,
      kind: "video",
      media: { ...physical, source: range },
      fit: "exact",
      processing: "reset",
    },
  ]);
  current = selected(current.projectId, reset);
  assert.deepEqual((await call("processing.get", { ...current, target })).steps, []);
  const raw = await project(physical, []);
  const resetComparisons = [];
  for (const atUs of [700000, 1500000]) {
    const actual = await picture(current, atUs, `reset-${atUs}`),
      expected = await picture(raw.selection, atUs, `raw-${atUs}`);
    assert.equal(actual.sha256, expected.sha256, "Reset retained clip processing");
    assert.notEqual(
      actual.sha256,
      comparisons.find((row) => row.actual.atUs === atUs).actual.sha256,
      "Reset no-op control escaped",
    );
    resetComparisons.push({ actual, expected, resetNoopRejected: true });
  }
  report.checks.reset = { reset, comparisons: resetComparisons };
  const paddingProject = await project(replacementSource);
  const padded = await edit(paddingProject.selection, [
    {
      operation: "replace",
      clipId: paddingProject.labels.clip,
      kind: "video",
      media: {
        ...replacementSource,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      },
      fit: "hold",
    },
  ]);
  const paddedSelection = selected(paddingProject.selection.projectId, padded);
  const tail = padded.revision.document.clips.find(
    (clip) => clip.id !== paddingProject.labels.clip,
  );
  assert.deepEqual(tail.source, { kind: "hold", atUs: 999999 });
  const prefixSteps = (
    await call("processing.get", {
      ...paddedSelection,
      target: { kind: "clip", id: paddingProject.labels.clip },
    })
  ).steps;
  const tailSteps = (
    await call("processing.get", {
      ...paddedSelection,
      target: { kind: "clip", id: tail.id },
    })
  ).steps;
  const settings = (steps) => steps.map(({ enabled, processor }) => ({ enabled, processor }));
  assert.deepEqual(settings(tailSteps), settings(prefixSteps));
  assert.ok(
    tailSteps.every((step) => !prefixSteps.some((original) => original.id === step.id)),
    "Copied tail must own its step IDs",
  );
  const heldReference = await project(replacementSource, pointerSteps, {
    kind: "hold",
    atUs: 999999,
  });
  const expectedHold = await picture(heldReference.selection, 1000000, "padding-hold-reference");
  const paddingComparisons = [];
  for (const atUs of [1000000, 1500000, 1900000]) {
    const actual = await picture(paddedSelection, atUs, `padded-tail-${atUs}`);
    assert.equal(
      actual.sha256,
      expectedHold.sha256,
      "Padded tail lost processing or advanced source history",
    );
    paddingComparisons.push(actual);
  }
  const prefix = await picture(paddedSelection, 700000, "padded-prefix"),
    prefixReference = comparisons[0].reference;
  assert.equal(prefix.sha256, prefixReference.sha256);
  assert.notEqual(
    expectedHold.sha256,
    comparisons[2].reference.sha256,
    "Advancing-pointer control must differ from held tail",
  );
  report.checks.padding = {
    padded,
    prefixSteps,
    tailSteps,
    expectedHold,
    comparisons: paddingComparisons,
    prefix,
    prefixReference,
    advancingPointerRejected: true,
  };
  const trimProject = await project(originalSource);
  const trimmed = await edit(trimProject.selection, [
    {
      operation: "trim",
      clipId: trimProject.labels.clip,
      range: { startUs: 950001, endUs: 1500001 },
      ripple: "none",
    },
  ]);
  const trimmedSelection = selected(trimProject.selection.projectId, trimmed),
    trimComparisons = [];
  for (const atUs of [1000000, 1100000, 1500000]) {
    const expected = await picture(original.selection, atUs, `trim-reference-${atUs}`),
      actual = await picture(trimmedSelection, atUs, `trimmed-${atUs}`);
    assert.equal(
      actual.sha256,
      expected.sha256,
      "Trim reset history or changed source-time mapping",
    );
    trimComparisons.push({ actual, expected });
  }
  const noTrail = await project(
    originalSource,
    pointerSteps.map((step) =>
      step.processor.type === "pointer" ? { processor: { type: "pointer", trailUs: 0 } } : step,
    ),
  );
  const omittedHistory = await picture(noTrail.selection, 1000000, "trim-omitted-history-control");
  assert.notEqual(
    omittedHistory.sha256,
    trimComparisons[0].actual.sha256,
    "No-history control escaped trim comparison",
  );
  report.checks.trimHistory = {
    trimmed,
    comparisons: trimComparisons,
    omittedHistory,
    omittedHistoryRejected: true,
  };
  const historyProject = await project(originalSource);
  let historySelection = historyProject.selection;
  const history = [];
  for (const scope of ["clip", "track", "group", "outer", "output"]) {
    const processingTarget =
      scope === "output"
        ? { kind: "output" }
        : {
            kind: scope === "outer" ? "group" : scope,
            id: historyProject.labels[scope],
          };
    const steps =
      scope === "clip"
        ? [
            { processor: { type: "pointer", trailUs: 600000 } },
            { processor: { type: "geometry", rotationDeg: 180 } },
          ]
        : scope === "track" || scope === "outer"
          ? [
              {
                processor: {
                  type: "opacity",
                  opacity: scope === "track" ? 0.6 : 0.7,
                },
              },
            ]
          : [
              {
                processor: {
                  type: "geometry",
                  rotationDeg: 180,
                  ...(scope === "group"
                    ? {
                        rect: { x: 16, y: 8, width: 200, height: 130 },
                        fit: "stretch",
                      }
                    : {}),
                },
              },
            ];
    const previous = await call("revision.get", {
      projectId: historySelection.projectId,
    });
    const beforePicture = await picture(historySelection, 1000000, `history-${scope}-before`);
    const request = {
      projectId: historySelection.projectId,
      expectedRevisionId: historySelection.revisionId,
      requestId: randomUUID(),
      operations: [{ operation: "processing.set", target: processingTarget, steps }],
    };
    const applied = await call("edit.apply", request);
    const appliedSelection = selected(historySelection.projectId, applied);
    const afterPicture = await picture(appliedSelection, 1000000, `history-${scope}-after`);
    assert.notEqual(
      afterPicture.sha256,
      beforePicture.sha256,
      `${scope} processing no-op escaped image comparison`,
    );
    assert.deepEqual(
      await call("edit.apply", request, { transport: "mcp" }),
      applied,
      "Cross-transport replay changed receipt",
    );
    const undone = await call(
      "edit.undo",
      {
        projectId: historySelection.projectId,
        expectedRevisionId: applied.revision.revisionId,
        requestId: randomUUID(),
      },
      { transport: "mcp" },
    );
    assert.deepEqual(undone.document, previous.revision.document);
    const undoSelection = selected(historySelection.projectId, undone),
      undoPicture = await picture(undoSelection, 1000000, `history-${scope}-undo`);
    assert.equal(
      undoPicture.sha256,
      beforePicture.sha256,
      `${scope} undo changed delivered pixels`,
    );
    assert.deepEqual(
      await call("edit.apply", request),
      applied,
      "Old request replay lost original receipt after undo",
    );
    assert.equal(
      (await call("project.get", { projectId: historySelection.projectId })).currentRevisionId,
      undone.id,
      "Replay mutated the current head",
    );
    const restored = await call("edit.restore", {
      projectId: historySelection.projectId,
      expectedRevisionId: undone.id,
      targetRevisionId: applied.revision.revisionId,
      requestId: randomUUID(),
    });
    assert.deepEqual(restored.document, applied.revision.document);
    historySelection = selected(historySelection.projectId, restored);
    const restoredPicture = await picture(historySelection, 1000000, `history-${scope}-restored`);
    assert.equal(
      restoredPicture.sha256,
      afterPicture.sha256,
      `${scope} restore changed delivered pixels`,
    );
    const historicalPicture = await picture(
      appliedSelection,
      1000000,
      `history-${scope}-historical`,
    );
    assert.equal(historicalPicture.sha256, afterPicture.sha256);
    history.push({
      scope,
      processingTarget,
      request,
      applied,
      undone,
      restored,
      beforePicture,
      afterPicture,
      undoPicture,
      restoredPicture,
      historicalPicture,
      noOpRejected: true,
      replayKeptHead: true,
    });
  }
  report.checks.processingHistory = history;
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
      await writeFile(join(out, "service.log"), service.logs.join(""));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
