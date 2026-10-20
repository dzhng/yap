import { readRawCursor } from "./raw-cursor.js";
import { test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, renameSync, readFileSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFrameTrail } from "./trails.js";
import type { VisualSampler } from "./scenes.js";
import { CaptureStore } from "./capture-store.js";
import { recordingEvidenceOwner, SourceEvidenceStore } from "./evidence.js";
import {
  FileSourceEvidence,
  readSourceMetadata,
  writeSourceEvidencePages,
} from "./evidence-pages.js";

const roots: string[] = [];
const stores = new Set<CaptureStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "source-pages-"));
  roots.push(root);
  const library = join(root, "library.sqlite");
  const store = new CaptureStore(library, { now: () => "", newId: randomUUID });
  stores.add(store);
  const recording = store.allocate().recording;
  const identity = {
    owner: { kind: "recording" as const, id: recording.id },
    sourceId: recording.sourceId,
    generation: "source-1",
  };
  const cursor = (sourceUs: number, eligibility = "inside") => ({
    event: "cursorSample",
    data: {
      sourceUs,
      x: 1,
      y: 2,
      globalX: 1,
      globalY: 2,
      buttons: 0,
      eligibility,
      geometryEpoch: 1,
    },
  });
  const geometry = (epoch: number, sourceUs: number | null) => ({
    event: "geometry",
    data: {
      epoch,
      sourceUs,
      hostUs: 123,
      geometry: {
        outputWidth: 10,
        outputHeight: 10,
        contentScale: 1,
        scaleFactor: 1,
        contentRect: { x: 0, y: 0, width: 10, height: 10 },
      },
    },
  });
  const records = [
    geometry(0, null),
    geometry(1, 0),
    cursor(30),
    cursor(10),
    cursor(10, "unknownGeometry"),
    { event: "pause", data: { atSourceUs: 20, elapsedPauseUs: 999 } },
    geometry(2, null),
    geometry(2, 25),
    { event: "audioAcquired", data: { role: "narration", startUs: 0, endUs: 15 } },
    { event: "audioAcquired", data: { role: "narration", startUs: 20, endUs: 40 } },
    ...Array.from({ length: 800 }, (_, i) => cursor(100 + i)),
  ];
  const file = join(root, "normalized.jsonl"),
    body = records.map((row) => JSON.stringify(row) + "\n").join("");
  writeFileSync(file, body);
  const receipt = {
    file,
    journal: "capture.journal.jsonl",
    header: { sessionID: identity.sourceId, microphone: true, systemAudio: true },
    cursorSamples: 803,
    geometryRecords: 4,
    displaySpaces: 0,
    pauseEvents: 1,
    audioIntervals: 2,
    firstCursorSourceUs: 30,
    lastCursorSourceUs: 899,
    lastSequence: records.length,
    incompleteTail: false,
    finished: true,
    bytes: Buffer.byteLength(body),
  };
  const evidence = new SourceEvidenceStore(store, recordingEvidenceOwner(store));
  const metadata = await evidence.ingest({ ...identity, receipt, file });
  return { root, store, evidence, identity, metadata, library, file };
}
function observed(
  reader: SourceEvidenceStore | FileSourceEvidence,
  identity: Parameters<SourceEvidenceStore["latestCursor"]>[0],
) {
  const range = { startUs: 10, endUs: 900 };
  const first = reader.page({ ...identity, range, limit: 257 });
  return {
    first,
    second: reader.page({ ...identity, range, limit: 257, afterSequence: first.nextSequence! }),
    latest: reader.latestCursor(identity, 10),
    timed: reader.timedGeometryAt(identity, 24),
    next: reader.nextTimedGeometry(identity, 24),
    unplaced: reader.unplacedGeometry(identity, { afterSequence: 2, beforeSequence: 8 }),
    changes: reader.geometryChanges(identity, { startUs: 0, endUs: 25 }),
    pauses: reader.pauseBoundaries(identity, { startUs: 20, endUs: 20 }),
    hasNarration: reader.hasAudio(identity, "narration"),
    hasSystem: reader.hasAudio(identity, "system"),
    audio: reader.audio(identity, "narration", { startUs: 10, endUs: 25 }),
  };
}
test("relocated bounded source pages preserve normalized queries without the original library", async () => {
  const f = await fixture();
  const expected = observed(f.evidence, f.identity);
  expect(expected.latest?.eligibility).toBe("unknownGeometry");
  expect(expected.audio).toEqual([
    { startUs: 10, endUs: 15 },
    { startUs: 20, endUs: 25 },
  ]);
  expect(expected.pauses).toEqual([{ atSourceUs: 20, elapsedPauseUs: 999, sequence: 6 }]);
  const sample: VisualSampler = async (request) => ({
    sourceWidth: 10,
    sourceHeight: 10,
    samples: request.atSourceUs.map((at) => ({
      requestedSourceUs: at,
      actualSourceUs: at,
      distanceUs: 0,
      width: 8,
      height: 8,
      rgbBase64: Buffer.alloc(192).toString("base64"),
    })),
  });
  const trailRequest = {
    source: "/generated/video.mov",
    kept: { startUs: 0, endUs: 900 },
    requestedSourceUs: 30,
  };
  const trail = await planFrameTrail(
    trailRequest,
    { evidence: f.evidence, identity: f.identity, sample },
    new AbortController().signal,
  );
  const output = join(f.root, "exported");
  await writeSourceEvidencePages(f.evidence, f.metadata, output);
  f.store.close();
  stores.delete(f.store);
  rmSync(f.library);
  rmSync(f.file);
  const moved = join(f.root, "moved");
  renameSync(output, moved);
  const reader = new FileSourceEvidence(moved, f.identity);
  expect(observed(reader, f.identity)).toEqual(expected);
  expect(
    await planFrameTrail(
      trailRequest,
      { evidence: reader, identity: f.identity, sample },
      new AbortController().signal,
    ),
  ).toEqual(trail);
  expect(() =>
    reader.page({ ...f.identity, range: { startUs: 0, endUs: 40 }, afterSequence: 99999 }),
  ).toThrow("continuation");
  expect(() =>
    reader.page({ ...f.identity, range: { startUs: 20, endUs: 40 }, afterSequence: 4 }),
  ).toThrow("continuation");
  expect(() => reader.latestCursor({ ...f.identity, generation: "other" }, 10)).toThrow(
    "not indexed",
  );
  if (process.env.YAP_SOURCE_PAGES_EVIDENCE) {
    const manifest = JSON.parse(readFileSync(join(moved, "pages.json"), "utf8"));
    writeFileSync(
      process.env.YAP_SOURCE_PAGES_EVIDENCE,
      JSON.stringify(
        {
          scope:
            "Internal source-only directory reader; original catalog and normalized source file removed; no native decoding or package archive claim",
          cursorSamples: f.metadata.receipt.cursorSamples,
          indexes: Object.fromEntries(
            Object.entries(manifest.indexes).map(([index, pages]) => [
              index,
              (pages as { rows: number; bytes: number }[]).reduce<{
                pages: number;
                rows: number;
                bytes: number;
              }>(
                (summary, page) => ({
                  pages: summary.pages + 1,
                  rows: summary.rows + page.rows,
                  bytes: summary.bytes + page.bytes,
                }),
                { pages: 0, rows: 0, bytes: 0 },
              ),
            ]),
          ),
          equalTimeLatest: expected.latest,
          pauses: expected.pauses,
          unplacedGeometry: expected.unplaced,
          acquiredAudio: expected.audio,
          trailPlan: trail,
          parity: { queries: true, trailPlan: true },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  }
});

test("page reads seek only relevant members and fail when a required member disappears or changes", async () => {
  const f = await fixture(),
    output = join(f.root, "pages");
  await writeSourceEvidencePages(f.evidence, f.identity, output);
  const manifest = JSON.parse(readFileSync(join(output, "pages.json"), "utf8"));
  const last = manifest.indexes.cursor.at(-1),
    first = manifest.indexes.cursor[0];
  expect(last.file).not.toBe(first.file);
  rmSync(join(output, last.file));
  const reader = new FileSourceEvidence(output, f.identity);
  expect(reader.latestCursor(f.identity, 10)?.eligibility).toBe("unknownGeometry");
  expect(() => reader.latestCursor(f.identity, 899)).toThrow();
  const firstPath = join(output, first.file),
    original = readFileSync(firstPath);
  writeFileSync(firstPath, original.subarray(0, original.length - 1));
  expect(() => reader.latestCursor(f.identity, 10)).toThrow("descriptor");
  writeFileSync(firstPath, original.toString().replace('globalX\\":1', 'globalX\\":9'));
  expect(readFileSync(firstPath).equals(original)).toBe(false);
  expect(() => reader.latestCursor(f.identity, 10)).toThrow("descriptor");
  rmSync(firstPath);
  const outside = join(f.root, "outside.json");
  writeFileSync(outside, original);
  symlinkSync(outside, firstPath);
  expect(() => reader.latestCursor(f.identity, 10)).toThrow();
});

test("invalid page directories fail before returning misleading empty evidence", async () => {
  const f = await fixture(),
    output = join(f.root, "pages");
  await writeSourceEvidencePages(f.evidence, f.identity, output);
  const path = join(output, "pages.json"),
    original = readFileSync(path),
    manifest = JSON.parse(original.toString());
  expect(() => new FileSourceEvidence(output, { ...f.identity, sourceId: "wrong" })).toThrow(
    "not indexed",
  );
  for (const mutate of [
    (value: typeof manifest) => {
      value.version = 2;
    },
    (value: typeof manifest) => {
      value.indexes.cursor[0].file = "../outside.json";
    },
    (value: typeof manifest) => {
      value.indexes.cursor[0].first = [0];
    },
    (value: typeof manifest) => {
      value.indexes.cursor[1].first = value.indexes.cursor[0].last;
    },
    (value: typeof manifest) => {
      delete value.indexes.pauses;
    },
    (value: typeof manifest) => {
      value.indexes.cursor[1].file = value.indexes.cursor[0].file;
    },
  ]) {
    const value = structuredClone(manifest);
    mutate(value);
    writeFileSync(path, JSON.stringify(value));
    expect(() => new FileSourceEvidence(output, f.identity)).toThrow();
  }
  writeFileSync(path, Buffer.alloc(4_194_305, 32));
  expect(() => new FileSourceEvidence(output, f.identity)).toThrow("budget");
  writeFileSync(path, original);
  const reader = new FileSourceEvidence(output, f.identity);
  writeFileSync(join(output, manifest.indexes.cursor[0].file), Buffer.alloc(1_048_577, 32));
  expect(() => reader.latestCursor(f.identity, 10)).toThrow("budget");
});

test("ordered seek parity covers page edges, reverse lookups and half-open continuations", async () => {
  const f = await fixture(),
    output = join(f.root, "pages");
  await writeSourceEvidencePages(f.evidence, f.identity, output);
  const reader = new FileSourceEvidence(output, f.identity);
  for (const at of [0, 9, 10, 20, 24, 25, 30, 352, 353, 354, 609, 610, 611, 899, 900]) {
    expect(reader.latestCursor(f.identity, at)).toEqual(f.evidence.latestCursor(f.identity, at));
    expect(reader.timedGeometryAt(f.identity, at)).toEqual(
      f.evidence.timedGeometryAt(f.identity, at),
    );
    expect(reader.nextTimedGeometry(f.identity, at)).toEqual(
      f.evidence.nextTimedGeometry(f.identity, at),
    );
    const range = { startUs: at, endUs: at + 3 };
    expect(reader.page({ ...f.identity, range, limit: 1 })).toEqual(
      f.evidence.page({ ...f.identity, range, limit: 1 }),
    );
    expect(reader.audio(f.identity, "narration", range)).toEqual(
      f.evidence.audio(f.identity, "narration", range),
    );
  }
  const all = f.evidence.page({
    ...f.identity,
    range: { startUs: 0, endUs: 1000 },
    limit: 5000,
  }).samples;
  const actual = [];
  let afterSequence: number | undefined;
  do {
    const page = reader.page({
      ...f.identity,
      range: { startUs: 0, endUs: 1000 },
      limit: 73,
      ...(afterSequence ? { afterSequence } : {}),
    });
    actual.push(...page.samples);
    afterSequence = page.nextSequence ?? undefined;
  } while (afterSequence !== undefined);
  expect(actual).toEqual(all);
});

test("aborted export never publishes a readable manifest", async () => {
  const f = await fixture(),
    output = join(f.root, "pages"),
    controller = new AbortController();
  const exporting = writeSourceEvidencePages(f.evidence, f.identity, output, controller.signal);
  setImmediate(() => controller.abort(new Error("canceled export")));
  await expect(exporting).rejects.toThrow();
  expect(() => new FileSourceEvidence(output, f.identity)).toThrow();
});

test("portable receipt uses the native ingest validator and its pinned source generation", async () => {
  const f = await fixture();
  const path = join(f.root, "metadata.json");
  writeFileSync(path, JSON.stringify(f.metadata));
  expect(readSourceMetadata(f.root, f.identity)).toEqual(f.metadata);
  expect(() => readSourceMetadata(f.root, { ...f.identity, generation: "other" })).toThrow(
    "another generation",
  );
  const invalid = { ...f.metadata, receipt: { ...f.metadata.receipt, cursorSamples: -1 } };
  writeFileSync(path, JSON.stringify(invalid));
  expect(() => readSourceMetadata(f.root, f.identity)).toThrow(
    expect.objectContaining({ code: "INVALID_INPUT_EVIDENCE", retryable: false }),
  );
  await expect(
    f.evidence.ingest({
      ...f.identity,
      generation: "bad-receipt",
      file: f.file,
      receipt: invalid.receipt,
    }),
  ).rejects.toThrow("Invalid evidence receipt");
});

test("raw cursor pages share source-time ordering and isolate package continuations", async () => {
  const f = await fixture();
  await writeSourceEvidencePages(f.evidence, f.identity, join(f.root, "portable"));
  const reader = new FileSourceEvidence(join(f.root, "portable"), f.identity);
  const sourceRange = { startUs: 10, endUs: 40 };
  const target = { packageHandle: "first-open" };
  const source = () => ({ metadata: f.metadata, reader });
  const first = readRawCursor(target, { sourceRange, limit: 1 }, source);
  const second = readRawCursor(
    target,
    { sourceRange, limit: 2, cursor: first.nextCursor! },
    source,
  );
  expect(
    [...first.samples, ...second.samples].map(({ sourceUs, sequence, eligibility }) => ({
      sourceUs,
      sequence,
      eligibility,
    })),
  ).toEqual([
    { sourceUs: 10, sequence: 4, eligibility: "inside" },
    { sourceUs: 10, sequence: 5, eligibility: "unknownGeometry" },
    { sourceUs: 30, sequence: 3, eligibility: "inside" },
  ]);
  expect(second.nextCursor).toBeNull();
  expect(first.sourceRevisionId).toBe("r0");
  const library = readRawCursor({ recordingId: f.identity.owner.id }, { sourceRange }, () => ({
    metadata: f.metadata,
    reader: f.evidence,
  }));
  expect([...first.samples, ...second.samples]).toEqual(library.samples);
  expect(first.integrity).toEqual(library.integrity);
  // Another package or range is another filter set; other evidence is a stale pin.
  for (const [changed, code] of [
    [{ packageHandle: "second-open" }, "INVALID_PARAMS"],
    [{ sourceRange: { startUs: 0, endUs: 40 } }, "INVALID_PARAMS"],
    [{ sourceId: "other" }, "ARTIFACT_CHANGED"],
    [{ generation: "other" }, "ARTIFACT_CHANGED"],
  ] as const)
    expect(() =>
      readRawCursor(target, { sourceRange, cursor: { ...first.nextCursor!, ...changed } }, source),
    ).toThrow(expect.objectContaining({ code }));
  expect(() =>
    readRawCursor(
      target,
      { sourceRange, cursor: { ...first.nextCursor!, afterSequence: 99 } },
      source,
    ),
  ).toThrow(expect.objectContaining({ code: "INVALID_EVIDENCE" }));
  for (const limit of [0, 5001])
    expect(() => readRawCursor(target, { sourceRange, limit }, source)).toThrow();
});
