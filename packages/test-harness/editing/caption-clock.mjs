import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { poll, root, run } from "./source-evidence-fixture.mjs";

/** A clipped first picture must keep the full project's caption sample and phase. */
export async function captionClock({ call, out, font, project, admit, picture, report }) {
  const media = await admit(join(root, "specs/done/agent-editing/assets/00-corpus/a.mov"));
  const p = await project({
    width: 320,
    height: 100,
    fps: { numerator: 8, denominator: 1 },
    background: "#000000ff",
  });
  const source = {
    kind: "text",
    text: "Boundary caption",
    font: { assetId: font.assetId, postScriptName: "ArialMT" },
    width: 320,
    height: 100,
    size: 28,
    color: "#ffffffff",
    alignment: "left",
    wrap: false,
  };
  report.clockRequests = [];
  const api = async (operation, params, options) => {
    const row = { operation, params };
    report.clockRequests.push(row);
    return (row.reply = await call(operation, params, options));
  };
  await p.edit([
    { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
    { operation: "track.add", label: "text", track: { kind: "video", order: 1 } },
    {
      operation: "place",
      clip: {
        trackId: { label: "video" },
        assetId: media.assetId,
        streamId: media.streams.find((s) => s.kind === "video").streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
      },
    },
    ...[
      { startUs: 0, endUs: 505000 },
      { startUs: 1000000, endUs: 1250000 },
    ].map((range) => ({
      operation: "place",
      clip: { trackId: { label: "text" }, source, placement: { kind: "project", range } },
    })),
  ]);
  const range = { startUs: 510000, endUs: 1510000 };
  const files = { full: join(out, "full.mp4"), range: join(out, "range.mp4") };
  for (const name of ["full", "range"]) {
    const params = { ...p.selection(), ...(name === "range" ? { range } : {}) };
    await poll(
      () => api("preview.get", params),
      (v) => v.state === "ready",
      name,
    );
    await api("preview.get", params, { output: files[name] });
  }
  const { exportId } = await api("export.create", {
    ...p.selection(),
    requestId: randomUUID(),
    kind: "video",
    directory: out,
    leaf: "export.mp4",
  });
  const exported = await poll(
    () => api("export.status", { exportId }),
    (v) => v.state === "ready",
    "export",
  );
  assert.deepEqual(await readFile(files.full), await readFile(exported.output));
  const pts = {};
  for (const name of ["full", "range"]) {
    const probe = JSON.parse(
      (
        await run("ffprobe", [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_frames",
          "-show_entries",
          "frame=best_effort_timestamp_time,pkt_duration_time",
          "-of",
          "json",
          files[name],
        ])
      ).stdout,
    );
    report[name + "Clock"] = probe;
    pts[name] = probe.frames.map((f) => Math.round(Number(f.best_effort_timestamp_time) * 1000000));
  }
  assert.deepEqual(
    pts.full,
    Array.from({ length: 16 }, (_, i) => i * 125000),
  );
  const samples = pts.full.filter((t) => t + 125000 > range.startUs && t < range.endUs);
  assert.deepEqual(
    pts.range,
    samples.map((t) => Math.max(t, range.startUs) - range.startUs),
  );
  const assets = {};
  for (const name of ["full", "range"]) {
    const asset = await admit(files[name]);
    assets[name] = {
      assetId: asset.assetId,
      streamId: asset.streams.find((s) => s.kind === "video").streamId,
    };
  }
  report.clockComparisons = [];
  async function rgb(path) {
    return (
      await run("ffmpeg", ["-v", "error", "-i", path, "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], {
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  }
  for (let i = 0; i < samples.length; i++) {
    const atUs = samples[i],
      expectedText = atUs <= 500000 || (atUs >= 1000000 && atUs < 1250000);
    const canonical = await picture({ ...p.selection(), atUs }, "canonical-" + atUs);
    assert.equal(
      canonical.receipt.pictures.filter((p) => p.kind === "text").length,
      expectedText ? 1 : 0,
    );
    const decoded = {};
    const deliveredIntervals = {};
    for (const name of ["full", "range"]) {
      const selection = { ...assets[name], atUs: name === "full" ? atUs : pts.range[i] };
      await poll(
        () => api("frame.get", selection),
        (v) => v.state === "ready",
        "decode",
      );
      const path = join(out, name + "-" + atUs + ".png");
      const delivered = await api("frame.get", selection, { output: path });
      assert.equal(delivered.published.output.actualSourceUs, selection.atUs);
      const sample = delivered.published.output.sample;
      const expectedEndUs =
        name === "full" ? atUs + 125000 : Math.min(atUs + 125000, range.endUs) - range.startUs;
      assert.equal(
        BigInt(sample.endValue) * 1000000n,
        BigInt(expectedEndUs) * BigInt(sample.endTimescale),
      );
      deliveredIntervals[name] = sample;

      decoded[name] = await rgb(path);
    }
    // Independently encoded GOPs need not match bytes. Pin the visible caption region.
    const count = 320 * 32 * 3;
    let sum = 0;
    for (let p = 0; p < count; p++) sum += Math.abs(decoded.full[p] - decoded.range[p]);
    const meanAbsoluteError = sum / count;
    assert.ok(meanAbsoluteError < 3, `caption region differs at ${atUs}: ${meanAbsoluteError}`);
    const whitePixels = {};
    for (const [name, bytes] of Object.entries(decoded)) {
      let white = 0;
      for (let p = 0; p < count; p += 3)
        if (bytes[p] > 220 && bytes[p + 1] > 220 && bytes[p + 2] > 220) white++;
      whitePixels[name] = white;
      // The frozen footage's identifier starts below this top caption region.
      assert.ok(
        expectedText ? white > 500 : white < 10,
        `${name} caption presence at ${atUs}: ${white}`,
      );
    }
    report.clockComparisons.push({
      sampleAtUs: atUs,
      rangeLocalUs: pts.range[i],
      expectedText,
      meanAbsoluteError,
      whitePixels,
      deliveredIntervals,
    });
  }
  report.checks.push({
    name: "caption-offgrid-delivered-range-clock",
    range,
    firstSampleUs: samples[0],
    frames: samples.length,
    exactFullExportBytes: true,
  });
}
