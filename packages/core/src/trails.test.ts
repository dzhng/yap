import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CaptureStore } from "./capture-store.js";
import { recordingEvidenceOwner, SourceEvidenceStore } from "./evidence.js";
import type { VisualSampler } from "./scenes.js";
import { FileSourceEvidence, writeSourceEvidencePages } from "./evidence-pages.js";
import { readRawCursor } from "./raw-cursor.js";
import { planFrameTrail } from "./trails.js";
import { PresentationEvidence } from "./presentation-evidence.js";
import {
  PresentationPointerHistory,
  pointerHistoryBudget,
} from "./presentation-pointer-history.js";
import { PresentationPointer } from "./presentation-pointer.js";
import { writePointerSchedule } from "./pointer-schedule.js";
import { type TimeRange } from "./presentation-time.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
const geometry = (sourceUs = 0, epoch = 1) => ({
  event: "geometry",
  data: {
    sourceUs,
    epoch,
    hostUs: sourceUs + 1000,
    geometry: {
      outputWidth: 100,
      outputHeight: 80,
      contentScale: 1,
      scaleFactor: 1,
      contentRect: { x: 0, y: 0, width: 100, height: 80 },
    },
  },
});
const point = (sourceUs: number, x: number, y = 20, eligibility = "inside", geometryEpoch = 1) => ({
  event: "cursorSample",
  data: { sourceUs, x, y, globalX: x, globalY: y, buttons: 0, eligibility, geometryEpoch },
});
async function fixture(records: { event: string; data: Record<string, unknown> }[], mode?: string) {
  const root = mkdtempSync(join(tmpdir(), "trail-plan-"));
  let next = 0;
  const store = new CaptureStore(join(root, "catalog.sqlite"), {
    now: () => "",
    newId: () => String(++next),
  });
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const recording = store.allocate().recording;
  const identity = {
    owner: { kind: "recording" as const, id: recording.id },
    sourceId: recording.sourceId,
    generation: "fixture",
  };
  const file = join(root, "normalized.jsonl");
  let nativeReceipt;
  if (mode) {
    execFileSync(
      new URL("../../../helpers/mac/.build/debug/YapCaptureTests", import.meta.url).pathname,
      [],
      {
        env: { ...process.env, YAP_CURSOR_HOLD_FIXTURES: root },
      },
    );
    const result = JSON.parse(
      execFileSync(
        new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url).pathname,
        [],
        {
          input:
            JSON.stringify({
              id: "held",
              operation: "media.sourceEvidence",
              params: { directory: join(root, mode), output: file },
            }) + "\n",
          encoding: "utf8",
        },
      ),
    );
    if (!result.ok) throw Error(JSON.stringify(result));
    nativeReceipt = result.data;
    records = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  const body = records.map((row) => JSON.stringify(row) + "\n").join("");
  writeFileSync(file, body);
  const cursors = records.filter((r) => r.event === "cursorSample");
  const evidence = new SourceEvidenceStore(store, recordingEvidenceOwner(store));
  const metadata = await evidence.ingest({
    ...identity,
    file,
    receipt: nativeReceipt ?? {
      file,
      journal: "capture.journal.jsonl",
      header: { sessionID: recording.sourceId },
      cursorSamples: cursors.length,
      geometryRecords: records.filter((r) => r.event === "geometry").length,
      pauseEvents: records.filter((r) => r.event === "pause").length,
      displaySpaces: 0,
      audioIntervals: 0,
      firstCursorSourceUs: (cursors[0]?.data.sourceUs as number) ?? null,
      lastCursorSourceUs: (cursors.at(-1)?.data.sourceUs as number) ?? null,
      bytes: Buffer.byteLength(body),
      lastSequence: records.length,
      incompleteTail: false,
      finished: true,
    },
  });
  const sample =
    (frames: [number, number][], size = [8, 8]): VisualSampler =>
    async (request) => ({
      sourceWidth: 100,
      sourceHeight: 80,
      samples: request.atSourceUs.map((at) => {
        const selected = frames
          .filter(([t]) => t >= request.kept.startUs && t < request.kept.endUs)
          .sort(([a], [b]) => Math.abs(a - at) - Math.abs(b - at) || a - b)[0];
        if (!selected) throw new Error("No reference sample");
        return {
          requestedSourceUs: at,
          actualSourceUs: selected[0],
          distanceUs: Math.abs(selected[0] - at),
          width: size[0]!,
          height: size[1]!,
          rgbBase64: Buffer.alloc(size[0]! * size[1]! * 3, selected[1]).toString("base64"),
        };
      }),
    });
  return { evidence, identity, sample, metadata };
}
const request = {
  source: "/generated/video.mov",
  kept: { startUs: 0, endUs: 4000000 },
  requestedSourceUs: 1500000,
};
const signal = () => new AbortController().signal;

test("held image retains requested-time circle and future identical image never imports a later wave", async () => {
  const f = await fixture([
    geometry(),
    point(200000, 20, 20),
    point(400000, 30, 10),
    point(600000, 40, 20),
    point(800000, 30, 30),
    point(1000000, 20, 20),
    point(1600000, 80, 40),
    point(1700000, 90, 40),
  ]);
  for (const frames of [
    [[0, 0]],
    [
      [0, 0],
      [2000000, 0],
    ],
  ] as [number, number][][]) {
    const plan = await planFrameTrail(request, { ...f, sample: f.sample(frames) }, signal());
    expect(plan.overlay.trailUs).toBe(2000000);
    expect(plan.overlay.trail).toEqual([
      [
        { atSourceUs: 200000, x: 20, y: 20 },
        { atSourceUs: 400000, x: 30, y: 10 },
        { atSourceUs: 600000, x: 40, y: 20 },
        { atSourceUs: 800000, x: 30, y: 30 },
        { atSourceUs: 1000000, x: 20, y: 20 },
      ],
    ]);
    expect(plan.overlay.pointer).toEqual({ atSourceUs: 1000000, x: 20, y: 20 });
    expect(plan.requestedSourceUs).toBe(1500000);
  }
});

test("future changed frames veto past trails without borrowing future cursor samples", async () => {
  const f = await fixture([geometry(), point(1000000, 20), point(1600000, 80)]);
  const plan = await planFrameTrail(
    request,
    {
      ...f,
      sample: f.sample([
        [0, 0],
        [2000000, 255],
      ]),
    },
    signal(),
  );
  expect(plan.overlay).toEqual({ trail: [], trailUs: 2000000, pointer: null });
  expect(plan.cutoffs).toContainEqual({ reason: "future_scene", atSourceUs: 2000000 });
  expect(plan.pointerObservation?.sourceUs).toBe(1000000);
});

test("held window moves reset old pointing while compatible new pixel coordinates remain usable", async () => {
  const movedBase = geometry(500000, 2);
  const moved = {
    ...movedBase,
    data: {
      ...movedBase.data,
      geometry: {
        ...movedBase.data.geometry,
        screenRect: { x: 500, y: 300, width: 100, height: 80 },
      },
    },
  };
  const f = await fixture([
    geometry(),
    point(400000, 10),
    moved,
    point(600000, 30, 20, "inside", 2),
  ]);
  const plan = await planFrameTrail(request, { ...f, sample: f.sample([[0, 0]]) }, signal());
  expect(plan.overlay.trail).toEqual([[{ atSourceUs: 600000, x: 30, y: 20 }]]);
  expect(plan.overlay.pointer).toEqual({ atSourceUs: 600000, x: 30, y: 20 });
  expect(plan.cutoffs).toContainEqual({ reason: "geometry", atSourceUs: 500000 });
  moved.data.geometry.contentRect.width = 80;
  const resized = await fixture([geometry(), moved, point(600000, 30, 20, "inside", 2)]);
  const incompatible = await planFrameTrail(
    request,
    { ...resized, sample: resized.sample([[0, 0]]) },
    signal(),
  );
  expect(incompatible.overlay.pointer).toBeNull();
  expect(incompatible.overlay.trail).toEqual([]);
  expect(incompatible.cutoffs).toContainEqual({ reason: "geometry", atSourceUs: 500000 });
});

test("cut, scene and pause resets clip history, and equal-time pause points are omitted", async () => {
  const f = await fixture([
    geometry(),
    point(200000, 10),
    point(600000, 20),
    { event: "pause", data: { atSourceUs: 700000, elapsedPauseUs: 1000000 } },
    point(700000, 30),
    point(800000, 40),
    point(1000000, 50),
  ]);
  const plan = await planFrameTrail(
    { ...request, kept: { startUs: 500000, endUs: 4000000 } },
    {
      ...f,
      sample: f.sample([
        [500000, 0],
        [900000, 255],
        [1500000, 255],
      ]),
    },
    signal(),
  );
  expect(plan.overlay.trail).toEqual([[{ atSourceUs: 1000000, x: 50, y: 20 }]]);
  expect(plan.cutoffs).toContainEqual({ reason: "kept_start", atSourceUs: 500000 });
  expect(plan.cutoffs).toContainEqual({ reason: "pause", atSourceUs: 700000 });
  expect(plan.cutoffs).toContainEqual({ reason: "scene", atSourceUs: 900000 });
  const equal = await planFrameTrail(
    { ...request, requestedSourceUs: 700000 },
    { ...f, sample: f.sample([[0, 0]]) },
    signal(),
  );
  expect(equal.overlay.pointer).toBeNull();
  expect(equal.overlay.trail).toEqual([]);
});

test("ineligible observations split paths and the latest unknown pointer never revives an older point", async () => {
  const f = await fixture([
    geometry(),
    point(200000, 10),
    point(300000, -1, 20, "outside"),
    point(400000, 20),
    point(500000, 30),
    point(500000, 40, 20, "unknownGeometry", 0),
  ]);
  const plan = await planFrameTrail(request, { ...f, sample: f.sample([[0, 0]]) }, signal());
  expect(plan.overlay.trail).toEqual([
    [{ atSourceUs: 200000, x: 10, y: 20 }],
    [{ atSourceUs: 400000, x: 20, y: 20 }],
  ]);
  expect(plan.overlay.pointer).toBeNull();
  expect(plan.cutoffs).toContainEqual({ reason: "unknown_geometry", atSourceUs: 500000 });
});

test("pointer-only preserves an old observation with explicit bounded scene compatibility", async () => {
  const f = await fixture([geometry(), point(1000000, 30)]);
  const far = {
    ...request,
    requestedSourceUs: 119000000,
    kept: { startUs: 0, endUs: 121000000 },
    trailUs: 0,
  };
  for (const changed of [false, true]) {
    const plan = await planFrameTrail(
      far,
      {
        ...f,
        sample: f.sample([
          [0, 0],
          [120000000, changed ? 255 : 0],
        ]),
      },
      signal(),
    );
    expect(plan.overlay.trail).toEqual([]);
    expect(plan.overlay.pointer).toEqual(changed ? null : { atSourceUs: 1000000, x: 30, y: 20 });
    expect(plan.scene.coverage).toHaveLength(1);
    if (!changed) expect(plan.stalePointerScene?.coverage).toHaveLength(1);
  }
});

test("stale-pointer endpoint comparison rejects a known changed held image without a time-to-live", async () => {
  const f = await fixture([geometry(), point(1000000, 30)]);
  const far = {
    ...request,
    requestedSourceUs: 119000000,
    kept: { startUs: 0, endUs: 121000000 },
    trailUs: 0,
  };
  const plan = await planFrameTrail(
    far,
    {
      ...f,
      sample: f.sample([
        [0, 0],
        [118000000, 255],
      ]),
    },
    signal(),
  );
  expect(plan.scene.futureComparison).toBeNull();
  expect(plan.stalePointerComparison?.boundary).toBe(true);
  expect(plan.overlay.pointer).toBeNull();
});

test("repeated geometry confirmations do not reset a run and unresolved null placement fails explicitly", async () => {
  const f = await fixture([geometry(), point(200000, 10), geometry(300000), point(400000, 20)]);
  const plan = await planFrameTrail(request, { ...f, sample: f.sample([[0, 0]]) }, signal());
  expect(plan.overlay.trail[0]).toEqual([
    { atSourceUs: 200000, x: 10, y: 20 },
    { atSourceUs: 400000, x: 20, y: 20 },
  ]);
  expect(plan.cutoffs.some((cutoff) => cutoff.reason === "geometry")).toBe(false);
  const unplaced = { event: "geometry", data: { ...geometry(1000000, 2).data, sourceUs: null } };
  const unknown = await fixture([geometry(), unplaced, point(1200000, 20, 20, "inside", 2)]);
  await expect(
    planFrameTrail(request, { ...unknown, sample: unknown.sample([[0, 0]]) }, signal()),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  const confirmed = await fixture([geometry(), unplaced, geometry(2000000, 2), point(1200000, 20)]);
  const historical = await planFrameTrail(
    request,
    { ...confirmed, sample: confirmed.sample([[0, 0]]) },
    signal(),
  );
  expect(historical.overlay.pointer).toEqual({ atSourceUs: 1200000, x: 20, y: 20 });
});

test("missing geometry, reference and generation remain explicit and scene cancellation propagates", async () => {
  const f = await fixture([point(1000000, 20)]);
  await expect(
    planFrameTrail(request, { ...f, sample: f.sample([[0, 0]]) }, signal()),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  const valid = await fixture([geometry(), point(1000000, 20)]);
  await expect(
    planFrameTrail(request, { ...valid, sample: valid.sample([[2000000, 0]]) }, signal()),
  ).rejects.toThrow("No reference sample");
  await expect(
    planFrameTrail(
      request,
      {
        ...valid,
        identity: { ...valid.identity, generation: "missing" },
        sample: valid.sample([[0, 0]]),
      },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "PREREQUISITE_MISSING" });
  const controller = new AbortController();
  const sample: VisualSampler = async (params) => {
    controller.abort();
    return valid.sample([[0, 0]])(params, controller.signal);
  };
  await expect(planFrameTrail(request, { ...valid, sample }, controller.signal)).rejects.toThrow();
});

test("native-normalized buffered pause fixture keeps only later source-time observations", async () => {
  const nativeFixture = new URL(
    "../../../specs/done/recording-for-ai/assets/trail-evidence/normalized.jsonl",
    import.meta.url,
  );
  const before = readFileSync(nativeFixture, "utf8");
  const f = await fixture(
    before
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  const plan = await planFrameTrail(request, { ...f, sample: f.sample([[0, 0]]) }, signal());
  expect(plan.overlay.trail).toEqual([[{ atSourceUs: 101, x: 40, y: 20 }]]);
  expect(plan.overlay.pointer).toEqual({ atSourceUs: 101, x: 40, y: 20 });
  expect(readFileSync(nativeFixture, "utf8")).toBe(before);
});

test("a pause before a future identical image vetoes old evidence without acquiring a future pointer", async () => {
  const f = await fixture([
    geometry(),
    point(1000000, 20),
    { event: "pause", data: { atSourceUs: 1800000, elapsedPauseUs: 1000000 } },
    point(1900000, 80),
  ]);
  const plan = await planFrameTrail(
    request,
    {
      ...f,
      sample: f.sample([
        [0, 0],
        [2000000, 0],
      ]),
    },
    signal(),
  );
  expect(plan.scene.futureComparison?.boundary).toBe(false);
  expect(plan.overlay).toEqual({ trail: [], trailUs: 2000000, pointer: null });
  expect(plan.cutoffs).toContainEqual({ reason: "pause", atSourceUs: 1800000 });
  expect(plan.pointerObservation?.sourceUs).toBe(1000000);
});

const exact = (value: number) => ({ value: String(value), timescale: 1_000_000 });
const presentationRecord = (start: number, end: number, pts: number | null, shade = 0) => ({
  spanIndex: 0,
  start: exact(start),
  end: exact(end),
  empty: pts === null,
  ...(pts === null
    ? {}
    : {
        sampleTime: exact(pts),
        actualSourceUs: pts,
        width: 64,
        height: 51,
        rgbBase64: Buffer.alloc(64 * 51 * 3, shade).toString("base64"),
      }),
});
async function withPresentation(
  revision: Readonly<{ spans: readonly TimeRange[]; durationUs: number }>,
  records: unknown[],
  run: (source: PresentationEvidence) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "presentation-pointer-")),
    file = join(root, "support.jsonl");
  const header = {
    version: 1 as const,
    sourceWidth: 100,
    sourceHeight: 80,
    durationUs: revision.durationUs,
    spanCount: revision.spans.length,
  };
  const body = [header, ...records].map((row) => JSON.stringify(row) + "\n").join("");
  writeFileSync(file, body);
  const source = await PresentationEvidence.open(
    {
      version: 1,
      sourceWidth: 100,
      sourceHeight: 80,
      durationUs: revision.durationUs,
      file,
      records: records.length,
      bytes: Buffer.byteLength(body),
    },
    revision.spans,
    signal(),
  );
  try {
    await run(source);
  } finally {
    await source.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("presentation pointer shares cut/scene eligibility and identical still decisions when pictures agree", async () => {
  const f = await fixture([
    geometry(),
    point(700_000, 10),
    point(800_000, 20),
    point(1_050_000, 30),
  ]);
  const revision = { spans: [{ startUs: 750_000, endUs: 1_250_000 }], durationUs: 500000 };
  await withPresentation(
    revision,
    [
      presentationRecord(750_000, 1_000_000, 0),
      presentationRecord(1_000_000, 1_250_000, 1_000_000, 255),
    ],
    async (source) => {
      const pointer = new PresentationPointer(source, f.evidence, f.identity, signal());
      const atCut = await pointer.at(0, 750_000);
      expect(atCut.kind === "picture" && atCut.plan.overlay.pointer).toBe(null);
      const held = await pointer.at(0, 800_000);
      expect(held.kind === "picture" && held.plan.overlay).toEqual({
        trail: [],
        trailUs: 0,
        pointer: { atSourceUs: 800_000, x: 20, y: 20 },
      });
      const changed = await pointer.at(0, 1_000_000);
      expect(changed.kind === "picture" && changed.plan.overlay.pointer).toBe(null);
      expect(changed.kind === "picture" && changed.plan.cutoffs).toContainEqual({
        reason: "scene",
        atSourceUs: 1_000_000,
      });
      const current = await pointer.at(0, 1_100_000);
      const still = await planFrameTrail(
        {
          source: "/video.mov",
          kept: revision.spans[0]!,
          requestedSourceUs: 1_100_000,
          trailUs: 0,
        },
        {
          ...f,
          sample: f.sample(
            [
              [0, 0],
              [1_000_000, 255],
            ],
            [64, 51],
          ),
        },
        signal(),
      );
      expect(current.kind).toBe("picture");
      if (current.kind === "picture")
        expect(JSON.stringify(current.plan)).toBe(JSON.stringify(still));
    },
  );
});

test("presentation pointer keeps the same pause, geometry, outside and unknown rules", async () => {
  const f = await fixture([
    geometry(),
    point(800_000, 20),
    { event: "pause", data: { atSourceUs: 900_000, elapsedPauseUs: 2_000_000 } },
    point(900_000, 25),
    point(950_000, 30),
    geometry(1_000_000, 2),
    point(1_010_000, 40, 20, "inside", 2),
    point(1_020_000, 45, 20, "outside", 2),
    point(1_030_000, 50, 20, "unknownGeometry", 0),
  ]);
  const revision = { spans: [{ startUs: 0, endUs: 2_000_000 }], durationUs: 2_000_000 };
  await withPresentation(
    revision,
    [presentationRecord(0, 1_000_000, 0), presentationRecord(1_000_000, 2_000_000, 1_000_000)],
    async (source) => {
      const pointer = new PresentationPointer(source, f.evidence, f.identity, signal());
      for (const [at, expected] of [
        [900_000, null],
        [950_000, 30],
        [1_000_000, null],
        [1_010_000, 40],
        [1_020_000, null],
        [1_030_000, null],
      ] as const) {
        const result = await pointer.at(0, at);
        if (result.kind !== "picture") throw new Error("Expected a picture");
        expect(result.plan.overlay.pointer?.x ?? null).toBe(expected);
        expect(result.plan.overlay.trail).toEqual([]);
      }
    },
  );
});

test("empty presentation has no pointer and a pointer observed over empty time never revives", async () => {
  const f = await fixture([geometry(), point(800_000, 20), point(1_050_000, 30)]);
  const revision = { spans: [{ startUs: 0, endUs: 2_000_000 }], durationUs: 2_000_000 };
  await withPresentation(
    revision,
    [presentationRecord(0, 1_000_000, null), presentationRecord(1_000_000, 2_000_000, 1_000_000)],
    async (source) => {
      const pointer = new PresentationPointer(source, f.evidence, f.identity, signal());
      expect(await pointer.at(0, 900_000)).toMatchObject({
        kind: "empty",
        pointer: null,
        record: { empty: true },
      });
      const stale = await pointer.at(0, 1_000_000);
      expect(stale.kind === "picture" && stale.plan.overlay.pointer).toBe(null);
      expect(stale.kind === "picture" && stale.plan.cutoffs).toContainEqual({
        reason: "empty_presentation",
        atSourceUs: 800_000,
      });
      const fresh = await pointer.at(0, 1_100_000);
      expect(fresh.kind === "picture" && fresh.plan.overlay.pointer?.x).toBe(30);
    },
  );
});

test("movie schedule keeps a pointer hidden through A-B-A until a fresh cursor observation", async () => {
  const f = await fixture([geometry(), point(500_000, 20), point(2_500_000, 30)]);
  const revision = { spans: [{ startUs: 0, endUs: 3_000_000 }], durationUs: 3_000_000 };
  await withPresentation(
    revision,
    [
      presentationRecord(0, 1_000_000, 0),
      presentationRecord(1_000_000, 2_000_000, 1_000_000, 255),
      presentationRecord(2_000_000, 3_000_000, 2_000_000),
    ],
    async (presentation) => {
      const output = join(dirname(presentation.receipt.file), "pointer.jsonl");
      const receipt = await writePointerSchedule(
        {
          presentation,
          revisionId: "fixture-revision",
          evidence: f.evidence,
          identity: f.identity,
          output,
          maxBytes: 100_000,
          maxEvents: 1000,
        },
        signal(),
      );
      const [header, ...events] = readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(header.revisionId).toBe("fixture-revision");
      expect(receipt.records).toBe(4);
      expect(
        events.map((row) => [Number(row.at.value) / row.at.timescale, row.pointer?.x ?? null]),
      ).toEqual([
        [0, null],
        [0.5, 20],
        [1, null],
        [2.5, 30],
      ]);
    },
  );
});

async function scheduled(
  presentation: PresentationEvidence,
  f: Awaited<ReturnType<typeof fixture>>,
  options: { maxEvents?: number; maxBytes?: number; signal?: AbortSignal } = {},
) {
  const output = join(dirname(presentation.receipt.file), "pointer.jsonl");
  const receipt = await writePointerSchedule(
    {
      presentation,
      revisionId: "scheduled-fixture",
      evidence: f.evidence,
      identity: f.identity,
      output,
      maxBytes: options.maxBytes ?? 100_000,
      maxEvents: options.maxEvents ?? 100_000,
    },
    options.signal ?? signal(),
  );
  const [header, ...events] = readFileSync(output, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { receipt, header, events, output };
}

test("schedule drains duplicate timestamps across pages and keeps pause/geometry reset equality", async () => {
  const f = await fixture([
    geometry(),
    ...Array.from({ length: 600 }, (_, i) => point(500_000, i % 80)),
    point(500_000, 42),
    point(600_000, 42),
    { event: "pause", data: { atSourceUs: 700_000, elapsedPauseUs: 2_000_000 } },
    point(700_000, 80),
    point(700_001, 30),
    geometry(800_000, 2),
    point(800_001, 45, 20, "inside", 2),
  ]);
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 1_000_000 }], durationUs: 1_000_000 },
    [presentationRecord(0, 1_000_000, 0)],
    async (presentation) => {
      const { events } = await scheduled(presentation, f);
      expect(
        events.map((e) => [Number(e.at.value) / e.at.timescale, e.pointer?.x ?? null]),
      ).toEqual([
        [0, null],
        [0.5, 42],
        [0.7, null],
        [0.700001, 30],
        [0.8, null],
        [0.800001, 45],
      ]);
    },
  );
});

test("fractional presentation resets retain exact output time and never borrow the later cursor", async () => {
  for (const subMicrosecond of [false, true]) {
    const before = subMicrosecond ? 0 : 333_333,
      after = before + 1;
    const boundary = subMicrosecond
      ? { value: "2", timescale: 5_000_000 }
      : { value: "1", timescale: 3 };
    const duration = subMicrosecond ? 2 : 1_000_000;
    const f = await fixture([geometry(), point(before, 20), point(after, 40)]);
    await withPresentation(
      { spans: [{ startUs: 0, endUs: duration }], durationUs: duration },
      [
        { ...presentationRecord(0, 1, 0), end: boundary },
        {
          ...presentationRecord(1, duration, subMicrosecond ? 0 : 333_333, 255),
          start: boundary,
          sampleTime: boundary,
        },
      ],
      async (presentation) => {
        const { events } = await scheduled(presentation, f);
        const atBoundary = events.find(
          (e) => e.at.value === boundary.value && e.at.timescale === boundary.timescale,
        );
        expect(atBoundary?.pointer).toBe(null);
        expect(events.find((e) => e.pointer?.x === 20)?.pointer.atSourceUs).toBe(before);
        const fresh = events.find((e) => e.pointer?.x === 40);
        expect(fresh.at).toEqual(exact(after));
        expect(fresh.pointer.atSourceUs).toBe(after);
      },
    );
  }
});

test("each kept span gets an initial state; deleted and empty observations cannot revive", async () => {
  const f = await fixture([
    geometry(),
    point(200_000, 20),
    point(900_000, 30),
    point(1_200_000, 40),
    point(1_600_000, 50),
  ]);
  const revision = {
    spans: [
      { startUs: 0, endUs: 500_000 },
      { startUs: 1_000_000, endUs: 2_000_000 },
    ],
    durationUs: 1500000,
  };
  await withPresentation(
    revision,
    [
      presentationRecord(0, 500_000, 0),
      { ...presentationRecord(1_000_000, 1_500_000, null), spanIndex: 1 },
      { ...presentationRecord(1_500_000, 2_000_000, 1_500_000), spanIndex: 1 },
    ],
    async (presentation) => {
      const { events } = await scheduled(presentation, f);
      expect(
        events.map((e) => [e.spanIndex, Number(e.at.value) / e.at.timescale, e.pointer?.x ?? null]),
      ).toEqual([
        [0, 0, null],
        [0, 0.2, 20],
        [1, 1, null],
        [1, 1.6, 50],
      ]);
    },
  );
});

test("schedule budgets, cancellation and publication races never publish partial output", async () => {
  for (const mode of ["events", "bytes", "cancel", "existing"] as const) {
    const f = await fixture([
      geometry(),
      ...Array.from({ length: 600 }, (_, i) => point(mode === "events" ? 1000 : 1000 + i, i % 80)),
    ]);
    const abort = new AbortController();
    if (mode === "cancel") {
      const original = f.evidence.exportRecords.bind(f.evidence);
      f.evidence.exportRecords = function* (identity, index) {
        for (const page of original(identity, index)) {
          yield page;
          if (index === "cursor") abort.abort();
        }
      };
    }
    await withPresentation(
      { spans: [{ startUs: 0, endUs: 1_000_000 }], durationUs: 1_000_000 },
      [presentationRecord(0, 1_000_000, 0)],
      async (presentation) => {
        const output = join(dirname(presentation.receipt.file), "pointer.jsonl");
        if (mode === "existing") {
          const original = f.evidence.exportRecords.bind(f.evidence);
          f.evidence.exportRecords = function* (identity, index, range) {
            for (const page of original(identity, index, range)) {
              yield page;
              if (index === "cursor" && !existsSync(output)) writeFileSync(output, "unrelated");
            }
          };
        }
        const promise = scheduled(presentation, f, {
          maxEvents: mode === "events" ? 20 : 10_000,
          maxBytes: mode === "bytes" ? 1 : 100_000,
          signal: abort.signal,
        });
        await expect(promise).rejects.toMatchObject(
          mode === "cancel"
            ? { name: "AbortError" }
            : { code: mode === "existing" ? "INVALID_OUTPUT" : "LIMIT_EXCEEDED" },
        );
        if (mode === "existing") expect(readFileSync(output, "utf8")).toBe("unrelated");
        else expect(existsSync(output)).toBe(false);
        expect(readdirSync(dirname(output)).some((n) => n.startsWith(".pointer-schedule-"))).toBe(
          false,
        );
      },
    );
  }
});

test("a late kept span seeks past deleted cursor history while preserving geometry and pause at the cut", async () => {
  const f = await fixture([
    geometry(),
    ...Array.from({ length: 600 }, (_, i) => point(1000 + i, i % 80)),
    geometry(500_000, 2),
    point(700_000, 20, 20, "inside", 2),
    { event: "pause", data: { atSourceUs: 750_000, elapsedPauseUs: 1_000_000 } },
    point(750_000, 30, 20, "inside", 2),
    point(750_001, 40, 20, "inside", 2),
  ]);
  const revision = { spans: [{ startUs: 750_000, endUs: 1_000_000 }], durationUs: 250000 };
  await withPresentation(
    revision,
    [presentationRecord(750_000, 1_000_000, 500_000)],
    async (presentation) => {
      const { events, receipt } = await scheduled(presentation, f, { maxEvents: 10 });
      expect(receipt.events).toBe(4);
      expect(
        events.map((e) => [Number(e.at.value) / e.at.timescale, e.pointer?.x ?? null]),
      ).toEqual([
        [0.75, null],
        [0.750001, 40],
      ]);
    },
  );
});

test("fresh cursor observations exactly at scene and kept boundaries remain eligible", async () => {
  const f = await fixture([
    geometry(),
    point(200_000, 20),
    point(1_000_000, 40),
    point(1_500_000, 50),
  ]);
  const revision = {
    spans: [
      { startUs: 0, endUs: 500_000 },
      { startUs: 1_000_000, endUs: 2_000_000 },
    ],
    durationUs: 1500000,
  };
  await withPresentation(
    revision,
    [
      presentationRecord(0, 500_000, 0),
      { ...presentationRecord(1_000_000, 1_500_000, 1_000_000, 255), spanIndex: 1 },
      { ...presentationRecord(1_500_000, 2_000_000, 1_500_000), spanIndex: 1 },
    ],
    async (presentation) => {
      const { events } = await scheduled(presentation, f);
      expect(
        events.map((e) => [Number(e.at.value) / e.at.timescale, e.pointer?.x ?? null]),
      ).toEqual([
        [0, null],
        [0.2, 20],
        [1, 40],
        [1.5, 50],
      ]);
    },
  );
});

test("a fractional picture never pulls a future pause into its event", async () => {
  const f = await fixture([
    geometry(),
    point(0, 20),
    { event: "pause", data: { atSourceUs: 1, elapsedPauseUs: 1000 } },
  ]);
  const boundary = { value: "3", timescale: 5_000_000 };
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 2 }], durationUs: 2 },
    [
      { ...presentationRecord(0, 1, 0), end: boundary },
      { ...presentationRecord(1, 2, 1), start: boundary, sampleTime: boundary },
    ],
    async (presentation) => {
      const { events } = await scheduled(presentation, f);
      expect(events.map((e) => [e.at, e.pointer?.x ?? null])).toEqual([
        [exact(0), 20],
        [exact(1), null],
      ]);
    },
  );
});

test("stale-pointer comparisons retain exact order when cumulative changes share a rounded timestamp", async () => {
  const f = await fixture([geometry(), point(0, 20)]);
  const one = { value: "1", timescale: 10_000_000 },
    two = { value: "2", timescale: 10_000_000 };
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 2 }], durationUs: 2 },
    [
      { ...presentationRecord(0, 1, 0), end: one },
      { ...presentationRecord(0, 1, 0, 16), start: one, end: two, sampleTime: one },
      { ...presentationRecord(0, 2, 0, 32), start: two, sampleTime: two },
    ],
    async (presentation) => {
      const { events } = await scheduled(presentation, f);
      expect(events.map((e) => [e.at, e.pointer?.x ?? null])).toEqual([
        [exact(0), 20],
        [two, null],
      ]);
    },
  );
});

test("sampled pointers preserve immutable lookback, requested clock and held/backward identity", async () => {
  const f = await fixture([
    geometry(),
    point(100_000, 10),
    point(200_000, 20),
    point(400_000, 40),
    point(900_000, 90),
  ]);
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 1_000_000 }], durationUs: 1_000_000 },
    [presentationRecord(0, 1_000_000, 0)],
    async (presentation) => {
      const h = new PresentationPointerHistory(
        { ...f, presentation },
        signal(),
        pointerHistoryBudget({
          maxEvents: 100,
          maxSamples: 10,
        }),
      );
      try {
        const first = await h.sample(0, 450_000, 300_000);
        expect(first.record).toMatchObject({ actualSourceUs: 0 });
        expect(first.inspection.kind).toBe("picture");
        if (first.inspection.kind !== "picture") throw Error("Expected picture");
        expect(first.inspection.plan.requestedSourceUs).toBe(450_000);
        expect(first.inspection.plan.overlay).toEqual({
          trailUs: 300_000,
          trail: [
            [
              { atSourceUs: 200_000, x: 20, y: 20 },
              { atSourceUs: 400_000, x: 40, y: 20 },
            ],
          ],
          pointer: { atSourceUs: 400_000, x: 40, y: 20 },
        });
        // A clip beginning at450ms must retain these earlier source observations.
        expect(await h.sample(0, 450_000, 300_000)).toEqual(first);
        const noTrail = await h.sample(0, 450_000, 0);
        expect(
          noTrail.inspection.kind === "picture" && noTrail.inspection.plan.overlay.trail,
        ).toEqual([]);
        const work = h.events;
        const earlier = await h.sample(0, 150_000, 300_000);
        expect(
          earlier.inspection.kind === "picture" && earlier.inspection.plan.overlay.pointer?.x,
        ).toBe(10);
        expect(h.events).toBeGreaterThan(work);
        expect(await h.sample(0, 450_000, 300_000)).toEqual(first);
      } finally {
        await h.close();
      }
    },
  );
});

test("sampled pointer visits intervening A-B-A scenes and physical gaps before a late request", async () => {
  const f = await fixture([
    geometry(),
    point(100_000, 10),
    point(1_000_000, 20),
    point(1_100_000, 30),
    point(2_500_000, 40),
  ]);
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 3_000_000 }], durationUs: 3_000_000 },
    [
      presentationRecord(0, 500_000, 0),
      presentationRecord(500_000, 750_000, 500_000, 255),
      presentationRecord(750_000, 1_000_000, 750_000),
      presentationRecord(1_000_000, 1_000_001, null),
      {
        ...presentationRecord(1_000_001, 3_000_000, 1_000_001),
        start: { value: "3000001", timescale: 3_000_000 },
        sampleTime: { value: "3000001", timescale: 3_000_000 },
        actualSourceUs: 1_000_000,
      },
    ].map((row, i) =>
      i === 3 ? { ...row, end: { value: "3000001", timescale: 3_000_000 } } : row,
    ),
    async (presentation) => {
      const h = new PresentationPointerHistory(
        { ...f, presentation },
        signal(),
        pointerHistoryBudget({
          maxEvents: 100,
          maxSamples: 10,
        }),
      );
      try {
        const afterScene = await h.sample(0, 900_000, 1_000_000);
        expect(
          afterScene.inspection.kind === "picture" && afterScene.inspection.plan.overlay,
        ).toEqual({ trailUs: 1_000_000, trail: [], pointer: null });
        expect((await h.sample(0, 1_000_000, 1_000_000)).inspection.kind).toBe("empty");
        const afterGap = await h.sample(0, 1_000_001, 1_000_000);
        expect(afterGap.inspection.kind === "picture" && afterGap.inspection.plan.overlay).toEqual({
          trailUs: 1_000_000,
          trail: [],
          pointer: null,
        });
        const fresh = await h.sample(0, 1_200_000, 1_000_000);
        expect(
          fresh.inspection.kind === "picture" &&
            fresh.inspection.plan.overlay.trail.flat().map((p) => p.x),
        ).toEqual([30]);
        expect(fresh.inspection.kind === "picture" && fresh.inspection.plan.cutoffs).toContainEqual(
          { reason: "empty_presentation", atSourceUs: 1_000_001 },
        );
      } finally {
        await h.close();
      }
    },
  );
});

test("sampled trails retain pause equality and geometry/outside run breaks", async () => {
  const f = await fixture([
    geometry(),
    point(100_000, 10),
    { event: "pause", data: { atSourceUs: 200_000, elapsedPauseUs: 1_000_000 } },
    point(200_000, 20),
    point(250_000, 25),
    point(300_000, 30, 20, "outside"),
    point(350_000, 35),
    geometry(400_000, 2),
    point(400_000, 40, 20, "inside", 2),
    point(450_000, 45, 20, "unknownGeometry", 2),
    point(500_000, 50, 20, "inside", 2),
  ]);
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 1_000_000 }], durationUs: 1_000_000 },
    [presentationRecord(0, 1_000_000, 0)],
    async (presentation) => {
      const h = new PresentationPointerHistory(
        { ...f, presentation },
        signal(),
        pointerHistoryBudget({
          maxEvents: 100,
          maxSamples: 10,
        }),
      );
      try {
        const pause = await h.sample(0, 200_000, 1_000_000);
        expect(pause.inspection.kind === "picture" && pause.inspection.plan.overlay).toEqual({
          trailUs: 1_000_000,
          trail: [],
          pointer: null,
        });
        const runs = await h.sample(0, 375_000, 1_000_000);
        expect(
          runs.inspection.kind === "picture" &&
            runs.inspection.plan.overlay.trail.map((run) => run.map((p) => p.x)),
        ).toEqual([[25], [35]]);
        const changed = await h.sample(0, 550_000, 1_000_000);
        expect(
          changed.inspection.kind === "picture" &&
            changed.inspection.plan.overlay.trail.map((run) => run.map((p) => p.x)),
        ).toEqual([[40], [50]]);
      } finally {
        await h.close();
      }
    },
  );
});

test("sampled pointer does not evaluate future invalid geometry or admit later journal events", async () => {
  const future = geometry(800_000, 2);
  future.data.geometry.outputWidth = 101;
  const f = await fixture([
    geometry(),
    point(100_000, 10),
    future,
    point(900_000, 90, 20, "inside", 2),
  ]);
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 1_000_000 }], durationUs: 1_000_000 },
    [presentationRecord(0, 1_000_000, 0)],
    async (presentation) => {
      const h = new PresentationPointerHistory(
        { ...f, presentation },
        signal(),
        pointerHistoryBudget({
          maxEvents: 100,
          maxSamples: 10,
        }),
      );
      try {
        const result = await h.sample(0, 500_000, 500_000);
        expect(
          result.inspection.kind === "picture" && result.inspection.plan.overlay.pointer?.x,
        ).toBe(10);
        await expect(h.sample(0, 850_000, 500_000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      } finally {
        await h.close();
      }
    },
  );
});

test("pointer sampling bounds occurrences and aggregate replay work and honors cancellation", async () => {
  const f = await fixture([geometry(), point(100_000, 10), point(200_000, 20)]);
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 1_000_000 }], durationUs: 1_000_000 },
    [presentationRecord(0, 1_000_000, 0)],
    async (presentation) => {
      const controller = new AbortController();
      const h = new PresentationPointerHistory(
        { ...f, presentation },
        controller.signal,
        pointerHistoryBudget({
          maxEvents: 6,
          maxSamples: 10,
        }),
      );
      try {
        await h.sample(0, 300_000, 100_000);
        await expect(h.sample(0, 150_000, 100_000)).rejects.toMatchObject({
          code: "LIMIT_EXCEEDED",
        });
      } finally {
        await h.close();
      }
      const held = new PresentationPointerHistory(
        { ...f, presentation },
        controller.signal,
        pointerHistoryBudget({
          maxEvents: 100,
          maxSamples: 1,
        }),
      );
      try {
        await held.sample(0, 300_000, 0);
        await expect(held.sample(0, 300_000, 0)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
      } finally {
        await held.close();
      }
      const canceled = new PresentationPointerHistory(
        { ...f, presentation },
        controller.signal,
        pointerHistoryBudget({
          maxEvents: 100,
          maxSamples: 10,
        }),
      );
      try {
        await canceled.sample(0, 300_000, 0);
        controller.abort();
        await expect(canceled.sample(0, 400_000, 0)).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        await canceled.close();
      }
    },
  );
});

test("separate pointer histories share the render-attempt occurrence budget", async () => {
  const f = await fixture([geometry(), point(100_000, 10)]);
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 1_000_000 }], durationUs: 1_000_000 },
    [presentationRecord(0, 1_000_000, 0)],
    async (presentation) => {
      const budget = pointerHistoryBudget({ maxEvents: 100, maxSamples: 1 });
      const first = new PresentationPointerHistory({ ...f, presentation }, signal(), budget);
      const second = new PresentationPointerHistory({ ...f, presentation }, signal(), budget);
      try {
        await first.sample(0, 300_000, 0);
        await expect(second.sample(0, 300_000, 0)).rejects.toMatchObject({
          code: "LIMIT_EXCEEDED",
        });
      } finally {
        await first.close();
        await second.close();
      }
    },
  );
});

test("sampled exact pointer membership precedes the integer observation cutoff", async () => {
  const f = await fixture([geometry(), point(0, 20), point(1, 80)]);
  const boundary = { value: "3", timescale: 5000000 };
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 2 }], durationUs: 2 },
    [
      { ...presentationRecord(0, 1, 0), end: boundary },
      { ...presentationRecord(1, 2, 1), start: boundary, sampleTime: boundary },
    ],
    async (presentation) => {
      const history = new PresentationPointerHistory(
        { ...f, presentation },
        signal(),
        pointerHistoryBudget({ maxEvents: 100, maxSamples: 10 }),
      );
      try {
        const before = await history.sample(
          0,
          { numerator: 1, denominator: Number.MAX_SAFE_INTEGER },
          0,
        );
        expect(before.record).toMatchObject({ sampleTime: exact(0) });
        const after = await history.sample(0, { numerator: 7, denominator: 10 }, 0);
        expect(after.record).toMatchObject({ sampleTime: boundary });
        if (after.inspection.kind !== "picture") throw Error("Expected picture");
        expect(after.inspection.plan.requestedSourceUs).toBe(0);
        expect(after.inspection.plan.overlay.pointer).toEqual({ atSourceUs: 0, x: 20, y: 20 });
      } finally {
        await history.close();
      }
    },
  );
});

test("change-only pointer survives a cut like the every-tick journal", async () => {
  const positions = [];
  for (const mode of ["dense", "sparse"]) {
    const f = await fixture([], mode);
    const plan = await planFrameTrail(
      { ...request, kept: { startUs: 1_000_000, endUs: 3_000_000 }, trailUs: 0 },
      {
        ...f,
        sample: f.sample([
          [1_000_000, 0],
          [1_500_000, 0],
        ]),
      },
      signal(),
    );
    positions.push(
      plan.overlay.pointer && { x: plan.overlay.pointer.x, y: plan.overlay.pointer.y },
    );
  }
  expect(positions).toEqual([
    { x: 42, y: 20 },
    { x: 42, y: 20 },
  ]);
}, 30_000);

test("portable cursor pages retain held semantics across relocation", async () => {
  const f = await fixture([], "sparse");
  const directory = join(dirname(f.metadata.receipt.file), "portable");
  await writeSourceEvidencePages(f.evidence, f.identity, directory);
  const reader = new FileSourceEvidence(directory, f.identity);
  const plan = await planFrameTrail(
    { ...request, kept: { startUs: 1_000_000, endUs: 3_000_000 }, trailUs: 0 },
    {
      ...f,
      evidence: reader,
      sample: f.sample([
        [1_000_000, 0],
        [1_500_000, 0],
      ]),
    },
    signal(),
  );
  expect(plan.overlay.pointer).toEqual({ atSourceUs: 0, x: 42, y: 20 });
}, 30_000);

test("held pointers match dense journals at scenes, trimmed spans and backward project requests", async () => {
  const outputs: unknown[][] = [];
  for (const mode of ["dense", "sparse", "historical", "everyTick"]) {
    const f = await fixture([], mode);
    const positions: unknown[] = [];
    const still = await planFrameTrail(
      { ...request, requestedSourceUs: 2_000_000, trailUs: 0 },
      {
        ...f,
        sample: f.sample([
          [0, 0],
          [1_000_000, 255],
          [2_000_000, 255],
        ]),
      },
      signal(),
    );
    positions.push(still.overlay.pointer?.x ?? null);
    await withPresentation(
      { spans: [{ startUs: 1_000_000, endUs: 3_000_000 }], durationUs: 2_000_000 },
      [
        presentationRecord(1_000_000, 2_000_000, 1_000_000),
        presentationRecord(2_000_000, 3_000_000, 2_000_000, 255),
      ],
      async (presentation) => {
        const history = new PresentationPointerHistory(
          { ...f, presentation },
          signal(),
          pointerHistoryBudget({ maxEvents: 1000, maxSamples: 10 }),
        );
        try {
          // Project clip order can visit this source backward, with a trimmed initial sample.
          for (const at of [2_500_000, 1_500_000, 2_000_000, 1_000_000]) {
            const result = await history.sample(0, at, 500_000);
            positions.push(
              result.inspection.kind === "picture"
                ? (result.inspection.plan.overlay.pointer?.x ?? null)
                : null,
            );
          }
        } finally {
          await history.close();
        }
      },
    );
    outputs.push(positions);
  }
  expect(outputs[0]).toEqual([42, 42, 42, 42, 42]);
  expect(outputs[1]).toEqual(outputs[0]);
  expect(outputs[2]).toEqual([null, null, null, null, null]);
  expect(outputs[3]).toEqual(outputs[2]);
}, 30_000);

test("raw held cursor pages include the in-force sample without consuming continuation progress", async () => {
  const f = await fixture([], "sparse");
  const first = readRawCursor(
    { recordingId: f.identity.owner.id },
    { sourceRange: { startUs: 500_000, endUs: 2_000_000 }, limit: 1 },
    () => ({ metadata: f.metadata, reader: f.evidence }),
  );
  expect(first.samples).toMatchObject([{ sourceUs: 0, x: 42, y: 20 }]);
  expect(first.nextCursor).toBeNull();
  const dense = await fixture([], "dense");
  const target = { recordingId: dense.identity.owner.id };
  const sourceRange = { startUs: 505_000, endUs: 600_000 };
  const source = () => ({ metadata: dense.metadata, reader: dense.evidence });
  const page = readRawCursor(target, { sourceRange, limit: 1 }, source);
  expect(page.samples.map((p) => p.sourceUs)).toEqual([500_000, 516_666]);
  expect(page.nextCursor?.afterSequence).toBe(page.samples.at(-1)!.sequence);
  const next = readRawCursor(target, { sourceRange, cursor: page.nextCursor!, limit: 1 }, source);
  expect(next.samples.map((p) => p.sourceUs)).toEqual([533_333]);
  const historical = await fixture([], "historical");
  expect(
    readRawCursor({ recordingId: historical.identity.owner.id }, { sourceRange }, () => ({
      metadata: historical.metadata,
      reader: historical.evidence,
    })).samples,
  ).toEqual([]);
}, 30_000);

test("held trails depend on elapsed time and changes rather than storage density or point caps", async () => {
  const trails = [];
  for (const mode of ["denseMotion", "sparseMotion", "busy"]) {
    const f = await fixture([], mode);
    const plan = await planFrameTrail(
      { ...request, requestedSourceUs: 2_500_000, trailUs: 2_000_000 },
      { ...f, sample: f.sample([[0, 0]]) },
      signal(),
    );
    expect(plan.overlay.pointer).toMatchObject({ x: mode === "busy" ? 40 : 35, y: 20 });
    trails.push(plan.overlay.trail);
  }
  expect(trails[0]).toEqual(trails[1]);
  expect(trails[0]![0]![0]).toMatchObject({ atSourceUs: 500_000, x: 42 });
  expect(trails[2]!.flat().length).toBeGreaterThan(1200);
}, 30_000);

test("held pointers remain absent after a physical presentation gap even through later scene resets", async () => {
  const f = await fixture([], "sparse");
  await withPresentation(
    { spans: [{ startUs: 0, endUs: 3_000_000 }], durationUs: 3_000_000 },
    [
      presentationRecord(0, 500_000, 0),
      presentationRecord(500_000, 1_000_000, null),
      presentationRecord(1_000_000, 2_000_000, 1_000_000),
      presentationRecord(2_000_000, 3_000_000, 2_000_000, 255),
    ],
    async (presentation) => {
      const h = new PresentationPointerHistory(
        { ...f, presentation },
        signal(),
        pointerHistoryBudget({ maxEvents: 100, maxSamples: 10 }),
      );
      try {
        for (const at of [1_500_000, 2_500_000]) {
          const result = await h.sample(0, at, 500_000);
          expect(
            result.inspection.kind === "picture" && result.inspection.plan.overlay.pointer,
          ).toBeNull();
        }
      } finally {
        await h.close();
      }
    },
  );
}, 30_000);
