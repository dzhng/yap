import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { poll, run, hash, root } from "./source-evidence-fixture.mjs";
import { mask, classify } from "./render-membership.mjs";

/** Output-size/render-budget proof; the corpus does not claim 1080p source decoding. */
export async function previewScale(service, out, limits, base, durationUs) {
  const call = (operation, params) => service.call(operation, params, { transport: "mcp" });
  const corpus = join(root, "specs/done/agent-editing/assets/00-corpus");
  const probe = async (file) =>
    JSON.parse(
      (
        await run(
          "ffprobe",
          ["-v", "error", "-show_streams", "-show_frames", "-show_format", "-of", "json", file],
          { maxBuffer: 8 * 1024 ** 2 },
        )
      ).stdout,
    );
  const pixels = async (file, filter) =>
    (
      await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-i",
          file,
          "-map",
          "0:v:0",
          "-vf",
          filter,
          "-fps_mode",
          "passthrough",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer", maxBuffer: 32 * 1024 ** 2, timeout: 60000 },
      )
    ).stdout;
  const assets = [],
    refs = [],
    clocks = [];
  for (const name of ["a", "b"]) {
    const file = join(corpus, `${name}.mov`);
    const imported = await call("asset.import", { requestId: `preview-${name}`, path: file });
    const job = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (value) => value.state === "ready",
      "preview source",
    );
    assets.push(await call("asset.get", { assetId: job.published.output.assetId }));
    const metadata = await probe(file),
      frames = metadata.frames.filter((frame) => frame.media_type === "video");
    const rgb = await pixels(
      file,
      "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,scale=160:90",
    );
    assert.equal(rgb.length, frames.length * 160 * 90 * 3);
    clocks.push(
      frames.map((frame, index) => ({
        atUs: Math.round(Number(frame.best_effort_timestamp_time) * 1e6),
        id: `${name}${index}`,
      })),
    );
    for (let index = 0; index < frames.length; index++)
      refs.push({
        id: `${name}${index}`,
        mask: mask(rgb.subarray(index * 160 * 90 * 3, (index + 1) * 160 * 90 * 3)),
      });
  }
  assert.ok(durationUs >= 20e6);
  const beginning = durationUs - 20e6;
  const operations = [
    {
      operation: "canvas.set",
      canvas: { width: 1920, height: 1080, fps: { numerator: 30, denominator: 1 } },
    },
    { operation: "track.add", label: "picture", track: { kind: "video", order: 1 } },
  ];
  for (let second = 0; second < 20; second++) {
    const asset = assets[second % 2],
      stream = asset.streams.find((stream) => stream.kind === "video");
    operations.push({
      operation: "place",
      clip: {
        trackId: { label: "picture" },
        assetId: asset.id,
        streamId: stream.id,
        source: { kind: "range", range: { startUs: 0, endUs: 1e6 } },
        placement: {
          kind: "project",
          range: { startUs: beginning + second * 1e6, endUs: beginning + (second + 1) * 1e6 },
        },
      },
    });
  }
  const edited = await call("edit.apply", {
    projectId: base.projectId,
    expectedRevisionId: base.revisionId,
    requestId: "preview-layout",
    operations,
  });
  const selection = { projectId: base.projectId, revisionId: edited.revision.revisionId };
  const result = {
    selection,
    output: { width: 1920, height: 1080, fps: 30 },
    scope:
      "First movie in this journey, then a distinct uncached window. Native workers are per-request; this is not cold-boot or same-process residency measurement.",
    renders: [],
  };
  for (const [name, startUs] of [
    ["cold", beginning],
    ["warm", beginning + 10e6],
    ["cache-hit", beginning + 10e6],
  ]) {
    const params = { ...selection, range: { startUs, endUs: startUs + 10e6 } },
      at = performance.now();
    const ready = await poll(
      () => call("preview.get", params),
      (value) => value.state === "ready",
      `${name} preview`,
    );
    const readyMs = performance.now() - at;
    const file = join(out, `preview-${name}.mp4`),
      deliveryAt = performance.now();
    await service.call("preview.get", params, { output: file });
    const record = {
      name,
      range: params.range,
      readyMs,
      deliveryMs: performance.now() - deliveryAt,
      jobId: ready.jobId,
      sha256: hash(await readFile(file)),
    };
    result.renders.push(record);
    if (name === "cache-hit") {
      assert.equal(record.jobId, result.renders[1].jobId);
      assert.equal(record.sha256, result.renders[1].sha256);
      continue;
    }
    const metadata = await probe(file),
      video = metadata.streams.find((stream) => stream.codec_type === "video"),
      audio = metadata.streams.find((stream) => stream.codec_type === "audio");
    assert.deepEqual([video.width, video.height, video.codec_name], [1920, 1080, "h264"]);
    assert.equal(Math.round(Number(metadata.format.duration) * 1e6), 10e6);
    assert.equal(Math.round(Number(audio.duration) * Number(audio.sample_rate)), 480000);
    const frames = metadata.frames.filter((frame) => frame.media_type === "video");
    assert.equal(frames.length, 300);
    const rgb = await pixels(file, "scale=160:90");
    assert.equal(rgb.length, 300 * 160 * 90 * 3);
    const membership = [];
    for (let n = 0; n < frames.length; n++) {
      const localUs = Math.round(Number(frames[n].best_effort_timestamp_time) * 1e6);
      assert.ok(
        Math.abs(localUs - Math.round((n * 1e6) / 30)) <= 1,
        "Exact local30fps presentation grid",
      );
      const second = Math.floor(n / 30),
        sourceUs = Math.round(((n % 30) * 1e6) / 30);
      const expected = clocks[second % 2].findLast((frame) => frame.atUs <= sourceUs).id;
      const observed = classify(rgb.subarray(n * 160 * 90 * 3, (n + 1) * 160 * 90 * 3), refs);
      assert.equal(observed.id, expected, `${name} frame${n}`);
      assert.ok(
        observed.differingPixels < 200,
        `Counter membership differs: ${JSON.stringify(observed)}`,
      );
      membership.push({ localUs, id: observed.id, differingPixels: observed.differingPixels });
    }
    record.membership = membership;
  }
  const receipts = [];
  for (const name of await readdir(join(out, "native")))
    if (name.endsWith(".json") && name.startsWith("picture-")) {
      const value = JSON.parse(await readFile(join(out, "native", name), "utf8"));
      if (value.operation !== "media.renderCompositionMovie") continue;
      assert.equal(value.response.ok, true);
      const receipt = value.response.data;
      assert.equal(receipt.frameCount, 300);
      assert.equal(receipt.audio.frames, 480000);
      assert.ok(
        receipt.peakResidentBytes > 0 &&
          receipt.peakResidentBytes >= receipt.audio.peakResidentBytes,
      );
      receipts.push({
        range: value.request.range,
        frameCount: receipt.frameCount,
        frames: receipt.audio.frames,
        peakResidentBytes: receipt.peakResidentBytes,
      });
    }
  assert.equal(
    receipts.length,
    2,
    "The warm window renders anew and its cache hit does not invoke native work",
  );
  assert.notEqual(result.renders[0].jobId, result.renders[1].jobId);
  result.receipts = receipts;
  result.withinBudget =
    result.renders[1].readyMs <= limits.warmPreviewMs &&
    receipts.every((receipt) => receipt.peakResidentBytes <= limits.workerRSSBytes);
  return result;
}
