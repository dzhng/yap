import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out && process.env.YAP_NATIVE, "Pass --out NEW_DIRECTORY and YAP_NATIVE");
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const home = await mkdtemp("/tmp/yap-motion-blur-");
const source = join(root, "specs/done/ffmpeg-parity/evidence/motion-alpha/alpha.mov");
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  sourceSha256: hash(await readFile(source)),
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  recipe: { samples: 4, shutter: 0.5, canvas: { width: 64, height: 48 }, frameUs: 500001 },
  checks: [],
};
const service = new JourneyService(join(home, "sender"), report);
const call = service.call.bind(service);
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const ffmpeg = join(root, "helpers/ffmpeg/.build/distribution/bin/ffmpeg");
const pixels = async (path) =>
  Buffer.from(
    (
      await run(
        ffmpeg,
        ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
        {
          encoding: "buffer",
        },
      )
    ).stdout,
  );
const visibleBounds = (rgba) => {
  const width = 64,
    height = 48,
    points = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (rgba[offset] + rgba[offset + 1] + rgba[offset + 2] > 5) points.push([x, y]);
    }
  assert.ok(points.length > 0, "motion fixture must contain visible pixels");
  return {
    minX: Math.min(...points.map(([x]) => x)),
    maxX: Math.max(...points.map(([x]) => x)),
    minY: Math.min(...points.map(([, y]) => y)),
    maxY: Math.max(...points.map(([, y]) => y)),
  };
};
const renderFrame = async (request, output, label) => {
  const startedAt = performance.now();
  let polls = 0;
  await poll(
    async () => {
      polls++;
      return call("frame.get", request);
    },
    (value) => value.state === "ready",
    label,
  );
  const readyAt = performance.now();
  const delivered = await call("frame.get", request, { output });
  const finishedAt = performance.now();
  const outputStats = await stat(output);
  return {
    delivered,
    cost: {
      polls,
      readyMs: readyAt - startedAt,
      deliveryMs: finishedAt - readyAt,
      totalMs: finishedAt - startedAt,
      outputBytes: outputStats.size,
      decodedSamples: delivered.published?.output?.decodedSamples ?? null,
    },
  };
};
const edit = async (projectId, revisionId, operations) =>
  call("edit.apply", {
    projectId,
    expectedRevisionId: revisionId,
    requestId: randomUUID(),
    operations,
  });
try {
  await service.start();
  const originalPath = join(home, "external-alpha.mov");
  const { copyFile } = await import("node:fs/promises");
  await copyFile(source, originalPath);
  const imported = await call("asset.import", { requestId: randomUUID(), path: originalPath });
  const ready = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "alpha import",
  );
  const asset = await call("asset.get", { assetId: ready.published.output.assetId });
  const stream = asset.streams.find((value) => value.kind === "video");
  assert.equal(stream.codec, "ap4h");
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const placed = await edit(created.project.projectId, created.revision.revisionId, [
    { operation: "track.add", label: "pictures", track: { kind: "video", order: 0 } },
    {
      operation: "place",
      label: "motion",
      clip: {
        trackId: { label: "pictures" },
        assetId: asset.id,
        streamId: stream.id,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
      },
    },
  ]);
  const target = { kind: "clip", id: placed.edit.labels.motion };
  const baseRequest = {
    projectId: created.project.projectId,
    revisionId: placed.revision.revisionId,
    atUs: 500001,
  };
  const baseResult = await renderFrame(baseRequest, join(out, "base.png"), "base frame");
  const base = baseResult.delivered;
  assert.equal(base.state, "ready");
  const trajectory = {
    enabled: true,
    processor: {
      type: "geometry",
      scale: {
        x: {
          keys: [
            { at: { numerator: 0, denominator: 1 }, value: 1, interpolation: "linear" },
            { at: { numerator: 1, denominator: 1 }, value: 1.5, interpolation: "linear" },
          ],
        },
        y: {
          keys: [
            { at: { numerator: 0, denominator: 1 }, value: 1, interpolation: "linear" },
            { at: { numerator: 1, denominator: 1 }, value: 1.5, interpolation: "linear" },
          ],
        },
      },
    },
  };
  const changed = await edit(created.project.projectId, placed.revision.revisionId, [
    {
      operation: "processing.set",
      target,
      steps: [
        trajectory,
        { enabled: true, processor: { type: "motion-blur", samples: 4, shutter: 0.5 } },
      ],
    },
  ]);
  const control = await edit(created.project.projectId, changed.revision.revisionId, [
    { operation: "processing.set", target, steps: [trajectory] },
  ]);
  const blurRequest = {
    projectId: created.project.projectId,
    revisionId: changed.revision.revisionId,
    atUs: 500001,
  };
  const blurredResult = await renderFrame(blurRequest, join(out, "blurred.png"), "blurred frame");
  const blurred = blurredResult.delivered;
  assert.equal(blurred.state, "ready");
  const controlResult = await renderFrame(
    { projectId: created.project.projectId, revisionId: control.revision.revisionId, atUs: 500001 },
    join(out, "control.png"),
    "unblurred trajectory control",
  );
  assert.equal(controlResult.delivered.state, "ready");
  const before = await pixels(join(out, "base.png"));
  const controlPixels = await pixels(join(out, "control.png"));
  const after = await pixels(join(out, "blurred.png"));
  assert.equal(before.length, after.length);
  assert.equal(controlPixels.length, after.length);
  let trajectoryChangedPixels = 0,
    blurChangedPixels = 0,
    sum = 0,
    max = 0,
    transparent = 0;
  for (let i = 0; i < before.length; i += 4) {
    const trajectoryDelta =
      Math.abs(before[i] - controlPixels[i]) +
      Math.abs(before[i + 1] - controlPixels[i + 1]) +
      Math.abs(before[i + 2] - controlPixels[i + 2]);
    const delta =
      Math.abs(controlPixels[i] - after[i]) +
      Math.abs(controlPixels[i + 1] - after[i + 1]) +
      Math.abs(controlPixels[i + 2] - after[i + 2]);
    if (trajectoryDelta) trajectoryChangedPixels++;
    if (delta) blurChangedPixels++;
    sum += delta;
    max = Math.max(max, delta);
    if (after[i + 3] !== 255) transparent++;
  }
  assert.ok(trajectoryChangedPixels > 0, "the authored trajectory must move the control");
  assert.ok(blurChangedPixels > 0, "bounded blur must change the moving control");
  assert.ok(blurChangedPixels >= 32, "bounded blur must have a measurable footprint");
  assert.ok(sum >= 512, "bounded blur must have a measurable color delta");
  assert.equal(transparent, 0, "delivered H.264 control must remain opaque");
  const baseBounds = visibleBounds(before),
    controlBounds = visibleBounds(controlPixels),
    blurredBounds = visibleBounds(after);
  assert.ok(
    blurredBounds.minX >= controlBounds.minX - 1 && blurredBounds.maxX <= controlBounds.maxX + 1,
    `motion blur expanded the horizontal trajectory footprint too far: ${JSON.stringify({ controlBounds, blurredBounds })}`,
  );
  assert.ok(
    blurredBounds.minY >= controlBounds.minY - 1 && blurredBounds.maxY <= controlBounds.maxY + 1,
    `motion blur expanded the vertical trajectory footprint too far: ${JSON.stringify({ controlBounds, blurredBounds })}`,
  );
  report.checks.push({
    frame: 500001,
    trajectoryChangedPixels,
    blurChangedPixels,
    totalPixels: before.length / 4,
    meanRgbDelta: sum / (before.length / 4),
    maxRgbDelta: max,
    transparentPixels: transparent,
    baseBounds,
    controlBounds,
    blurredBounds,
  });
  report.cost = {
    base: baseResult.cost,
    blurred: blurredResult.cost,
    blurOverBaseTotalMs: blurredResult.cost.totalMs - baseResult.cost.totalMs,
  };
  report.outputs = { base: hash(before), blurred: hash(after) };
  report.passed = true;
  await save();
  console.log(JSON.stringify({ passed: true, evidence: out, checks: report.checks }));
} finally {
  await service.stop();
}
