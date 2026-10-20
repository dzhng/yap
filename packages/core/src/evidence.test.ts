import { test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CaptureStore } from "./capture-store.js";
import {
  cameraProofIntervals,
  recordingEvidenceOwner,
  SourceEvidenceStore,
  sourceEvidenceRecords,
  validateSourceReceipt,
  validateRecord,
} from "./evidence.js";
import { EVIDENCE_BATCH_BYTES } from "./evidence-read.js";
const roots: string[] = [];
const stores: CaptureStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});

test("schema 3 mark fixture is accepted and counted in the evidence receipt", () => {
  const fixture = readFileSync(
    new URL("../../../fixtures/journal/schema3-marks.jsonl", import.meta.url),
    "utf8",
  );
  const records = fixture
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const marks = records.filter((record) => record.event === "mark");
  expect(marks).toHaveLength(4);
  for (const record of marks) validateRecord("mark", record.data);
});

test("portable schema 3 receipts retain the acquisition journal contract", () => {
  expect(() =>
    validateSourceReceipt(
      {
        file: "source.jsonl",
        journal: "capture.journal.jsonl",
        header: { sessionID: "schema3-marks", schemaVersion: 3, source: { kind: "display" } },
        cursorSamples: 0,
        geometryRecords: 2,
        displaySpaces: 0,
        pauseEvents: 1,
        audioIntervals: 0,
        markEvents: 4,
        lastSequence: 9,
        incompleteTail: false,
        finished: false,
        publications: {},
        bytes: 1,
      },
      "schema3-marks",
    ),
  ).not.toThrow();
});

test("journal sampling rejects invalid cadence rather than misreading a take", () => {
  const receipt = {
    file: "source.jsonl",
    journal: "capture.journal.jsonl",
    header: {
      sessionID: "sampling",
      schemaVersion: 4,
      cursorSampling: { intervalUs: 0, holds: false },
    },
    cursorSamples: 0,
    geometryRecords: 0,
    displaySpaces: 0,
    pauseEvents: 0,
    audioIntervals: 0,
    markEvents: 0,
    lastSequence: 1,
    incompleteTail: false,
    finished: false,
    publications: {},
    bytes: 1,
  };
  expect(() => validateSourceReceipt(receipt, "sampling")).toThrow(/cursor sampling/i);
});

test("normalized mark evidence matches the markEvents receipt count", async () => {
  const f = fixture();
  const body = [
    {
      event: "mark",
      data: {
        hostUs: 10,
        sourceUs: 0,
        epoch: 1,
        id: "m1",
        kind: "click",
        points: [{ hostUs: 10, globalX: 1, globalY: 2, x: 1, y: 2 }],
      },
    },
    {
      event: "mark",
      data: {
        hostUs: 20,
        sourceUs: 10,
        epoch: 1,
        id: "undo",
        kind: "click",
        points: [],
        retracts: "m1",
      },
    },
  ]
    .map((record) => JSON.stringify(record) + "\n")
    .join("");
  writeFileSync(f.file, body);
  const receipt = {
    ...f.receipt,
    header: { sessionID: f.identity.sourceId, schemaVersion: 3, source: { kind: "display" } },
    cursorSamples: 0,
    firstCursorSourceUs: null,
    lastCursorSourceUs: null,
    markEvents: 2,
    lastSequence: 2,
    bytes: Buffer.byteLength(body),
  };
  const rows = [];
  for await (const row of sourceEvidenceRecords(f.file, receipt)) rows.push(row);
  expect(rows.map((row) => row.event)).toEqual(["mark", "mark"]);
  await expect(
    (async () => {
      const legacy = { ...receipt, header: { sessionID: f.identity.sourceId, schemaVersion: 2 } };
      for await (const _row of sourceEvidenceRecords(f.file, legacy)) {
        // The stream must reject before exposing a legacy mark.
      }
    })(),
  ).rejects.toThrow("carries marks");
});
function fixture(times = [0, 10, 10, 20]) {
  const root = mkdtempSync(join(tmpdir(), "evidence-"));
  roots.push(root);
  let id = 0;
  const store = new CaptureStore(join(root, "library.sqlite"), {
    now: () => "",
    newId: () => `id-${++id}`,
  });
  stores.push(store);
  const recording = store.allocate().recording;
  const identity = {
    owner: { kind: "recording" as const, id: recording.id },
    sourceId: recording.sourceId,
    generation: "attempt-1",
  };
  const samples = times.map((sourceUs) => ({
    sourceUs,
    x: -2,
    y: 4,
    globalX: 22,
    globalY: 44,
    buttons: 0,
    eligibility: "outside",
    geometryEpoch: 1,
  }));
  const file = join(root, "normalized.jsonl");
  const body = samples
    .map((data) => JSON.stringify({ event: "cursorSample", data }) + "\n")
    .join("");
  writeFileSync(file, body);
  const receipt = {
    file,
    journal: "capture.journal.jsonl",
    header: { sessionID: recording.sourceId },
    cursorSamples: times.length,
    geometryRecords: 0,
    displaySpaces: 0,
    pauseEvents: 0,
    audioIntervals: 0,
    firstCursorSourceUs: times[0] ?? null,
    lastCursorSourceUs: times.at(-1) ?? null,
    lastSequence: 5,
    incompleteTail: true,
    invalidAtSequence: 6,
    finished: false,
    bytes: Buffer.byteLength(body),
  };
  return {
    root,
    store,
    evidence: new SourceEvidenceStore(store, recordingEvidenceOwner(store)),
    identity,
    file,
    receipt,
    samples,
  };
}
test("export batches fill the content-byte budget, isolate oversized rows and keep ordered progress", async () => {
  const f = fixture([]);
  const budget = EVIDENCE_BATCH_BYTES;
  const sizes = [budget / 2, budget / 2, budget + 1, ...Array<number>(300).fill(256)];
  const marks = sizes.map((size, i) => {
    const data = {
      hostUs: i,
      sourceUs: Math.floor(i / 2),
      epoch: 1,
      id: "",
      kind: "stroke",
      points: [{ hostUs: i, globalX: 1, globalY: 2, x: 1, y: 2 }],
    };
    const padding = size - Buffer.byteLength(JSON.stringify(data));
    data.id = "é".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2);
    expect(Buffer.byteLength(JSON.stringify(data))).toBe(size);
    return data;
  });
  const body = marks.map((data) => JSON.stringify({ event: "mark", data }) + "\n").join("");
  writeFileSync(f.file, body);
  await f.evidence.ingest({
    ...f.identity,
    file: f.file,
    receipt: {
      ...f.receipt,
      header: { sessionID: f.identity.sourceId, schemaVersion: 3 },
      markEvents: marks.length,
      bytes: Buffer.byteLength(body),
      publications: {},
    },
  });
  const batches = [...f.evidence.exportRecords(f.identity, "marks")];
  expect(batches.map((batch) => batch.length)).toEqual([2, 1, 256, 44]);
  for (const batch of batches) {
    const bytes = batch.reduce((sum, row) => sum + Buffer.byteLength(row.content), 0);
    expect(bytes <= budget || (batch.length === 1 && bytes > budget)).toBe(true);
  }
  expect(batches.flat().map((row) => JSON.parse(row.content))).toEqual(marks);
  expect(batches.flat().map((row) => row.sequence)).toEqual(marks.map((_, i) => i + 1));
});
test("pages equal-time raw samples with explicit range and stable continuation", async () => {
  const f = fixture();
  await f.evidence.ingest({ ...f.identity, file: f.file, receipt: f.receipt });
  const first = f.evidence.page({ ...f.identity, range: { startUs: 10, endUs: 20 }, limit: 1 });
  expect(first.samples).toEqual([{ sequence: 2, ...f.samples[1] }]);
  expect(
    f.evidence.page({
      ...f.identity,
      range: { startUs: 10, endUs: 20 },
      afterSequence: first.nextSequence!,
      limit: 1,
    }),
  ).toEqual({ samples: [{ sequence: 3, ...f.samples[2] }], nextSequence: null });
});

// The native writer gives every primary take, a camera-only one included, the packed layout.
test.each([2, 3, 4])(
  "layout-%i primary camera evidence retains unbound device provenance",
  async (schemaVersion) => {
    const f = fixture();
    const receipt = {
      ...f.receipt,
      header: { sessionID: f.identity.sourceId, schemaVersion, source: { kind: "camera" } },
      publications: {},
    };
    const admitted = await f.evidence.ingest({ ...f.identity, file: f.file, receipt });
    expect(admitted.receipt).toEqual(receipt);
    expect(f.evidence.page({ ...f.identity, range: { startUs: 0, endUs: 30 } }).samples).toEqual(
      f.samples.map((sample, i) => ({ sequence: i + 1, ...sample })),
    );
  },
);

test("unbound camera evidence refuses missing and unsupported primary layouts", async () => {
  const f = fixture();
  for (const schemaVersion of [undefined, 1, 5]) {
    const receipt = {
      ...f.receipt,
      header: { sessionID: f.identity.sourceId, schemaVersion, source: { kind: "camera" } },
      publications: {},
    };
    await expect(f.evidence.ingest({ ...f.identity, file: f.file, receipt })).rejects.toThrow();
  }
});

test("declared camera evidence cannot be indexed without its verified publication", async () => {
  const f = fixture();
  const receipt = {
    ...f.receipt,
    header: {
      sessionID: f.identity.sourceId,
      schemaVersion: 1,
      source: { kind: "camera" },
      cameraBinding: {
        recordingId: f.identity.owner.id,
        sourceId: f.identity.sourceId,
        deviceId: "fixture-camera",
      },
    },
  };
  await expect(f.evidence.ingest({ ...f.identity, file: f.file, receipt })).rejects.toThrow(
    "camera publication",
  );
});

function cameraProof(changes: Record<string, unknown> = {}) {
  const file = { bytes: "10", sha256: "a".repeat(64) };
  return {
    canonical: file,
    receipt: file,
    mapping: file,
    support: { startUs: 100, endUs: 400 },
    representedFrames: 9,
    ...changes,
  };
}

test("camera proof intervals are support minus gaps; a proof without gaps is one interval", async () => {
  const f = fixture();
  const continuous = cameraProof();
  const gapped = cameraProof({
    gaps: [
      { startUs: 150, endUs: 200 },
      { startUs: 250, endUs: { numerator: 1000, denominator: 3 } },
    ],
  });
  for (const [generation, video] of [
    ["continuous", continuous],
    ["gapped", gapped],
  ] as const) {
    const receipt = { ...f.receipt, publications: { video } };
    const admitted = await f.evidence.ingest({ ...f.identity, generation, file: f.file, receipt });
    expect(admitted.receipt.publications?.video).toEqual(video);
  }
  expect(cameraProofIntervals(continuous)).toEqual([{ startUs: 100, endUs: 400 }]);
  expect(cameraProofIntervals(gapped)).toEqual([
    { startUs: 100, endUs: 150 },
    { startUs: 200, endUs: 250 },
    { startUs: { numerator: 1000, denominator: 3 }, endUs: 400 },
  ]);
});

test("camera gap inventories preserve every interval beyond five hundred transitions", async () => {
  const f = fixture();
  const gaps = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ startUs: 102 + 2 * i, endUs: 103 + 2 * i }));
  const support = { startUs: 100, endUs: 1200 };
  const within = {
    ...f.receipt,
    publications: { video: cameraProof({ support, gaps: gaps(499) }) },
  };
  await f.evidence.ingest({ ...f.identity, generation: "within", file: f.file, receipt: within });
  const beyond = {
    ...f.receipt,
    publications: { video: cameraProof({ support, gaps: gaps(500) }) },
  };
  await expect(
    f.evidence.ingest({ ...f.identity, generation: "beyond", file: f.file, receipt: beyond }),
  ).resolves.toMatchObject({ receipt: beyond });
});

test("malformed camera gaps refuse the whole receipt", async () => {
  const f = fixture();
  const cases = {
    empty: [],
    notList: { startUs: 150, endUs: 200 },
    emptyRange: [{ startUs: 150, endUs: 150 }],
    fractionalMicro: [{ startUs: 150.5, endUs: 200 }],
    unsorted: [
      { startUs: 250, endUs: 300 },
      { startUs: 150, endUs: 200 },
    ],
    overlapping: [
      { startUs: 150, endUs: 260 },
      { startUs: 250, endUs: 300 },
    ],
    adjacent: [
      { startUs: 150, endUs: 200 },
      { startUs: 200, endUs: 300 },
    ],
    atSupportStart: [{ startUs: 100, endUs: 200 }],
    atSupportEnd: [{ startUs: 300, endUs: 400 }],
    outsideSupport: [{ startUs: 350, endUs: 500 }],
  };
  for (const [generation, gaps] of Object.entries(cases)) {
    const receipt = { ...f.receipt, publications: { video: cameraProof({ gaps }) } };
    await expect(
      f.evidence.ingest({ ...f.identity, generation, file: f.file, receipt } as never),
      generation,
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE", message: "Invalid verified camera gaps" });
    expect(() =>
      f.evidence.page({ ...f.identity, generation, range: { startUs: 0, endUs: 100 } }),
    ).toThrow(expect.objectContaining({ code: "PREREQUISITE_MISSING" }));
  }
});

test("generations and recording identities never share pages; duplicate ingestion preserves evidence", async () => {
  const f = fixture();
  const metadata = await f.evidence.ingest({ ...f.identity, file: f.file, receipt: f.receipt });
  expect(metadata.receipt).toEqual(f.receipt);
  const newer = { ...f.identity, generation: "attempt-2" };
  await f.evidence.ingest({ ...newer, file: f.file, receipt: f.receipt });
  await expect(
    f.evidence.ingest({ ...f.identity, file: f.file, receipt: f.receipt }),
  ).rejects.toThrow("already exists");
  await expect(
    f.evidence.ingest({
      ...f.identity,
      generation: "bad",
      sourceId: "wrong",
      file: f.file,
      receipt: f.receipt,
    }),
  ).rejects.toThrow("identity");
  expect(() =>
    f.evidence.page({ ...newer, sourceId: "wrong", range: { startUs: 0, endUs: 30 } }),
  ).toThrow("not indexed");
  f.evidence.removeUnpublished(newer);
  expect(() => f.evidence.page({ ...newer, range: { startUs: 0, endUs: 30 } })).toThrow(
    "not indexed",
  );
  expect(
    f.evidence.page({ ...f.identity, range: { startUs: 0, endUs: 30 } }).samples.map((s) => s.x),
  ).toEqual([-2, -2, -2, -2]);
});

test("malformed normalized data and receipt mismatch remove all partial rows", async () => {
  const f = fixture(Array.from({ length: 600 }, (_, i) => i));
  writeFileSync(f.file, '{"event":"cursorSample","data":{"sourceUs":1.5}}\n', { flag: "a" });
  const { statSync } = await import("node:fs");
  await expect(
    f.evidence.ingest({
      ...f.identity,
      file: f.file,
      receipt: { ...f.receipt, bytes: statSync(f.file).size },
    }),
  ).rejects.toThrow("Invalid normalized");
  expect(
    f.store.catalog.prepare("SELECT count(*) AS n FROM source_evidence_records").get(),
  ).toEqual({ n: 0 });
  expect(() => f.evidence.page({ ...f.identity, range: { startUs: 0, endUs: 1000 } })).toThrow(
    "not indexed",
  );
  const g = fixture();
  await expect(
    g.evidence.ingest({
      ...g.identity,
      file: g.file,
      receipt: { ...g.receipt, cursorSamples: 99 },
    }),
  ).rejects.toThrow("receipt");
  expect(
    g.store.catalog.prepare("SELECT count(*) AS n FROM source_evidence_generations").get(),
  ).toEqual({ n: 0 });
});

test("bounded batches yield and cancellation cleans a partially indexed generation", async () => {
  const f = fixture(Array.from({ length: 4000 }, (_, i) => i));
  const controller = new AbortController();
  const { setImmediate } = await import("node:timers/promises");
  const ingest = f.evidence.ingest({
    ...f.identity,
    file: f.file,
    receipt: f.receipt,
    signal: controller.signal,
  });
  let sawPartial = false;
  for (let i = 0; i < 200; i++) {
    await setImmediate();
    if (
      (f.store.catalog.prepare("SELECT count(*) AS n FROM source_evidence_records").get()!
        .n as number) > 0
    ) {
      sawPartial = true;
      break;
    }
  }
  expect(sawPartial).toBe(true);
  expect(() => f.evidence.page({ ...f.identity, range: { startUs: 0, endUs: 5000 } })).toThrow(
    "not indexed",
  );
  controller.abort();
  await expect(ingest).rejects.toThrow();
  expect(
    f.store.catalog.prepare("SELECT count(*) AS n FROM source_evidence_records").get(),
  ).toEqual({ n: 0 });
  expect(
    f.store.catalog.prepare("SELECT count(*) AS n FROM source_evidence_generations").get(),
  ).toEqual({ n: 0 });
});

test("retains geometry/display records and unknown raw fields without geometry reinterpretation", async () => {
  const f = fixture([10]);
  const records = [
    { event: "displaySpace", data: { hostUs: 50, zeroOriginHeight: 1080 } },
    {
      event: "geometry",
      data: {
        epoch: 1,
        hostUs: 51,
        geometry: {
          outputWidth: 100,
          outputHeight: 100,
          contentScale: 1,
          scaleFactor: 2,
          contentRect: { x: 0, y: 0, width: 50, height: 50 },
        },
      },
    },
    { event: "cursorSample", data: { ...f.samples[0], nativeExtra: "preserved" } },
  ];
  const body = records.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(f.file, body);
  await f.evidence.ingest({
    ...f.identity,
    file: f.file,
    receipt: { ...f.receipt, geometryRecords: 1, displaySpaces: 1, bytes: Buffer.byteLength(body) },
  });
  expect(
    f.store.catalog
      .prepare("SELECT event,content FROM source_evidence_records ORDER BY sequence")
      .all()
      .map((r) => ({ event: r.event, data: JSON.parse(r.content as string) })),
  ).toEqual(records);
  expect(f.evidence.page({ ...f.identity, range: { startUs: 0, endUs: 20 } }).samples).toEqual([
    { sequence: 3, ...records[2]!.data },
  ]);
});

test("large streamed evidence pages seek through SQLite without reading the file again", async () => {
  const f = fixture([]);
  const { open, readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const handle = await open(f.file, "w");
  const total = 50000;
  let bytes = 0;
  for (let start = 0; start < total; start += 250) {
    const lines = Array.from(
      { length: 250 },
      (_, i) =>
        JSON.stringify({
          event: "cursorSample",
          data: {
            sourceUs: Math.floor((start + i) / 2),
            globalX: 1,
            globalY: 2,
            buttons: 0,
            eligibility: "unknownGeometry",
            geometryEpoch: 0,
          },
        }) + "\n",
    ).join("");
    await handle.write(lines);
    bytes += Buffer.byteLength(lines);
  }
  await handle.close();
  const hash = async () =>
    createHash("sha256")
      .update(await readFile(f.file))
      .digest("hex");
  const before = await hash();
  await f.evidence.ingest({
    ...f.identity,
    file: f.file,
    receipt: {
      ...f.receipt,
      cursorSamples: total,
      firstCursorSourceUs: 0,
      lastCursorSourceUs: 24999,
      bytes,
    },
  });
  expect(await hash()).toBe(before);
  rmSync(f.file);
  expect(f.evidence.latestCursor(f.identity, 24999)).toMatchObject({
    sourceUs: 24999,
    sequence: 50000,
    eligibility: "unknownGeometry",
    geometryEpoch: 0,
  });
  const range = { startUs: 24900, endUs: 25000 };
  let afterSequence: number | undefined;
  const sequences: number[] = [];
  do {
    const page = f.evidence.page({
      ...f.identity,
      range,
      limit: 17,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
    sequences.push(...page.samples.map((s) => s.sequence));
    afterSequence = page.nextSequence ?? undefined;
  } while (afterSequence);
  expect(sequences).toEqual(Array.from({ length: 200 }, (_, i) => 49801 + i));
  const plans = f.store.catalog
    .prepare(
      "EXPLAIN QUERY PLAN SELECT sequence,content FROM source_evidence_records WHERE ownerKind='recording' AND ownerId=? AND sourceId=? AND generation=? AND event='cursorSample' AND sourceUs>=? AND sourceUs<? AND (sourceUs,sequence)>(?,?) ORDER BY sourceUs,sequence LIMIT ?",
    )
    .all(
      f.identity.owner.id,
      f.identity.sourceId,
      f.identity.generation,
      24900,
      25000,
      24990,
      49981,
      18,
    );
  expect(plans.map((p) => p.detail).join(" ")).toContain(
    "SEARCH source_evidence_records USING INDEX source_evidence_time",
  );
  expect(plans.map((p) => p.detail).join(" ")).not.toContain("TEMP B-TREE");
});

test("source time ordering handles out-of-order records and bounds invalid requests", async () => {
  const f = fixture([20, 10, 10, 0]);
  await f.evidence.ingest({ ...f.identity, file: f.file, receipt: f.receipt });
  const range = { startUs: 0, endUs: 30 };
  const first = f.evidence.page({ ...f.identity, range, limit: 2 });
  expect(first.samples.map((s) => s.sequence)).toEqual([4, 2]);
  expect(
    f.evidence
      .page({ ...f.identity, range, afterSequence: first.nextSequence! })
      .samples.map((s) => s.sequence),
  ).toEqual([3, 1]);
  expect(() => f.evidence.page({ ...f.identity, range, limit: 5001 })).toThrow("limit");
  expect(() => f.evidence.page({ ...f.identity, range, afterSequence: 99 })).toThrow(
    "continuation",
  );
  expect(() => f.evidence.page({ ...f.identity, range: { startUs: 0.5, endUs: 30 } })).toThrow(
    "range",
  );
});

test("exchanging valid receipts between different output files cannot publish evidence", async () => {
  const first = fixture([0, 10]),
    second = fixture([0, 10]);
  for (const [owner, foreign] of [
    [first, second],
    [second, first],
  ] as const) {
    await expect(
      owner.evidence.ingest({ ...owner.identity, file: owner.file, receipt: foreign.receipt }),
    ).rejects.toThrow("receipt");
    expect(() =>
      owner.evidence.page({ ...owner.identity, range: { startUs: 0, endUs: 40 } }),
    ).toThrow("not indexed");
  }
  await first.evidence.ingest({ ...first.identity, file: first.file, receipt: first.receipt });
  expect(
    first.evidence
      .page({ ...first.identity, range: { startUs: 0, endUs: 40 } })
      .samples.map((sample) => sample.sourceUs),
  ).toEqual([0, 10]);
});

test("rejects a wrong export path and nonfinite coordinates without publishing rows", async () => {
  const f = fixture();
  await expect(
    f.evidence.ingest({
      ...f.identity,
      file: f.file,
      receipt: { ...f.receipt, file: "/different" },
    }),
  ).rejects.toThrow("receipt");
  const body =
    '{"event":"cursorSample","data":{"sourceUs":0,"globalX":1e999,"globalY":2,"buttons":0,"eligibility":"inside","geometryEpoch":1}}\n';
  writeFileSync(f.file, body);
  await expect(
    f.evidence.ingest({
      ...f.identity,
      file: f.file,
      receipt: { ...f.receipt, bytes: Buffer.byteLength(body) },
    }),
  ).rejects.toThrow("sample");
  expect(
    f.store.catalog.prepare("SELECT count(*) AS n FROM source_evidence_generations").get(),
  ).toEqual({ n: 0 });
});

test("cursor pages honor the contract's 1000 default and inclusive 5000 maximum", async () => {
  const f = fixture(Array.from({ length: 5001 }, (_, i) => i));
  await f.evidence.ingest({ ...f.identity, file: f.file, receipt: f.receipt });
  const request = { ...f.identity, range: { startUs: 0, endUs: 6000 } };
  const normal = f.evidence.page(request);
  expect(normal.samples).toEqual(
    f.samples.slice(0, 1000).map((sample, i) => ({ ...sample, sequence: i + 1 })),
  );
  expect(normal.nextSequence).toBe(1000);
  const maximum = f.evidence.page({ ...request, limit: 5000 });
  expect(maximum.samples.at(-1)).toEqual({ ...f.samples[4999], sequence: 5000 });
  expect(maximum.samples).toHaveLength(5000);
  expect(maximum.nextSequence).toBe(5000);
  expect(
    f.evidence.page({ ...request, limit: 5000, afterSequence: maximum.nextSequence! }),
  ).toEqual({
    samples: [{ ...f.samples[5000], sequence: 5001 }],
    nextSequence: null,
  });
  expect(() => f.evidence.page({ ...request, limit: 5001 })).toThrow("range or limit");
});

test("source timing queries keep pause boundaries and clip acquired audio without inventing gaps", async () => {
  const f = fixture([]);
  const records = [
    { event: "pause", data: { atSourceUs: 100, elapsedPauseUs: 5000 } },
    { event: "audioAcquired", data: { role: "narration", startUs: 0, endUs: 90 } },
    { event: "audioAcquired", data: { role: "system", startUs: 20, endUs: 150 } },
    { event: "audioAcquired", data: { role: "narration", startUs: 110, endUs: 200 } },
  ];
  const text = records.map((row) => JSON.stringify(row) + "\n").join("");
  writeFileSync(f.file, text);
  const receipt = {
    ...f.receipt,
    pauseEvents: 1,
    audioIntervals: 3,
    bytes: Buffer.byteLength(text),
  };
  await f.evidence.ingest({ ...f.identity, file: f.file, receipt });
  const range = { startUs: 50, endUs: 120 };
  expect(f.evidence.audio(f.identity, "narration", range)).toEqual([
    { startUs: 50, endUs: 90 },
    { startUs: 110, endUs: 120 },
  ]);
  expect(f.evidence.audio(f.identity, "system", range)).toEqual([{ startUs: 50, endUs: 120 }]);
  expect(f.evidence.audio(f.identity, "narration", { startUs: 90, endUs: 110 })).toEqual([]);
  expect(f.evidence.pauseBoundaries(f.identity, { startUs: 0, endUs: 100 })).toEqual([
    expect.objectContaining({ atSourceUs: 100, elapsedPauseUs: 5000 }),
  ]);
  expect(f.evidence.pauseBoundaries(f.identity, { startUs: 101, endUs: 200 })).toEqual([]);
});

test("malformed overlapping audio intervals and wrong timing receipts never become readable", async () => {
  for (const wrongCount of [false, true]) {
    const f = fixture([]);
    const rows = [
      { event: "audioAcquired", data: { role: "narration", startUs: 0, endUs: 100 } },
      {
        event: "audioAcquired",
        data: { role: "narration", startUs: wrongCount ? 110 : 90, endUs: 200 },
      },
    ];
    const text = rows.map((row) => JSON.stringify(row) + "\n").join("");
    writeFileSync(f.file, text);
    await expect(
      f.evidence.ingest({
        ...f.identity,
        file: f.file,
        receipt: {
          ...f.receipt,
          audioIntervals: wrongCount ? 1 : 2,
          bytes: Buffer.byteLength(text),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
    expect(() => f.evidence.audio(f.identity, "narration", { startUs: 0, endUs: 200 })).toThrow(
      expect.objectContaining({ code: "PREREQUISITE_MISSING" }),
    );
  }
});

async function ingestRecords(
  f: ReturnType<typeof fixture>,
  records: { event: string; data: Record<string, unknown> }[],
) {
  const body = records.map((row) => JSON.stringify(row) + "\n").join("");
  writeFileSync(f.file, body);
  const cursors = records.filter((row) => row.event === "cursorSample");
  await f.evidence.ingest({
    ...f.identity,
    file: f.file,
    receipt: {
      ...f.receipt,
      cursorSamples: cursors.length,
      geometryRecords: records.filter((row) => row.event === "geometry").length,
      pauseEvents: records.filter((row) => row.event === "pause").length,
      firstCursorSourceUs: (cursors[0]?.data.sourceUs as number) ?? null,
      lastCursorSourceUs: (cursors.at(-1)?.data.sourceUs as number) ?? null,
      bytes: Buffer.byteLength(body),
    },
  });
}

test("cursor predecessor retains ineligible observations and exposes stable delivery order", async () => {
  const f = fixture([]);
  const nativeFixture = new URL(
    "../../../specs/done/recording-for-ai/assets/trail-evidence/normalized.jsonl",
    import.meta.url,
  );
  const original = readFileSync(nativeFixture, "utf8");
  const records = original
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  await ingestRecords(f, records);
  expect(f.evidence.latestCursor(f.identity, 98)).toBeNull();
  expect(f.evidence.latestCursor(f.identity, 99)).toEqual({ ...records[3]!.data, sequence: 4 });
  expect(f.evidence.latestCursor(f.identity, 100)).toEqual({ ...records[5]!.data, sequence: 6 });
  expect(f.evidence.pauseBoundaries(f.identity, { startUs: 100, endUs: 100 })).toEqual([
    { ...records[2]!.data, sequence: 3 },
  ]);
  expect(readFileSync(nativeFixture, "utf8")).toBe(original);
  expect(() => f.evidence.latestCursor({ ...f.identity, generation: "missing" }, 100)).toThrow(
    "not indexed",
  );
  expect(() => f.evidence.latestCursor(f.identity, -1)).toThrow("range");
});

function geometry(epoch: number, sourceUs: number | null, hostUs = epoch * 100) {
  return {
    event: "geometry",
    data: {
      epoch,
      sourceUs,
      hostUs,
      geometry: {
        outputWidth: 100,
        outputHeight: 80,
        contentScale: 1,
        scaleFactor: 2,
        contentRect: { x: epoch, y: 0, width: 100, height: 80 },
      },
    },
  };
}

test("geometry reads preserve nullable placements, epoch identity and same-time ordering", async () => {
  const f = fixture([]);
  const records = [
    geometry(1, null),
    geometry(1, 0),
    geometry(2, 10),
    geometry(3, 10),
    geometry(4, null),
    geometry(4, 30),
  ];
  await ingestRecords(f, records);
  const row = (index: number) => ({ ...records[index]!.data, sequence: index + 1 });
  expect(f.evidence.timedGeometryAt(f.identity, 5)).toEqual(row(1));
  expect(f.evidence.nextTimedGeometry(f.identity, 5)).toEqual(row(2));
  expect(f.evidence.nextTimedGeometry(f.identity, 10)).toEqual(row(5));
  expect(f.evidence.nextTimedGeometry(f.identity, 30)).toBeNull();
  expect(f.evidence.timedGeometryAt(f.identity, 10)).toEqual(row(3));
  expect(f.evidence.timedGeometryAt(f.identity, 29)).toEqual(row(3));
  expect(f.evidence.geometryChanges(f.identity, { startUs: 10, endUs: 10 })).toEqual([
    row(2),
    row(3),
  ]);
  expect(f.evidence.geometryChanges(f.identity, { startUs: 11, endUs: 29 })).toEqual([]);
  expect(f.evidence.unplacedGeometry(f.identity, { afterSequence: 0 })).toEqual([row(0), row(4)]);
  expect(f.evidence.unplacedGeometry(f.identity, { afterSequence: 2, beforeSequence: 6 })).toEqual([
    row(4),
  ]);
  expect(f.evidence.unplacedGeometry(f.identity, { afterSequence: 5 })).toEqual([]);
  const unknown = fixture([]);
  await ingestRecords(unknown, [geometry(1, null)]);
  expect(unknown.evidence.timedGeometryAt(unknown.identity, 10000)).toBeNull();
});

test("geometry and pause reads traverse every index batch without truncating resets", async () => {
  for (const kind of ["timed", "unplaced", "pause"] as const) {
    const f = fixture([]);
    const records = Array.from({ length: 1001 }, (_, i) =>
      kind === "pause"
        ? { event: "pause", data: { atSourceUs: i, elapsedPauseUs: 1 } }
        : geometry(i + 1, kind === "timed" ? i : null),
    );
    await ingestRecords(f, records);
    const read = () =>
      kind === "pause"
        ? f.evidence.pauseBoundaries(f.identity, { startUs: 0, endUs: 1000 })
        : kind === "timed"
          ? f.evidence.geometryChanges(f.identity, { startUs: 0, endUs: 1000 })
          : f.evidence.unplacedGeometry(f.identity, { afterSequence: 0 });
    expect(read()).toEqual(records.map((record, i) => ({ ...record.data, sequence: i + 1 })));
    const bounded =
      kind === "pause"
        ? f.evidence.pauseBoundaries(f.identity, { startUs: 1000, endUs: 1000 })
        : kind === "timed"
          ? f.evidence.geometryChanges(f.identity, { startUs: 1000, endUs: 1000 })
          : f.evidence.unplacedGeometry(f.identity, { afterSequence: 1000 });
    expect(bounded).toEqual([{ ...records[1000]!.data, sequence: 1001 }]);
  }
});

test("production geometry reads and export batches seek indexes without full sorting", async () => {
  const f = fixture([]);
  await ingestRecords(f, [geometry(1, null), geometry(1, 0), geometry(2, 100)]);
  const plans: string[] = [];
  const prepare = f.store.catalog.prepare.bind(f.store.catalog);
  const spy = vi.spyOn(f.store.catalog, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT sequence,event,sourceUs,content")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        plans.push(
          prepare("EXPLAIN QUERY PLAN " + sql)
            .all(...args)
            .map((row) => row.detail)
            .join(" "),
        );
        return all(...args);
      });
    }
    return statement;
  });
  try {
    for (const [read, index, seek] of [
      [() => f.evidence.latestCursor(f.identity, 100), "source_evidence_time", "sourceUs"],
      [() => f.evidence.timedGeometryAt(f.identity, 100), "source_evidence_geometry", "sourceUs"],
      [
        () => f.evidence.geometryChanges(f.identity, { startUs: 0, endUs: 100 }),
        "source_evidence_geometry",
        "sourceUs",
      ],
      [
        () => f.evidence.unplacedGeometry(f.identity, { afterSequence: 0 }),
        "source_evidence_geometry",
        "sourceUs",
      ],
      [
        () => f.evidence.pauseBoundaries(f.identity, { startUs: 0, endUs: 100 }),
        "source_evidence_pauses",
        "sourceUs",
      ],
    ] as const) {
      plans.length = 0;
      read();
      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) {
        expect(plan).toContain(`SEARCH source_evidence_records USING INDEX ${index}`);
        expect(plan).toContain(seek);
        expect(plan).not.toContain("TEMP B-TREE");
      }
    }
  } finally {
    spy.mockRestore();
  }
});

test("recording purge reclaims complete and unfinished generations across restart, leaving siblings", async () => {
  const f = fixture([0, 10]);
  await f.evidence.ingest({ ...f.identity, file: f.file, receipt: f.receipt });
  const sibling = f.store.allocate().recording;
  f.store.catalog
    .prepare("INSERT INTO source_evidence_generations VALUES('recording',?,?,?,NULL)")
    .run(f.identity.owner.id, f.identity.sourceId, "unfinished");
  f.store.catalog
    .prepare("INSERT INTO source_evidence_generations VALUES('recording',?,?,?,NULL)")
    .run(sibling.id, sibling.sourceId, "sibling");
  f.store.markDeleting(f.identity.owner.id);
  f.store.close();
  const reopened = new CaptureStore(join(dirname(f.file), "library.sqlite"), {
    now: () => "",
    newId: () => "unused",
  });
  stores.push(reopened);
  const evidence = new SourceEvidenceStore(reopened, recordingEvidenceOwner(reopened));
  await evidence.purge(f.identity.owner, new AbortController().signal);
  await evidence.purge(f.identity.owner, new AbortController().signal);
  expect(
    reopened.catalog
      .prepare("SELECT ownerId AS recordingId,generation FROM source_evidence_generations")
      .all(),
  ).toEqual([{ recordingId: sibling.id, generation: "sibling" }]);
  expect(reopened.catalog.prepare("SELECT * FROM source_evidence_records").all()).toEqual([]);
});

test("purge yields even for empty generations and aborted cleanup can resume", async () => {
  const f = fixture();
  f.store.transaction(() => {
    const insert = f.store.catalog.prepare(
      "INSERT INTO source_evidence_generations VALUES('recording',?,?,?,NULL)",
    );
    for (let i = 0; i < 130; i++)
      insert.run(f.identity.owner.id, f.identity.sourceId, `unfinished-${i}`);
  });
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await expect(f.evidence.purge(f.identity.owner, controller.signal)).rejects.toThrow();
  expect(
    f.store.catalog.prepare("SELECT generation FROM source_evidence_generations LIMIT 1").get(),
  ).toBeDefined();
  await f.evidence.purge(f.identity.owner, new AbortController().signal);
  expect(
    f.store.catalog.prepare("SELECT generation FROM source_evidence_generations").all(),
  ).toEqual([]);
});

test("source purge retains unfinished generation identity across an interrupted multi-batch reclaim", async () => {
  const f = fixture(Array.from({ length: 600 }, (_, i) => i));
  await f.evidence.ingest({ ...f.identity, file: f.file, receipt: f.receipt });
  f.store.catalog
    .prepare(
      "UPDATE source_evidence_generations SET receipt=NULL WHERE ownerKind='recording' AND ownerId=?",
    )
    .run(f.identity.owner.id);
  const original = readFileSync(f.file);
  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await expect(f.evidence.purge(f.identity.owner, controller.signal)).rejects.toThrow();
  expect(
    f.store.catalog
      .prepare("SELECT ownerId AS recordingId,sourceId,generation FROM source_evidence_generations")
      .get(),
  ).toEqual({
    recordingId: f.identity.owner.id,
    sourceId: f.identity.sourceId,
    generation: f.identity.generation,
  });
  const remaining = f.store.catalog
    .prepare(
      "SELECT ownerId AS recordingId,sequence FROM source_evidence_records ORDER BY sequence LIMIT 1",
    )
    .get() as { recordingId: string; sequence: number };
  expect(remaining.recordingId).toBe(f.identity.owner.id);
  expect(remaining.sequence).toBeGreaterThan(1);
  await f.evidence.purge(f.identity.owner, new AbortController().signal);
  expect(f.store.catalog.prepare("SELECT sequence FROM source_evidence_records").all()).toEqual([]);
  expect(readFileSync(f.file).equals(original)).toBe(true);
});

test("capture completion provenance survives ingestion without fabricating timing for presence-only receipts", async () => {
  const f = fixture();
  const completion = {
    sequence: 4,
    state: "interrupted" as const,
    durationUs: 700,
    failureCode: "DEVICE_LOST",
    failureMessage: "Microphone disconnected",
  };
  const lastLifecycle = { state: "interrupted", reason: "DEVICE_LOST" };
  const receipt = {
    ...f.receipt,
    normalizationVersion: 2 as const,
    finished: true,
    completion,
    lastLifecycle,
  };
  const admitted = await f.evidence.ingest({ ...f.identity, file: f.file, receipt });
  expect(admitted.receipt.completion).toEqual(completion);
  expect(admitted.receipt.lastLifecycle).toEqual(lastLifecycle);
  expect(
    f.evidence
      .page({ ...f.identity, range: { startUs: 0, endUs: 100 }, limit: 10 })
      .samples.map((s) => s.sourceUs),
  ).toEqual([0, 10, 10, 20]);
  const legacy = { ...f.receipt, finished: true };
  const retained = await f.evidence.ingest({
    ...f.identity,
    generation: "presence-only",
    file: f.file,
    receipt: legacy,
  });
  expect(retained.receipt.finished).toBe(true);
  expect(retained.receipt.completion).toBeUndefined();
});

test("malformed terminal provenance refuses evidence publication", async () => {
  const f = fixture();
  const completion = {
    sequence: 4,
    state: "interrupted",
    durationUs: 700,
    failureCode: "DEVICE_LOST",
    failureMessage: "Microphone disconnected",
  };
  const cases = [
    { completion },
    ...[
      { sequence: 0 },
      { sequence: 6 },
      { state: "recording" },
      { durationUs: -1 },
      { durationUs: Number.MAX_SAFE_INTEGER + 1 },
      { failureCode: 7 },
      { failureMessage: 7 },
      { failureMessage: "x".repeat(4097) },
      { failureCode: null },
      { state: "complete" },
    ].map((change) => ({ finished: true, completion: { ...completion, ...change } })),
    { lastLifecycle: { state: 7 } },
    { lastLifecycle: { state: "interrupted", reason: 7 } },
  ];
  for (const [i, change] of cases.entries()) {
    const identity = { ...f.identity, generation: `invalid-${i}` };
    await expect(
      f.evidence.ingest({
        ...identity,
        file: f.file,
        receipt: { ...f.receipt, normalizationVersion: 2, ...change } as never,
      }),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
    expect(() =>
      f.evidence.page({ ...identity, range: { startUs: 0, endUs: 100 }, limit: 10 }),
    ).toThrow(expect.objectContaining({ code: "PREREQUISITE_MISSING" }));
  }
});

test.each(["schema4-marks", "schema4-undone"])(
  "shared %s fixture reads through portable evidence",
  async (name) => {
    const records = readFileSync(
      new URL(`../../../fixtures/journal/${name}.jsonl`, import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const header = records[0].data;
    const marks = records.filter((record) => record.event === "mark");
    const f = fixture();
    const body = marks.map(({ event, data }) => JSON.stringify({ event, data }) + "\n").join("");
    writeFileSync(f.file, body);
    const receipt = validateSourceReceipt(
      {
        ...f.receipt,
        header,
        publications: {},
        cursorSamples: 0,
        firstCursorSourceUs: null,
        lastCursorSourceUs: null,
        markEvents: marks.length,
        lastSequence: records.length,
        bytes: Buffer.byteLength(body),
      },
      header.sessionID,
    );
    const values = [];
    for await (const row of sourceEvidenceRecords(f.file, receipt))
      values.push(JSON.parse(row.content));
    expect(values).toEqual(marks.map((record) => record.data));
    expect(values.slice(0, 2).map((mark) => mark.id)).toEqual(["pin", "stroke"]);
    expect(values.flatMap((mark) => mark.retracts ?? [])).toEqual(
      name === "schema4-undone" ? ["pin", "stroke"] : [],
    );
    expect(() =>
      validateSourceReceipt(
        { ...receipt, header: { ...header, schemaVersion: 5 } },
        header.sessionID,
      ),
    ).toThrow("Unsupported evidence journal schema 5");
  },
);
