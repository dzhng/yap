import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  appendFileSync,
  existsSync,
  symlinkSync,
  linkSync,
  readdirSync,
  truncateSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { journalGoldenCases, exportJournalGolden } from "./fixtures/journal-goldens.mjs";
import { retryable } from "./refusal.mjs";
const executable =
  process.env.YAP_NATIVE ?? new URL("../.build/debug/yap-native", import.meta.url).pathname;

for (const entry of journalGoldenCases)
  test(`historical normalized bytes and receipt: ${entry.name}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "journal-golden-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { bytes, receipt } = exportJournalGolden(executable, entry, root);
    assert.deepEqual(
      bytes,
      gunzipSync(readFileSync(new URL(`${entry.name}.jsonl.gz`, entry.goldens))),
    );
    assert.deepEqual(
      receipt,
      JSON.parse(readFileSync(new URL(`${entry.name}.receipt.json`, entry.goldens))),
    );
  });
function request(directory, output, extra = {}) {
  const result = spawnSync(executable, [], {
    input:
      JSON.stringify({
        id: "evidence",
        operation: "media.sourceEvidence",
        params: { directory, output, ...extra },
      }) + "\n",
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function fixture(t, records, prefix = join(tmpdir(), "cursor-evidence-")) {
  const root = mkdtempSync(prefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "source");
  mkdirSync(directory);
  const header = {
    schemaVersion: 1,
    sessionID: "fixture",
    source: { kind: "display", displayID: 1 },
    width: 100,
    height: 80,
    microphone: false,
    systemAudio: false,
  };
  const text =
    [{ event: "header", data: header }, ...records]
      .map((r, i) => JSON.stringify({ sequence: i + 1, ...r }))
      .join("\n") + "\n";
  const journal = join(directory, "capture.journal.jsonl");
  writeFileSync(journal, text);
  return { root, directory, journal, text, output: join(root, "evidence.jsonl") };
}

test("worker exports display-space observations and preserves source", (t) => {
  const f = fixture(t, [
    { event: "displaySpace", data: { hostUs: 123, zeroOriginHeight: 900 } },
    { event: "finished", data: {} },
  ]);
  const r = request(f.directory, f.output);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.finished, true);
  assert.equal(r.data.displaySpaces, 1);
  assert.equal(r.data.markEvents, 0);
  assert.deepEqual(readFileSync(f.output, "utf8").trim().split("\n").map(JSON.parse), [
    { event: "displaySpace", data: { hostUs: 123, zeroOriginHeight: 900 } },
  ]);
  assert.equal(readFileSync(f.journal, "utf8"), f.text);
});
test("receipt preserves the requested output locator across macOS temporary-directory aliases", (t) => {
  const f = fixture(
    t,
    [
      { event: "displaySpace", data: { hostUs: 123, zeroOriginHeight: 900 } },
      { event: "finished", data: {} },
    ],
    "/tmp/source-locator-",
  );
  const canonical = realpathSync(f.root);
  assert.ok(canonical.startsWith("/private/tmp/"));
  let sequence = 0;
  for (const sourceRoot of [f.root, canonical])
    for (const outputRoot of [f.root, canonical]) {
      const output = join(outputRoot, `evidence-${sequence++}.jsonl`);
      const result = request(join(sourceRoot, "source"), output);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.file, output);
      assert.equal(result.data.bytes, readFileSync(output).length);
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
        event: "displaySpace",
        data: { hostUs: 123, zeroOriginHeight: 900 },
      });
    }
});
const sample = {
  sourceUs: 22,
  x: -3,
  y: 9,
  globalX: 100,
  globalY: 200,
  buttons: 1,
  eligibility: "outside",
  geometryEpoch: 1,
};
const geometry = {
  epoch: 1,
  hostUs: 100,
  sourceUs: 0,
  geometry: {
    outputWidth: 100,
    outputHeight: 80,
    contentRect: { x: 0, y: 0, width: 100, height: 80 },
    contentScale: 1,
    scaleFactor: 1,
  },
};
test("samples preserve raw values and geometry ordering across batches", (t) => {
  const f = fixture(t, [
    { event: "geometry", data: geometry },
    { event: "cursorSamples", data: { samples: [sample, { ...sample, sourceUs: 33 }] } },
    { event: "geometry", data: { ...geometry, epoch: 2 } },
    { event: "cursorSamples", data: { samples: [{ ...sample, sourceUs: 44, geometryEpoch: 2 }] } },
  ]);
  const r = request(f.directory, f.output);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = readFileSync(f.output, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows, [
    { event: "geometry", data: geometry },
    { event: "cursorSample", data: sample },
    { event: "cursorSample", data: { ...sample, sourceUs: 33 } },
    { event: "geometry", data: { ...geometry, epoch: 2 } },
    { event: "cursorSample", data: { ...sample, sourceUs: 44, geometryEpoch: 2 } },
  ]);
  assert.equal(r.data.firstCursorSourceUs, 22);
  assert.equal(r.data.lastCursorSourceUs, 44);
  assert.equal(r.data.geometryRecords, 2);
  assert.equal(r.data.cursorSamples, 3);
});

test("corrupt and incomplete tails retain only observed prefix with explicit markers", (t) => {
  for (const [tail, incompleteTail, invalidAtSequence] of [
    ["{", true, undefined],
    ["x".repeat(1_048_577), false, 3],
    ["{bad}\n", false, 3],
  ]) {
    const f = fixture(t, [{ event: "cursorSamples", data: { samples: [sample] } }]);
    appendFileSync(f.journal, tail);
    const before = readFileSync(f.journal);
    const r = request(f.directory, f.output);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.incompleteTail, incompleteTail);
    assert.equal(r.data.invalidAtSequence, invalidAtSequence);
    assert.equal(r.data.lastSequence, 2);
    assert.equal(r.data.finished, false);
    assert.deepEqual(JSON.parse(readFileSync(f.output, "utf8")), {
      event: "cursorSample",
      data: sample,
    });
    assert.deepEqual(readFileSync(f.journal), before);
  }
});
test("existing paths, links, source descendants and invalid requests never mutate source", (t) => {
  const f = fixture(t, []);
  const existing = join(f.root, "existing");
  writeFileSync(existing, "keep");
  const hard = join(f.root, "hard");
  linkSync(f.journal, hard);
  const symbolic = join(f.root, "symbolic");
  symlinkSync(f.journal, symbolic);
  const dangling = join(f.root, "dangling");
  symlinkSync(join(f.root, "absent"), dangling);
  const alias = join(f.root, "source-alias");
  symlinkSync(f.directory, alias);
  for (const output of [
    existing,
    hard,
    symbolic,
    dangling,
    f.directory,
    f.journal,
    join(f.directory, "new"),
    join(alias, "new"),
  ]) {
    const r = request(f.directory, output);
    assert.equal(r.ok, false, output);
    assert.equal(r.error.code, "INVALID_OUTPUT");
  }
  for (const [directory, output, extra] of [
    [f.directory, "relative", {}],
    [f.directory, f.output, { unexpected: 1 }],
    [f.directory + "\0suffix", f.output, {}],
  ]) {
    assert.equal(request(directory, output, extra).error.code, "INVALID_REQUEST");
  }
  assert.equal(readFileSync(existing, "utf8"), "keep");
  assert.equal(readFileSync(f.journal, "utf8"), f.text);
  assert.equal(existsSync(f.output), false);
  assert.equal(existsSync(join(f.directory, "new")), false);
  assert.equal(
    readdirSync(f.root).some((p) => p.startsWith(".yap-output-")),
    false,
  );
});
test("large journal streams individual samples through the real worker with a small receipt", (t) => {
  const f = fixture(t, []);
  const batches = 2000,
    batchSize = 60;
  for (let batch = 0; batch < batches; batch++)
    appendFileSync(
      f.journal,
      JSON.stringify({
        sequence: batch + 2,
        event: "cursorSamples",
        data: {
          samples: Array.from({ length: batchSize }, (_, i) => ({
            ...sample,
            sourceUs: batch * batchSize + i,
          })),
        },
      }) + "\n",
    );
  const r = request(f.directory, f.output);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.cursorSamples, batches * batchSize);
  assert.equal(r.data.lastCursorSourceUs, batches * batchSize - 1);
  assert.ok(JSON.stringify(r).length < 2048);
  const rows = readFileSync(f.output, "utf8").trim().split("\n");
  assert.equal(rows.length, batches * batchSize);
  assert.deepEqual(JSON.parse(rows.at(-1)), {
    event: "cursorSample",
    data: { ...sample, sourceUs: batches * batchSize - 1 },
  });
});
test("budget and malformed-header failures publish nothing and clean staging", (t) => {
  const f = fixture(t, []);
  truncateSync(f.journal, 268435457);
  assert.equal(request(f.directory, f.output).error.code, "EVIDENCE_LIMIT");
  const oversized = JSON.parse(f.text);
  oversized.data.sessionID = "s".repeat(17000);
  writeFileSync(f.journal, JSON.stringify(oversized) + "\n");
  assert.equal(request(f.directory, f.output).error.code, "EVIDENCE_LIMIT");
  writeFileSync(f.journal, "{bad}\n");
  assert.equal(request(f.directory, f.output).error.code, "INVALID_JOURNAL");
  assert.equal(existsSync(f.output), false);
  assert.deepEqual(readdirSync(f.root), ["source"]);
});

test("interleaved audio merges per role, preserves gaps and completed pauses", (t) => {
  const audio = (role, startUs, endUs) => ({
    event: "audioSamples",
    data: { role, startUs, endUs },
  });
  const f = fixture(t, [
    audio("narration", 0, 10),
    audio("system", 2, 5),
    audio("narration", 11, 20),
    audio("system", 4, 8),
    { event: "pauseBegan", data: { hostUs: 100 } },
    { event: "pauseEnded", data: { hostUs: 400, pause: { atSourceUs: 20, elapsedPauseUs: 300 } } },
    audio("narration", 25, 30),
    audio("system", 12, 15),
    { event: "pauseBegan", data: { hostUs: 500 } },
  ]);
  const r = request(f.directory, f.output);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.pauseEvents, 1);
  assert.equal(r.data.audioIntervals, 4);
  assert.equal(r.data.openPauseHostUs, 500);
  assert.equal(r.data.pauses, undefined);
  assert.equal(r.data.acquiredAudio, undefined);
  assert.deepEqual(readFileSync(f.output, "utf8").trim().split("\n").map(JSON.parse), [
    { event: "pause", data: { atSourceUs: 20, elapsedPauseUs: 300 } },
    { event: "audioAcquired", data: { role: "narration", startUs: 0, endUs: 20 } },
    { event: "audioAcquired", data: { role: "system", startUs: 2, endUs: 8 } },
    { event: "audioAcquired", data: { role: "narration", startUs: 25, endUs: 30 } },
    { event: "audioAcquired", data: { role: "system", startUs: 12, endUs: 15 } },
  ]);
  assert.equal(readFileSync(f.journal, "utf8"), f.text);
});

test("timing evidence flushes trusted audio at corrupt or unfinished pause tails", (t) => {
  for (const tail of ["{", "{bad}\n"]) {
    const f = fixture(t, [
      { event: "audioSamples", data: { role: "narration", startUs: 0, endUs: 10 } },
      { event: "pauseBegan", data: { hostUs: 100 } },
    ]);
    appendFileSync(f.journal, tail);
    const r = request(f.directory, f.output);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.pauseEvents, 0);
    assert.equal(r.data.audioIntervals, 1);
    assert.equal(r.data.openPauseHostUs, 100);
    assert.equal(r.data.lastSequence, 3);
    assert.equal(r.data.incompleteTail, tail === "{");
    assert.equal(r.data.invalidAtSequence, tail === "{" ? undefined : 4);
    assert.deepEqual(JSON.parse(readFileSync(f.output, "utf8")), {
      event: "audioAcquired",
      data: { role: "narration", startUs: 0, endUs: 10 },
    });
  }
});

test("invalid timing record stops before emitting or clearing observed pause", (t) => {
  for (const record of [
    { event: "audioSamples", data: { role: "other", startUs: 0, endUs: 10 } },
    { event: "audioSamples", data: { role: "system", startUs: 10, endUs: 10 } },
    { event: "pauseEnded", data: { hostUs: 300, pause: { atSourceUs: 0, elapsedPauseUs: -1 } } },
    { event: "pausePlaced", data: { atSourceUs: -1, elapsedPauseUs: 10 } },
    { event: "pausePlaced", data: { atSourceUs: 0, elapsedPauseUs: -1 } },
  ]) {
    const f = fixture(t, [{ event: "pauseBegan", data: { hostUs: 100 } }, record]);
    const r = request(f.directory, f.output);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.data.invalidAtSequence, 3);
    assert.equal(r.data.openPauseHostUs, 100);
    assert.equal(r.data.pauseEvents, 0);
    assert.equal(r.data.audioIntervals, 0);
    assert.equal(readFileSync(f.output, "utf8"), "");
  }
});

for (const timing of ["audio gaps", "deferred pauses"])
  test(`many ${timing} stream with bounded worker memory and a constant-size receipt`, (t) => {
    const f = fixture(t, []);
    const count = 100_000;
    for (let base = 0; base < count; base += 1000) {
      appendFileSync(
        f.journal,
        Array.from({ length: 1000 }, (_, offset) => {
          const i = base + offset;
          return JSON.stringify({
            sequence: i + 2,
            event: timing === "audio gaps" ? "audioSamples" : "pausePlaced",
            data:
              timing === "audio gaps"
                ? { role: i % 2 ? "system" : "narration", startUs: i * 10, endUs: i * 10 + 5 }
                : { atSourceUs: i * 10, elapsedPauseUs: 5 },
          });
        }).join("\n") + "\n",
      );
    }
    const result = spawnSync("/usr/bin/time", ["-l", executable], {
      input:
        JSON.stringify({
          id: "timing-memory",
          operation: "media.sourceEvidence",
          params: { directory: f.directory, output: f.output },
        }) + "\n",
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true, result.stdout);
    assert.equal(response.data[timing === "audio gaps" ? "audioIntervals" : "pauseEvents"], count);
    assert.ok(result.stdout.length < 2048);
    const maximumRss = Number(result.stderr.match(/(\d+)\s+maximum resident set size/)[1]);
    assert.ok(maximumRss < 128 * 1024 * 1024, `worker RSS ${maximumRss}`);
    t.diagnostic(`100,000 ${timing}: peak worker RSS ${maximumRss} bytes`);
    const lines = readFileSync(f.output, "utf8").trim().split("\n");
    assert.equal(lines.length, count);
    if (timing === "deferred pauses") {
      assert.deepEqual(JSON.parse(lines[0]), {
        event: "pause",
        data: { atSourceUs: 0, elapsedPauseUs: 5 },
      });
      assert.deepEqual(JSON.parse(lines.at(-1)), {
        event: "pause",
        data: { atSourceUs: (count - 1) * 10, elapsedPauseUs: 5 },
      });
    }
  });

test("terminal provenance preserves the recorded capture endpoint, independently of untimed lifecycle", (t) => {
  for (const state of ["complete", "interrupted"]) {
    const failure =
      state === "interrupted" ? { code: "DEVICE_LOST", message: "fixture failure" } : null;
    const f = fixture(t, [
      { event: "origin", data: { hostUs: 1000000 } },
      { event: "audioSamples", data: { role: "narration", startUs: 100, endUs: 300 } },
      { event: "cursorSamples", data: { samples: [sample] } },
      { event: "finished", data: { state, durationUs: 700, failure } },
      { event: "lifecycle", data: { state, reason: failure?.code ?? null } },
    ]);
    const result = request(f.directory, f.output);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.data.completion, {
      sequence: 5,
      state,
      durationUs: 700,
      ...(failure ? { failureCode: failure.code, failureMessage: failure.message } : {}),
    });
    assert.deepEqual(result.data.lastLifecycle, {
      state,
      ...(failure ? { reason: failure.code } : {}),
    });
    assert.equal(result.data.finished, true);
    assert.equal(result.data.lastSequence, 6);
    assert.equal(readFileSync(f.journal, "utf8"), f.text);
    const expected = [
      { data: sample, event: "cursorSample" },
      { data: { endUs: 300, role: "narration", startUs: 100 }, event: "audioAcquired" },
    ];
    assert.deepEqual(readFileSync(f.output, "utf8").trim().split("\n").map(JSON.parse), expected);
  }
});

test("long historical diagnostics retain their journal prefix and bound only disclosure", (t) => {
  const message = "lost input ".repeat(600);
  const f = fixture(t, [
    {
      event: "finished",
      data: { state: "interrupted", durationUs: 0, failure: { code: "DEVICE_LOST", message } },
    },
  ]);
  const result = request(f.directory, f.output);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.normalizationVersion, 2);
  assert.equal(result.data.lastSequence, 2);
  assert.equal(result.data.invalidAtSequence, undefined);
  assert.equal(result.data.completion.failureMessage, message.slice(0, 4096));
  assert.equal(readFileSync(f.journal, "utf8"), f.text);
});

test("missing or partial completion never fabricates a timed interruption", (t) => {
  for (const records of [
    [],
    [{ event: "finished", data: {} }],
    [{ event: "finished", data: { state: "interrupted" } }],
  ]) {
    const f = fixture(t, [
      { event: "lifecycle", data: { state: "interrupted", reason: "DEVICE_LOST" } },
      ...records,
    ]);
    const result = request(f.directory, f.output);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.data.lastLifecycle, { state: "interrupted", reason: "DEVICE_LOST" });
    assert.equal(result.data.completion, undefined);
    assert.equal(result.data.finished, records.length > 0);
  }
});

test("invalid terminal payloads stop at the trustworthy prefix", (t) => {
  for (const data of [
    { state: "recording", durationUs: 700 },
    { state: "complete", durationUs: -1 },
    { state: "complete", durationUs: "700" },
    { durationUs: 700 },
    { state: "interrupted", durationUs: 700, failure: { code: 1 } },
    { state: "complete", durationUs: 700, failure: { code: "CONTRADICTION" } },
  ]) {
    const f = fixture(t, [
      { event: "cursorSamples", data: { samples: [sample] } },
      { event: "finished", data },
      { event: "lifecycle", data: { state: "complete" } },
    ]);
    const result = request(f.directory, f.output);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.invalidAtSequence, 3);
    assert.equal(result.data.lastSequence, 2);
    assert.equal(result.data.finished, false);
    assert.equal(result.data.completion, undefined);
    assert.equal(result.data.lastLifecycle, undefined);
    assert.deepEqual(JSON.parse(readFileSync(f.output, "utf8")), {
      event: "cursorSample",
      data: sample,
    });
  }
});

test("torn and corrupt suffixes retain only an already recorded completion", (t) => {
  for (const completed of [false, true])
    for (const tail of ["{", "{bad}\n"]) {
      const f = fixture(
        t,
        completed
          ? [
              {
                event: "finished",
                data: { state: "interrupted", durationUs: 700, failure: { code: "DEVICE_LOST" } },
              },
            ]
          : [],
      );
      appendFileSync(f.journal, tail);
      const result = request(f.directory, f.output);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.finished, completed);
      assert.equal(result.data.completion?.durationUs, completed ? 700 : undefined);
      assert.equal(result.data.incompleteTail, tail === "{");
      assert.equal(result.data.invalidAtSequence, tail === "{" ? undefined : completed ? 3 : 2);
    }
});

test("lifecycle provenance shares the bounded receipt budget and refuses publication", (t) => {
  const f = fixture(t, [
    { event: "lifecycle", data: { state: "interrupted", reason: "x".repeat(17000) } },
  ]);
  const result = request(f.directory, f.output);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "EVIDENCE_LIMIT");
  assert.equal(existsSync(f.output), false);
  assert.equal(readFileSync(f.journal, "utf8"), f.text);
});

test("source evidence retries actual journal access failures without changing source", (t) => {
  const f = fixture(t, []);
  const before = readFileSync(f.journal);
  for (const path of [f.journal, f.directory]) {
    chmodSync(path, 0);
    let denied;
    try {
      denied = request(f.directory, f.output);
    } finally {
      chmodSync(path, path === f.directory ? 0o700 : 0o600);
    }
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "JOURNAL_UNAVAILABLE", JSON.stringify(denied));
    assert.equal(retryable(denied.error), true);
    assert.equal(existsSync(f.output), false);
  }
  assert.equal(request(f.directory, f.output).ok, true);
  assert.deepEqual(readFileSync(f.journal), before);
});

test("a linked journal is invalid input rather than an operational retry", (t) => {
  const f = fixture(t, []);
  const original = join(f.root, "original.jsonl");
  writeFileSync(original, f.text);
  rmSync(f.journal);
  symlinkSync(original, f.journal);
  const refused = request(f.directory, f.output);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "INVALID_JOURNAL");
  assert.equal(retryable(refused.error), false);
  assert.equal(readFileSync(original, "utf8"), f.text);
  assert.equal(existsSync(f.output), false);
});
