import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: false });
const worker = new URL("../.build/debug/yap-native", import.meta.url).pathname;
const tests = new URL("../.build/debug/YapSelectedAudioTests", import.meta.url).pathname;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { passed: false, workerSha256: hash(readFileSync(worker)), cases: [], repeated: [] };
try {
  for (const name of ["first", "repeat"]) {
    const run = spawnSync(tests, [], {
      env: { ...process.env, YAP_SELECTED_AUDIO_EVIDENCE: join(out, name) },
      encoding: "utf8",
      timeout: 60000,
    });
    writeFileSync(join(out, `${name}.log`), run.stdout + run.stderr);
    assert.equal(run.status, 0, run.stderr || String(run.error));
  }
  for (const name of readdirSync(join(out, "first")).filter((n) => n.endsWith(".wav"))) {
    const bytes = readFileSync(join(out, "first", name));
    assert.deepEqual(bytes, readFileSync(join(out, "repeat", name)));
    report.repeated.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const [name, source, sampleRate, channels, error] of [
    ["mono", "count-44100-8193.wav", 24000, 1, null],
    ["stereo", "count-44100-8193.wav", 24000, 2, null],
    ["truncated", "truncated.wav", 24000, 1, "NATIVE_DECODE_FAILED"],
    ["zero", "zero-quota.wav", 24000, 1, "INVALID_REQUEST"],
  ]) {
    const request = {
      id: name,
      operation: "media.convertSelectedAudio",
      params: {
        source: join(out, "first", source),
        output: join(out, `${name}.wav`),
        sampleRate,
        channels,
      },
    };
    const run = spawnSync(worker, [], {
      input: JSON.stringify(request) + "\n",
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    const response = JSON.parse(run.stdout);
    report.cases.push({ request, response });
    if (error) {
      assert.equal(response.ok, false);
      assert.equal(response.error.code, error);
    } else {
      assert.equal(response.ok, true, run.stdout);
      assert.deepEqual(response.data.input, { sampleRate: 44100, channels: 1, frames: 8193 });
      assert.deepEqual(response.data.output, {
        sampleRate,
        channels,
        frames: Math.floor((8193 * sampleRate) / 44100),
      });
      assert.equal(response.data.implementationId, "native-finite-pcm-v2");
      if (name === "mono")
        assert.deepEqual(
          readFileSync(request.params.output),
          readFileSync(join(out, "first", "result-44100-8193-24000.wav")),
        );
    }
  }
  report.passed = true;
} finally {
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    passed: report.passed,
    repeatedWavs: report.repeated.length,
    wireCases: report.cases.length,
  }),
);
