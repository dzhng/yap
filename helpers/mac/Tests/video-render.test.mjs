import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { test, after } from "node:test";
import { renderPlan } from "../../../packages/core/dist/presentation-time.js";
import { renderFrames } from "./fixtures/render-frames.mjs";
const native =
  process.env.YAP_NATIVE ?? new URL("../.build/debug/yap-native", import.meta.url).pathname;
const evidence = process.env.YAP_VIDEO_RENDER_EVIDENCE;
const directory = evidence ?? mkdtempSync(join(tmpdir(), "yap-video-render-"));
assert.ok(isAbsolute(directory));
mkdirSync(directory, { recursive: true });
assert.deepEqual(readdirSync(directory), []);
const receipts = [];
after(() => {
  if (evidence) writeFileSync(join(directory, "report.json"), JSON.stringify(receipts, null, 2));
  else rmSync(directory, { recursive: true, force: true });
});
function run(cmd, args, input) {
  const result = spawnSync(cmd, args, {
    input,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const frames = renderFrames();
writeFileSync(join(directory, "source.rgb"), Buffer.concat(frames));
for (const [name, rate] of [
  ["dense", 30],
  ["sparse", 1],
]) {
  run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    "320x180",
    "-framerate",
    String(rate),
    "-i",
    join(directory, "source.rgb"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-bf",
    "2",
    "-video_track_timescale",
    "90000",
    "-an",
    join(directory, name + ".mov"),
  ]);
}
run("swiftc", [
  "-parse-as-library",
  new URL("RenderMembership/gap.swift", import.meta.url).pathname,
  "-o",
  join(directory, "gap-maker"),
]);
for (const kind of ["leading", "internal"]) {
  run(join(directory, "gap-maker"), [
    join(directory, "sparse.mov"),
    join(directory, kind + ".mov"),
    kind,
  ]);
}
test("presentation evidence and source grids agree on the displayed physical support", () => {
  const source = join(directory, "sparse.mov"),
    output = join(directory, "held.jsonl");
  const plan = renderPlan({ spans: [{ startUs: 750000, endUs: 1250000 }] });
  const result = JSON.parse(
    run(
      native,
      [],
      JSON.stringify({
        id: "support",
        operation: "media.presentationEvidence",
        params: { source, output, plan },
      }) + "\n",
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const [header, ...records] = readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(header.version, 1);
  assert.deepEqual(
    records.map((r) => r.actualSourceUs),
    [0, 1000000],
  );
  assert.deepEqual(
    records.map((r) => Number(r.start.value) / r.start.timescale),
    [0.75, 1],
  );
  assert.deepEqual(
    records.map((r) => Number(r.end.value) / r.end.timescale),
    [1, 1.25],
  );
  const probe = JSON.parse(
    run(
      native,
      [],
      JSON.stringify({
        id: "probe",
        operation: "media.probe",
        params: { path: source },
      }) + "\n",
    ),
  );
  assert.equal(probe.ok, true, JSON.stringify(probe));
  const selected = JSON.parse(
    run(
      native,
      [],
      JSON.stringify({
        id: "selected",
        operation: "media.sourceVisualSamples",
        params: {
          asset: {
            assetId: "fixture",
            path: source,
            originUs: probe.data.originUs,
            streamId: probe.data.streams.find((stream) => stream.kind === "video").id,
          },
          available: [{ startUs: 0, endUs: 6000000 }],
          atSourceUs: [750000, 1000000],
        },
      }) + "\n",
    ),
  );
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.deepEqual(
    selected.data.samples.map((sample) => sample.actualSourceUs),
    [0, 1000000],
  );
  assert.deepEqual(
    selected.data.samples.map((sample) => sample.rgbBase64),
    records.map((row) => row.rgbBase64),
  );
});

function supportRequest(sourceName, name, ranges) {
  const source = join(directory, sourceName + ".mov"),
    output = join(directory, name + ".jsonl");
  const plan = renderPlan({ spans: ranges.map(([startUs, endUs]) => ({ startUs, endUs })) });
  return {
    output,
    result: JSON.parse(
      run(
        native,
        [],
        JSON.stringify({
          id: name,
          operation: "media.presentationEvidence",
          params: { source, output, plan },
        }) + "\n",
      ),
    ),
  };
}
function supportRows(output) {
  return readFileSync(output, "utf8").trim().split("\n").map(JSON.parse).slice(1);
}
const seconds = (t) => Number(t.value) / t.timescale;
test("presentation evidence clips exact rational supports across cuts and empty edits", () => {
  const cut = supportRequest("dense", "support-cuts", [
    [10001, 20002],
    [33334, 100001],
  ]);
  assert.equal(cut.result.ok, true, JSON.stringify(cut.result));
  const rows = supportRows(cut.output);
  assert.deepEqual(
    rows.map((r) => r.spanIndex),
    [0, 1, 1, 1],
  );
  assert.deepEqual(
    rows.map((r) => r.actualSourceUs),
    [0, 33333, 66667, 100000],
  );
  assert.equal(seconds(rows[0].start), 0.010001);
  assert.equal(seconds(rows[0].end), 0.020002);
  assert.equal(seconds(rows[1].end), 2 / 30);
  assert.equal(seconds(rows.at(-1).end), 0.100001);
  const empty = supportRequest("internal", "support-empty", [[500000, 3500000]]);
  assert.equal(empty.result.ok, true, JSON.stringify(empty.result));
  assert.deepEqual(
    supportRows(empty.output).map((r) => [seconds(r.start), seconds(r.end), r.empty]),
    [
      [0.5, 1, false],
      [1, 3, true],
      [3, 3.5, false],
    ],
  );
  const [beforeGap, black, afterGap] = supportRows(empty.output);
  assert.notEqual(beforeGap.rgbBase64, afterGap.rgbBase64);
  assert.equal(typeof afterGap.rgbBase64, "string");
  assert.equal(black.rgbBase64, undefined);
  assert.equal(black.sampleTime, undefined);
});

test("presentation evidence refuses unsupported video tail without partial output", () => {
  run("ffmpeg", [
    "-v",
    "error",
    "-i",
    join(directory, "dense.mov"),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=400:duration=1",
    "-c:v",
    "copy",
    "-c:a",
    "pcm_f32le",
    join(directory, "unsupported.mov"),
  ]);
  const unsupported = supportRequest("unsupported", "unsupported-evidence", [[0, 500000]]);
  assert.equal(unsupported.result.ok, false);
  assert.equal(unsupported.result.error.code, "UNAVAILABLE");
  assert.match(unsupported.result.error.message, /support/);
  assert.equal(existsSync(unsupported.output), false);
  assert.ok(!readdirSync(directory).some((name) => name.startsWith(".yap-output-")));
});

test("presentation evidence memory stays bounded while streamed output grows", async () => {
  const peaks = [];
  const thumbnails = new Map();
  for (const count of [100, 5000]) {
    const source = join(directory, "dense.mov"),
      output = join(directory, `stream-${count}.jsonl`);
    const plan = renderPlan({
      spans: Array.from({ length: count }, (_, index) => ({
        startUs: index * 20,
        endUs: index * 20 + 1,
      })),
    });
    const statistics = join(directory, `memory-${count}.txt`);
    const result = JSON.parse(
      run(
        "/usr/bin/time",
        ["-l", "-o", statistics, native],
        JSON.stringify({
          id: "stream",
          operation: "media.presentationEvidence",
          params: { source, output, plan },
        }) + "\n",
      ),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.records, count);
    const peak = Number(
      readFileSync(statistics, "utf8").match(/(\d+)\s+maximum resident set size/)[1],
    );
    peaks.push(peak);
    const { createReadStream } = await import("node:fs");
    const { createInterface } = await import("node:readline");
    let ordinal = -1;
    for await (const line of createInterface({ input: createReadStream(output) })) {
      assert.ok(Buffer.byteLength(line) + 1 <= 65536);
      const row = JSON.parse(line);
      if (ordinal >= 0) {
        assert.equal(row.spanIndex, ordinal);
        assert.equal(seconds(row.start), (ordinal * 20) / 1000000);
        assert.equal(seconds(row.end), (ordinal * 20 + 1) / 1000000);
        assert.equal(row.empty, false);
        const sample = Math.floor((ordinal * 20 * 30) / 1000000);
        assert.equal(seconds(row.sampleTime), sample / 30);
        assert.equal(typeof row.rgbBase64, "string");
        if (thumbnails.has(sample)) assert.equal(row.rgbBase64, thumbnails.get(sample));
        else thumbnails.set(sample, row.rgbBase64);
      }
      ordinal++;
    }
    assert.equal(ordinal, count);
    receipts.push({
      name: `support-stream-${count}`,
      receipt: { ...result.data, file: `stream-${count}.jsonl` },
      peakResidentBytes: peak,
    });
  }
  assert.equal(new Set(thumbnails.values()).size, 3, "each source frame has distinct pixels");
  // Retaining the ~46 MB large result would exceed this allowance; decoder/startup
  // variation gets 24 MB while the output grows fiftyfold.
  assert.ok(peaks[1] - peaks[0] < 24 * 1024 * 1024, JSON.stringify(peaks));
});
