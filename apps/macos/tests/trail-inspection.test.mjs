import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  seedCapture,
  startPublicService,
  importAcquisition,
  publicCommand,
  connectPublicMcp,
  until,
} from "./fixtures/public-service.mjs";
import { temporary } from "./harness.mjs";

import { width, height, page, journalRows } from "./fixtures/generated-capture.mjs";
function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", ...args], {
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
function pixels(file) {
  const rgb = ffmpeg([
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  assert.equal(rgb.length, width * height * 3, "Delivered pixels retain full fixture dimensions");
  return rgb;
}
function differences(a, b, region = { x: 0, y: 0, width, height }) {
  let changed = 0;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++) {
      const at = (y * width + x) * 3;
      if ([0, 1, 2].some((channel) => Math.abs(a[at + channel] - b[at + channel]) > 16)) changed++;
    }
  return changed;
}
function compact(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    assert.ok(
      !value.some((item) => item && typeof item === "object" && "x" in item && "y" in item),
      "Public frame metadata must not dump cursor points",
    );
    value.forEach(compact);
  } else
    for (const [key, item] of Object.entries(value)) {
      assert.notEqual(key, "rgbBase64", "Analysis rasters must not enter public tool context");
      compact(item);
    }
}
async function fixture(home, transformRows = (rows) => rows, frameStepUs = 6_000_000) {
  const take = await seedCapture(home, {
    recordingId: randomUUID(),
    sourceId: randomUUID(),
    sourceDurationUs: 18_000_000,
  });
  const source = join(home, "library", "recordings", take.id, "source");
  await mkdir(source, { recursive: true });
  const frameCount = 18_000_000 / frameStepUs;
  for (let index = 0; index < frameCount; index++)
    await writeFile(
      join(home, `page-${index}.ppm`),
      Buffer.concat([
        Buffer.from(`P6\n${width} ${height}\n255\n`),
        page(index * frameStepUs >= 12_000_000),
      ]),
    );
  const video = join(source, "video.mov");
  ffmpeg([
    "-framerate",
    `${1_000_000}/${frameStepUs}`,
    "-i",
    join(home, "page-%d.ppm"),
    "-frames:v",
    String(frameCount),
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-bf",
    "0",
    video,
  ]);
  const truth = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "json",
      video,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(truth.status, 0, truth.stderr);
  assert.deepEqual(
    JSON.parse(truth.stdout).frames.map((frame) => Number(frame.pts_time)),
    Array.from({ length: frameCount }, (_, i) => (i * frameStepUs) / 1_000_000),
  );
  const samples = [];
  const point = (sourceUs, x, y) =>
    samples.push({
      sourceUs,
      x,
      y,
      globalX: x,
      globalY: y,
      buttons: 0,
      eligibility: "inside",
      geometryEpoch: 1,
    });
  for (let i = 0; i <= 52; i++)
    point(
      200_000 + i * 25_000,
      490 + 120 * Math.cos((i / 52) * Math.PI * 2),
      360 + 120 * Math.sin((i / 52) * Math.PI * 2),
    );
  for (let i = 0; i <= 18; i++)
    point(
      1_525_000 + i * 25_000,
      650 + (320 * i) / 18,
      455 + 18 * Math.sin((i / 18) * Math.PI * 4),
    );
  for (let i = 0; i <= 11; i++)
    point(2_300_000 + i * 25_000, 340 + i * 22, 568 + 10 * Math.sin((i / 11) * Math.PI * 2));
  for (const base of [3_500_000, 9_500_000])
    for (let i = 0; i <= 19; i++)
      point(base + i * 25_000, 805 + i * 8, 474 + 10 * Math.sin((i / 19) * Math.PI * 2));
  const rows = journalRows({
    sourceId: take.sourceId,
    width,
    height,
    samples,
    pauses: [{ atSourceUs: 2_250_000, elapsedPauseUs: 5_000_000 }],
  });
  const journal = join(source, "capture.journal.jsonl");
  await writeFile(
    journal,
    transformRows(rows)
      .map((row, index) => JSON.stringify({ sequence: index + 1, ...row }))
      .join("\n") + "\n",
  );
  return { take, video, journal };
}

async function inspector(home, source, service) {
  const call = async (operation, params) => {
    const reply = await service.call(operation, params);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  const { acquisition } = await importAcquisition(
    service,
    join(home, "library", "recordings", source.take.id, "source"),
  );
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
  assert.ok(binding);
  const initial = await call("project.create", {
    requestId: randomUUID(),
    canvas: { width, height, fps: { numerator: 30, denominator: 1 }, background: "#000000ff" },
  });
  const projectId = initial.project.id;
  let authored = await call("edit.apply", {
    projectId,
    expectedRevisionId: initial.revision.id,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          assetId: binding.assetId,
          streamId: binding.streamId,
          acquisitionId: acquisition.id,
          trackId: { label: "video" },
          source: { kind: "range", range: { startUs: 0, endUs: 18_000_000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 18_000_000 } },
        },
      },
    ],
  });
  const clipId = authored.edit.labels.clip,
    trackId = authored.edit.labels.video,
    results = {};
  const edit = async (operations) => {
    authored = await call("edit.apply", {
      projectId,
      expectedRevisionId: authored.revision.id,
      requestId: randomUUID(),
      operations,
    });
    return authored.revision.id;
  };
  async function request(options = {}) {
    const { clean = false, trailUs = 2_000_000, revisionId, atUs = 2_000_000 } = options;
    const pinned =
      revisionId ??
      (await edit([
        {
          operation: "processing.set",
          target: { kind: "clip", id: clipId },
          steps: clean ? [] : [{ processor: { type: "pointer", trailUs } }],
        },
      ]));
    return { projectId, revisionId: pinned, atUs, maxLongEdge: width };
  }
  async function deliver(name, options = {}) {
    const params = await request(options);
    const ready = await until(
      async () => {
        const status = await call("frame.get", params);
        assert.ok(!["failed", "unavailable"].includes(status.state), JSON.stringify(status));
        if (status.state !== "ready") return false;
        await call("artifact.close", { token: status.delivery.token });
        return status;
      },
      "Authored pointer frame",
      30_000,
    );
    const output = join(home, `${name}.png`);
    const delivered = publicCommand(service.socket, "frame.get", params, ["--output", output]);
    assert.deepEqual(delivered.published, ready.published);
    const frame = ready.published.output;
    assert.deepEqual([frame.width, frame.height], [width, height]);
    compact(frame);
    results[name] = { params, output, frame, rgb: pixels(output) };
    return results[name];
  }
  return { call, edit, clipId, trackId, request, deliver, results };
}

test("explicit pointer steps preserve held-frame gesture pixels and reach CLI and MCP", async () => {
  const home = temporary("/tmp/scr-trail-public-"),
    source = await fixture(home);
  const hashes = { video: await hash(source.video), journal: await hash(source.journal) };
  const service = await startPublicService(home, process.env.YAP_NATIVE);
  try {
    const { deliver, results } = await inspector(home, source, service);
    await deliver("clean", { clean: true });
    await deliver("pointer", { trailUs: 0 });
    await deliver("default");
    await deliver("short", { trailUs: 500_000 });
    await deliver("pause-reset", { atUs: 2_600_000 });
    const counts = {};
    for (const name of ["pointer", "default", "short", "pause-reset"])
      counts[name] = differences(results.clean.rgb, results[name].rgb);
    assert.ok(counts.pointer > 20 && counts.pointer < 1000);
    assert.ok(
      counts.default > 1000 && counts.default > counts.short && counts.short > counts.pointer,
    );
    const oldCircle = { x: 360, y: 240, width: 120, height: 240 };
    assert.ok(differences(results.clean.rgb, results.default.rgb, oldCircle) > 100);
    for (const name of ["pointer", "short", "pause-reset"])
      assert.equal(differences(results.clean.rgb, results[name].rgb, oldCircle), 0);
    const client = await connectPublicMcp(service.socket, "trail-public-proof");
    try {
      for (const name of ["default", "pause-reset"]) {
        const reply = await client.callTool({ name: "frame.get", arguments: results[name].params });
        assert.equal(reply.structuredContent.ok, true, JSON.stringify(reply));
        assert.deepEqual(reply.structuredContent.data.published.output, results[name].frame);
        const image = reply.content.find((item) => item.type === "image");
        assert.equal(image?.mimeType, "image/png");
        assert.deepEqual(Buffer.from(image.data, "base64"), await readFile(results[name].output));
      }
    } finally {
      await client.close();
    }
    assert.deepEqual(
      { video: await hash(source.video), journal: await hash(source.journal) },
      hashes,
    );
    if (process.env.YAP_TRAIL_EVIDENCE) {
      await mkdir(process.env.YAP_TRAIL_EVIDENCE, { recursive: true });
      for (const [name, result] of Object.entries(results))
        await copyFile(result.output, join(process.env.YAP_TRAIL_EVIDENCE, `${name}.png`));
      await writeFile(
        join(process.env.YAP_TRAIL_EVIDENCE, "metrics.json"),
        JSON.stringify(
          {
            syntheticObservations: true,
            hashes,
            changedPixels: counts,
            frames: Object.fromEntries(
              Object.entries(results).map(([name, value]) => [name, value.frame]),
            ),
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await service.close();
  }
});

test("explicit project cut follows source history while its pinned historical revision preserves the gesture", async () => {
  const home = temporary("/tmp/scr-trail-cut-"),
    source = await fixture(home, undefined, 500_000);
  const service = await startPublicService(home, process.env.YAP_NATIVE);
  try {
    const { deliver, edit, clipId, trackId } = await inspector(home, source, service);
    const historical = await deliver("before-cut");
    const revised = await edit([
      {
        operation: "remove",
        clipIds: [clipId],
        ranges: [{ startUs: 0, endUs: 1_500_000 }],
        ripple: { trackIds: [trackId] },
      },
    ]);
    const cut = await deliver("cut", { revisionId: revised, atUs: 500_000 });
    const clean = await deliver("cut-clean", { atUs: 500_000, clean: true });
    const oldCircle = { x: 360, y: 240, width: 120, height: 240 };
    assert.deepEqual(cut.rgb, historical.rgb);
    assert.ok(differences(clean.rgb, cut.rgb, oldCircle) > 100);
    assert.ok(differences(clean.rgb, cut.rgb) > 100);
    const pinned = await deliver("historical", { revisionId: historical.params.revisionId });
    assert.deepEqual(pinned.frame, historical.frame);
    assert.deepEqual(pinned.rgb, historical.rgb);
    assert.ok(differences(clean.rgb, pinned.rgb, oldCircle) > 100);
  } finally {
    await service.close();
  }
});

for (const resized of [false, true])
  test(`authored pointer ${resized ? "resize vetoes" : "window move preserves"} held-raster coordinates`, async () => {
    const home = temporary("/tmp/scr-trail-geometry-");
    const source = await fixture(home, (rows) => {
      const moved = structuredClone(rows.find((row) => row.event === "geometry"));
      moved.data.epoch = 2;
      moved.data.sourceUs = 1_500_000;
      moved.data.hostUs += 1_500_000;
      moved.data.geometry.screenRect.x = 500;
      moved.data.geometry.screenRect.y = 300;
      if (resized) moved.data.geometry.contentRect.width -= 200;
      rows.splice(3, 0, moved);
      for (const row of rows)
        if (row.event === "cursorSamples")
          for (const sample of row.data.samples)
            if (sample.sourceUs >= moved.data.sourceUs) {
              sample.geometryEpoch = 2;
              sample.globalX += 500;
              sample.globalY += 300;
            }
      return rows;
    });
    const service = await startPublicService(home, process.env.YAP_NATIVE);
    try {
      const { deliver } = await inspector(home, source, service);
      const clean = await deliver("clean", { clean: true }),
        annotated = await deliver("geometry");
      assert.equal(
        differences(clean.rgb, annotated.rgb, { x: 360, y: 240, width: 120, height: 240 }),
        0,
      );
      if (resized) assert.deepEqual(annotated.rgb, clean.rgb);
      else {
        assert.ok(
          differences(clean.rgb, annotated.rgb, { x: 640, y: 420, width: 350, height: 70 }) > 100,
        );
        assert.equal(
          differences(clean.rgb, annotated.rgb, { x: 1000, y: 650, width: 280, height: 150 }),
          0,
        );
      }
    } finally {
      await service.close();
    }
  });

for (const eligibility of ["outside", "unknownGeometry"])
  test(`authored ${eligibility} observation wins a duplicate timestamp without reviving the pointer`, async () => {
    const home = temporary("/tmp/scr-trail-eligibility-");
    const source = await fixture(home, (rows) => {
      for (const row of rows)
        if (row.event === "cursorSamples") {
          const index = row.data.samples.findIndex((sample) => sample.sourceUs === 1_975_000);
          if (index >= 0)
            row.data.samples.splice(index + 1, 0, {
              ...row.data.samples[index],
              eligibility,
              x: null,
              y: null,
              geometryEpoch: eligibility === "unknownGeometry" ? 0 : 1,
            });
        }
      return rows;
    });
    const service = await startPublicService(home, process.env.YAP_NATIVE);
    try {
      const { deliver } = await inspector(home, source, service);
      const clean = await deliver("clean", { clean: true }),
        pointer = await deliver("pointer", { trailUs: 0 }),
        trail = await deliver("trail");
      assert.deepEqual(pointer.rgb, clean.rgb);
      assert.ok(
        differences(clean.rgb, trail.rgb, { x: 360, y: 240, width: 120, height: 240 }) > 100,
      );
    } finally {
      await service.close();
    }
  });

test("missing geometry refuses authored pointer work while the clean project remains usable", async () => {
  const home = temporary("/tmp/scr-trail-missing-geometry-");
  const source = await fixture(home, (rows) => rows.filter((row) => row.event !== "geometry"));
  const service = await startPublicService(home, process.env.YAP_NATIVE);
  try {
    const { call, request, deliver } = await inspector(home, source, service);
    const params = await request();
    const unavailable = await until(
      async () => {
        const status = await call("frame.get", params);
        assert.notEqual(status.state, "ready");
        return ["failed", "unavailable"].includes(status.state) && status;
      },
      "Missing pointer geometry",
      30_000,
    );
    assert.equal(unavailable.published, null);
    assert.equal(unavailable.delivery, null);
    await deliver("clean", { clean: true });
  } finally {
    await service.close();
  }
});
