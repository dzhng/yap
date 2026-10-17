import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync, truncateSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const native =
  process.env.YAP_NATIVE ?? fileURLToPath(new URL("../.build/debug/yap-native", import.meta.url));
const fixture =
  process.env.YAP_SOURCE_AUDIO_FIXTURE ??
  fileURLToPath(new URL("../.build/debug/YapSourceAudioTests", import.meta.url));
test("source WAV wire delivery retains native fixture samples and refuses ambiguous selection", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-audio-wire-"));
  try {
    const proof = spawnSync(fixture, ["--wire-fixtures"], {
      env: { ...process.env, YAP_SOURCE_AUDIO_EVIDENCE: directory },
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    assert.match(proof.stdout, /Wire fixtures ready/);
    for (const rate of [44100, 48000]) {
      const params = JSON.parse(readFileSync(join(directory, `request-${rate}.json`), "utf8"));
      const execute = (value) => {
        const result = spawnSync(native, [], {
          input:
            JSON.stringify({ id: "source", operation: "media.sourceAudio", params: value }) + "\n",
          encoding: "utf8",
          timeout: 30000,
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      };
      const reply = execute(params);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.data.sampleRate, rate);
      assert.equal(reply.data.channels, 2);
      assert.equal(reply.data.layout, "stereo");
      assert.equal(reply.data.frames, rate);
      assert.deepEqual(reply.data.sampleRange, { start: 0, end: rate });
      assert.deepEqual(
        readFileSync(params.output),
        readFileSync(join(directory, `full-${rate}.wav`)),
      );
      const touching = structuredClone(params);
      touching.output = join(directory, `touching-${rate}.wav`);
      touching.source.available = params.source.available.flatMap(({ startUs, endUs }) => {
        const seam = startUs + Math.floor((endUs - startUs) / 2);
        return [
          { startUs, endUs: seam },
          { startUs: seam, endUs },
        ];
      });
      const joined = execute(touching);
      assert.equal(joined.ok, true, JSON.stringify(joined));
      assert.deepEqual(joined.data, { ...reply.data, file: touching.output });
      assert.deepEqual(readFileSync(touching.output), readFileSync(params.output));
      const overlap = structuredClone(touching);
      overlap.output = join(directory, `overlap-${rate}.wav`);
      overlap.source.available[1].startUs--;
      assert.equal(execute(overlap).error.code, "INVALID_RANGE");
      const hole = structuredClone(touching);
      hole.output = join(directory, `hole-${rate}.wav`);
      hole.source.available[1].startUs++;
      const missing = execute(hole);
      assert.equal(missing.ok, true, JSON.stringify(missing));
      assert.ok(
        missing.data.unavailable.some(
          (span) =>
            span.startUs === touching.source.available[0].endUs &&
            span.endUs === touching.source.available[0].endUs + 1,
        ),
        "A real one-microsecond gap must remain unavailable",
      );
      assert.equal(execute(params).error.code, "INVALID_OUTPUT");
      const ambiguous = structuredClone(params);
      delete ambiguous.source.streamId;
      ambiguous.output = join(directory, `ambiguous-${rate}.wav`);
      assert.equal(execute(ambiguous).error.code, "INVALID_REQUEST");
      assert.equal(execute({ ...params, unexpected: true }).error.code, "INVALID_REQUEST");
    }
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith(".yap-output-")),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("AAC terminal windows decode bounded real packet context and truncated sources fail cleanly", () => {
  const directory = mkdtempSync(join(tmpdir(), "source-audio-tail-"));
  const execute = (source, range, output) => {
    const result = spawnSync(native, [], {
      input:
        JSON.stringify({
          id: "tail",
          operation: "media.sourceAudio",
          params: {
            source: { source, sourceOffsetUs: 0, available: [{ startUs: 0, endUs: 32000000 }] },
            range,
            output,
          },
        }) + "\n",
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return JSON.parse(result.stdout);
  };
  try {
    const source = join(directory, "silence.m4a");
    const encode = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        "32",
        "-c:a",
        "aac",
        "-b:a",
        "32k",
        source,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(encode.status, 0, encode.stderr);
    const original = readFileSync(source);
    for (const wanted of [1, 2, 1024, 2048, 2049]) {
      const first = 32 * 48000 - wanted;
      const range = {
        startUs: Number((BigInt(first) * 1000000n + 47999n) / 48000n),
        endUs: 32000000,
      };
      const output = join(directory, `tail-${wanted}.wav`);
      const result = execute(source, range, output);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.frames, wanted);
      assert.deepEqual(result.data.sampleRange, { start: first, end: 32 * 48000 });
      assert.ok(
        result.data.decodedFrames <= 8192,
        "Terminal query must not decode the source prefix",
      );
      const bytes = readFileSync(output);
      let pcm;
      for (let at = 12; at + 8 <= bytes.length;) {
        const size = bytes.readUInt32LE(at + 4);
        if (bytes.toString("ascii", at, at + 4) === "data") {
          pcm = bytes.subarray(at + 8, at + 8 + size);
          break;
        }
        at += 8 + size + (size % 2);
      }
      assert.equal(pcm?.length, wanted * 8);
      assert.ok(pcm.every((value) => value === 0));
    }
    assert.ok(original.equals(readFileSync(source)));
    const broken = join(directory, "truncated.mov"),
      output = join(directory, "incomplete.wav");
    const make = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000:duration=2",
        "-c:a",
        "pcm_f32le",
        "-movflags",
        "faststart",
        broken,
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(make.status, 0, make.stderr);
    truncateSync(broken, readFileSync(broken).length - 5000);
    const before = readFileSync(broken);
    const refused = execute(broken, { startUs: 0, endUs: 2000000 }, output);
    assert.equal(refused.error.code, "NATIVE_DECODE_FAILED");
    assert.equal(existsSync(output), false);
    assert.ok(!readdirSync(directory).some((name) => name.startsWith(".yap-output-")));
    assert.ok(before.equals(readFileSync(broken)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
