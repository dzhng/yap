import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, stat, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Models } from "../../core/dist/models.js";
import { Catalog } from "../../core/dist/catalog.js";
import { voiceRenderer } from "../../../apps/service/dist/voice.js";
import { mediaWorker } from "../../../apps/service/dist/worker.js";
const { values } = parseArgs({
  options: Object.fromEntries(
    ["out", "model-home", "native", "case"].map((x) => [x, { type: "string" }]),
  ),
});
for (const key of ["out", "model-home", "native"]) assert(values[key], `Missing --${key}`);
assert(
  !values.case || ["reference-lifetime", "lifetime"].includes(values.case),
  "Unknown focused case",
);
const out = resolve(values.out);
await mkdir(out, { mode: 0o700 });
const workspace = join(out, "workspace");
const root = new URL("../../../", import.meta.url).pathname;
const frozen = join(root, "specs/done/agent-editing/assets/18-voice");
const cases = JSON.parse(
  await readFile(join(root, "packages/test-harness/editing/voice/cases.json")),
);
const modelHome = resolve(values["model-home"]);
const models = new Models(
  modelHome,
  globalThis.fetch,
  undefined,
  new Catalog(join(modelHome, "catalog.sqlite")),
);
const preparation = await models.runtime("qwen3-tts-icl-v1", "voice");
const native = mediaWorker({ YAP_NATIVE: resolve(values.native) });
const run = voiceRenderer(native, models, "qwen3-tts-icl-v1", workspace);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const request = (name) => ({
  reference: join(frozen, "reference.wav"),
  referenceText: cases.reference.text,
  text: cases.replacements[0].text,
  generation: cases.generation,
  seed: String(cases.seed),
  output: join(out, `${name}.wav`),
});
const report = {
  passed: false,
  checks: [],
  scope: "Registered entry parity; no public job, managed-origin or listening acceptance",
  case: values.case ?? "all",
  preparation,
};
async function empty() {
  assert.deepEqual(await readdir(workspace), []);
}
async function refusal(label, execute, code) {
  let error;
  try {
    await execute();
  } catch (e) {
    error = e;
  }
  assert.equal(error?.code, code, `${label}: ${error}`);
  await empty();
  report.checks.push({ label, code, details: error.details });
  return error;
}
const previousPythonPath = process.env.PYTHONPATH;
const shadow = join(out, "shadow");
await mkdir(shadow);
await writeFile(
  join(shadow, "mlx_audio.py"),
  'raise RuntimeError("unprepared ambient module was imported")\n',
);
process.env.PYTHONPATH = shadow;
try {
  if (!values.case) {
    for (const replacement of cases.replacements) {
      const q = { ...request(replacement.id), text: replacement.text };
      const result = await run(q, new AbortController().signal);
      const actual = await readFile(q.output),
        expected = await readFile(join(frozen, `same-take-${replacement.id}.wav`));
      assert.deepEqual(actual, expected);
      await empty();
      report.checks.push({
        label: replacement.id,
        exactWAVAndPCM: true,
        ignoresAmbientPythonPath: true,
        sha256: digest(actual),
        receipt: result,
      });
    }
    // Identical intelligible audio at budgets11/12 has different completion truth.
    for (const budget of [1, 11]) {
      const q = {
        ...request(`cap-${budget}`),
        generation: { ...cases.generation, max_tokens: budget },
      };
      const capped = await refusal(
        `token budget ${budget}`,
        () => run(q, new AbortController().signal),
        "VOICE_INCOMPLETE",
      );
      assert.equal(capped.details.stopReason, "token-budget");
      assert.equal(capped.details.generatedTokens, budget);
      await assert.rejects(stat(q.output), { code: "ENOENT" });
    }
    const boundary = {
      ...request("eos-boundary"),
      generation: { ...cases.generation, max_tokens: 12 },
    };
    const boundaryReceipt = await run(boundary, new AbortController().signal);
    assert.equal(boundaryReceipt.stopReason, "eos");
    assert.equal(boundaryReceipt.generatedTokens, 11);
    assert.deepEqual(
      await readFile(boundary.output),
      await readFile(join(frozen, "same-take-word.wav")),
    );
    report.checks.push({
      label: "EOS at final permitted iteration",
      receipt: boundaryReceipt,
      exactWAVAndPCM: true,
    });
    for (const generation of [{ top_p: -1 }, { repetition_penalty: 1e308 }, { speed: 1 }])
      await refusal(
        "unsupported numeric or ignored control",
        () => run({ ...request("invalid-control"), generation }, new AbortController().signal),
        "INVALID_REQUEST",
      );
    const overText = {
      ...request("over-text"),
      text: "This sentence exceeds the measured input budget. ".repeat(200),
    };
    await refusal(
      "actual target token budget",
      () => run(overText, new AbortController().signal),
      "LIMIT_EXCEEDED",
    );
    await assert.rejects(stat(overText.output), { code: "ENOENT" });
    const replay = [];
    for (const id of ["changed-seed", "changed-seed-replay"]) {
      const q = {
        ...request(id),
        text: "Okay, so this is the recorder workbench.",
        seed: "19",
        generation: { repetition_penalty: 1.5 },
      };
      const receipt = await run(q, new AbortController().signal);
      replay.push(await readFile(q.output));
      report.checks.push({ label: id, receipt, sha256: digest(replay.at(-1)) });
    }
    assert.deepEqual(replay[0], replay[1]);
    const filteredOracle = execFileSync("/usr/bin/tar", [
      "-xOf",
      join(root, "specs/done/agent-editing/assets/19d-voice-settings/evidence.tar.xz"),
      "yap-19d-controls/top-p.wav",
    ]);
    assert.equal(
      digest(filteredOracle),
      "f313e12e99228f2c7385beeb8f09c022e297829acfff6eaebf1f5635ba4c0692",
    );
    for (const id of ["filtered", "filtered-replay"]) {
      const q = {
        ...request(id),
        text: "Okay, so this is the recorder workbench.",
        generation: { top_p: 0.8 },
      };
      const receipt = await run(q, new AbortController().signal);
      const actual = await readFile(q.output);
      assert.deepEqual(actual, filteredOracle);
      report.checks.push({ label: id, exactOldWAVAndPCM: true, sha256: digest(actual), receipt });
    }
    const smallest = {
      ...request("smallest-positive-top-p"),
      text: "Okay, so this is the recorder workbench.",
      generation: { top_p: Number.MIN_VALUE, top_k: 0 },
    };
    const smallestReceipt = await run(smallest, new AbortController().signal);
    assert.equal(smallestReceipt.filterModes.nucleus, "enabled");
    assert.equal(smallestReceipt.generation.top_p, Number.MIN_VALUE);
    report.checks.push({
      label: "smallest positive top-p admitted and completed",
      receipt: smallestReceipt,
      sha256: digest(await readFile(smallest.output)),
    });

    await refusal(
      "preexisting destination",
      () => run(request("word"), new AbortController().signal),
      "INVALID_REQUEST",
    );
    const same = { ...request("collision"), output: join(frozen, "reference.wav") };
    const before = digest(await readFile(same.output));
    await refusal(
      "input/output collision",
      () => run(same, new AbortController().signal),
      "INVALID_REQUEST",
    );
    assert.equal(digest(await readFile(same.output)), before);
    for (const [label, path, bytes] of [
      ["missing runtime", preparation.python, null],
      ["wrong runtime", preparation.python, Buffer.from("wrong executable")],
      ["missing model", join(preparation.model, ".gitattributes"), null],
      [
        "mismatched model bytes",
        join(preparation.model, ".gitattributes"),
        Buffer.from("changed bytes"),
      ],
    ]) {
      const backup = join(out, `${label.replaceAll(" ", "-")}-backup`);
      await rename(path, backup);
      try {
        if (bytes) await writeFile(path, bytes);
        await refusal(
          label,
          () => run(request(label.replaceAll(" ", "-")), new AbortController().signal),
          "MODEL_NOT_PREPARED",
        );
      } finally {
        await rm(path, { force: true });
        await rename(backup, path);
      }
    }
  }
  if (values.case !== "lifetime") {
    const unsupported = join(out, "unsupported.wav");
    const unsupportedBytes = Buffer.from(await readFile(join(frozen, "reference.wav")));
    let formatPosition = 12;
    while (unsupportedBytes.subarray(formatPosition, formatPosition + 4).toString() !== "fmt ")
      formatPosition +=
        8 +
        unsupportedBytes.readUInt32LE(formatPosition + 4) +
        (unsupportedBytes.readUInt32LE(formatPosition + 4) % 2);
    unsupportedBytes.writeUInt32LE(48000, formatPosition + 12);
    unsupportedBytes.writeUInt32LE(48000 * 4, formatPosition + 16);
    await writeFile(unsupported, unsupportedBytes);
    await refusal(
      "unsupported reference rate",
      () =>
        run(
          { ...request("unsupported-output"), reference: unsupported },
          new AbortController().signal,
        ),
      "INVALID_REFERENCE",
    );
    const invalid = join(out, "invalid.wav");
    await writeFile(invalid, "not a WAV");
    await refusal(
      "malformed reference",
      () => run({ ...request("malformed"), reference: invalid }, new AbortController().signal),
      "INVALID_REFERENCE",
    );
    const long = join(out, "too-long.wav");
    await writeFile(long, await readFile(join(frozen, "reference.wav")));
    // Preserve valid Float32 WAV while exceeding the registered twenty-second frame budget.
    const longBytes = await readFile(long);
    const extraBytes = (480001 - 120000) * 4;
    longBytes.writeUInt32LE(longBytes.readUInt32LE(4) + extraBytes, 4);
    let p = 12;
    while (longBytes.subarray(p, p + 4).toString() !== "data")
      p += 8 + longBytes.readUInt32LE(p + 4) + (longBytes.readUInt32LE(p + 4) % 2);
    longBytes.writeUInt32LE(longBytes.readUInt32LE(p + 4) + extraBytes, p + 4);
    await writeFile(long, Buffer.concat([longBytes, Buffer.alloc(extraBytes)]));
    await refusal(
      "reference exceeds measured frames",
      () => run({ ...request("long"), reference: long }, new AbortController().signal),
      "INVALID_REFERENCE",
    );
  }
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const mode of ["cancel", "deadline"]) {
    const requestAt = performance.now();
    let settled;
    const controller = new AbortController();
    const pending = run(request(mode), controller.signal, mode === "deadline" ? 10000 : 600000)
      .then(
        () => ({ unexpected: true }),
        (error) => ({ error }),
      )
      .then((result) => {
        settled = result;
        return result;
      });
    try {
      let pid;
      const end = Date.now() + 8000;
      while (Date.now() < end) {
        assert(
          !settled,
          `${mode}: execution ended before staged output: ${settled?.error?.code}: ${settled?.error?.message}`,
        );
        const dirs = await readdir(workspace);
        if (
          dirs.length &&
          (await stat(join(workspace, dirs[0], "audio.wav")).then(
            () => true,
            () => false,
          ))
        ) {
          const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
            encoding: "utf8",
          }).split("\n");
          const row = rows.find(
            (s) =>
              s.includes(preparation.entry) && Number(s.trim().split(/\s+/)[1]) === process.pid,
          );
          if (row) {
            pid = Number(row.trim().split(/\s+/)[0]);
            break;
          }
        }
        await delay(10);
      }
      assert(pid, `${mode}: worker did not reach partial output`);
      const markerMs = performance.now() - requestAt;
      process.kill(pid, "SIGSTOP");
      const interruptedAt = performance.now();
      if (mode === "cancel") controller.abort();
      const result = await pending;
      const settlementMs = performance.now() - interruptedAt;
      assert.equal(result.error?.code, mode === "cancel" ? "CANCELED" : "MEDIA_WORKER_TIMEOUT");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await empty();
      report.checks.push({
        label: mode,
        pid,
        partialOutput: true,
        setupToMarkerMs: markerMs,
        interruptionToSettlementMs: settlementMs,
        closedBeforeReturn: true,
        code: result.error.code,
      });
    } finally {
      controller.abort();
      await pending;
    }
  }
  report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = previousPythonPath;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
