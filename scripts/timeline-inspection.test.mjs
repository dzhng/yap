import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { inspectTimeline } from "../skills/yap/scripts/timeline-inspection.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=",
  "base64",
);

test("a pinned project sheet retains repeated occurrences, exact fragments, channel clocks and cut evidence", async () => {
  const calls = [];
  const range = { startUs: 100001, endUs: 300001 };
  const rows = [
    {
      type: "word",
      text: "again",
      clipId: "first",
      trackId: "audio",
      generation: "g",
      sourceRange: { startUs: 1, endUs: 20 },
      fragments: [
        {
          project: { startUs: { numerator: 400005, denominator: 4 }, endUs: 120001 },
          source: { startUs: 1, endUs: 20 },
        },
      ],
    },
    {
      type: "word",
      text: "again",
      clipId: "second",
      trackId: "audio",
      generation: "g",
      sourceRange: { startUs: 1, endUs: 20 },
      fragments: [
        { project: { startUs: 200001, endUs: 220001 }, source: { startUs: 1, endUs: 20 } },
      ],
    },
    {
      type: "gap",
      clipId: "second",
      sourceRange: { startUs: 20, endUs: 30 },
      fragments: [
        { project: { startUs: 220001, endUs: 230001 }, source: { startUs: 20, endUs: 30 } },
      ],
    },
  ];
  const cut = {
    kind: "cut",
    projectAtUs: { numerator: 800005, denominator: 4 },
    mediaKind: "audio",
    trackId: "audio",
    before: { clipId: "first" },
    after: { clipId: "second" },
  };
  const waveform = {
    domain: "project",
    projectId: "p",
    revisionId: "r",
    range,
    sampleRate: 48000,
    channels: 2,
    sampleRange: { start: 4801, end: 14401 },
    unavailable: [{ clipId: "second", ranges: [{ start: 10561, end: 11041 }] }],
    buckets: [
      {
        sampleRange: { start: 4801, end: 6000 },
        partial: true,
        channels: [
          { min: -0.2, max: 0.4, rms: 0.1 },
          { min: -0.6, max: 0.1, rms: 0.2 },
        ],
      },
    ],
    audio: { jobId: "audio", generation: 1 },
  };
  const invoke = async (operation, params) => {
    calls.push({ operation, params });
    if (operation === "revision.get")
      return { projectId: "p", revision: { id: "r", document: {} } };
    assert.equal(params.revisionId, "r");
    if (operation === "frame.batch")
      return {
        projectId: "p",
        revisionId: "r",
        items: params.atUs.map((atUs) => ({
          atUs,
          ok: true,
          data: {
            projectId: "p",
            revisionId: "r",
            state: "ready",
            output: "picture",
            published: {
              generation: 1,
              output: {
                frame: { sampleAtUs: 100000, visibleRange: { startUs: 100000, endUs: 133333 } },
                decodedSamples: 1,
                readerOpens: 1,
                width: 1,
                height: 1,
              },
            },
          },
        })),
      };
    if (operation === "waveform.get")
      return {
        projectId: "p",
        revisionId: "r",
        state: "ready",
        output: "waveform",
        published: { generation: 1, output: { mediaType: "application/json", ...waveform } },
      };
    if (operation === "transcript.get") {
      return {
        projectId: "p",
        revisionId: "r",
        state: "ready",
        rows,
        nextCursor: null,
        transcript: { source: { durationUs: range.endUs } },
      };
    }
    assert.equal(operation, "timeline.events");
    return {
      projectId: "p",
      revisionId: "r",
      state: "ready",
      coverage: { cut: { state: "ready" } },
      rows: [cut],
      nextCursor: null,
    };
  };
  const output = await inspectTimeline(
    { target: { projectId: "p" }, range, frames: 2, maxWords: 8, maxBuckets: 16 },
    invoke,
    {
      readOutput: async (path) =>
        path === "picture" ? png : Buffer.from(JSON.stringify(waveform)),
    },
  );
  assert.deepEqual(output.manifest.identity, { projectId: "p", revisionId: "r" });
  assert.deepEqual(output.manifest.transcripts.selections[0].rows, rows);
  assert.deepEqual(output.manifest.events.rows, [cut]);
  assert.deepEqual(output.manifest.waveform.measurements, waveform);
  assert.deepEqual(output.manifest.frames[0].data.published.output.frame.visibleRange, {
    startUs: 100000,
    endUs: 133333,
  });
  assert.match(output.svg, /Channel 1/);
  assert.match(output.svg, /Channel 2/);
  assert.match(output.svg, /first/);
  assert.match(output.svg, /second/);
  assert.match(output.svg, /gap/);
  assert.equal(calls.filter((c) => c.operation === "frame.batch")[0].params.atUs.length, 2);
  assert.ok(calls.find((c) => c.operation === "waveform.get").params.bucketFrames > 1);
});

test("source selection keeps VFR sample evidence and unavailable pictures without guessing an audio stream", async () => {
  const calls = [];
  const sample = { value: "1", timescale: 30, endValue: "3", endTimescale: 30, originUs: 0 };
  const invoke = async (operation, params) => {
    calls.push(operation);
    if (operation === "asset.get")
      return {
        id: "asset",
        streams: [
          { id: "video", kind: "video" },
          { id: "audio", kind: "audio", sampleRate: 44100 },
        ],
      };
    if (operation === "frame.batch")
      return {
        assetId: "asset",
        streamId: "video",
        items: [
          {
            atUs: params.atUs[0],
            ok: true,
            data: {
              state: "ready",
              output: "picture",
              published: {
                generation: 1,
                output: {
                  requestedSourceUs: params.atUs[0],
                  actualSourceUs: 33333,
                  sample,
                  width: 1,
                  height: 1,
                  decodedSamples: 1,
                  readerOpens: 1,
                },
              },
            },
          },
          {
            atUs: params.atUs[1],
            ok: true,
            data: { state: "unavailable", reason: "empty_edit", published: null },
          },
        ],
      };
    assert.equal(operation, "timeline.events");
    assert.equal(params.sourceRange.startUs, 40001);
    return {
      state: "ready",
      context: {
        coverage: [
          { kind: "scene", state: "ready" },
          { kind: "pause", state: "unavailable", reason: "capture_context_missing" },
        ],
      },
      rows: [],
      nextCursor: null,
    };
  };
  const output = await inspectTimeline(
    {
      target: { assetId: "asset", videoStreamId: "video" },
      range: { startUs: 40001, endUs: 250001 },
      frames: 2,
    },
    invoke,
    { readOutput: async () => png },
  );
  assert.deepEqual(output.manifest.frames[0].data.published.output.sample, sample);
  assert.equal(output.manifest.frames[1].data.state, "unavailable");
  assert.match(output.svg, /decoded 0.033 s/);
  assert.match(output.svg, /unavailable/);
  assert.deepEqual(calls, ["asset.get", "frame.batch", "timeline.events"]);
});

test("event pagination stops at the total row budget and preserves its opaque continuation", async () => {
  const cursor = "opaque-owner-continuation";
  let pages = 0;
  const invoke = async (operation, params) => {
    if (operation === "asset.get") return { id: "asset", streams: [] };
    assert.equal(operation, "timeline.events");
    pages++;
    return {
      state: "ready",
      rows: Array.from({ length: params.limit }, (_, i) => ({
        kind: "scene",
        sourceAtUs: 10 + i,
      })),
      nextCursor: cursor,
    };
  };
  const output = await inspectTimeline(
    {
      target: { assetId: "asset", videoStreamId: "video" },
      range: { startUs: 0, endUs: 1000 },
      frames: 0,
      maxEvents: 2,
      maxEventPages: 3,
    },
    invoke,
  );
  assert.equal(pages, 1);
  assert.deepEqual(output.manifest.events.rows, [
    { kind: "scene", sourceAtUs: 10 },
    { kind: "scene", sourceAtUs: 11 },
  ]);
  assert.deepEqual(output.manifest.events.nextCursor, cursor);
});

test("pending event evidence retains dependency failure identities for an explicit caller retry", async () => {
  const dependency = {
    selection: { assetId: "asset", streamId: "video" },
    state: "failed",
    reason: "native_failure",
    retryable: true,
    jobId: "scene-job",
  };
  const invoke = async (operation) => {
    if (operation === "revision.get") return { projectId: "p", revision: { id: "r" } };
    if (operation === "waveform.get" || operation === "transcript.get")
      return { projectId: "p", revisionId: "r", state: "unavailable", reason: "no_audio" };
    assert.equal(operation, "timeline.events");
    return {
      projectId: "p",
      revisionId: "r",
      state: "queued",
      reason: "source_evidence_not_ready",
      retryable: true,
      dependencies: [dependency],
    };
  };
  const output = await inspectTimeline(
    { target: { projectId: "p" }, range: { startUs: 0, endUs: 1000000 }, frames: 0 },
    invoke,
  );
  assert.deepEqual(output.manifest.events.observations?.[0]?.dependencies, [dependency]);
  assert.equal(output.manifest.events.observations?.[0]?.reason, "source_evidence_not_ready");
  assert.deepEqual(output.manifest.events.rows, []);
});

test("distributed helper reads bounded stdin and invokes the installed CLI for selected evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "yap-timeline-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "yap");
  await writeFile(
    executable,
    `#!${process.execPath}
let input="";process.stdin.on("data",data=>input+=data);process.stdin.on("end",()=>{
 const params=JSON.parse(input);
 if(process.argv[2]!=="asset.get"||params.assetId!=="selected")process.exit(2);
 console.log(JSON.stringify({ok:true,data:{id:"selected",streams:[]}}));
});`,
    { mode: 0o755 },
  );
  const helper = fileURLToPath(
    new URL("../skills/yap/scripts/timeline-inspection.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [helper], {
    encoding: "utf8",
    timeout: 5000,
    input: JSON.stringify({
      target: { assetId: "selected", videoStreamId: "video" },
      range: { startUs: 0, endUs: 100000 },
      frames: 0,
      maxEventPages: 0,
      cli: { executable },
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.manifest.identity.assetId, "selected");
  assert.equal(output.manifest.waveform.state, "not_selected");
  assert.match(output.svg, /source timeline/);
});

test("event labels fit beside their own markers while preserving kind/time and exact full IDs", async () => {
  const fullId = "track:" + "a".repeat(64) + ":0";
  const rows = [0, 500000, 600000, 999999].map((projectAtUs) => ({
    kind: "cut",
    mediaKind: "audio",
    trackId: fullId,
    projectAtUs,
  }));
  const invoke = async (operation) =>
    operation === "revision.get"
      ? { revision: { id: "r" } }
      : operation === "timeline.events"
        ? { revisionId: "r", state: "ready", rows, nextCursor: null }
        : { revisionId: "r", state: "unavailable", reason: "no_audio" };
  for (const width of [640, 1200]) {
    const result = await inspectTimeline(
      { target: { projectId: "p" }, range: { startUs: 0, endUs: 1000000 }, frames: 0, width },
      invoke,
    );
    assert.deepEqual(result.manifest.events.rows, rows);
    const labels = [...result.svg.matchAll(/<text ([^>]+)>(cut[^<]+)<\/text>/g)];
    assert.equal(labels.length, rows.length);
    labels.forEach(([, attrs, label], index) => {
      const x = Number(attrs.match(/\bx="([^"]+)"/)?.[1]);
      const length = Number(attrs.match(/\btextLength="([^"]+)"/)?.[1]);
      const marker = 140 + (rows[index].projectAtUs / 1000000) * (width - 175);
      assert.ok(
        Number.isFinite(length) && length > 0,
        "An explicit fitted glyph extent is required",
      );
      assert.ok(
        x >= marker + 8 || x + length <= marker - 8,
        "Event label must stay on one side of its own marker",
      );
      assert.ok(x >= 140 && x + length <= width - 35, "Event label must fit inside the plot");
      assert.ok(label.includes((rows[index].projectAtUs / 1e6).toFixed(3) + " s"));
      assert.ok(label.includes("audio"));
      assert.ok(!label.includes(fullId));
    });
  }
});

test("the picture panel distinguishes unselected evidence from actual pending and failed requests", async () => {
  const invoke = async (operation, params) =>
    operation === "revision.get"
      ? { revision: { id: "r" } }
      : operation === "frame.batch"
        ? {
            items: params.atUs.map((atUs, index) => ({
              atUs,
              ok: true,
              data: { revisionId: "r", state: index ? "failed" : "queued" },
            })),
          }
        : { revisionId: "r", state: "unavailable", reason: "no_audio" };
  const request = {
    target: { projectId: "p" },
    range: { startUs: 0, endUs: 1000000 },
    maxEventPages: 0,
  };
  const unselected = await inspectTimeline({ ...request, frames: 0 }, invoke);
  assert.match(unselected.svg, /Pictures: unselected · no frame requests/);
  assert.equal(unselected.manifest.pictureRequests, 0);
  const requested = await inspectTimeline({ ...request, frames: 2 }, invoke);
  assert.equal(requested.manifest.pictureRequests, 2);
  assert.match(requested.svg, />queued</);
  assert.match(requested.svg, />failed</);
  assert.doesNotMatch(requested.svg, /Pictures: unselected/);
});
