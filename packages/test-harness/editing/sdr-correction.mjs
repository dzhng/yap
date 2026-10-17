import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out && process.env.YAP_NATIVE, "Pass --out NEW_DIRECTORY and YAP_NATIVE");
const out = resolve(values.out);
await mkdir(out);
const home = await mkdtemp("/tmp/yap-sdr-");
const source = join(root, "specs/done/ffmpeg-parity/evidence/motion-interchange/phase-0.png");
const reference = join(
  root,
  "specs/done/ffmpeg-parity/evidence/sdr-correction/core-image/imported",
);
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  sourceSha256: hash(await readFile(source)),
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const ffmpeg = join(root, "helpers/ffmpeg/.build/distribution/bin/ffmpeg");
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
try {
  await service.start();
  report.capabilities = await call("processing.capabilities", {});
  const capability = report.capabilities.find((c) => c.type === "sdr-correction");
  assert.ok(
    capability.execution &&
      capability.implementationId.startsWith("coreimage-sdr-source-neutral-recovery-v2:"),
  );
  const admitted = await call("asset.import", { requestId: randomUUID(), path: source });
  const ready = await poll(
    () => call("job.get", { jobId: admitted.jobId }),
    (v) => v.state === "ready",
    "still import",
  );
  const asset = await call("asset.get", { assetId: ready.published.output.assetId });
  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = project.project.projectId;
  let revisionId = project.revision.id;
  const edit = async (operations) => {
    const result = await call("edit.apply", {
      projectId,
      expectedRevisionId: revisionId,
      requestId: randomUUID(),
      operations,
    });
    revisionId = result.revision.id;
    return result;
  };
  const placed = await edit([
    { operation: "track.add", label: "track", track: { kind: "video", order: 0 } },
    {
      operation: "place",
      label: "clip",
      clip: {
        trackId: { label: "track" },
        assetId: asset.id,
        streamId: asset.streams[0].id,
        source: { kind: "hold", atUs: 0 },
        placement: { kind: "project", range: { startUs: 0, endUs: 250000 } },
      },
    },
  ]);
  const picture = async (name) => {
    const request = { projectId, revisionId, atUs: 1 };
    const result = await poll(
      () => call("frame.get", request),
      (v) => v.state === "ready",
      name,
    );
    const path = join(out, name + ".png");
    await call("frame.get", request, { output: path });
    await save();
    if (name !== "control")
      assert.ok(
        result.published.output.implementationId.includes(capability.implementationId),
        "Persisted frame must retain actual native SDR recipe",
      );
    return { result, path, pixels: await pixels(path) };
  };
  const control = await picture("control");
  const set = (processor) =>
    edit([
      {
        operation: "processing.set",
        target: { kind: "clip", id: placed.edit.labels.clip },
        steps: [{ processor }],
      },
    ]);
  await set({ type: "sdr-correction" });
  const identity = await picture("identity");
  assert.deepEqual(identity.pixels, control.pixels);
  const identityRevision = revisionId;
  for (const [name, parameters] of [
    ["exposure", { exposureEV: 1 }],
    ["saturation", { saturation: 0 }],
  ]) {
    await set({ type: "sdr-correction", ...parameters });
    const candidate = await picture(name);
    const expected = await pixels(join(reference, name + ".png"));
    assert.notDeepEqual(candidate.pixels, control.pixels);
    await save();
    assert.deepEqual(
      candidate.pixels,
      expected,
      "Production picture must preserve frozen recipe pixels",
    );
  }
  report.checks.push(
    "explicit public processor changes pixels; identity exact; exposure/saturation equal frozen recipe",
  );
  report.nativeRefusals = [];
  for (const identity of [undefined, "wrong-host"]) {
    const output = join(out, identity ? "wrong-recipe.png" : "missing-recipe.png");
    const request = {
      id: "recipe-refusal",
      operation: "media.renderCompositionFrame",
      params: {
        output,
        profile: "h264-rec709",
        processing: [],
        assets: [],
        maxLongEdge: 64,
        canvas: project.revision.document.canvas,
        ...(identity ? { sdrCorrectionImplementationId: identity } : {}),
        frame: {
          index: 0,
          sampleAtUs: 0,
          visibleRange: { startUs: 0, endUs: 1 },
          layers: [],
          visual: [
            {
              target: { kind: "output" },
              inputs: [],
              operations: [
                {
                  kind: "sdr-correction",
                  exposureEV: 1,
                  contrast: 1,
                  saturation: 1,
                  shadows: 0,
                  highlights: 0,
                  neutralKelvin: 6500,
                  neutralTint: 0,
                },
              ],
            },
          ],
        },
      },
    };
    const execution = spawnSync(process.env.YAP_NATIVE, [], {
      input: JSON.stringify(request) + "\n",
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr);
    const response = JSON.parse(execution.stdout);
    report.nativeRefusals.push({ request, response });
    await save();
    assert.equal(response.error?.code, "NOT_READY");
    await assert.rejects(readFile(output), { code: "ENOENT" });
  }

  // Both preview and export consume the same bound correction and exact revision.
  const previewParams = { projectId, revisionId, range: { startUs: 160001, endUs: 250000 } };
  const preview = await poll(
    () => call("preview.get", previewParams),
    (v) => v.state === "ready",
    "preview",
  );
  const movie = join(out, "preview.mp4");
  await call("preview.get", previewParams, { output: movie });
  report.preview = preview;
  assert.ok(
    preview.published.output.implementationId.includes(capability.implementationId),
    "Persisted preview must retain actual native SDR recipe",
  );
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    revisionId,
    exportId,
    kind: "video",
    directory: out,
    leaf: "export.mp4",
  });
  report.export = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready" && !v.cleanupPending,
    "export",
  );
  for (const [name, path] of [
    ["preview", movie],
    ["export", report.export.output],
  ])
    await run(ffmpeg, [
      "-v",
      "error",
      "-i",
      path,
      "-vf",
      "colorspace=all=bt709:trc=iec61966-2-1:range=pc,format=rgb24",
      "-frames:v",
      "1",
      join(out, name + ".png"),
    ]);
  const expected = await pixels(join(out, "saturation.png"));
  report.codecDifferences = [];
  for (const name of ["preview", "export"]) {
    const actual = await pixels(join(out, name + ".png"));
    assert.equal(actual.length, expected.length);
    let sum = 0;
    for (let i = 0; i < actual.length; i++) sum += Math.abs(actual[i] - expected[i]);
    const mae = sum / actual.length;
    report.codecDifferences.push({ name, mae });
    await save();
    assert.ok(mae <= 4, "Existing H264 appearance tolerance");
  }
  assert.deepEqual(await pixels(join(out, "preview.png")), await pixels(join(out, "export.png")));
  const historical = { projectId, revisionId: identityRevision, atUs: 1 };
  await poll(
    () => call("frame.get", historical),
    (v) => v.state === "ready",
    "historical identity",
  );
  await call("frame.get", historical, { output: join(out, "historical-identity.png") });
  assert.deepEqual(await pixels(join(out, "historical-identity.png")), control.pixels);
  const bypass = await edit([
    {
      operation: "processing.set",
      target: { kind: "clip", id: placed.edit.labels.clip },
      steps: [{ enabled: false, processor: { type: "sdr-correction", exposureEV: 1 } }],
    },
  ]);
  assert.deepEqual((await picture("bypass")).pixels, control.pixels);
  await edit([{ operation: "duplicate", clipIds: [placed.edit.labels.clip], atUs: 250000 }]);
  assert.equal(bypass.revision.document.processing[0].steps[0].enabled, false);
  const repeated = { projectId, revisionId, atUs: 250001 };
  await poll(
    () => call("frame.get", repeated),
    (v) => v.state === "ready",
    "repeat",
  );
  await call("frame.get", repeated, { output: join(out, "repeat.png") });
  assert.deepEqual(await pixels(join(out, "repeat.png")), control.pixels);
  report.checks.push(
    "pinned historical/bypass/repeated pictures; preview/export matched decoded frames under existing codec tolerance",
  );
  report.passed = true;
  await save();
} finally {
  try {
    await save();
  } finally {
    try {
      await service.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
console.log(
  JSON.stringify({
    passed: report.passed,
    out,
    checks: report.checks,
    codecDifferences: report.codecDifferences,
  }),
);
