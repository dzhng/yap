import assert from "node:assert/strict";
import test from "node:test";
import { compactTranscripts } from "../skills/yap/scripts/compact-transcripts.mjs";

const word = (ordinal, text, startUs, endUs, extra = {}) => ({
  type: "word",
  id: `w${ordinal}`,
  ordinal,
  text,
  kind: "word",
  confidence: 0.9,
  segment: 0,
  sourceRange: { startUs, endUs },
  partial: false,
  ...extra,
});
const selection = { assetId: "take-a", streamId: "audio:0", label: "Take A" };
const sourcePage = (rows, nextCursor = null, generation = "generation-a") => ({
  assetId: selection.assetId,
  streamId: selection.streamId,
  state: "ready",
  generation,
  transcript: {
    generation,
    source: {
      kind: "asset",
      streamId: selection.streamId,
      supportDigest: "support-a",
      durationUs: 10_000_000,
    },
  },
  rows,
  nextCursor,
});
/** Service cursors are opaque base64url strings; these fakes keep a position inside one. */
const opaque = (position) => Buffer.from(JSON.stringify(position)).toString("base64url");
const position = (cursor) => JSON.parse(Buffer.from(cursor, "base64url").toString());
/** A continuation repeats every first-page parameter except limit, or the service refuses it. */
function repeatsFirstPage() {
  let first;
  return (params) => {
    const { cursor, limit: _limit, ...filters } = params;
    if (!cursor) first = filters;
    else assert.deepEqual(filters, first, "continuation repeats the first page's parameters");
  };
}

test("reading two takes retains verbatim rows, generations and admitted duration", async () => {
  const rows = [word(0, "Hello,", 100_000, 220_000), word(1, "世界!", 230_000, 400_000)];
  const result = await compactTranscripts(
    { selections: [selection, { ...selection, assetId: "take-b", label: "Take B" }] },
    async (operation, params) => {
      assert.equal(operation, "transcript.get");
      assert.equal("prepare" in params, false);
      return {
        ...sourcePage(rows),
        assetId: params.assetId,
        generation: params.assetId === "take-a" ? "generation-a" : "generation-b",
        transcript: {
          generation: params.assetId === "take-a" ? "generation-a" : "generation-b",
          source: sourcePage(rows).transcript.source,
        },
      };
    },
  );
  assert.equal(result.continuation, null);
  assert.deepEqual(
    result.selections.map((entry) => [entry.label, entry.identity.generation, entry.durationUs]),
    [
      ["Take A", "generation-a", 10_000_000],
      ["Take B", "generation-b", 10_000_000],
    ],
  );
  assert.deepEqual(result.selections[0].rows, rows);
  assert.deepEqual(result.selections[0].phrases, [
    { text: "Hello, 世界!", rowIndexes: [0, 1], displayRangeSeconds: [0.1, 0.4], speaker: null },
  ]);
});

test("empty project pages continue with pinned revision and preserve repeated fractional occurrences", async () => {
  const next = opaque({ checkpointId: "checkpoint" });
  const repeats = repeatsFirstPage();
  const row = {
    ...word(2, "Again!", 200_000, 300_000),
    partial: true,
    clipId: "second-occurrence",
    trackId: "dialogue",
    trackRank: 0,
    assetId: "take-a",
    streamId: "audio:0",
    generation: "generation-a",
    fragments: [
      {
        source: { startUs: 250_000, endUs: 300_000 },
        project: { startUs: { numerator: 1_000_001, denominator: 3 }, endUs: 450_000 },
      },
    ],
  };
  const result = await compactTranscripts(
    { selections: [{ projectId: "project" }] },
    async (operation, params) => {
      assert.equal(operation, "transcript.get");
      assert.equal(params.revisionId ?? "revision-a", "revision-a");
      repeats(params);
      return params.cursor
        ? {
            projectId: "project",
            revisionId: "revision-a",
            state: "ready",
            dependencies: { manifestId: "manifest" },
            rows: [row],
            nextCursor: null,
          }
        : {
            projectId: "project",
            revisionId: "revision-a",
            state: "ready",
            dependencies: [
              {
                selection: { assetId: "take-a", streamId: "audio:0" },
                transcript: { generation: "generation-a", source: { durationUs: 10_000_000 } },
              },
            ],
            rows: [],
            nextCursor: next,
          };
    },
  );
  assert.equal(result.continuation, null);
  assert.equal(result.selections[0].identity.revisionId, "revision-a");
  assert.deepEqual(result.selections[0].rows, [row]);
  assert.deepEqual(result.selections[0].sourceDurations, [
    {
      selection: { assetId: "take-a", streamId: "audio:0" },
      generation: "generation-a",
      durationUs: 10_000_000,
    },
  ]);
  assert.equal(result.selections[0].phrases[0].text, "Again!");
});

test("UTF-8 budget returns replayable pages without dropping verbatim words", async () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    word(i, `世界${i}`.repeat(14), i * 100_000, (i + 1) * 100_000),
  );
  const invoke = async (_, params) => {
    const { cursor, limit: _limit, ...filters } = params;
    assert.deepEqual(filters, { assetId: "take-a", streamId: "audio:0" });
    const start = cursor ? position(cursor).afterOrdinal + 1 : 0;
    const selected = rows.slice(start, start + params.limit);
    const last = selected.at(-1)?.ordinal;
    return sourcePage(selected, last < rows.length - 1 ? opaque({ afterOrdinal: last }) : null);
  };
  const seen = [];
  let continuation;
  let calls = 0;
  do {
    const page = await compactTranscripts(
      { selections: [selection], maxBytes: 2800, maxPages: 8, pageRows: 7, continuation },
      invoke,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(page) + "\n") <= 2800,
      "entire output including exact pointers fits byte budget",
    );
    seen.push(...page.selections.flatMap((entry) => entry.rows));
    continuation = page.continuation && JSON.parse(JSON.stringify(page.continuation));
    assert.ok(++calls < 12, "each continuation makes progress");
  } while (continuation);
  assert.deepEqual(seen, rows);
});

test("a ready envelope without a transcript page is rejected rather than called complete", async () => {
  await assert.rejects(
    () =>
      compactTranscripts({ selections: [selection] }, async () => ({
        state: "ready",
        generation: "generation-a",
      })),
    { code: "INVALID_RESPONSE" },
  );
});

test("phrases never bridge discontinuous projected fragments even when words are close", async () => {
  const rows = [
    word(0, "before", 0, 100),
    word(1, "after", 200, 300, {
      clipId: undefined,
      fragments: [
        { source: { startUs: 200, endUs: 230 }, project: { startUs: 200, endUs: 230 } },
        { source: { startUs: 250, endUs: 300 }, project: { startUs: 250, endUs: 300 } },
      ],
    }),
  ];
  const result = await compactTranscripts({ selections: [selection] }, async () =>
    sourcePage(rows),
  );
  assert.deepEqual(
    result.selections[0].phrases.map((phrase) => phrase.text),
    ["before", "after"],
  );
});

test("unavailable reads do not erase the expected transcript-generation check", async () => {
  await assert.rejects(
    () =>
      compactTranscripts(
        { selections: [{ ...selection, generation: "generation-old" }] },
        async () => sourcePage([word(0, "new", 0, 100)]),
      ),
    { code: "ARTIFACT_CHANGED" },
  );
  const result = await compactTranscripts({ selections: [selection] }, async () => ({
    state: "unavailable",
    reason: "model_not_prepared",
  }));
  assert.equal(result.selections[0].complete, false);
  assert.equal(result.selections[0].reason, "model_not_prepared");
  assert.deepEqual(result.selections[0].rows, []);
});

test("consumer command reads stdin and calls only installed transcript reads", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "yap-compact-"));
  try {
    const executable = join(directory, "yap");
    await writeFile(
      executable,
      `#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(process.argv[2]!=='transcript.get')process.exit(2);console.log(JSON.stringify({ok:true,data:${JSON.stringify(sourcePage([word(0, "Hello!", 100, 200)]))}}))});`,
      { mode: 0o755 },
    );
    const child = spawn(process.execPath, ["skills/yap/scripts/compact-transcripts.mjs"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(JSON.stringify({ selections: [selection], cli: { executable } }));
    const code = await new Promise((resolve) => child.once("close", resolve));
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).selections[0].phrases[0].text, "Hello!");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gaps, inference segments and partial words split reading phrases", async () => {
  const gap = {
    type: "gap",
    reason: "not_acquired",
    sourceRange: { startUs: 200, endUs: 300 },
    partial: false,
  };
  const rows = [
    word(0, "one", 0, 100),
    gap,
    word(1, "two", 310, 400),
    word(2, "three", 410, 500, { segment: 1 }),
    word(3, "four", 510, 600, { segment: 1, partial: true }),
  ];
  const result = await compactTranscripts({ selections: [selection] }, async () =>
    sourcePage(rows),
  );
  assert.deepEqual(result.selections[0].rows, rows);
  assert.deepEqual(
    result.selections[0].phrases.map(({ text, rowIndexes }) => [text, rowIndexes]),
    [
      ["one", [0]],
      ["two", [2]],
      ["three", [3]],
      ["four", [4]],
    ],
  );
});

test("a bounded empty-page read returns its real continuation and rejects another source list", async () => {
  const cursor = opaque({ checkpointId: "checkpoint" });
  const result = await compactTranscripts(
    { selections: [{ projectId: "project" }], maxPages: 1 },
    async () => ({
      projectId: "project",
      revisionId: "revision",
      state: "ready",
      dependencies: [],
      rows: [],
      nextCursor: cursor,
    }),
  );
  assert.equal(result.limitReached, "pages");
  assert.deepEqual(result.continuation.cursor, cursor);
  await assert.rejects(
    () =>
      compactTranscripts(
        { selections: [{ projectId: "other" }], continuation: result.continuation },
        async () => {
          throw new Error("must not call");
        },
      ),
    { code: "INVALID_PARAMS" },
  );
});

test("oversized verbatim words fail explicitly instead of truncating evidence", async () => {
  await assert.rejects(
    () =>
      compactTranscripts({ selections: [selection], maxBytes: 1024, pageRows: 1 }, async () =>
        sourcePage([word(0, "large".repeat(1000), 0, 10)]),
      ),
    { code: "OUTPUT_BUDGET_EXCEEDED" },
  );
});

test("a later take that cannot fit returns the accepted prefix with a compact continuation", async () => {
  const selections = [selection, { ...selection, assetId: "take-b", label: "Take B" }];
  const result = await compactTranscripts(
    { selections, maxBytes: 1024, pageRows: 1 },
    async (_, params) => ({ ...sourcePage([word(0, "yes", 0, 100)]), assetId: params.assetId }),
  );
  assert.equal(result.selections[0].phrases[0].text, "yes");
  assert.equal(result.continuation.index, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result) + "\n") <= 1024);
});

test("exact pause threshold separates phrases before display rounding", async () => {
  const rows = [word(0, "one", 900_000, 1_000_000), word(1, "two", 1_400_000, 1_500_000)];
  const result = await compactTranscripts({ selections: [selection], pauseUs: 400_000 }, async () =>
    sourcePage(rows),
  );
  assert.deepEqual(
    result.selections[0].phrases.map(({ text }) => text),
    ["one", "two"],
  );
});

test("project occurrence coverage remains available after manifest-only continuation pages", async () => {
  const coverage = {
    manifestId: "manifest",
    occurrences: [{ clipId: "clip", available: [], unavailable: [{ startUs: 0, endUs: 100 }] }],
  };
  const repeats = repeatsFirstPage();
  const result = await compactTranscripts(
    { selections: [{ projectId: "project" }] },
    async (_, params) => {
      repeats(params);
      return {
        projectId: "project",
        revisionId: "revision",
        state: "ready",
        dependencies: [],
        coverage: params.cursor ? { manifestId: "manifest" } : coverage,
        rows: [],
        nextCursor: params.cursor ? null : opaque({ checkpointId: "checkpoint" }),
      };
    },
  );
  assert.deepEqual(result.selections[0].coverage, coverage);
});

test("reading phrases retain overlap envelopes and isolate exact instant observations", async () => {
  const rows = [
    word(0, "long", 0, 1000000),
    word(1, "short", 200000, 300000),
    word(2, "next", 800000, 900000),
    word(3, "point", 900000, 900000, { instant: true }),
    word(4, "after", 950000, 1000000),
  ];
  const result = await compactTranscripts({ selections: [selection], pauseUs: 400000 }, async () =>
    sourcePage(rows),
  );
  assert.deepEqual(result.selections[0].rows, rows);
  assert.deepEqual(
    result.selections[0].phrases.map(({ text, rowIndexes, displayRangeSeconds }) => ({
      text,
      rowIndexes,
      displayRangeSeconds,
    })),
    [
      { text: "long short next", rowIndexes: [0, 1, 2], displayRangeSeconds: [0, 1] },
      { text: "point", rowIndexes: [3], displayRangeSeconds: [0.9, 0.9] },
      { text: "after", rowIndexes: [4], displayRangeSeconds: [0.95, 1] },
    ],
  );
});
