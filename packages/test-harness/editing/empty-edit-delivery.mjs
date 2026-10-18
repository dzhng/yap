import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: { out: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "Usage: YAP_NATIVE=FROZEN_WORKER node empty-edit-delivery.mjs --out EMPTY_DIRECTORY\nImports the frozen AVFoundation physical empty-edit fixture through the public CLI/MCP lifecycle, places it in a project, observes the gap in source and delivered project frames, and exports the same project. No personal library or source mutation.",
  );
  process.exit(0);
}
assert.ok(process.env.YAP_NATIVE, "Set a frozen native worker");
const out = resolve(values.out ?? (await mkdtemp(join(tmpdir(), "empty-edit-delivery-"))));
await mkdir(out, { recursive: true });
assert.deepEqual(await readdir(out), [], "Evidence directory must be empty");
const home = await mkdtemp(join(tmpdir(), "yap-empty-edit-delivery-"));
const source = join(root, "specs/done/agent-editing/assets/10d-source-frames/visual/source.mov");
const sourceBytes = await readFile(source);
const report = {
  passed: false,
  scope:
    "Public import, source-index and project/export delivery of an AVFoundation physical empty-edit fixture",
  source: { path: source, sha256: hash(sourceBytes), bytes: sourceBytes.length },
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  trace: [],
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");

try {
  await service.start();
  const importing = await call("asset.import", {
    requestId: "physical-empty-edit",
    path: source,
  });
  const importedJob = await poll(
    () => call("job.get", { jobId: importing.jobId }),
    (value) => value.state === "ready",
    "physical empty-edit import",
  );
  const asset = await call("asset.get", { assetId: importedJob.published.output.assetId });
  const video = asset.streams.find((stream) => stream.kind === "video");
  assert.ok(video, "Fixture must expose a video stream");
  const selection = { assetId: asset.id, streamId: video.id };

  const indexed = await poll(
    () => call("index.get", { ...selection, limit: 1 }, { transport: "mcp" }),
    (value) => value.state === "ready",
    "physical empty-edit source index",
  );
  const sourceCoverage = [];
  let cursor;
  do {
    const page = await call(
      "index.coverage",
      {
        ...selection,
        generation: indexed.page.metadata.generation,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      },
      { transport: "mcp" },
    );
    sourceCoverage.push(...page.coverage);
    cursor = page.nextCursor;
  } while (cursor);
  const gap = sourceCoverage.find(
    (range) => range.source.startUs === 400000 && range.source.endUs === 600000,
  );
  assert.deepEqual(
    gap && {
      source: gap.source,
      state: gap.state,
      basis: gap.basis,
    },
    {
      source: { startUs: 400000, endUs: 600000 },
      state: "unavailable",
      basis: "support",
    },
  );
  const missingSource = await call("frame.get", { ...selection, atUs: 450000, maxLongEdge: 64 });
  assert.equal(missingSource.state, "unavailable");
  assert.equal(missingSource.reason, "physical_gap");

  const created = await call("project.create", {
    requestId: "physical-empty-edit-project",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const edited = await call("edit.apply", {
    projectId: created.project.projectId,
    expectedRevisionId: created.revision.revisionId,
    requestId: "physical-empty-edit-placement",
    operations: [
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "physical-gap",
        clip: {
          ...selection,
          trackId: { label: "video" },
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  const project = {
    projectId: created.project.projectId,
    revisionId: edited.revision.revisionId,
    maxLongEdge: 64,
  };
  const frames = {};
  for (const atUs of [300000, 450000, 700000]) {
    const output = join(out, `project-${atUs}.png`);
    const frame = await poll(
      () => call("frame.get", { ...project, atUs }, { output }),
      (value) => value.state === undefined || value.state === "ready",
      `project frame ${atUs}`,
    );
    assert.equal(frame.state, "ready");
    frames[atUs] = { output, receipt: frame.published.output };
    assert.equal(
      frame.published.output.frame.layers[0].availability,
      atUs === 450000 ? "source-unavailable" : "available",
    );
    assert.equal(
      frame.published.output.pictures[0].status,
      atUs === 450000 ? "unavailable" : "available",
    );
  }

  const exportDirectory = join(out, "exports");
  await mkdir(exportDirectory);
  const exportId = randomUUID();
  await call("export.create", {
    exportId,
    projectId: created.project.projectId,
    revisionId: edited.revision.revisionId,
    kind: "video",
    directory: exportDirectory,
    leaf: "physical-gap.mp4",
  });
  const committed = await poll(
    () => call("export.status", { exportId }, { transport: "mcp" }),
    (value) => value.state === "ready",
    "physical empty-edit export",
  );
  assert.equal(committed.output, join(await realpath(exportDirectory), "physical-gap.mp4"));
  const exportDigest = hash(await readFile(committed.output));
  assert.equal(exportDigest, committed.receipt.sha256);
  const decoded = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_frames",
        "-show_streams",
        "-of",
        "json",
        committed.output,
      ])
    ).stdout,
  );
  const videoFrames = decoded.frames.filter((frame) => frame.media_type === "video");
  assert.equal(videoFrames.length, 10);
  const raw = (
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        committed.output,
        "-map",
        "0:v:0",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    )
  ).stdout;
  const frameBytes = 64 * 48 * 4;
  assert.equal(raw.length, 10 * frameBytes);
  const mean = (offset) => {
    let total = 0;
    for (let index = offset; index < offset + frameBytes; index += 4)
      total += raw[index] + raw[index + 1] + raw[index + 2];
    return total / ((frameBytes / 4) * 3);
  };
  const means = [3, 4, 7].map((index) => mean(index * frameBytes));
  assert.ok(means[0] > 0, `available frame unexpectedly black: ${means[0]}`);
  assert.ok(means[1] <= 2, `physical gap frame unexpectedly contains picture: ${means[1]}`);
  assert.ok(means[2] > 0, `post-gap frame unexpectedly black: ${means[2]}`);
  report.checks = {
    sourceCoverage: { generation: indexed.page.metadata.generation, gap },
    project: { projectId: project.projectId, revisionId: project.revisionId, frames },
    export: {
      exportId,
      receipt: committed.receipt,
      file: {
        path: committed.output,
        bytes: (await readFile(committed.output)).length,
        sha256: exportDigest,
      },
      decodedFrames: videoFrames.length,
      decodedMeanRgb: means,
    },
    interpretation:
      "The source index marks 400000–600000 as unavailable from physical support; a direct source frame request at 450000 is refused, while the project frame and exported pixels show the same black interval between available neighbors.",
  };
  assert.equal(
    hash(await readFile(source)),
    report.source.sha256,
    "Source changed during inspection",
  );
  report.passed = true;
  await save("report.json", report);
  await save("request.json", {
    source: {
      path: "specs/done/agent-editing/assets/10d-source-frames/visual/source.mov",
      sha256: report.source.sha256,
    },
    selection,
    project,
    range: { startUs: 0, endUs: 1000000 },
    export: { exportId, directory: "exports", leaf: "physical-gap.mp4" },
  });
  console.log(JSON.stringify({ out, passed: true, physicalGap: gap.source }));
} catch (error) {
  report.error = { name: error?.name, message: error?.message, stack: error?.stack };
  await save("report.json", report);
  throw error;
} finally {
  await service.stop().catch(() => {});
}
