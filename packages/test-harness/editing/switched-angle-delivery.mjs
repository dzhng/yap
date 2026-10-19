import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(
  values.out && process.env.YAP_NATIVE,
  "Usage: YAP_NATIVE=WORKER node packages/test-harness/editing/switched-angle-delivery.mjs --out NEW_DIRECTORY",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const home = await mkdtemp("/tmp/yap-switched-angle-delivery-");
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  recipe: {
    kind: "declared-angle-switch",
    mediaKind: "video",
    projectRange: { startUs: 0, endUs: 3000000 },
    sourceRange: { startUs: 0, endUs: 1000000 },
    angles: ["A", "B", "C"],
    colors: { A: [255, 0, 0], B: [0, 255, 0], C: [0, 0, 255] },
    evidence: {
      id: "known-angle-control",
      generation: "g1",
      status: "accepted",
      method: "waveform",
      fingerprint: "sha256:known-angle-control",
    },
  },
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const ffmpeg = process.env.YAP_FFMPEG ?? "ffmpeg";
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const runFFmpeg = (args, options) => run(ffmpeg, ["-v", "error", "-nostdin", ...args], options);
const decodeRGB = async (path) =>
  Buffer.from(
    (
      await runFFmpeg(["-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
        encoding: "buffer",
      })
    ).stdout,
  );
const meanRGB = (bytes) => {
  assert.ok(bytes.length > 0 && bytes.length % 3 === 0, "decoded frame has RGB pixels");
  const mean = [0, 0, 0];
  for (let i = 0; i < bytes.length; i++) mean[i % 3] += bytes[i];
  return mean.map((value) => value / (bytes.length / 3));
};
const distance = (a, b) =>
  Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
const makeAngle = async (name, color) => {
  const path = join(out, `angle-${name}.mp4`);
  await runFFmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x48:r=2`,
    "-t",
    "1",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    path,
  ]);
  return path;
};
try {
  await service.start();
  const importVideo = async (path) => {
    const imported = await call("asset.import", { requestId: randomUUID(), path });
    const ready = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (value) => value.state === "ready",
      "angle import",
    );
    return call("asset.get", { assetId: ready.published.output.assetId }, { transport: "mcp" });
  };
  const sourceAssets = {};
  for (const [name, color] of Object.entries({ A: "0xff0000", B: "0x00ff00", C: "0x0000ff" }))
    sourceAssets[name] = await importVideo(await makeAngle(name, color));

  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 2, denominator: 1 },
      background: "#000000ff",
    },
  });
  const members = Object.entries(sourceAssets).map(([name, asset]) => ({
    name,
    asset,
    streamId: asset.streams.find((stream) => stream.kind === "video").streamId,
  }));
  const edited = await call("edit.apply", {
    projectId: project.project.projectId,
    expectedRevisionId: project.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "angles", track: { kind: "video", order: 0 } },
      ...members.map(({ name, asset, streamId }, index) => ({
        operation: "place",
        label: `angle-${name}`,
        clip: {
          trackId: { label: "angles" },
          assetId: asset.assetId,
          streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: {
            kind: "project",
            range: { startUs: index * 1000000, endUs: (index + 1) * 1000000 },
          },
        },
      })),
      {
        operation: "angle.declare",
        label: "angles-session",
        sessionId: "session-angle-delivery",
        originClipId: { label: "angle-A" },
        evidence: {
          id: "known-angle-control",
          generation: "g1",
          status: "accepted",
          method: "waveform",
          fingerprint: "sha256:known-angle-control",
          sources: members.map(({ asset, streamId }) => ({ assetId: asset.assetId, streamId })),
        },
        members: members.map(({ name }, index) => ({
          clipId: { label: `angle-${name}` },
          offsetUs: 0,
          validRange: { startUs: index * 1000000, endUs: (index + 1) * 1000000 },
        })),
      },
    ],
  });
  report.project = { projectId: project.project.projectId, revisionId: edited.revision.revisionId };

  const expected = {};
  for (const { name, asset, streamId } of members) {
    const request = { assetId: asset.assetId, streamId, atUs: 0, maxLongEdge: 64 };
    await poll(
      () => call("frame.get", request),
      (value) => value.state === "ready",
      `source ${name} frame`,
    );
    const file = join(out, `source-${name}.png`);
    await call("frame.get", request, { output: file });
    expected[name] = meanRGB(await decodeRGB(file));
  }
  report.sources = expected;
  const samples = {};
  for (const [name, atUs] of Object.entries({ A: 250000, B: 1250000, C: 2250000 })) {
    const request = {
      projectId: project.project.projectId,
      revisionId: edited.revision.revisionId,
      atUs,
      maxLongEdge: 64,
    };
    const ready = await poll(
      () => call("frame.get", request),
      (value) => value.state === "ready",
      `angle ${name} frame`,
    );
    const file = join(out, `frame-${name}.png`);
    await call("frame.get", request, { output: file });
    const mean = meanRGB(await decodeRGB(file));
    assert.ok(distance(mean, expected[name]) < 18, `${name} frame selects its declared angle`);
    samples[name] = {
      atUs,
      meanRGB: mean,
      output: {
        implementationId: ready.published.output.implementationId,
        frame: ready.published.output.frame,
      },
    };
  }
  report.samples = samples;
  const preview = join(out, "switched-angle-preview.mp4");
  const previewResult = await poll(
    () =>
      call(
        "preview.get",
        {
          projectId: project.project.projectId,
          revisionId: edited.revision.revisionId,
          range: { startUs: 0, endUs: 3000000 },
        },
        { output: preview },
      ),
    (value) => value.state === "ready",
    "switched-angle preview",
  );
  const movie = await decodeRGB(preview);
  assert.equal(movie.length, 6 * 64 * 48 * 3, "preview contains six declared 2fps project frames");
  const previewFrames = [];
  for (let frame = 0; frame < 6; frame++)
    previewFrames.push(meanRGB(movie.subarray(frame * 64 * 48 * 3, (frame + 1) * 64 * 48 * 3)));
  for (const [index, name] of ["A", "A", "B", "B", "C", "C"].entries())
    assert.ok(
      distance(previewFrames[index], expected[name]) < 18,
      `preview frame ${index} selects ${name}`,
    );
  report.preview = {
    receipt: previewResult.published.output,
    frames: previewFrames.map((meanRGB, index) => ({ index, meanRGB })),
    rgbSha256: hash(movie),
  };
  report.checks.push(
    "public CLI/MCP imports three caller-authored angle sources and declares source-bound accepted evidence",
    "native frame delivery selects A, B and C at their explicit sequential placements",
    "native preview delivery preserves the six 2fps frames and each selected angle",
  );
  report.passed = true;
} finally {
  await save();
  await service.stop();
  await rm(home, { recursive: true, force: true });
}
await save();
console.log(
  JSON.stringify({ passed: report.passed, out, checks: report.checks, samples: report.samples }),
);
