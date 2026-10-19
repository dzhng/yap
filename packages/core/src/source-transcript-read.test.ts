import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog } from "./catalog.js";
import { writeOutputIssues } from "./issues.js";
import { speechExecution, TranscriptStore, type TranscriptMetadata } from "./transcript.js";
import { SourceTranscriptRead, type SourceTranscriptRow } from "./transcript-read.js";
import { portHistoricalSpeechRaw } from "../../test-harness/speech/reference-raw.mjs";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const pins = {
  runtime: "FluidAudio",
  runtimeVersion: "0.15.7",
  runtimeRevision: "pin",
  decoder: "parakeet-tdt-batch",
  model: "model",
  modelRevision: "pin",
  modelDigest: "a".repeat(64),
};
type Word = { text: string; startUs: number; endUs: number };
async function fixture(
  segments = [
    {
      startUs: 100,
      endUs: 500,
      words: [
        { text: "Hello,", startUs: 100, endUs: 250 },
        { text: "WORLD!", startUs: 250, endUs: 300 },
        { text: "last", startUs: 400, endUs: 500 },
      ],
    },
    {
      startUs: 700,
      endUs: 900,
      words: [
        { text: "first", startUs: 700, endUs: 750 },
        { text: "hello", startUs: 800, endUs: 900 },
      ],
    },
  ] as { startUs: number; endUs: number; words: Word[] }[],
  durationUs = 1000,
  retainedRaw?: string,
) {
  const home = await mkdtemp("/tmp/source-transcript-read-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const store = new TranscriptStore(catalog, home, () => {});
  const identity = {
    owner: { kind: "asset" as const, id: "asset-a" },
    sourceId: "asset-a",
    generation: "generation-a",
  };
  const output = await store.reserve(identity);
  const lines = segments.map(({ startUs, endUs, words }, ordinal) => ({
    ordinal,
    source: { startUs, endUs },
    owned: { startUs, endUs },
    state: "transcribed" as const,
    words: words.map(({ text, startUs, endUs }) => ({
      text,
      source: { startUs, endUs },
      confidence: 0.75,
    })),
  }));
  const raw = retainedRaw ?? lines.map((line) => JSON.stringify(line) + "\n").join("");
  await writeFile(output, raw);
  const { transcript: metadata, issues } = await store.ingest({
    identity,
    source: {
      kind: "asset",
      streamId: "track:7",
      acquisitionId: "capture-a",
      durationUs,
      supportDigest: "b".repeat(64),
    },
    request: {
      execution: speechExecution(),
      models: { directory: join(home, "models"), files: [] },
      output,
      track: {
        source: join(home, "source.mov"),
        streamId: "track:7",
        sourceOffsetUs: -500,
        available: segments.map(({ startUs, endUs }) => ({ startUs, endUs })),
      },
    },
    receipt: {
      output: {
        file: output,
        bytes: Buffer.byteLength(raw),
        sha256: createHash("sha256").update(raw).digest("hex"),
      },
      engine: { ...pins, encoderPrecision: "int8", computeUnits: "cpuAndNeuralEngine" },
      segments: lines.map(({ ordinal, source, state, words }) => ({
        ordinal,
        source,
        owned: source,
        state,
        wordCount: words.length,
      })),
      execution: speechExecution(),
      wordCount: lines.reduce((sum, line) => sum + line.words.length, 0),
      available: segments.map(({ startUs, endUs }) => ({ startUs, endUs })),
    },
    pins,
    signal: new AbortController().signal,
  });
  return { catalog, store, metadata, issues, read: new SourceTranscriptRead(store, metadata) };
}

test("source pages preserve words and raw acquisition gaps across one-row continuations", async () => {
  const { read } = await fixture();
  const rows: SourceTranscriptRow[] = [];
  let cursor: unknown;
  do {
    const page = read.page({ limit: 1, cursor });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  expect(
    rows.map((row) => [row.type === "word" ? row.text : row.reason, row.sourceRange, row.partial]),
  ).toEqual([
    ["not_acquired", { startUs: 0, endUs: 100 }, false],
    ["Hello,", { startUs: 100, endUs: 250 }, false],
    ["WORLD!", { startUs: 250, endUs: 300 }, false],
    ["last", { startUs: 400, endUs: 500 }, false],
    ["not_acquired", { startUs: 500, endUs: 700 }, false],
    ["first", { startUs: 700, endUs: 750 }, false],
    ["hello", { startUs: 800, endUs: 900 }, false],
    ["not_acquired", { startUs: 900, endUs: 1000 }, false],
  ]);
  expect(rows).toEqual(read.page({}).rows);
  expect(rows.every((row) => !("fragments" in row))).toBe(true);
  expect(
    read
      .page({ range: { startUs: 200, endUs: 225 } })
      .rows.map((row) => [row.sourceRange, row.partial]),
  ).toEqual([[{ startUs: 100, endUs: 250 }, true]]);
});

test("word issues in raw evidence round-trip to their rows through one-row continuations and range reads", async () => {
  const unresolved = {
    code: "boundary-unresolved",
    message:
      "'last' has no unique peer across the 0.000 s seam; the window whose core holds its start publishes it.",
    word: 2,
    evidence: { boundaryUs: 500, window: 0, observation: 2, text: "last", published: true },
  };
  const clamped = {
    code: "timing-clamped",
    message:
      "The engine estimate [0.000, 0.001] s runs past its decoded window; it is clamped to the window edge.",
    word: 1,
    evidence: {
      window: 1,
      observation: 1,
      decoded: { startUs: 700, endUs: 900 },
      startSeconds: 0.0001,
      endSeconds: 0.00021,
    },
  };
  const raw = [
    { startUs: 100, endUs: 500, texts: ["Hello,", "WORLD!", "last"], issues: [unresolved] },
    { startUs: 700, endUs: 900, texts: ["first", "hello"], issues: [clamped] },
  ]
    .map(({ startUs, endUs, texts, issues }, ordinal) => {
      const spans = ordinal
        ? [
            [700, 750],
            [800, 900],
          ]
        : [
            [100, 250],
            [250, 300],
            [400, 500],
          ];
      return (
        JSON.stringify({
          ordinal,
          source: { startUs, endUs },
          owned: { startUs, endUs },
          state: "transcribed",
          words: texts.map((text, index) => ({
            text,
            source: { startUs: spans[index]![0], endUs: spans[index]![1] },
            confidence: 0.75,
          })),
          issues,
        }) + "\n"
      );
    })
    .join("");
  const { catalog, issues, metadata, read } = await fixture(undefined, 1000, raw);
  expect(issues.map((issue) => [issue.code, issue.at])).toEqual([
    ["boundary-unresolved", { word: 2 }],
    ["timing-clamped", { word: 4 }],
  ]);
  // What the job queue does when the attempt that produced this generation publishes it.
  writeOutputIssues(
    catalog,
    { outputKind: "artifact", outputId: metadata.generation, generation: 1 },
    issues,
  );
  const rows: SourceTranscriptRow[] = [];
  let cursor: unknown;
  do {
    const page = read.page({ limit: 1, cursor });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  expect(
    rows.flatMap((row) =>
      row.type === "word" ? [[row.text, row.issues?.map((issue) => issue.code) ?? []]] : [],
    ),
  ).toEqual([
    ["Hello,", []],
    ["WORLD!", []],
    ["last", ["boundary-unresolved"]],
    ["first", []],
    ["hello", ["timing-clamped"]],
  ]);
  expect(read.page({ range: { startUs: 850, endUs: 900 } }).rows).toMatchObject([
    { text: "hello", issues: [issues[1]] },
  ]);
});

test("coincident and overlapping estimates retain every word and instant point through bounded pages", async () => {
  const words = [
    { text: "I", startUs: 0, endUs: 80 },
    { text: "just", startUs: 0, endUs: 160 },
    { text: "point", startUs: 20, endUs: 20 },
    { text: "again", startUs: 20, endUs: 20 },
    { text: "kind", startUs: 80, endUs: 240 },
  ];
  const { read, store, metadata } = await fixture([{ startUs: 0, endUs: 300, words }], 300);
  expect(
    store
      .wordRecords(metadata, { limit: 20 })
      .map(({ text, startUs, endUs, instant }) => ({ text, startUs, endUs, instant })),
  ).toEqual(words.map((word) => ({ ...word, instant: word.startUs === word.endUs })));
  const rows: SourceTranscriptRow[] = [];
  let cursor: unknown;
  do {
    const page = read.page({ range: { startUs: 20, endUs: 21 }, limit: 1, cursor });
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  expect(rows.map((row) => [row.type === "word" ? row.text : row.reason, row.sourceRange])).toEqual(
    [
      ["I", { startUs: 0, endUs: 80 }],
      ["just", { startUs: 0, endUs: 160 }],
      ["point", { startUs: 20, endUs: 20 }],
      ["again", { startUs: 20, endUs: 20 }],
    ],
  );
  expect(
    read
      .page({ range: { startUs: 100, endUs: 101 } })
      .rows.map((row) => (row.type === "word" ? row.text : row.reason)),
  ).toEqual(["just", "kind"]);
  expect(read.search({ text: "I just" }).entries).toEqual([
    { wordIds: ["w0", "w1"], sourceRange: { startUs: 0, endUs: 160 } },
  ]);
});

test("source search folds literal words, pages matches and refuses phrases across acquisition segments", async () => {
  const { read } = await fixture();
  expect(read.search({ text: "HELLO world" }).entries).toEqual([
    { wordIds: ["w0", "w1"], sourceRange: { startUs: 100, endUs: 300 } },
  ]);
  expect(read.search({ text: "last first" }).entries).toEqual([]);
  expect(read.search({ text: "h.*llo" }).entries).toEqual([]);
  const first = read.search({ text: "hello", limit: 1 });
  expect(first.entries).toEqual([{ wordIds: ["w0"], sourceRange: { startUs: 100, endUs: 250 } }]);
  const second = read.search({ text: "hello", limit: 1, cursor: first.nextCursor });
  expect(second.entries).toEqual([{ wordIds: ["w4"], sourceRange: { startUs: 800, endUs: 900 } }]);
  expect(second.nextCursor).toBeNull();
});

test("source continuations pin every source identity dimension, generation and query", async () => {
  const { read, store, metadata } = await fixture();
  const page = read.page({ limit: 1, range: { startUs: 100, endUs: 900 } });
  const search = read.search({ text: "hello", limit: 1 });
  // The selected source is a filter; generation and support are the pin.
  for (const [field, code] of [
    ["assetId", "INVALID_PARAMS"],
    ["streamId", "INVALID_PARAMS"],
    ["acquisitionId", "INVALID_PARAMS"],
    ["generation", "ARTIFACT_CHANGED"],
    ["supportDigest", "ARTIFACT_CHANGED"],
  ] as const) {
    expect(() => read.page({ cursor: { ...page.nextCursor, [field]: "different" } })).toThrow(
      expect.objectContaining({ code }),
    );
    expect(() =>
      read.search({ text: "hello", cursor: { ...search.nextCursor, [field]: "different" } }),
    ).toThrow(expect.objectContaining({ code }));
  }
  expect(() => read.page({ cursor: page.nextCursor, range: { startUs: 100, endUs: 800 } })).toThrow(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
  expect(() => read.search({ text: "world", cursor: search.nextCursor })).toThrow(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
  expect(() => read.page({ cursor: { ...page.nextCursor, acquisitionId: null } })).toThrow(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
  const next = new SourceTranscriptRead(store, { ...metadata, generation: "next" });
  expect(() => next.page({ cursor: page.nextCursor })).toThrow(
    expect.objectContaining({ code: "ARTIFACT_CHANGED" }),
  );
  const physicalMetadata: TranscriptMetadata = {
    ...metadata,
    source: { kind: "asset", durationUs: 1000, streamId: "track:7", supportDigest: "b".repeat(64) },
  };
  const physical = new SourceTranscriptRead(store, physicalMetadata).page({ limit: 1 });
  expect(physical.nextCursor?.acquisitionId).toBeNull();
  expect(read.page({ range: { startUs: 0, endUs: 1001 } }).issues).toMatchObject([
    {
      code: "range-clamped",
      evidence: {
        requested: { startUs: 0, endUs: 1001 },
        applied: { startUs: 0, endUs: 1000 },
        bounds: { startUs: 0, endUs: 1000 },
      },
    },
  ]);
  expect(read.page({ range: { startUs: 0, endUs: 1000 } }).issues).toEqual([]);
  expect(() => read.page({ range: { startUs: 1000, endUs: 1001 } })).toThrow(
    expect.objectContaining({
      code: "INVALID_RANGE",
      details: expect.objectContaining({ bounds: { startUs: 0, endUs: 1000 } }),
    }),
  );
  expect(() => read.page({ limit: 0 })).toThrow(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
  expect(() => read.page({ cursor: {} })).toThrow(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
});

test("late source windows stay bounded and no-match search yields resumable empty pages", async () => {
  const words = Array.from({ length: 10_003 }, (_, i) => ({
    text: i === 10_001 ? "needle" : "hay",
    startUs: i * 10,
    endUs: i * 10 + 5,
  }));
  const { read, store, metadata } = await fixture([{ startUs: 0, endUs: 100_030, words }], 100_030);
  const bounds: number[] = [];
  const inspected = new SourceTranscriptRead(
    {
      wordRecords(identity, query) {
        const rows = store.wordRecords(identity, query);
        bounds.push(rows.length);
        return rows;
      },
      gapRecords(identity, query) {
        return store.gapRecords(identity, query);
      },
    },
    metadata,
  );
  expect(inspected.page({ range: { startUs: 100_011, endUs: 100_013 } }).rows).toMatchObject([
    {
      type: "word",
      text: "needle",
      sourceRange: { startUs: 100_010, endUs: 100_015 },
      partial: true,
    },
  ]);
  expect(bounds.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(2);
  const first = read.search({ text: "needle" });
  expect(first.entries).toEqual([]);
  expect(first.nextCursor?.afterOrdinal).toBe(9999);
  expect(read.search({ text: "needle", cursor: first.nextCursor })).toEqual({
    entries: [{ wordIds: ["w10001"], sourceRange: { startUs: 100_010, endUs: 100_015 } }],
    nextCursor: null,
  });
});

test("one long early word cannot make a late source window scan the short-word prefix", async () => {
  const words = [
    { text: "long", startUs: 0, endUs: 200_000 },
    ...Array.from({ length: 10_003 }, (_, i) => ({
      text: i === 10_001 ? "needle" : "hay",
      startUs: 200_000 + i * 10,
      endUs: 200_005 + i * 10,
    })),
  ];
  const { store, metadata } = await fixture([{ startUs: 0, endUs: 300_030, words }], 300_030);
  let readRows = 0;
  const read = new SourceTranscriptRead(
    {
      wordRecords(identity, query) {
        const rows = store.wordRecords(identity, query);
        readRows += rows.length;
        return rows;
      },
      gapRecords(identity, query) {
        return store.gapRecords(identity, query);
      },
    },
    metadata,
  );
  expect(read.page({ range: { startUs: 300_011, endUs: 300_013 } }).rows).toMatchObject([
    { text: "needle", sourceRange: { startUs: 300_010, endUs: 300_015 }, partial: true },
  ]);
  expect(readRows).toBeLessThanOrEqual(2);
  expect(read.page({ range: { startUs: 100_000, endUs: 100_001 } }).rows).toMatchObject([
    { text: "long", sourceRange: { startUs: 0, endUs: 200_000 }, partial: true },
  ]);
  const first = read.page({ range: { startUs: 199_999, endUs: 200_015 }, limit: 1 });
  expect(first.rows).toMatchObject([{ text: "long" }]);
  expect(read.page({ cursor: first.nextCursor, limit: 1 }).rows).toMatchObject([
    { ordinal: 1, text: "hay" },
  ]);
  const boundary = read.page({ range: { startUs: 0, endUs: 300_030 }, limit: 1 });
  expect(read.page({ cursor: boundary.nextCursor, limit: 1 }).rows).toMatchObject([
    { ordinal: 1, text: "hay" },
  ]);
});

test("source pagination and phrase matches retain exact ordinals across storage batches", async () => {
  const words = Array.from({ length: 3000 }, (_, index) => ({
    text: `word${index % 1000}`,
    startUs: index * 3000,
    endUs: index * 3000 + 2000,
  }));
  const selected = words.filter((word) => word.startUs < 4500000 || word.startUs >= 4600000);
  const { read } = await fixture(
    [
      { startUs: 0, endUs: 4500000, words: words.filter((word) => word.startUs < 4500000) },
      { startUs: 4600000, endUs: 10000000, words: words.filter((word) => word.startUs >= 4600000) },
    ],
    10000000,
  );
  const rows: SourceTranscriptRow[] = [];
  let cursor: unknown;
  let pages = 0;
  do {
    const page = read.page({ limit: 1000, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  expect(pages).toBe(3);
  expect(
    rows.flatMap((row) => (row.type === "word" ? [[row.text, row.sourceRange.startUs]] : [])),
  ).toEqual(selected.map((word) => [word.text, word.startUs]));
  const gap = rows.findIndex((row) => row.type === "gap");
  expect(rows.filter((row) => row.type === "gap")).toEqual([
    {
      type: "gap",
      reason: "not_acquired",
      sourceRange: { startUs: 4500000, endUs: 4600000 },
      partial: false,
    },
  ]);
  expect(rows.slice(gap - 1, gap + 2).map((row) => (row.type === "word" ? row.id : "gap"))).toEqual(
    ["w1499", "gap", "w1500"],
  );
  const first = read.search({ text: "WORD999 word0", limit: 1 });
  expect(first.entries).toEqual([
    { wordIds: ["w999", "w1000"], sourceRange: { startUs: 2997000, endUs: 3002000 } },
  ]);
  const second = read.search({ text: "WORD999 word0", cursor: first.nextCursor });
  expect(second.entries).toEqual([
    { wordIds: ["w1965", "w1966"], sourceRange: { startUs: 5997000, endUs: 6002000 } },
  ]);
  expect(second.nextCursor).toBeNull();
});

test("whole-source listing retains terminal instant observations while selected ranges stay half-open", async () => {
  const { read } = await fixture([
    {
      startUs: 0,
      endUs: 1000,
      words: [
        { text: "last", startUs: 900, endUs: 1000 },
        { text: "point", startUs: 1000, endUs: 1000 },
        { text: "same", startUs: 1000, endUs: 1000 },
      ],
    },
  ]);
  const first = read.page({ limit: 1 });
  const second = read.page({ limit: 1, cursor: first.nextCursor });
  const third = read.page({ limit: 1, cursor: second.nextCursor });
  expect(
    [first, second, third].flatMap((page) =>
      page.rows.map((row) => row.type === "word" && row.text),
    ),
  ).toEqual(["last", "point", "same"]);
  expect(third.nextCursor).toBeNull();
  expect(
    read
      .page({ range: { startUs: 900, endUs: 1000 } })
      .rows.map((row) => row.type === "word" && row.text),
  ).toEqual(["last"]);
});

test("a point at the next gap start never hides either record in one-row continuations", async () => {
  const { read } = await fixture([
    {
      startUs: 0,
      endUs: 500,
      words: [
        { text: "spoken", startUs: 0, endUs: 400 },
        { text: "point", startUs: 500, endUs: 500 },
      ],
    },
    { startUs: 700, endUs: 1000, words: [{ text: "later", startUs: 700, endUs: 800 }] },
  ]);
  for (const range of [undefined, { startUs: 400, endUs: 1000 }]) {
    const rows: SourceTranscriptRow[] = [];
    let cursor: unknown;
    do {
      const page = read.page({ range, cursor, limit: 1 });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor);
    expect(rows.map((row) => (row.type === "word" ? row.text : row.reason))).toEqual(
      range ? ["point", "not_acquired", "later"] : ["spoken", "point", "not_acquired", "later"],
    );
  }
});

test.each(["baseline", "green"])(
  "retained Madison %s word estimates survive explicit reference admission",
  async (version) => {
    const raw = await readFile(
      new URL(
        `../../../specs/done/video-editing-feedback/assets/07-speech-timing/m1877.55-${version}.jsonl`,
        import.meta.url,
      ),
      "utf8",
    );
    const segment = JSON.parse(raw) as {
      source: { startUs: number; endUs: number };
      words: { text: string; source: { startUs: number; endUs: number } }[];
    };
    const adapted = portHistoricalSpeechRaw(Buffer.from(raw), {
      execution: speechExecution(),
      available: [segment.source],
    });
    const { read, metadata } = await fixture(
      [
        {
          ...segment.source,
          words: segment.words.map((word) => ({ text: word.text, ...word.source })),
        },
      ],
      2650000,
      adapted.body.toString("utf8"),
    );
    expect(metadata.raw.sha256).toBe(adapted.sha256);
    expect(adapted.referenceReplay.sourceSha256).toBe(
      createHash("sha256").update(raw).digest("hex"),
    );
    expect(
      read
        .page({})
        .rows.filter((row) => row.type === "word")
        .map((row) => ({ text: row.text, source: row.sourceRange })),
    ).toEqual(segment.words.map(({ text, source }) => ({ text, source })));
    expect(
      read
        .page({ range: { startUs: 0, endUs: 1 } })
        .rows.map((row) => row.type === "word" && row.text),
    ).toEqual(["I", "just"]);
    expect(read.search({ text: "I just" }).entries.map((entry) => entry.sourceRange)).toEqual([
      { startUs: 0, endUs: 160000 },
    ]);
  },
);
