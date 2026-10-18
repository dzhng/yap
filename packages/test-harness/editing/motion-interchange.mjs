import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out && process.env.YAP_NATIVE, "Pass --out NEW_DIRECTORY and YAP_NATIVE");
await mkdir(resolve(values.out));
const out = await realpath(resolve(values.out)),
  home = await mkdtemp("/tmp/yap-motion-");
const source = join(root, "specs/done/ffmpeg-parity/evidence/motion-alpha/alpha.mov");
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  sourceSha256: hash(await readFile(source)),
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
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
        ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        { encoding: "buffer" },
      )
    ).stdout,
  );
try {
  await service.start();
  const originalPath = join(home, "external-alpha.mov");
  await copyFile(source, originalPath);
  const admission = await call("asset.import", { requestId: randomUUID(), path: originalPath });
  const imported = await poll(
    () => call("job.get", { jobId: admission.jobId }),
    (v) => v.state === "ready",
    "alpha import",
  );
  const asset = await call("asset.get", { assetId: imported.published.output.assetId });
  assert.equal(asset.id, report.sourceSha256);
  const stream = asset.streams.find((s) => s.kind === "video");
  assert.equal(stream.codec, "ap4h");
  assert.equal(stream.endUs, 1000000);
  await rm(originalPath);
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  let revisionId = created.revision.revisionId;
  const selection = () => ({ projectId, revisionId });
  const edit = async (operations) => {
    const result = await call("edit.apply", {
      projectId,
      expectedRevisionId: revisionId,
      requestId: randomUUID(),
      operations,
    });
    revisionId = result.revision.revisionId;
    return result;
  };
  const placed = await edit([
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
  const picture = async (selected, name) => {
    await poll(
      () => call("frame.get", selected),
      (v) => v.state === "ready",
      name,
    );
    const output = join(out, name + ".png");
    const receipt = await call("frame.get", selected, { output });
    const decoded = await pixels(output);
    await save();
    return { receipt, pixels: decoded, output };
  };
  const reference = [];
  for (let phase = 0; phase < 4; phase++) {
    const atUs = phase === 3 ? 999999 : phase * 250000 + 1;
    const image = await picture({ ...selection(), atUs }, `phase-${phase}`);
    const control = await pixels(
      join(root, `specs/done/ffmpeg-parity/evidence/motion-alpha/ordinary-${phase}-dark-movie.png`),
    );
    assert.deepEqual(image.pixels, control);
    reference.push(image);
  }
  const duplicate = await edit([
    { operation: "duplicate", clipIds: [placed.edit.labels.motion], atUs: 1000000 },
  ]);
  const repeated = duplicate.revision.document.clips.find(
    (c) => c.id !== placed.edit.labels.motion,
  );
  assert.ok(repeated);
  assert.deepEqual(
    (await picture({ ...selection(), atUs: 1250001 }, "repeated-phase-1")).pixels,
    reference[1].pixels,
  );
  const repeatedRevision = revisionId;
  await edit([
    { operation: "retime", clipIds: [repeated.id], durationUs: 2000000, ripple: "none" },
  ]);
  assert.deepEqual(
    (await picture({ ...selection(), atUs: 2000001 }, "retimed-phase-2")).pixels,
    reference[2].pixels,
  );
  const retimedRevision = revisionId;
  const undone = await call("edit.undo", {
    projectId,
    expectedRevisionId: revisionId,
    requestId: randomUUID(),
  });
  revisionId = undone.id;
  assert.deepEqual(
    (await picture({ ...selection(), atUs: 1250001 }, "undo-repeat-phase-1")).pixels,
    reference[1].pixels,
  );
  assert.deepEqual(
    (
      await picture(
        { projectId, revisionId: retimedRevision, atUs: 2000001 },
        "historical-retimed-phase-2",
      )
    ).pixels,
    reference[2].pixels,
  );
  report.checks.push(
    "ordinary immutable alpha import; source path removed; exact off-grid/repeated/retimed/undo/historical pictures",
  );
  const previewParams = {
    projectId,
    revisionId: repeatedRevision,
    range: { startUs: 160001, endUs: 610007 },
  };
  const preview = await poll(
    () => call("preview.get", previewParams),
    (v) => v.state === "ready",
    "alpha preview",
  );
  const movie = join(out, "preview.mp4");
  await call("preview.get", previewParams, { output: movie });
  report.preview = preview;
  const timing = JSON.parse(
    (
      await run(join(root, "helpers/ffmpeg/.build/distribution/bin/ffprobe"), [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=pts_time,duration_time",
        "-of",
        "json",
        movie,
      ])
    ).stdout,
  );
  report.previewTimes = timing.frames.map((frame) => frame.pts_time);
  assert.deepEqual(report.previewTimes, ["0.000000", "0.089999", "0.339999"]);
  report.previewDurations = timing.frames.map((frame) => frame.duration_time);
  assert.deepEqual(report.previewDurations, ["0.089999", "0.250000", "0.110007"]);
  await run(ffmpeg, [
    "-v",
    "error",
    "-i",
    movie,
    "-vf",
    "colorspace=all=bt709:trc=iec61966-2-1:range=pc,format=rgb24",
    "-fps_mode",
    "passthrough",
    join(out, "preview-%d.png"),
  ]);
  assert.equal((await readdir(out)).filter((name) => /^preview-\d+\.png$/.test(name)).length, 3);
  report.previewDifferences = [];
  for (let phase = 0; phase < 3; phase++) {
    const actual = await pixels(join(out, `preview-${phase + 1}.png`));
    const expected = await pixels(reference[phase].output);
    assert.equal(actual.length, expected.length);
    let sum = 0;
    for (let i = 0; i < actual.length; i++) sum += Math.abs(actual[i] - expected[i]);
    const mae = sum / actual.length;
    report.previewDifferences.push({ phase, mae });
    await save();
    // H.264 chroma subsampling changes saturated edges; whole-frame error is bounded.
    assert.ok(mae <= 4, `preview phase ${phase}: RGB mean error ${mae}/255`);
  }
  report.checks.push(
    "off-grid preview preserves absolute frame times/phases within declared H.264 appearance tolerance",
  );
  const stillProject = await call("project.create", {
    requestId: randomUUID(),
    canvas: created.revision.document.canvas,
  });
  const controlOperations = [
    { operation: "track.add", label: "pictures", track: { kind: "video", order: 0 } },
  ];
  for (let phase = 0; phase < 4; phase++) {
    const admitted = await call("asset.import", {
      requestId: randomUUID(),
      path: reference[phase].output,
    });
    const ready = await poll(
      () => call("job.get", { jobId: admitted.jobId }),
      (v) => v.state === "ready",
      "control image",
    );
    const still = await call("asset.get", { assetId: ready.published.output.assetId });
    controlOperations.push({
      operation: "place",
      clip: {
        trackId: { label: "pictures" },
        assetId: still.id,
        streamId: still.streams[0].streamId,
        source: { kind: "hold", atUs: 0 },
        placement: {
          kind: "project",
          range: { startUs: phase * 250000, endUs: (phase + 1) * 250000 },
        },
      },
    });
  }
  const stillEdit = await call("edit.apply", {
    projectId: stillProject.project.projectId,
    expectedRevisionId: stillProject.revision.revisionId,
    requestId: randomUUID(),
    operations: controlOperations,
  });
  const stillSelection = {
    projectId: stillProject.project.projectId,
    revisionId: stillEdit.revision.revisionId,
  };
  assert.deepEqual(
    (await picture({ ...stillSelection, atUs: 160001 }, "encode-control-frame")).pixels,
    reference[0].pixels,
  );
  const controlParams = { ...stillSelection, range: previewParams.range };
  await poll(
    () => call("preview.get", controlParams),
    (v) => v.state === "ready",
    "matched still preview",
  );
  const controlMovie = join(out, "encode-control.mp4");
  await call("preview.get", controlParams, { output: controlMovie });
  await run(ffmpeg, [
    "-v",
    "error",
    "-i",
    controlMovie,
    "-vf",
    "colorspace=all=bt709:trc=iec61966-2-1:range=pc,format=rgb24",
    "-fps_mode",
    "passthrough",
    join(out, "encode-control-%d.png"),
  ]);
  report.matchedEncodeDifferences = [];
  for (let phase = 0; phase < 3; phase++) {
    const actual = await pixels(join(out, `preview-${phase + 1}.png`));
    const expected = await pixels(join(out, `encode-control-${phase + 1}.png`));
    assert.equal(actual.length, expected.length);
    let sum = 0;
    for (let i = 0; i < actual.length; i++) sum += Math.abs(actual[i] - expected[i]);
    const mae = sum / actual.length;
    report.matchedEncodeDifferences.push({ phase, mae });
    await save();
    assert.ok(mae <= 1, `matched encode phase ${phase}: RGB mean difference ${mae}/255`);
  }
  report.checks.push(
    "matched still-image encoding isolates saturated-edge codec loss from alpha input",
  );
  const exportId = randomUUID();
  await call("export.create", {
    projectId,
    revisionId: retimedRevision,
    exportId,
    kind: "processed-package",
    directory: out,
    leaf: "motion.zip",
  });
  const packaged = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready" && !v.cleanupPending,
    "alpha package",
  );
  await service.stop();
  await rm(service.home, { recursive: true });
  service.home = join(home, "recipient");
  await service.start();
  const opened = await call("package.open", { path: packaged.output });
  const ready = await poll(
    () => call("package.status", { admissionId: opened.id }),
    (v) => v.state === "ready",
    "open alpha package",
  );
  const adopted = await poll(
    () => call("package.adopt", { packageHandle: ready.packageHandle, requestId: "adopt-motion" }),
    (v) => v.state === "ready",
    "adopt alpha package",
  );
  const recipient = {
    projectId: adopted.published.output.projectId,
    revisionId: adopted.published.output.revisionId,
  };
  assert.deepEqual(
    (await picture({ ...recipient, atUs: 2000001 }, "adopted-retimed-phase-2")).pixels,
    reference[2].pixels,
  );
  const retainedAsset = await call("asset.get", { assetId: asset.id });
  assert.deepEqual(retainedAsset.streams, asset.streams);
  const undoAdoption = await call("edit.undo", {
    projectId: recipient.projectId,
    expectedRevisionId: recipient.revisionId,
    requestId: randomUUID(),
  });
  assert.deepEqual(
    (
      await picture(
        { projectId: recipient.projectId, revisionId: undoAdoption.id, atUs: 1250001 },
        "adopted-undo-phase-1",
      )
    ).pixels,
    reference[1].pixels,
  );
  report.checks.push(
    "portable byte identity/metadata; retimed current and undo history survive adoption without original source",
  );
  const broken = join(out, "missing-movie.zip");
  await copyFile(packaged.output, broken);
  const members = (await run("/usr/bin/unzip", ["-Z1", broken])).stdout.trim().split("\n");
  const mediaMember = members.find((name) => name.startsWith("assets/"));
  assert.ok(mediaMember);
  assert.equal(
    hash(
      (await run("/usr/bin/unzip", ["-p", packaged.output, mediaMember], { encoding: "buffer" }))
        .stdout,
    ),
    report.sourceSha256,
  );
  await run("/usr/bin/zip", ["-d", broken, mediaMember]);
  const bad = await call("package.open", { path: broken });
  const failed = await poll(
    () => call("package.status", { admissionId: bad.id }),
    (v) => v.state === "failed" || v.state === "ready",
    "missing movie refusal",
  );
  assert.equal(failed.state, "failed");
  report.missingMember = failed;
  report.checks.push("missing sole movie package member refuses; no substitute media");
  assert.equal(hash(await readFile(source)), report.sourceSha256);
  report.passed = true;
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
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, evidence: out }));
