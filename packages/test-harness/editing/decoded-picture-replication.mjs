import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, poll, run, root, hash } from "./source-evidence-fixture.mjs";
import { verifyPictureSample, verifyPicturePixels } from "./decoded-picture-proof.mjs";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    case: { type: "string" },
    ffmpeg: { type: "string" },
    ffprobe: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node decoded-picture-replication.mjs --out EMPTY_DIRECTORY --ffmpeg ABSOLUTE_EXECUTABLE --ffprobe ABSOLUTE_EXECUTABLE [--case graham|madison|lily|chart|rotated]\nCompare public unchanged source/project frames with the shared player-oriented sRGB reference. Plain FFmpeg RGB is a diagnostic, not the display reference.",
  );
  process.exit(0);
}
assert.ok(
  !values.case || ["graham", "madison", "lily", "chart", "rotated"].includes(values.case),
  "Unknown case",
);
for (const key of ["out", "ffmpeg", "ffprobe"])
  assert.ok(values[key] && isAbsolute(values[key]), `Absolute --${key} required`);
assert.ok(
  process.env.YAP_NATIVE && isAbsolute(process.env.YAP_NATIVE),
  "Pinned YAP_NATIVE required",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true });
assert.deepEqual(await readdir(out), []);
const home = await mkdtemp("/tmp/yap-picture-replication-");
const report = {
  passed: false,
  recipe: {
    output: "color-managed sRGB RGBA8; full oriented raster",
    reference:
      "AVAssetImageGenerator zero requested tolerance + preferred track transform; CoreGraphics explicit sRGB",
    tolerance: { rgbMAEMaximum: 1, maxChannelDelta: 2 },
    plainFfmpeg: "encoded RGB values without applying PNG/display profile; diagnostic only",
  },
  tools: {},
  trace: [],
  cases: [],
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");
try {
  for (const [key, path] of Object.entries({
    native: process.env.YAP_NATIVE,
    ffmpeg: values.ffmpeg,
    ffprobe: values.ffprobe,
  }))
    report.tools[key] = { path, sha256: hash(await readFile(path)) };
  assert.equal(
    report.tools.ffmpeg.sha256,
    "78cd5ab1a088c0db965893f9c4a475beb60525d8dc1f0ecad80e2e8959a8cc33",
  );
  assert.equal(
    report.tools.ffprobe.sha256,
    "b229056ccc5bcf597816babc7957b1a52d93f4874a70f303e81a4ddefa9acc94",
  );
  const reference = join(home, "reference"),
    pixelTool = join(home, "pixels");
  for (const [source, target] of [
    ["FrameColorReference.swift", reference],
    ["FrameImagePixels.swift", pixelTool],
  ])
    await run(
      "swiftc",
      ["-parse-as-library", join(root, "packages/test-harness/editing", source), "-o", target],
      { timeout: 120000 },
    );
  let reads = 0;
  async function pixels(file) {
    const output = join(home, `rgba-${reads++}`);
    const receipt = JSON.parse((await run(pixelTool, [file, output], { timeout: 30000 })).stdout);
    const bytes = await readFile(output);
    await rm(output);
    assert.equal(bytes.length, receipt.width * receipt.height * 4);
    assert.equal(receipt.opaque, true);
    return { receipt, bytes };
  }
  function compare(a, b) {
    assert.equal(a.length, b.length);
    let sum = 0,
      squares = 0,
      max = 0;
    for (let i = 0; i < a.length; i++) {
      const delta = Math.abs(a[i] - b[i]);
      sum += delta;
      squares += delta * delta;
      max = Math.max(max, delta);
    }
    return {
      mae: sum / a.length,
      maxDelta: max,
      psnr: squares === 0 ? null : 10 * Math.log10(255 ** 2 / (squares / a.length)),
    };
  }
  function rgb(rgba) {
    const out = Buffer.alloc((rgba.length / 4) * 3);
    for (let i = 0; i < rgba.length / 4; i++)
      for (let c = 0; c < 3; c++) out[i * 3 + c] = rgba[i * 4 + c];
    return out;
  }
  const manifest = JSON.parse(
    await readFile(join(root, "fixtures/video-editing-feedback/manifest.json")),
  );
  const cases = ["graham", "madison", "lily"].map((id) => {
    const c = manifest.cases.find((v) => v.id === `${id}-picture`);
    return {
      id,
      file: join(root, "fixtures/video-editing-feedback", c.derivative.file),
      sha256: c.derivative.sha256,
      width: 1920,
      height: 1080,
      frames: [0, 12, 36, 71],
      fps: 24,
      durationUs: 3000000,
    };
  });
  const chart = join(root, "specs/done/agent-editing/assets/00-corpus/a.mov");
  const chartHash = "f3b7d8f718e1724f7c22bee97419cafca0df7180ce3637eaf3fb2c19513002bd";
  assert.equal(hash(await readFile(chart)), chartHash, "Frozen asymmetric chart identity");
  cases.push({
    id: "chart",
    file: chart,
    sha256: chartHash,
    width: 160,
    height: 96,
    frames: [0, 2, 4, 7],
    fps: 4,
    durationUs: 2000000,
  });
  const rotated = join(home, "rotated.mov");
  if (!values.case || values.case === "rotated") {
    await run(
      values.ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-display_rotation",
        "90",
        "-i",
        chart,
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        rotated,
      ],
      { timeout: 30000 },
    );
    assert.equal(
      hash(await readFile(rotated)),
      "f96deff887e5882c53ea89bb9edd2f1c013291d6088ab9edd1d49db59283a35e",
      "Frozen orientation-only control identity",
    );
    cases.push({
      id: "rotated",
      file: rotated,
      sha256: hash(await readFile(rotated)),
      width: 96,
      height: 160,
      frames: [0, 2, 4, 7],
      fps: 4,
      durationUs: 2000000,
      controlRecipe: {
        sourceSHA256: chartHash,
        arguments: [
          "-nostdin",
          "-v",
          "error",
          "-display_rotation",
          "90",
          "-i",
          "SOURCE",
          "-map",
          "0:v:0",
          "-an",
          "-c:v",
          "copy",
          "OUTPUT",
        ],
      },
    });
  }
  const selected = values.case ? cases.filter((c) => c.id === values.case) : cases;
  assert.ok(selected.length, "Unknown case");
  await service.start();
  for (const c of selected) {
    const directory = join(out, c.id);
    await mkdir(directory);
    assert.equal(hash(await readFile(c.file)), c.sha256);
    const row = {
      ...c,
      metadata: JSON.parse(
        (
          await run(
            values.ffprobe,
            ["-v", "error", "-show_streams", "-show_frames", "-of", "json", c.file],
            { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
          )
        ).stdout,
      ),
      samples: [],
      coverage: { requested: c.frames.length, available: 0, failed: 0 },
    };
    report.cases.push(row);
    const request = {
      movie: c.file,
      output: directory,
      timesUs: c.frames.map((n) => Math.ceil((n * 1000000) / c.fps)),
    };
    await save(join(directory, "player-request.json"), request);
    const references = JSON.parse(
      (await run(reference, [join(directory, "player-request.json")], { timeout: 30000 })).stdout,
    );
    await save(join(directory, "player-receipts.json"), references);
    assert.equal(references.length, c.frames.length);
    const ack = await call("asset.import", { path: c.file, requestId: `import-${c.id}` });
    const job = await poll(
      () => call("job.get", { jobId: ack.jobId }),
      (v) => v.state === "ready",
      "import",
    );
    const asset = await call("asset.get", { assetId: job.published.output.assetId });
    const source = {
      assetId: asset.assetId,
      streamId: asset.streams.find((v) => v.kind === "video").streamId,
    };
    row.import = { ack, job, source };
    const create = await call("project.create", {
      requestId: `project-${c.id}`,
      canvas: {
        width: c.width,
        height: c.height,
        fps: { numerator: c.fps, denominator: 1 },
        background: "#000000ff",
      },
    });
    const editRequest = {
      projectId: create.project.projectId,
      expectedRevisionId: create.revision.revisionId,
      requestId: `place-${c.id}`,
      operations: [
        { operation: "track.add", label: "picture", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          clip: {
            ...source,
            trackId: { label: "picture" },
            source: { kind: "range", range: { startUs: 0, endUs: c.durationUs } },
            placement: { kind: "project", range: { startUs: 0, endUs: c.durationUs } },
          },
        },
      ],
    };
    const edited = await call("edit.apply", editRequest);
    const project = { projectId: create.project.projectId, revisionId: edited.revision.revisionId };
    row.project = { create, editRequest, edited };
    for (const [i, n] of c.frames.entries()) {
      const ref = references[i],
        sample = { index: n, reference: ref };
      row.samples.push(sample);
      try {
        assert.equal(ref.status, "available", "Player observation failed");
        assert.equal(
          BigInt(ref.actualValue) * BigInt(c.fps),
          BigInt(n) * BigInt(ref.actualTimescale),
        );
        const expected = await pixels(ref.file);
        assert.deepEqual([expected.receipt.width, expected.receipt.height], [c.width, c.height]);
        verifyPicturePixels(expected.receipt);
        assert.equal(
          ref.outputProfile,
          expected.receipt.sourceProfile,
          "Reference encoded profile",
        );
        assert.equal(
          ref.outputProfileSHA256,
          expected.receipt.sourceProfileSHA256,
          "Reference encoded ICC",
        );
        sample.referencePixels = expected.receipt;
        const referenceRGB = rgb(expected.bytes);
        for (const [kind, selection] of Object.entries({ source, project })) {
          const params = { ...selection, atUs: request.timesUs[i], maxLongEdge: 8192 };
          await poll(
            () => call("frame.get", params, { transport: "mcp" }),
            (v) => v.state === "ready",
            `${kind} picture`,
          );
          const file = join(directory, `${kind}-${n}.png`);
          const receipt = await call("frame.get", params, { output: file });
          const actual = await pixels(file);
          verifyPicturePixels(actual.receipt);
          assert.deepEqual([actual.receipt.width, actual.receipt.height], [c.width, c.height]);
          const difference = compare(rgb(actual.bytes), referenceRGB);
          sample[kind] = {
            request: params,
            receipt,
            pixels: actual.receipt,
            pngSHA256: hash(await readFile(file)),
            difference,
          };
          assert.ok(
            difference.mae <= report.recipe.tolerance.rgbMAEMaximum &&
              difference.maxDelta <= report.recipe.tolerance.maxChannelDelta,
            `${c.id}/${n}/${kind}: ${JSON.stringify(difference)}`,
          );
        }
        verifyPictureSample(sample, c.fps);
        const ffFile = join(directory, `ffmpeg-${n}.png`);
        await run(
          values.ffmpeg,
          [
            "-nostdin",
            "-v",
            "error",
            "-i",
            c.file,
            "-vf",
            `select=eq(n\\,${n})`,
            "-frames:v",
            "1",
            ffFile,
          ],
          { timeout: 30000 },
        );
        const plain = (
          await run(
            values.ffmpeg,
            [
              "-nostdin",
              "-v",
              "error",
              "-i",
              ffFile,
              "-pix_fmt",
              "rgb24",
              "-f",
              "rawvideo",
              "pipe:1",
            ],
            { encoding: "buffer", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
          )
        ).stdout;
        const display = await pixels(ffFile);
        sample.ffmpeg = {
          pngSHA256: hash(await readFile(ffFile)),
          pixels: display.receipt,
          rawRGB: compare(plain, referenceRGB),
          displayRGB: compare(rgb(display.bytes), referenceRGB),
        };
        sample.status = "available";
        row.coverage.available++;
        console.log(
          JSON.stringify({
            case: c.id,
            frame: n,
            source: sample.source.difference,
            project: sample.project.difference,
            plainFfmpeg: sample.ffmpeg.rawRGB,
          }),
        );
      } catch (error) {
        sample.status = "failed";
        sample.error = { name: error.name, message: error.message };
        row.coverage.failed++;
      }
    }
    assert.equal(hash(await readFile(c.file)), c.sha256);
    assert.equal(row.coverage.available + row.coverage.failed, row.coverage.requested);
  }
  assert.ok(
    report.cases.every((c) => c.coverage.failed === 0),
    "Required picture observations failed; see report",
  );
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message };
  throw error;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      await save(join(out, "report.json"), report);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
