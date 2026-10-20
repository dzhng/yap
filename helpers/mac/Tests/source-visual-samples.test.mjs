import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const native =
  process.env.YAP_NATIVE ?? fileURLToPath(new URL("../.build/debug/yap-native", import.meta.url));
function run(file, args, options = {}) {
  const r = spawnSync(file, args, { timeout: 30000, ...options });
  assert.equal(r.status, 0, String(r.stderr || r.error));
  return r.stdout;
}
test("selected scene grids retain exact clocks and reset across physical and acquisition sub-grid holes", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-scenes-"));
  try {
    for (const [name, color] of [
      ["a", "red"],
      ["b", "green"],
    ])
      run("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=64x48:r=10:d=1`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        join(dir, name + ".mov"),
      ]);
    run("swiftc", [
      "-parse-as-library",
      fileURLToPath(new URL("SourceFrame/fixture.swift", import.meta.url)),
      "-o",
      join(dir, "fixture"),
    ]);
    run(join(dir, "fixture"), [
      join(dir, "a.mov"),
      join(dir, "b.mov"),
      join(dir, "source.mov"),
      "50000",
    ]);
    const base = {
      asset: {
        assetId: "fixture",
        streamId: "track:1",
        path: join(dir, "source.mov"),
        originUs: 1250000,
      },
      available: [{ startUs: 0, endUs: 850000 }],
      atSourceUs: [100000, 300000, 500000, 700000],
    };
    const call = (changes = {}) =>
      JSON.parse(
        run(native, [], {
          input:
            JSON.stringify({
              id: "sample",
              operation: "media.sourceVisualSamples",
              params: { ...base, ...changes },
            }) + "\n",
          encoding: "utf8",
        }),
      );
    const first = call();
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.data.readerOpens, 1);
    assert.ok(first.data.decodedSamples <= 10);
    assert.deepEqual(
      first.data.samples.map((s) => [s.requestedSourceUs, s.status, s.continuousFromPrevious]),
      [
        [100000, "available", false],
        [300000, "available", true],
        [500000, "available", false],
        [700000, "available", true],
      ],
    );
    const sample = first.data.samples[0];
    assert.equal(sample.actualSourceUs, 100000);
    assert.equal(
      BigInt(sample.sample.value) * 1000000n,
      1350000n * BigInt(sample.sample.timescale),
    );
    assert.equal(
      BigInt(sample.sample.endValue) * 1000000n,
      1450000n * BigInt(sample.sample.endTimescale),
    );
    const second = call({ asset: { ...base.asset, streamId: "track:2" } });
    assert.equal(second.ok, true);
    assert.notEqual(second.data.samples[0].rgbBase64, sample.rgbBase64);
    const acquired = call({
      atSourceUs: [100000, 300000],
      available: [
        { startUs: 0, endUs: 150000 },
        { startUs: 250000, endUs: 850000 },
      ],
    });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.data.samples[1].continuousFromPrevious, false);
    const touching = call({
      atSourceUs: [100000, 300000],
      available: [
        { startUs: 0, endUs: 150000 },
        { startUs: 150000, endUs: 850000 },
      ],
    });
    assert.equal(touching.ok, true);
    assert.equal(touching.data.samples[1].continuousFromPrevious, true);
    const gap = call({ atSourceUs: [399999, 400000, 449999, 450000] });
    assert.equal(gap.ok, true, JSON.stringify(gap));
    assert.deepEqual(
      gap.data.samples.map((s) => [s.status, s.reason ?? null, s.continuousFromPrevious]),
      [
        ["available", null, false],
        ["unavailable", "empty_edit", false],
        ["unavailable", "empty_edit", false],
        ["available", null, false],
      ],
    );
    const excluded = call({
      atSourceUs: [100000, 200000, 300000],
      available: [
        { startUs: 0, endUs: 200000 },
        { startUs: 300000, endUs: 850000 },
      ],
    });
    assert.equal(excluded.ok, true);
    assert.deepEqual(excluded.data.samples[1], {
      requestedSourceUs: 200000,
      status: "unavailable",
      reason: "outside_support",
      continuousFromPrevious: false,
    });
    assert.equal(excluded.data.samples[2].continuousFromPrevious, false);
    for (const changes of [
      { atSourceUs: [100000, 100000] },
      { atSourceUs: Array.from({ length: 53 }, (_, i) => i) },
      { atSourceUs: [0, 10200001] },
      { asset: { ...base.asset, streamId: "track:404" } },
    ])
      assert.equal(call(changes).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selected scene grids deliver all 52 clean color samples within inspection bounds", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "source-scenes-bounds-"));
  try {
    const source = join(dir, "source.mov");
    run("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:size=160x90:rate=10:duration=11",
      "-an",
      "-c:v",
      "libx264",
      source,
    ]);
    const before = readFileSync(source);
    const params = {
      asset: { assetId: "fixture", streamId: "track:1", path: source, originUs: 0 },
      available: [{ startUs: 0, endUs: 11000000 }],
      atSourceUs: Array.from({ length: 52 }, (_, index) => index * 200000),
    };
    const start = performance.now();
    const result = spawnSync("/usr/bin/time", ["-l", native], {
      input: JSON.stringify({ id: "grid", operation: "media.sourceVisualSamples", params }) + "\n",
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const elapsedMs = performance.now() - start;
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const data = reply.data;
    assert.deepEqual([data.sourceWidth, data.sourceHeight], [160, 90]);
    assert.equal(data.samples.length, 52);
    for (const [index, sample] of data.samples.entries()) {
      assert.equal(sample.status, "available");
      assert.equal(sample.requestedSourceUs, index * 200000);
      assert.equal(sample.actualSourceUs, index * 200000);
      assert.equal(sample.continuousFromPrevious, index > 0);
      assert.deepEqual([sample.width, sample.height], [64, 36]);
      const rgb = Buffer.from(sample.rgbBase64, "base64");
      assert.equal(rgb.length, 64 * 36 * 3);
      for (let offset = 0; offset < rgb.length; offset += 3)
        assert.ok(
          rgb[offset] > 220 && rgb[offset + 1] < 60 && rgb[offset + 2] < 40,
          `sample ${index}, pixel ${offset / 3}: expected clean sRGB red`,
        );
    }
    const rss = Number(result.stderr.match(/(\d+)\s+maximum resident set size/)?.[1]);
    assert.ok(Number.isFinite(rss));
    assert.ok(rss < 256 * 1024 * 1024, `peak RSS ${rss}`);
    assert.ok(elapsedMs < 30000);
    assert.ok(Buffer.byteLength(result.stdout) < 8 * 1024 * 1024);
    assert.deepEqual(readFileSync(source), before);
    assert.deepEqual(readdirSync(dir), ["source.mov"]);
    t.diagnostic(
      `52 source samples: ${elapsedMs.toFixed(1)}ms, ${rss} peak RSS bytes, ${Buffer.byteLength(result.stdout)} response bytes`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "visual observations traverse more than 100,000 physical samples in one take",
  { timeout: 120_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "source-visual-long-"));
    try {
      const source = join(dir, "long.mov");
      run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-f",
          "lavfi",
          "-i",
          "color=s=16x16:r=10000",
          "-frames:v",
          "100002",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-g",
          "300000",
          "-pix_fmt",
          "yuv420p",
          source,
        ],
        { timeout: 60_000 },
      );
      const endUs = 10_000_200;
      const response = JSON.parse(
        run(native, [], {
          input:
            JSON.stringify({
              id: "long",
              operation: "media.sourceVisualSamples",
              params: {
                asset: { assetId: "long", streamId: "track:1", path: source, originUs: 0 },
                available: [{ startUs: 0, endUs }],
                atSourceUs: [0, 10_000_100],
              },
            }) + "\n",
          encoding: "utf8",
          timeout: 60_000,
        }),
      );
      assert.equal(response.ok, true, JSON.stringify(response));
      assert.deepEqual(
        response.data.samples.map((sample) => sample.status),
        ["available", "available"],
      );
      assert.ok(response.data.decodedSamples > 100_000, JSON.stringify(response.data));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
