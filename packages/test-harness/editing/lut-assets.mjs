import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(
  values.out && process.env.YAP_NATIVE,
  "Usage: YAP_NATIVE=WORKER node packages/test-harness/editing/lut-assets.mjs --out NEW_DIRECTORY",
);
const out = resolve(values.out);
await mkdir(out);
const home = await mkdtemp("/tmp/yap-lut-public-");
const recipientHome = await mkdtemp("/tmp/yap-lut-recipient-");
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const donor = new JourneyService(home, report, join(out, "native"));
const recipient = new JourneyService(recipientHome, report);
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const ffmpeg =
  process.env.YAP_FFMPEG ?? join(root, "helpers/ffmpeg/.build/distribution/bin/ffmpeg");
const pixels = async (path) =>
  Buffer.from(
    (
      await run(
        ffmpeg,
        ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        { encoding: "buffer" },
      )
    ).stdout,
  );
function cube(size, map) {
  const rows = [`LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++)
        rows.push(map(r / (size - 1), g / (size - 1), b / (size - 1)).join(" "));
  return rows.join("\n") + "\n";
}
try {
  await donor.start();
  const call = donor.call.bind(donor);
  report.capabilities = await call("processing.capabilities", {}, { transport: "mcp" });
  const capability = report.capabilities.find((v) => v.type === "lut");
  assert.ok(
    capability.execution &&
      capability.implementationId.startsWith("coreimage-unit-linear-srgb-cube-trilinear-v1:"),
  );
  const importAsset = async (path) => {
    const admitted = await call("asset.import", { requestId: randomUUID(), path });
    const ready = await poll(
      () => call("job.get", { jobId: admitted.jobId }),
      (v) => v.state === "ready",
      "import",
    );
    return call("asset.get", { assetId: ready.published.output.assetId }, { transport: "mcp" });
  };
  const identityPath = join(out, "identity.cube"),
    lookPath = join(out, "look.cube");
  await writeFile(
    identityPath,
    cube(3, (r, g, b) => [r, g, b]),
  );
  await writeFile(
    lookPath,
    cube(3, (r, g, b) => [r * 0.8, g * 0.9, b]),
  );
  const identity = await importAsset(identityPath),
    look = await importAsset(lookPath);
  assert.deepEqual(look.lut, {
    format: "cube-3d",
    size: 3,
    domain: "unit",
    ordering: "red-fastest",
  });
  assert.equal(look.id, hash(await readFile(lookPath)));
  assert.deepEqual(look.streams, []);
  const shot = await importAsset(
    join(root, "specs/done/video-editing-feedback/assets/01-corpus-picture/lily-12-original.png"),
  );
  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 320,
      height: 180,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = project.project.projectId;
  let revisionId = project.revision.revisionId;
  const edit = async (operations) => {
    const v = await call("edit.apply", {
      projectId,
      expectedRevisionId: revisionId,
      requestId: randomUUID(),
      operations,
    });
    revisionId = v.revision.revisionId;
    return v;
  };
  const placed = await edit([
    { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
    {
      operation: "place",
      label: "shot",
      clip: {
        trackId: { label: "v" },
        assetId: shot.id,
        streamId: shot.streams[0].streamId,
        source: { kind: "hold", atUs: 0 },
        placement: { kind: "project", range: { startUs: 0, endUs: 500000 } },
      },
    },
  ]);
  const target = { kind: "clip", id: placed.edit.labels.shot };
  const frame = async (name, service = donor, id = projectId, revision = revisionId) => {
    const request = { projectId: id, revisionId: revision, atUs: 1, maxLongEdge: 320 };
    const result = await poll(
      () => service.call("frame.get", request),
      (v) => v.state === "ready",
      name,
    );
    const file = join(out, name + ".png");
    await service.call("frame.get", request, { output: file });
    return { result, file, rgb: await pixels(file) };
  };
  const dry = await frame("dry");
  const processor = (assetId) => ({
    type: "lut",
    assetId,
    colorSpace: "linear-srgb",
    interpolation: "trilinear",
  });
  await edit([
    { operation: "processing.set", target, steps: [{ processor: processor(identity.id) }] },
  ]);
  const same = await frame("identity");
  assert.deepEqual(same.rgb, dry.rgb);
  await edit([{ operation: "processing.set", target, steps: [{ processor: processor(look.id) }] }]);
  const graded = await frame("graded");
  assert.notDeepEqual(graded.rgb, dry.rgb);
  assert.ok(graded.result.published.output.implementationId.includes(capability.implementationId));
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const encoded = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  let maximumError = 0,
    sum = 0;
  const expected = Buffer.alloc(dry.rgb.length);
  for (let i = 0; i < expected.length; i++) {
    const gain = [0.8, 0.9, 1][i % 3];
    expected[i] = Math.round(encoded(linear(dry.rgb[i] / 255) * gain) * 255);
    const error = Math.abs(expected[i] - graded.rgb[i]);
    maximumError = Math.max(maximumError, error);
    sum += error;
  }
  report.numeric = { maximumError, meanError: sum / expected.length, channels: expected.length };
  await save();
  assert.ok(
    maximumError <= 1,
    "Independent encoded/linear affine LUT response must agree within one delivery code value",
  );
  await writeFile(join(out, "expected.rgb"), expected);
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-s",
    "320x180",
    "-i",
    join(out, "expected.rgb"),
    "-frames:v",
    "1",
    join(out, "reference.png"),
  ]);
  const movieId = randomUUID();
  await call("export.create", {
    projectId,
    revisionId,
    requestId: movieId,
    kind: "video",
    directory: out,
    leaf: "graded.mp4",
  });
  report.movie = await poll(
    () => call("export.status", { exportId: movieId }),
    (v) => v.state === "ready" && !v.cleanupPending,
    "movie",
  );
  await run(ffmpeg, [
    "-v",
    "error",
    "-i",
    report.movie.output,
    "-vf",
    "colorspace=all=bt709:trc=iec61966-2-1:range=pc,format=rgb24",
    "-frames:v",
    "1",
    join(out, "movie-frame.png"),
  ]);
  const movieRGB = await pixels(join(out, "movie-frame.png"));
  let codecError = 0;
  for (let i = 0; i < movieRGB.length; i++) codecError += Math.abs(movieRGB[i] - graded.rgb[i]);
  report.movieDifference = { meanError: codecError / movieRGB.length, channels: movieRGB.length };
  let rawReferenceSum = 0,
    rawReferenceMaximum = 0;
  for (let i = 0; i < movieRGB.length; i++) {
    const error = Math.abs(movieRGB[i] - expected[i]);
    rawReferenceSum += error;
    rawReferenceMaximum = Math.max(rawReferenceMaximum, error);
  }
  report.rawReferenceMovieDifference = {
    meanError: rawReferenceSum / movieRGB.length,
    maximumError: rawReferenceMaximum,
    channels: movieRGB.length,
    scope: "first decoded candidate movie frame versus independent lossless reference, no mask",
  };
  await save();
  assert.ok(report.movieDifference.meanError <= 4, "Existing SDR H264 appearance tolerance");
  // Feed the independently computed lossless reference through the same public
  // held-shot/encoder path. This isolates LUT response from known codec conversion.
  const referenceAsset = await importAsset(join(out, "reference.png"));
  const referenceProject = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 320,
      height: 180,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const referencePlaced = await call("edit.apply", {
    projectId: referenceProject.project.projectId,
    expectedRevisionId: referenceProject.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "v" },
          assetId: referenceAsset.id,
          streamId: referenceAsset.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 500000 } },
        },
      },
    ],
  });
  const referenceExportId = randomUUID();
  await call("export.create", {
    projectId: referenceProject.project.projectId,
    revisionId: referencePlaced.revision.revisionId,
    requestId: referenceExportId,
    kind: "video",
    directory: out,
    leaf: "reference.mp4",
  });
  report.referenceMovie = await poll(
    () => call("export.status", { exportId: referenceExportId }),
    (v) => v.state === "ready" && !v.cleanupPending,
    "reference movie",
  );
  const decodedMoviePixels = async (path) =>
    Buffer.from(
      (
        await run(
          ffmpeg,
          [
            "-v",
            "error",
            "-i",
            path,
            "-vf",
            "colorspace=all=bt709:trc=iec61966-2-1:range=pc,format=rgb24",
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { encoding: "buffer" },
        )
      ).stdout,
    );
  const candidateMovie = await decodedMoviePixels(report.movie.output);
  const referenceMovie = await decodedMoviePixels(report.referenceMovie.output);
  assert.equal(candidateMovie.length, 2 * 320 * 180 * 3);
  assert.equal(referenceMovie.length, candidateMovie.length);
  let matchedSum = 0,
    matchedMaximum = 0;
  for (let i = 0; i < candidateMovie.length; i++) {
    const error = Math.abs(candidateMovie[i] - referenceMovie[i]);
    matchedSum += error;
    matchedMaximum = Math.max(matchedMaximum, error);
  }
  report.matchedMovie = {
    meanError: matchedSum / candidateMovie.length,
    maximumError: matchedMaximum,
    channels: candidateMovie.length,
    frames: 2,
    mask: "complete raster, all held-shot frames",
    meanErrorGate: 1,
  };
  await save();
  assert.ok(
    report.matchedMovie.meanError <= 1,
    "Matched native encoded reference LUT response must agree within one mean code value",
  );
  await run(ffmpeg, [
    "-v",
    "error",
    "-i",
    report.referenceMovie.output,
    "-vf",
    "colorspace=all=bt709:trc=iec61966-2-1:range=pc,format=rgb24",
    "-frames:v",
    "1",
    join(out, "reference-movie-frame.png"),
  ]);
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    revisionId,
    exportId,
    kind: "processed-package",
    directory: out,
    leaf: "lut-project.zip",
  });
  report.package = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready" && !v.cleanupPending,
    "package",
  );
  // Only owned scratch state is removed; the external frozen shot and supplied cube files stay intact.
  await donor.stop();
  await rm(home, { recursive: true, force: true });
  await recipient.start();
  const opened = await recipient.call("package.open", { path: report.package.output });
  const ready = await poll(
    () => recipient.call("package.status", { admissionId: opened.id }),
    (v) => v.state === "ready",
    "open",
  );
  report.opened = ready;
  await save();
  const requestId = randomUUID();
  const adopted = await poll(
    () => recipient.call("package.adopt", { packageHandle: ready.packageHandle, requestId }),
    (v) => v.state === "ready",
    "adopt",
  );
  report.adopted = adopted;
  await save();
  const adoptedFrame = await frame(
    "relocated",
    recipient,
    adopted.published.output.projectId,
    adopted.published.output.revisionId,
  );
  assert.deepEqual(adoptedFrame.rgb, graded.rgb);
  report.checks.push(
    "CLI and MCP immutable import/discovery",
    "size-3 identity exact delivered RGB",
    "independent linear/sRGB grade response <=1 code value",
    "native recipe retained",
    "matched encoded independent reference: complete two-frame held-shot RGB MAE <=1",
    "processed ZIP adoption reproduces exact pixels after donor state deletion",
  );
  report.passed = true;
} finally {
  await save();
  await donor.stop();
  await recipient.stop();
  await rm(home, { recursive: true, force: true });
  await rm(recipientHome, { recursive: true, force: true });
}
console.log(
  JSON.stringify({ passed: report.passed, out, checks: report.checks, numeric: report.numeric }),
);
