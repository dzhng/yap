import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import {
  sourceSurface,
  geometrySurface,
  background,
  over,
  expectedRgba,
  compareGeometry,
  compareLandmarks,
} from "./layers-oracle.mjs";
import { prepareMotionFixture } from "./layer-edit-motion-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Freeze the native compositor before running this journey");
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "motion-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-motion-"));
const report = { passed: false, trace: [], frames: [], checks: {}, movies: [] };
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const canvas = { width: 160, height: 96 };
const geometry = {
  type: "geometry",
  crop: { x: 4, y: 4, width: 56, height: 40 },
  rect: { x: 16, y: 8, width: 112, height: 80 },
  fit: "stretch",
};
const ref = (label) => ({ label });
let fixtures,
  projectId,
  ordinal = 0;
async function importMedia(fixture) {
  const job = await call("asset.import", { requestId: fixture.sha256, path: fixture.path });
  await poll(
    () => call("job.get", { jobId: job.jobId }),
    (value) => value.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: fixture.sha256 });
  return { assetId: asset.id, streamId: asset.streams[0].streamId };
}
function expected(frameIndex, clipOnly = false, screenVisible = true) {
  let surface = clipOnly ? background(canvas, [0, 0, 0, 0]) : background(canvas);
  if (!clipOnly && screenVisible)
    surface = over(surface, geometrySurface(sourceSurface(fixtures.media.screen), {}, canvas));
  if (frameIndex !== null)
    surface = over(
      surface,
      geometrySurface(sourceSurface(fixtures.motion.frames[frameIndex]), geometry, canvas),
    );
  return expectedRgba(surface);
}
async function delivered(
  revisionId,
  atUs,
  name,
  frameIndex,
  sourceUs,
  clipId,
  clipOnly = false,
  screenVisible = true,
) {
  const params = {
    projectId,
    revisionId,
    atUs,
    ...(clipOnly
      ? { tap: { target: { kind: "clip", id: clipId }, point: { kind: "processed" } } }
      : {}),
  };
  await poll(
    () => call("frame.get", params),
    (value) => value.state === "ready",
    name,
  );
  const file = join(out, `${ordinal++}-${name}.png`);
  const ready = await call("frame.get", params, { output: file });
  const mcp = await service.mcp.callTool({ name: "frame.get", arguments: params });
  assert.equal(mcp.structuredContent.ok, true);
  const images = mcp.content.filter((item) => item.type === "image");
  assert.equal(images.length, 1);
  const bytes = await readFile(file);
  assert.ok(bytes.equals(Buffer.from(images[0].data, "base64")));
  const receipt = ready.published.output;
  const actual = receipt.pictures.find((picture) => picture.clipId === clipId);
  if (frameIndex === null) assert.equal(actual, undefined);
  else {
    assert.equal(actual.requestedSourceUs, sourceUs);
    assert.equal(actual.actualSourceUs, frameIndex * 100000);
    assert.equal(actual.status, "available");
  }
  const rgbaFile = file + ".rgba";
  await run(fixtures.pixelTool, [file, rgbaFile]);
  const rgba = await readFile(rgbaFile),
    oracle = expected(frameIndex, clipOnly, screenVisible);
  const verdict = compareGeometry(rgba, oracle, canvas.width, canvas.height);
  const expectedFile = file + ".expected.png";
  await writeFile(file + ".expected.rgba", oracle);
  await run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    "160x96",
    "-i",
    file + ".expected.rgba",
    "-frames:v",
    "1",
    expectedFile,
  ]);
  const result = {
    name,
    file,
    expectedFile,
    atUs,
    sourceUs,
    frameIndex,
    sha256: hash(bytes),
    receipt,
    verdict,
  };
  report.frames.push(result);
  return result;
}
function emptyMovie(actual) {
  assert.equal(actual.length, canvas.width * canvas.height * 4);
  let maximumError = 0;
  for (let at = 0; at < actual.length; at += 4) {
    assert.equal(actual[at + 3], 255, "Blank movie background must remain opaque");
    for (let channel = 0; channel < 3; channel++) {
      maximumError = Math.max(maximumError, actual[at + channel]);
      assert.ok(
        actual[at + channel] <= 2,
        "Blank movie exceeds the existing two-code-value budget",
      );
    }
  }
  return { emptyBackground: true, maximumError };
}
async function movie(revisionId, range, mapping, name) {
  const file = join(out, `${name}.mp4`),
    params = { projectId, revisionId, ...(range ? { range } : {}) };
  const selected = range ?? { startUs: 0, endUs: 3000000 };
  const ready = await poll(
    () => call("preview.get", params, { output: file }),
    (v) => v.state === "ready",
    name,
  );
  const mcp = await call("preview.get", params, { transport: "mcp" });
  const chunks = [];
  let offset = 0;
  try {
    while (offset < mcp.delivery.bytes) {
      const part = await call(
        "artifact.read",
        { token: mcp.delivery.token, offset, maxBytes: 65536 },
        { transport: "mcp" },
      );
      const bytes = Buffer.from(part.data, "base64");
      assert.ok(bytes.length > 0);
      assert.equal(part.nextOffset, offset + bytes.length);
      chunks.push(bytes);
      offset = part.nextOffset;
    }
    assert.ok(
      Buffer.concat(chunks).equals(await readFile(file)),
      "CLI and MCP preview bytes differ",
    );
  } finally {
    await call("artifact.close", { token: mcp.delivery.token }, { transport: "mcp" });
  }
  const times = [0];
  for (
    let t = (Math.floor(selected.startUs / 100000) + 1) * 100000;
    t < selected.endUs;
    t += 100000
  )
    times.push(t - selected.startUs);
  const directory = join(out, name + "-frames");
  await mkdir(directory);
  const request = join(directory, "request.json");
  await writeFile(request, JSON.stringify({ movie: file, output: directory, timesUs: times }));
  const decoded = JSON.parse((await run(fixtures.referenceTool, [request])).stdout);
  const checked = [];
  for (const frame of decoded) {
    assert.equal(frame.status, "available", frame.error);
    const sampleAtUs = Math.floor((selected.startUs + frame.requestedUs) / 100000) * 100000;
    const sourceUs = mapping(sampleAtUs),
      frameIndex = sourceUs === null ? null : Math.floor(sourceUs / 100000);
    const rgbaPath = frame.file + ".rgba";
    await run(fixtures.pixelTool, [frame.file, rgbaPath]);
    const oracle = expected(frameIndex, false, sampleAtUs < 1000000);
    const actual = await readFile(rgbaPath);
    const blank = sourceUs === null && sampleAtUs >= 1000000;
    const verdict = blank
      ? emptyMovie(actual)
      : compareLandmarks(actual, oracle, canvas.width, canvas.height);
    if (blank && !report.checks.blankCodecBudget) {
      const color = Buffer.from(actual);
      color[0] = 3;
      assert.throws(() => emptyMovie(color), /two-code-value budget/);
      const alpha = Buffer.from(actual);
      alpha[3] = 254;
      assert.throws(() => emptyMovie(alpha), /remain opaque/);
      report.checks.blankCodecBudget = {
        maximumAllowedRgb: 2,
        requiredAlpha: 255,
        colorAndAlphaNegativeControls: true,
      };
    }
    const expectedFile = frame.file + ".expected.png",
      raw = frame.file + ".expected.rgba";
    await writeFile(raw, oracle);
    await run("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "rawvideo",
      "-pixel_format",
      "rgba",
      "-video_size",
      "160x96",
      "-i",
      raw,
      "-frames:v",
      "1",
      expectedFile,
    ]);
    checked.push({
      name: `${name}-${frame.requestedUs}`,
      file: frame.file,
      expectedFile,
      sampleAtUs,
      sourceUs,
      frameIndex,
      verdict,
    });
  }
  const probe = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time,duration_time",
        "-of",
        "json",
        file,
      ])
    ).stdout,
  );
  assert.deepEqual(
    probe.frames.map((f) => Math.round(Number(f.best_effort_timestamp_time) * 1000000)),
    times,
  );
  assert.deepEqual(
    probe.frames.map((f) => Math.round(Number(f.duration_time) * 1000000)),
    times.map((t, i) => (times[i + 1] ?? selected.endUs - selected.startUs) - t),
  );
  report.movies.push({
    name,
    file,
    range: selected,
    frames: checked,
    receipt: ready.published.output,
  });
}
async function protectedAudio(revisionId, name) {
  const file = join(out, name + ".wav");
  const ready = await poll(
    () =>
      call(
        "audio.get",
        { projectId, revisionId, range: { startUs: 0, endUs: 1000000 } },
        { output: file },
      ),
    (v) => v.state === "ready",
    name,
  );
  const decoded = (
    await run(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", file, "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    )
  ).stdout;
  assert.ok(
    decoded.equals(fixtures.media.narration.pcm),
    "Video edits changed the independent narration plane",
  );
  return { file, pcmSha256: hash(decoded), receipt: ready.published.output };
}
try {
  fixtures = await prepareMotionFixture(home, out);
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  await service.start();
  const [motion, screen, narration] = await Promise.all([
    importMedia(fixtures.motion),
    importMedia(fixtures.media.screen),
    importMedia(fixtures.media.narration),
  ]);
  const created = await call("project.create", {
    requestId: "motion",
    canvas: { ...canvas, fps: { numerator: 10, denominator: 1 }, background: "#000000ff" },
  });
  projectId = created.project.projectId;
  const place = (label, track, source) => ({
    operation: "place",
    label,
    clip: {
      ...source,
      trackId: ref(track),
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  });
  const initial = await call("edit.apply", {
    projectId,
    expectedRevisionId: created.revision.revisionId,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "screen-track", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "motion-track", track: { kind: "video", order: 1 } },
      { operation: "track.add", label: "audio-track", track: { kind: "audio", order: 2 } },
      place("screen", "screen-track", screen),
      place("motion", "motion-track", motion),
      place("audio", "audio-track", narration),
      {
        operation: "place",
        clip: {
          trackId: ref("audio-track"),
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 1000000, endUs: 3000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: ref("motion") },
        steps: [{ label: "layout", processor: geometry }],
      },
    ],
  });
  const clipId = initial.edit.labels.motion,
    splitAtUs = 333333;
  const split = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: initial.revision.revisionId,
      requestId: "split",
      operations: [
        {
          operation: "split",
          clipIds: [clipId],
          atUs: splitAtUs,
          rightLabels: [{ clipId, label: "right" }],
        },
      ],
    },
    { transport: "mcp" },
  );
  for (const atUs of [0, 200000, 300000, 333332, 333333, 333334, 400000, 900000, 999999]) {
    const sourceUs = Math.floor(atUs / 100000) * 100000;
    const before = await delivered(
      initial.revision.revisionId,
      atUs,
      `original-${atUs}`,
      sourceUs / 100000,
      sourceUs,
      clipId,
    );
    const after = await delivered(
      split.revision.revisionId,
      atUs,
      `split-${atUs}`,
      sourceUs / 100000,
      sourceUs,
      sourceUs < splitAtUs ? clipId : split.edit.labels.right,
    );
    assert.equal(before.sha256, after.sha256, `Pure split changed moving picture at ${atUs}`);
  }
  report.checks.fractionalSplit = { splitAtUs, unchanged: true };
  const duplicate = await call("edit.apply", {
    projectId,
    expectedRevisionId: split.revision.revisionId,
    requestId: "copy",
    operations: [
      {
        operation: "duplicate",
        clipIds: [clipId],
        atUs: 1200000,
        copyLabels: [{ clipId, label: "copy" }],
      },
    ],
  });
  const copyId = duplicate.edit.labels.copy;
  for (const sourceUs of [0, 100000, 200000, 300000])
    await delivered(
      duplicate.revision.revisionId,
      1200000 + sourceUs,
      `copy-${sourceUs}`,
      sourceUs / 100000,
      sourceUs,
      copyId,
      true,
      false,
    );
  const destination = 1733333;
  const moved = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: duplicate.revision.revisionId,
      requestId: "move",
      operations: [{ operation: "move", clipIds: [copyId], atUs: destination, ripple: "none" }],
    },
    { transport: "mcp" },
  );
  for (const atUs of [1200000, 1733333, 1799999, 1800000, 1900000, 2000000, 2100000]) {
    const sample = Math.floor(atUs / 100000) * 100000;
    const sourceUs =
      sample >= destination && sample < destination + splitAtUs ? sample - destination : null;
    await delivered(
      moved.revision.revisionId,
      atUs,
      `moved-${atUs}`,
      sourceUs === null ? null : Math.floor(sourceUs / 100000),
      sourceUs,
      copyId,
      true,
      false,
    );
  }
  const keep = { startUs: 1833333, endUs: 2033333 };
  const trimmed = await call("edit.apply", {
    projectId,
    expectedRevisionId: moved.revision.revisionId,
    requestId: "trim",
    operations: [{ operation: "trim", clipId: copyId, range: keep, ripple: "none" }],
  });
  for (const atUs of [1800000, 1833333, 1899999, 1900000, 2000000, 2033333, 2099999, 2100000]) {
    const sample = Math.floor(atUs / 100000) * 100000;
    const sourceUs = sample >= keep.startUs && sample < keep.endUs ? sample - destination : null;
    await delivered(
      trimmed.revision.revisionId,
      atUs,
      `trimmed-${atUs}`,
      sourceUs === null ? null : Math.floor(sourceUs / 100000),
      sourceUs,
      copyId,
      true,
      false,
    );
  }
  const before = await delivered(
    initial.revision.revisionId,
    200000,
    "protected-original-revision",
    2,
    200000,
    clipId,
  );
  const after = await delivered(
    trimmed.revision.revisionId,
    200000,
    "protected-original-clip",
    2,
    200000,
    clipId,
  );
  assert.equal(before.sha256, after.sha256);
  const a = await protectedAudio(initial.revision.revisionId, "original-audio"),
    b = await protectedAudio(trimmed.revision.revisionId, "protected-audio");
  assert.equal(a.pcmSha256, b.pcmSha256);
  assert.equal(
    hash(await readFile(fixtures.motion.path)),
    fixtures.motion.sha256,
    "Edits changed original source bytes",
  );
  const mapping = (sample) =>
    sample < 1000000
      ? sample
      : sample >= keep.startUs && sample < keep.endUs
        ? sample - destination
        : null;
  await movie(trimmed.revision.revisionId, null, mapping, "whole");
  await movie(trimmed.revision.revisionId, { startUs: 1850001, endUs: 2050001 }, mapping, "range");
  report.checks.edits = {
    copyAtUs: 1200000,
    destination,
    trim: keep,
    originalPixelsUnchanged: true,
    originalSourceUnchanged: true,
    protectedAudio: { original: a, edited: b },
  };
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await service.stop().catch((error) => {
    report.passed = false;
    report.shutdownError = error.message;
    process.exitCode = 1;
  });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
