import { speechExecution } from "../../../packages/core/dist/transcript.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { retryable } from "./refusal.mjs";

const executable =
  process.env.YAP_NATIVE ?? fileURLToPath(new URL("../.build/debug/yap-native", import.meta.url));

// Stand-in model files: the worker checks bytes and digests, not what they mean, so none of these
// requests needs the real model. Nested paths exercise the directory walk.
const modelContents = {
  "Preprocessor.mlmodelc/coremldata.bin": "preprocessor",
  "Encoder.mlmodelc/coremldata.bin": "encoder",
  "Encoder.mlmodelc/weights/weight.bin": "encoder weights",
  "Decoder.mlmodelc/coremldata.bin": "decoder",
  "JointDecision.mlmodelc/coremldata.bin": "joint",
  "parakeet_vocab.json": "{}",
};

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "yap-speech-wire-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, "models", "parakeet-tdt-0.6b-v2");
  const files = Object.entries(modelContents).map(([path, content]) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
    return {
      path,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const attempt = join(home, "evidence", "transcript", "attempt");
  mkdirSync(attempt, { recursive: true });
  const params = {
    execution: speechExecution(),
    models: { directory, files },
    track: {
      source: join(home, "source", "narration.mov"),
      sourceOffsetUs: 0,
      available: [{ startUs: 0, endUs: 1000000 }],
    },
    output: join(attempt, "raw.jsonl"),
  };
  return { home, directory, attempt, params };
}

function transcribe(...requests) {
  const result = spawnSync(executable, [], {
    input:
      requests
        .map((params, index) =>
          JSON.stringify({ id: String(index), operation: "speech.transcribe", params }),
        )
        .join("\n") + "\n",
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, requests.length);
  return replies;
}

/// Every file under `root`, with contents, so a refused request can be shown to have changed none.
function snapshot(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [relative(root, path), entry.isFile() ? readFileSync(path, "utf8") : "link"];
    })
    .sort();
}

function tone(path, seconds) {
  mkdirSync(dirname(path), { recursive: true });
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      "-c:a",
      "pcm_f32le",
      path,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr);
}

test("malformed, relative and unsafe requests are refused before models are read", (t) => {
  const { home, params } = fixture(t);
  const before = snapshot(home);
  const { models, track } = params;
  const withFile = (change) => ({
    ...params,
    models: { ...models, files: models.files.map((file, index) => (index ? file : change(file))) },
  });
  const cases = [
    { ...params, extra: true },
    { ...params, models: { ...models, extra: true } },
    withFile((file) => ({ ...file, extra: true })),
    { ...params, track: { ...track, available: [{ startUs: 0, endUs: 1000, extra: true }] } },
    { models, track },
    { ...params, track: { ...track, role: "system" } },
    { ...params, track: { ...track, role: "narration" } },
    { ...params, track: { ...track, role: null } },
    { ...params, models: { ...models, directory: "models/parakeet-tdt-0.6b-v2" } },
    { ...params, track: { ...track, source: "narration.mov" } },
    { ...params, output: "raw.jsonl" },
    withFile((file) => ({ ...file, path: "../outside.bin" })),
    withFile((file) => ({ ...file, path: "/etc/hosts" })),
    withFile((file) => ({ ...file, path: "Encoder.mlmodelc//coremldata.bin" })),
    withFile((file) => ({ ...file, path: "./parakeet_vocab.json" })),
    withFile((file) => ({ ...file, sha256: file.sha256.toUpperCase() })),
    { ...params, models: { ...models, files: [...models.files, models.files[0]] } },
    // FluidAudio resolves its folder by name beside the directory it is given.
    { ...params, models: { ...models, directory: join(home, "models", "parakeet") } },
    // A list that omits a component would let the engine read a file nobody pinned.
    {
      ...params,
      models: { ...models, files: models.files.filter((file) => !file.path.startsWith("Encoder")) },
    },
  ];
  const replies = transcribe(...cases);
  for (const [index, reply] of replies.entries()) {
    assert.equal(reply.ok, false, `case ${index}`);
    assert.equal(reply.error.code, "INVALID_REQUEST", `case ${index}: ${reply.error.message}`);
    assert.equal(retryable(reply.error), false, `case ${index}`);
  }
  assert.deepEqual(snapshot(home), before);
});

test("absent model files are unavailable and changed ones invalid, before any load", (t) => {
  const { home, directory, attempt, params } = fixture(t);
  const missingDirectory = join(home, "absent", "parakeet-tdt-0.6b-v2");
  const cases = [
    [
      "MODEL_UNAVAILABLE",
      () => ({ ...params, models: { ...params.models, directory: missingDirectory } }),
    ],
    ["MODEL_UNAVAILABLE", () => rmSync(join(directory, "Encoder.mlmodelc/weights/weight.bin"))],
    [
      "MODEL_INVALID",
      () => writeFileSync(join(directory, "Decoder.mlmodelc/coremldata.bin"), "decodex"),
    ],
    [
      "MODEL_INVALID",
      () => writeFileSync(join(directory, "Decoder.mlmodelc/coremldata.bin"), "longer decoder"),
    ],
    ["MODEL_INVALID", () => writeFileSync(join(directory, "Decoder.mlmodelc/extra.bin"), "")],
    [
      "MODEL_INVALID",
      () => {
        const target = join(home, "elsewhere.json");
        writeFileSync(target, "{}");
        rmSync(join(directory, "parakeet_vocab.json"));
        symlinkSync(target, join(directory, "parakeet_vocab.json"));
      },
    ],
  ];
  for (const [code, arrange] of cases) {
    rmSync(directory, { recursive: true, force: true });
    rmSync(join(home, "elsewhere.json"), { force: true });
    for (const file of params.models.files) {
      mkdirSync(dirname(join(directory, file.path)), { recursive: true });
      writeFileSync(join(directory, file.path), modelContents[file.path]);
    }
    const request = arrange() ?? params;
    const before = snapshot(home);
    const [reply] = transcribe(request);
    assert.equal(reply.ok, false, code);
    assert.equal(reply.error.code, code, reply.error.message);
    assert.equal(retryable(reply.error), true);
    // Nothing was created or repaired: no output, no staging, no model folder, no download.
    assert.deepEqual(snapshot(home), before, reply.error.message);
    assert.deepEqual(readdirSync(attempt), []);
    assert.equal(existsSync(dirname(missingDirectory)), false);
  }
});

test("verified models still refuse an occupied output and report unreadable narration", (t) => {
  const { attempt, params } = fixture(t);
  tone(params.track.source, 0.1);
  writeFileSync(params.output, "earlier");
  const [occupied, unreadable] = transcribe(params, {
    ...params,
    output: join(attempt, "other.jsonl"),
    track: { ...params.track, source: join(attempt, "absent.mov") },
  });
  assert.equal(occupied.error.code, "INVALID_OUTPUT", occupied.error.message);
  assert.equal(readFileSync(params.output, "utf8"), "earlier");
  assert.equal(unreadable.error.code, "MEDIA_UNAVAILABLE", unreadable.error.message);
  assert.equal("retryable" in unreadable.error, false);
  assert.deepEqual(readdirSync(attempt), ["raw.jsonl"]);
});

test("only readable narration becomes segments, and a fragment too short is skipped unread by the engine", (t) => {
  const { attempt, params } = fixture(t);
  tone(params.track.source, 1);
  // The file holds one second starting 0.25 s into the recording. Acquisition claims time the file
  // never covered, and a short stretch at the end; neither may become transcribed silence.
  const track = {
    ...params.track,
    sourceOffsetUs: 250000,
    available: [
      { startUs: 0, endUs: 400000 },
      { startUs: 2000000, endUs: 3000000 },
    ],
  };
  const [reply] = transcribe({ ...params, track });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  const readable = { startUs: 250000, endUs: 400000 };
  assert.deepEqual(reply.data.segments, [
    {
      ordinal: 0,
      source: readable,
      owned: readable,
      state: "skipped",
      reason: "too_short",
      wordCount: 0,
    },
  ]);
  assert.equal(reply.data.wordCount, 0);
  assert.deepEqual(reply.data.engine, {
    runtime: "FluidAudio",
    runtimeVersion: "0.15.7",
    decoder: "parakeet-tdt-batch",
    encoderPrecision: "int8",
    computeUnits: "cpuAndNeuralEngine",
  });
  assert.ok(Number.isSafeInteger(reply.data.details.peakResidentBytes));

  const raw = readFileSync(params.output);
  assert.deepEqual(reply.data.output, {
    file: params.output,
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
  const lines = raw.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  // 150 ms read at the engine's 16 kHz, never padded up to its minimum.
  assert.deepEqual(lines, [
    {
      ordinal: 0,
      source: readable,
      owned: readable,
      state: "skipped",
      reason: "too_short",
      sampleRate: 16000,
      samples: 2400,
      words: [],
      observations: [],
      selectedObservationIndexes: [],
      issues: [],
    },
  ]);
  assert.deepEqual(readdirSync(attempt), ["raw.jsonl"]);

  const [again] = transcribe({ ...params, track });
  assert.equal(again.error.code, "INVALID_OUTPUT");
  assert.deepEqual(readFileSync(params.output), raw);
});

test("a verified model that cannot load fails retryably and is left exactly as it was", (t) => {
  const { home, directory, attempt, params } = fixture(t);
  tone(params.track.source, 1);
  const before = snapshot(directory);
  const offline = ["-p", "(version 1)(allow default)(deny network*)", executable];
  const result = spawnSync("/usr/bin/sandbox-exec", offline, {
    input: JSON.stringify({ id: "load", operation: "speech.transcribe", params }) + "\n",
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const [line, ...rest] = result.stdout.split("\n");
  assert.deepEqual(rest, [""], "Nothing but the response reaches standard output");
  const reply = JSON.parse(line);
  assert.equal(reply.error.code, "TRANSCRIPTION_FAILED", reply.error.message);
  assert.equal(retryable(reply.error), true);
  // FluidAudio would purge and download a model that failed to load; the worker forbids both.
  assert.deepEqual(snapshot(directory), before);
  assert.deepEqual(readdirSync(attempt), []);
  assert.deepEqual(readdirSync(join(home, "models")), ["parakeet-tdt-0.6b-v2"]);
});

test("selected audio streams stay distinct and an omitted ambiguous selection is refused", (t) => {
  const { home, params } = fixture(t);
  const source = join(home, "two-streams.mov");
  const made = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=0.1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=44100:duration=0.15",
      "-map",
      "0:a",
      "-map",
      "1:a",
      "-c:a",
      "pcm_s16le",
      source,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(made.status, 0, made.stderr);
  const selected = (streamId, name) => ({
    ...params,
    track: { ...params.track, source, ...(streamId ? { streamId } : {}) },
    output: join(home, `${name}.jsonl`),
  });
  const [first, second, ambiguous, absent] = transcribe(
    selected("track:1", "first"),
    selected("track:2", "second"),
    selected(undefined, "ambiguous"),
    selected("track:99", "absent"),
  );
  for (const [reply, endUs, samples] of [
    [first, 100000, 1600],
    [second, 150000, 2400],
  ]) {
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.data.segments, [
      {
        ordinal: 0,
        source: { startUs: 0, endUs },
        owned: { startUs: 0, endUs },
        state: "skipped",
        reason: "too_short",
        wordCount: 0,
      },
    ]);
    assert.equal(JSON.parse(readFileSync(reply.data.output.file, "utf8")).samples, samples);
  }
  assert.equal(ambiguous.ok, false, JSON.stringify(ambiguous));
  assert.equal(ambiguous.error.code, "INVALID_REQUEST");
  assert.equal(absent.ok, false, JSON.stringify(absent));
  assert.equal(absent.error.code, "NATIVE_DECODE_FAILED");
  assert.equal(existsSync(join(home, "ambiguous.jsonl")), false);
  assert.equal(existsSync(join(home, "absent.jsonl")), false);
});
