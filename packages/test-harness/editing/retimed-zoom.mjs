import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { sourceFrame, width, height, fps } from "./retiming-fixture.mjs";

export async function runRetimedZoom(output) {
  assert(output && process.env.YAP_NATIVE);
  const out = resolve(output);
  await mkdir(out);
  const home = await mkdtemp(join(tmpdir(), "yap-retimed-zoom-"));
  const stride = width * height * 3;
  const report = {
    passed: false,
    trace: [],
    exchanges: [],
    pictures: [],
    movies: [],
    workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
    harnessSha256: hash(await readFile(new URL(import.meta.url))),
    scope:
      "All-frame delivered counter and analytic zoom trajectory; no continuous playback or sound",
    oracle: {
      source: "For global frame i in [15,90): floor(4*(i-15)/5)",
      contentScale: "0.6+0.3*smoothstep((i/30-0.5)/2.5)",
      projectScale: "0.6+0.3*smoothstep((i/30)/2)",
      edgeTolerancePixels: 2,
      note: "Fixed before first render; geometry uses high-contrast boundary membership, not encoded color equality",
    },
  };
  const service = new JourneyService(home, report),
    call = service.call.bind(service);
  const ff = async (args) =>
    (
      await run("ffmpeg", ["-v", "error", "-nostdin", ...args], {
        encoding: "buffer",
        timeout: 60000,
        maxBuffer: 128 * 1024 ** 2,
      })
    ).stdout;
  const smooth = (t) => {
    t = Math.max(0, Math.min(1, t));
    return 3 * t * t - 2 * t * t * t;
  };
  const expectedScale = (frame, anchor) =>
    0.6 + 0.3 * smooth(anchor === "content" ? (frame - 15) / 75 : frame / 60);
  function measure(rgb, globalFrame, anchor) {
    if (globalFrame < 15) {
      assert(
        rgb.every((v) => v <= 3),
        `Nonblack leading frame${globalFrame}`,
      );
      return { globalFrame, gap: true };
    }
    const scale = expectedScale(globalFrame, anchor),
      left = ((1 - scale) * width) / 2,
      top = ((1 - scale) * height) / 2;
    const pixel = (x, y) => {
      const at = (Math.floor(y) * width + Math.floor(x)) * 3;
      return Array.from(rgb.subarray(at, at + 3));
    };
    let counter = 0;
    for (let bit = 0; bit < 8; bit++)
      if (pixel(left + (46 + 48 * bit) * scale, top + 324 * scale)[0] > 125) counter |= 1 << bit;
    const expectedCounter = Math.floor((4 * (globalFrame - 15)) / 5);
    assert.equal(
      counter,
      expectedCounter,
      `Wrong physical source in ${anchor} frame${globalFrame}`,
    );
    // Only the source's upper-left red bar lies in this bounded search rectangle.
    const bounds = { left: width, top: height, right: -1, bottom: -1 };
    for (let y = 0; y < 160; y++)
      for (let x = 0; x < 200; x++) {
        const at = (y * width + x) * 3;
        if (rgb[at] > 150 && rgb[at + 1] < 100 && rgb[at + 2] < 100) {
          bounds.left = Math.min(bounds.left, x);
          bounds.top = Math.min(bounds.top, y);
          bounds.right = Math.max(bounds.right, x);
          bounds.bottom = Math.max(bounds.bottom, y);
        }
      }
    const expected = {
      left: Math.floor(left),
      top: Math.floor(top),
      right: Math.ceil(left + 18 * scale) - 1,
      bottom: Math.ceil(top + 100 * scale) - 1,
    };
    for (const key of Object.keys(expected))
      assert(
        Math.abs(bounds[key] - expected[key]) <= report.oracle.edgeTolerancePixels,
        `${anchor} frame${globalFrame} ${key}: ${bounds[key]} vs ${expected[key]}`,
      );
    return { globalFrame, counter, expectedCounter, scale, bounds, expectedBounds: expected };
  }
  async function preview(selection, name, first, last, anchor) {
    const path = join(out, name + ".mp4");
    const result = await poll(
      () => call("preview.get", selection, { output: path }),
      (v) => v.state === "ready",
      name,
    );
    const rgb = await ff(["-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    assert.equal(rgb.length, (last - first) * stride);
    const frames = [];
    for (let i = first; i < last; i++)
      frames.push(measure(rgb.subarray((i - first) * stride, (i - first + 1) * stride), i, anchor));
    const metadata = JSON.parse(
      (
        await run("ffprobe", [
          "-v",
          "error",
          "-show_packets",
          "-select_streams",
          "v:0",
          "-show_streams",
          "-of",
          "json",
          path,
        ])
      ).stdout,
    );
    const [num, den] = metadata.streams[0].time_base.split("/").map(Number);
    const rangeStart = selection.range?.startUs ?? 0;
    const rangeEnd = selection.range?.endUs ?? 3000000;
    assert.equal(metadata.packets.length, last - first);
    for (let i = 0; i < metadata.packets.length; i++) {
      const visibleStart = Math.max(rangeStart, Math.floor(((first + i) * 1000000) / fps));
      const visibleEnd = Math.min(rangeEnd, Math.floor(((first + i + 1) * 1000000) / fps));
      assert.equal(
        metadata.packets[i].pts * num * 1000000,
        (visibleStart - rangeStart) * den,
        "Encoded visible interval start",
      );
      assert.equal(
        metadata.packets[i].duration * num * 1000000,
        (visibleEnd - visibleStart) * den,
        "Encoded visible interval duration",
      );
    }
    report.movies.push({
      name,
      path,
      anchor,
      first,
      last,
      rgbSha256: hash(rgb),
      frames,
      receipt: result.published.output,
      metadata,
    });
    return { path, rgb };
  }
  async function picture(selection, name, globalFrame, anchor) {
    const params = {
      ...selection,
      atUs: Math.ceil((globalFrame * 1000000) / fps),
      maxLongEdge: width,
    };
    await poll(
      () => call("frame.get", params),
      (v) => v.state === "ready",
      name,
    );
    const path = join(out, name + ".png");
    await call("frame.get", params, { output: path });
    const rgb = await ff(["-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    report.pictures.push({
      name,
      path,
      sha256: hash(await readFile(path)),
      ...measure(rgb, globalFrame, anchor),
    });
  }
  try {
    const raw = join(home, "source.rgb"),
      source = join(out, "source.mov");
    await writeFile(raw, Buffer.concat(Array.from({ length: 60 }, (_, i) => sourceFrame(i))));
    await ff([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${width}x${height}`,
      "-r",
      String(fps),
      "-i",
      raw,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "12",
      "-bf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      source,
    ]);
    report.sourceSha256 = hash(await readFile(source));
    await service.start();
    const admitted = await call("asset.import", { requestId: randomUUID(), path: source });
    await poll(
      () => call("job.get", { jobId: admitted.jobId }),
      (v) => v.state === "ready",
      "source",
    );
    const asset = await call("asset.get", { assetId: report.sourceSha256 });
    const created = await call("project.create", {
      requestId: randomUUID(),
      canvas: { width, height, fps: { numerator: fps, denominator: 1 }, background: "#000000ff" },
    });
    const projectId = created.project.projectId;
    let revisionId = created.revision.id;
    async function edit(operations) {
      const result = await call(
        "edit.apply",
        { projectId, expectedRevisionId: revisionId, requestId: randomUUID(), operations },
        { transport: "mcp" },
      );
      revisionId = result.revision.id;
      return result;
    }
    const placed = await edit([
      { operation: "track.add", label: "track", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: asset.streams[0].id,
          source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
        },
      },
    ]);
    const clipId = placed.edit.labels.clip;
    const curve = {
      keys: [
        { at: 0, value: 0.6, interpolation: { cubic: [1 / 3, 0, 2 / 3, 1] } },
        { at: 2000000, value: 0.9, interpolation: "hold" },
      ],
    };
    const step = (anchor) => ({
      processor: { type: "geometry", scale: { x: curve, y: curve } },
      window:
        anchor === "content"
          ? { kind: "content", clipId, sourceRange: { startUs: 0, endUs: 2000000 } }
          : { kind: "project", range: { startUs: 0, endUs: 3000000 } },
    });
    await edit([
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [step("content")],
      },
    ]);
    await edit([
      { operation: "move", clipIds: [clipId], atUs: 500000, ripple: "none" },
      {
        operation: "retime",
        clipIds: [clipId],
        durationUs: 2500000,
        pitch: "preserve",
        ripple: "none",
      },
    ]);
    const selection = { projectId, revisionId };
    const full = await preview(selection, "content-full", 0, 90, "content");
    for (const i of [15, 30, 51, 52, 53, 70, 89])
      await picture(selection, "content-" + i, i, "content");
    await edit([{ operation: "split", clipIds: [clipId], atUs: 1733334 }]);
    const splitSelection = { projectId, revisionId };
    const split = await preview(splitSelection, "content-split", 0, 90, "content");
    assert.deepEqual(split.rgb, full.rgb);
    for (const i of [51, 52, 53]) await picture(splitSelection, "split-" + i, i, "content");
    const ranged = await preview(
      { ...splitSelection, range: { startUs: 1100011, endUs: 1930037 } },
      "content-range",
      33,
      58,
      "content",
    );
    report.rangePixelComparison = {
      scope:
        "All matching full/range decoded RGB frames; codec differences measured, not strict color acceptance",
      frames: Array.from({ length: 25 }, (_, i) => {
        const original = split.rgb.subarray((i + 33) * stride, (i + 34) * stride);
        const candidate = ranged.rgb.subarray(i * stride, (i + 1) * stride);
        let maximum = 0,
          total = 0,
          changed = 0;
        for (let j = 0; j < stride; j++) {
          const d = Math.abs(original[j] - candidate[j]);
          maximum = Math.max(maximum, d);
          total += d;
          if (d) changed++;
        }
        return {
          globalFrame: i + 33,
          maximumChannelError: maximum,
          meanChannelError: total / stride,
          changedChannels: changed,
        };
      }),
    };
    const exportId = randomUUID();
    await call("export.create", {
      ...splitSelection,
      kind: "video",
      exportId,
      directory: out,
      leaf: "content-export.mp4",
    });
    const exported = await poll(
      () => call("export.status", { exportId }),
      (v) => v.state === "ready",
      "export",
    );
    assert.deepEqual(
      await ff([
        "-i",
        exported.output,
        "-map",
        "0:v:0",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ]),
      split.rgb,
    );
    const restored = await call("edit.restore", {
      projectId,
      expectedRevisionId: revisionId,
      targetRevisionId: placed.revision.id,
      requestId: randomUUID(),
    });
    revisionId = restored.id;
    await edit([
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [step("project")],
      },
    ]);
    await edit([
      { operation: "move", clipIds: [clipId], atUs: 500000, ripple: "none" },
      {
        operation: "retime",
        clipIds: [clipId],
        durationUs: 2500000,
        pitch: "preserve",
        ripple: "none",
      },
    ]);
    const fixed = await preview({ projectId, revisionId }, "project-fixed", 0, 90, "project");
    assert.notEqual(hash(fixed.rgb), hash(full.rgb));
    for (const i of [15, 30, 52, 70, 89])
      await picture({ projectId, revisionId }, "project-" + i, i, "project");
    // Freeze five independent analytic values through the ordinary static processor.
    const reset = await call("edit.restore", {
      projectId,
      expectedRevisionId: revisionId,
      targetRevisionId: selection.revisionId,
      requestId: randomUUID(),
    });
    revisionId = reset.id;
    for (const i of [15, 30, 52, 70, 89]) {
      const scale = expectedScale(i, "content");
      await edit([
        {
          operation: "processing.set",
          target: { kind: "clip", id: clipId },
          steps: [{ processor: { type: "geometry", scale: { x: scale, y: scale } } }],
        },
      ]);
      await picture({ projectId, revisionId }, "static-content-" + i, i, "content");
      assert.equal(
        report.pictures.at(-1).sha256,
        report.pictures.find((v) => v.name === "content-" + i).sha256,
        "Animated frame differs from static analytic control",
      );
    }
    report.analyticStaticPicturesExact = 5;
    report.splitFullPixelsExact = true;
    report.exportPixelsExact = true;
    assert.equal(hash(await readFile(source)), report.sourceSha256);
    report.passed = true;
  } finally {
    await service.stop();
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await rm(home, { recursive: true, force: true });
  }
}
