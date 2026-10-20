import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  openSync,
  closeSync,
  fstatSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const native =
  process.env.YAP_NATIVE ?? fileURLToPath(new URL("../.build/debug/yap-native", import.meta.url));
const frames = 257;
const range = { start: 480, end: 480 + frames };
function wave(values) {
  const b = Buffer.alloc(44 + values.length * 4);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(384000, 28);
  b.writeUInt16LE(8, 32);
  b.writeUInt16LE(32, 34);
  b.write("data", 36);
  b.writeUInt32LE(values.length * 4, 40);
  values.forEach((v, i) => b.writeFloatLE(v, 44 + i * 4));
  return b;
}
function pcm(path) {
  const bytes = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString("ascii", offset, offset + 4) === "data")
      return bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw Error("WAV has no data");
}
test("declared audio prefixes and held spans preserve signed PCM, ordered steps and absolute clocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "audio-state-seam-"));
  const input = join(dir, "input.wav");
  const values = Array.from({ length: frames * 2 }, (_, i) => ((i % 17) - 8) / 32);
  writeFileSync(input, wave(values));
  const fd = openSync(input, "r");
  const info = fstatSync(fd, { bigint: true });
  const limiter = { type: "limiter", ceilingDbfs: -3, lookaheadMs: 5, releaseMs: 50 };
  const normalization = {
    type: "normalization",
    mode: "gain-only",
    targetIntegratedLufs: -20,
    truePeakCeilingDbtp: -2,
    maxLoudnessRangeLu: 7,
  };
  const target = { kind: "output" };
  const processor = (id, p) => ({ id, enabled: true, processor: p });
  const node = {
    target,
    mediaKind: "output",
    inputs: [],
    steps: [
      processor("limit", { ...limiter, active: [range] }),
      processor("upstream-gain", { type: "gain", gain: 2 }),
      processor("normalize", { ...normalization, active: [range] }),
      processor("downstream-gain", { type: "gain", gain: 0.25 }),
    ],
  };
  const domains = [
    {
      recipe: limiter,
      sampleRange: range,
      dependencies: [],
      members: [{ target, stepId: "limit", sampleRange: range }],
    },
    {
      recipe: normalization,
      sampleRange: range,
      dependencies: [0],
      members: [{ target, stepId: "normalize", sampleRange: range }],
    },
  ];
  let ordinal = 0;
  const execute = (operation, extra, held) => {
    const output = join(dir, `output-${ordinal++}.wav`);
    const params = {
      output,
      statePreparationImplementationId: "native-audio-state-domains-v1",
      range,
      clips: [],
      processing: [node],
      assets: [],
      state: {
        implementationId:
          "rnnoise-70f1d256-d6021b7697677c4d2274c912975e143765552b0e6f25500aa660fdb4a9849be5-f480-s32768-flush2-delay960-independent-channels-v2",
        clips: [],
        processing: [node],
        domains,
        formats: [],
      },
      held,
      ...extra,
    };
    writeFileSync(join(dir, `request-${ordinal}.json`), JSON.stringify(params, null, 2));
    const r = spawnSync(native, [], {
      input: JSON.stringify({ id: "seam", operation, params }) + "\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe", fd],
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stderr || String(r.error));
    writeFileSync(join(dir, `reply-${ordinal}.json`), r.stdout);
    return { reply: JSON.parse(r.stdout), output };
  };
  const held = {
    domainIndex: 0,
    recipe: limiter,
    sampleRange: range,
    sampleRate: 48000,
    channels: 2,
    pcm: {
      descriptor: 3,
      identity: {
        device: String(info.dev),
        inode: String(info.ino),
        modifiedNs: String(info.mtimeNs),
        changedNs: String(info.ctimeNs),
      },
      bytes: Number(info.size),
      dataOffset: 44,
      frames,
      range: { start: 0, end: frames },
      unavailable: [],
    },
  };
  let passed = false;
  try {
    const prefix = execute(
      "media.prepareCompositionAudioDomain",
      { domainIndex: 1, input: "program" },
      [held],
    );
    const expected = wave(values.map((v) => v * 2)).subarray(44);
    writeFileSync(join(dir, "expected-prefix.f32"), expected);
    assert.equal(prefix.reply.ok, true, JSON.stringify(prefix.reply));
    assert.deepEqual(pcm(prefix.output), expected);
    for (const bad of [
      [],
      [held, held],
      [{ ...held, recipe: { ...limiter, releaseMs: 70 } }],
      [{ ...held, sampleRange: { ...range, start: range.start + 1 } }],
      [{ ...held, pcm: { ...held.pcm, frames: frames + 1 } }],
      [{ ...held, pcm: { ...held.pcm, identity: { ...held.pcm.identity, inode: "0" } } }],
    ]) {
      const result = execute(
        "media.prepareCompositionAudioDomain",
        { domainIndex: 1, input: "program" },
        bad,
      );
      assert.equal(result.reply.ok, false, JSON.stringify(result.reply));
    }
    const wrongImplementation = execute(
      "media.prepareCompositionAudioDomain",
      { domainIndex: 1, input: "program", statePreparationImplementationId: "unknown" },
      [held],
    );
    assert.equal(wrongImplementation.reply.ok, false, JSON.stringify(wrongImplementation.reply));
    assert.equal(wrongImplementation.reply.error.code, "PINNED_IMPLEMENTATION_UNAVAILABLE");
    const missingImplementation = execute(
      "media.prepareCompositionAudioDomain",
      { domainIndex: 1, input: "program", statePreparationImplementationId: undefined },
      [held],
    );
    assert.equal(
      missingImplementation.reply.ok,
      false,
      JSON.stringify(missingImplementation.reply),
    );
    assert.equal(missingImplementation.reply.error.code, "INTERNAL_ERROR");
    const final = execute("media.mixCompositionAudio", {}, [
      held,
      { ...held, domainIndex: 1, recipe: normalization },
    ]);
    const expectedFinal = wave(values.map((v) => v * 0.25)).subarray(44);
    writeFileSync(join(dir, "expected-final.f32"), expectedFinal);
    assert.equal(final.reply.ok, true, JSON.stringify(final.reply));
    assert.deepEqual(pcm(final.output), expectedFinal);
    passed = true;
  } finally {
    closeSync(fd);
    if (passed) rmSync(dir, { recursive: true, force: true });
    else process.stderr.write(`Unverified seam operands retained: ${dir}\n`);
  }
});
