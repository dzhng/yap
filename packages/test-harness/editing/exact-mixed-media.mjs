import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { compare, fromTime, rational, round, subtract } from "../../composition/dist/index.js";
import { hash, poll, root } from "./source-evidence-fixture.mjs";

/** Public physical-clock parity against the retained mixed fixture and its zero-origin donor. */
export async function verifyMixedMedia({ service, report, out, audio }) {
  const call = service.call.bind(service);
  const retained = join(root, "specs/done/agent-editing/assets/03d-consumer-cutover");
  const oracle = JSON.parse(gunzipSync(await readFile(join(retained, "mixed-av-oracle.json.gz"))));
  const bytes = gunzipSync(await readFile(join(retained, "mixed-av.mov.gz")));
  assert.equal(hash(bytes), oracle.fixtureSha256);
  const path = join(out, "mixed-av.mov");
  await writeFile(path, bytes, { flag: "wx" });
  async function imported(path) {
    const pending = await call("asset.import", { path, requestId: randomUUID() });
    const job = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === "ready",
      "mixed import",
    );
    return call("asset.get", { assetId: job.published.output.assetId }, { transport: "mcp" });
  }
  const asset = await imported(path);
  assert.equal(asset.id, oracle.fixtureSha256);
  assert.deepEqual(asset.originUs, oracle.metadata.originUs);
  assert.deepEqual(
    asset.streams,
    oracle.metadata.streams.map(({ segments, ...stream }) => ({
      ...stream,
      segmentCount: segments.length,
    })),
  );
  const record = (report.mixedMedia = { fixtureSha256: asset.id, asset, segments: [], frames: [] });
  for (const stream of oracle.metadata.streams) {
    const selected = { assetId: asset.id, streamId: stream.id };
    const segments = [];
    let cursor,
      pages = 0;
    do {
      assert(pages++ <= stream.segments.length, "Segment paging exceeded this fixture's bound");
      const page = await call(
        "asset.segments",
        { ...selected, limit: 1, ...(cursor ? { cursor } : {}) },
        { transport: "mcp" },
      );
      for (const { ordinal, ...segment } of page.segments) {
        assert.equal(ordinal, segments.length);
        segments.push(segment);
      }
      cursor = page.nextCursor;
      assert(segments.length <= stream.segments.length, "Segment paging failed to advance");
    } while (cursor);
    assert.deepEqual(segments, stream.segments);
    record.segments.push({ streamId: stream.id, segments });
  }
  const expected = Buffer.alloc(52817 * 4);
  for (let frame = 0; frame < 48017; frame++)
    expected.writeFloatLE(
      (((frame * 37) % 251) + 1) / 512,
      (frame + (frame >= 24017 ? 4800 : 0)) * 4,
    );
  assert.equal(hash(expected), oracle.fullPCMHash);
  const tail = expected.subarray(23890 * 4);
  assert.equal(hash(tail), oracle.latePCMHash);
  const source = {
    assetId: asset.id,
    streamId: asset.streams.find((s) => s.kind === "audio").streamId,
  };
  for (const [name, params, pcm] of [
    ["mixed-raw-late", { ...source, range: oracle.lateRange }, tail],
    ["mixed-raw-full", source, expected],
  ]) {
    await audio(params, name, pcm, { sampleRate: 48000, channels: 1 });
    assert.deepEqual(report.checks[name].ready.published.output.unavailable, oracle.unavailable);
  }
  const donorPath = join(root, "specs/done/agent-editing/assets/00-corpus/video-only.mov");
  assert.equal(hash(await readFile(donorPath)), oracle.videoDonorSha256);
  const donor = await imported(donorPath);
  assert.equal(donor.originUs, 0);
  const videos = [asset, donor].map((value) => ({
    assetId: value.id,
    streamId: value.streams.find((s) => s.kind === "video").streamId,
  }));
  const normalized = (sample, origin, end = false) =>
    subtract(
      rational(
        BigInt(sample[end ? "endValue" : "value"]) * 1000000n,
        BigInt(sample[end ? "endTimescale" : "timescale"]),
      ),
      fromTime(origin),
    );
  function sameClock(actual, reference) {
    assert.deepEqual(actual.originUs, asset.originUs);
    assert.equal(reference.originUs, 0);
    for (const end of [false, true])
      assert.equal(
        compare(normalized(actual, asset.originUs, end), normalized(reference, 0, end)),
        0,
      );
  }
  for (const atUs of [0, 250000, 750001, 1999999]) {
    const pair = [];
    for (const [index, selection] of videos.entries()) {
      const params = { ...selection, atUs };
      await poll(
        () => call("frame.get", params, { transport: "mcp" }),
        (v) => v.state === "ready",
        "mixed frame",
      );
      const output = join(out, `mixed-frame-${atUs}-${index}.png`);
      const ready = await call("frame.get", params, { output });
      const frame = ready.published.output;
      assert.equal(frame.actualSourceUs, Math.floor(atUs / 250000) * 250000);
      assert.equal(
        frame.actualSourceUs,
        round(normalized(frame.sample, [asset, donor][index].originUs)),
      );
      pair.push({ frame, bytes: await readFile(output) });
    }
    assert.deepEqual(
      pair[0].bytes,
      pair[1].bytes,
      "Shared-origin mapping changed decoded picture bytes",
    );
    sameClock(pair[0].frame.sample, pair[1].frame.sample);
    record.frames.push({
      atUs,
      pngSha256: hash(pair[0].bytes),
      mixed: pair[0].frame,
      donor: pair[1].frame,
    });
  }
  async function scenes(selection) {
    const params = { ...selection, sourceRange: { startUs: 0, endUs: 2000000 }, limit: 1 };
    await poll(
      () => call("timeline.events", params),
      (v) => v.state === "ready",
      "mixed scenes",
    );
    const first = await call("timeline.events", params, { transport: "mcp" });
    assert.equal(first.state, "ready");
    assert.equal(first.context.coverage.find((c) => c.kind === "scene").state, "ready");
    assert.equal(first.page.nextCursor, null);
    return { first, rows: first.page.rows };
  }

  const mixedScenes = await scenes(videos[0]),
    donorScenes = await scenes(videos[1]);
  const summaries = [mixedScenes, donorScenes].map(({ first, rows }, index) => {
    assert.deepEqual(rows, [], "This donor has no scene boundaries");
    const { sourceId, generation, owner, source, ...summary } = first.context.scene.evidence;
    assert.equal(sourceId, videos[index].assetId);
    assert.equal(owner.assetId, videos[index].assetId);
    assert.equal(typeof generation, "string");
    assert.deepEqual(source.originUs, [asset, donor][index].originUs);
    assert.equal(source.streamId, videos[index].streamId);
    assert.equal(source.supportDigest, first.context.supportDigest);
    return { summary, source: { ...source, originUs: 0 }, available: first.available };
  });
  assert.deepEqual(summaries[0], summaries[1]);
  assert.equal(summaries[0].summary.comparisonCount, 7);
  assert.equal(summaries[0].summary.boundaryCount, 0);
  record.scenes = { mixed: mixedScenes, donor: donorScenes };
  record.passed = true;
}
