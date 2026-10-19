import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";

// A canvas boundary must not resample an already composed picture. The same
// artwork inside a padded canvas provides an independent interior-pixel control.
const out = resolve(process.argv[2]);
assert.ok(process.argv[2] && process.env.YAP_NATIVE);
await mkdir(out);
const home = await mkdtemp(join(tmpdir(), "composed-border-"));
const report = {
  passed: false,
  trace: [],
  pictures: [],
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
try {
  const width = 64,
    height = 48,
    sourceWidth = width + 16,
    sourceHeight = height + 16,
    pixels = Buffer.alloc(sourceWidth * sourceHeight * 3);
  for (let y = 0; y < sourceHeight; y++)
    for (let x = 0; x < sourceWidth; x++) {
      const offset = (y * sourceWidth + x) * 3;
      pixels[offset] = (x * 37 + y * 17) % 256;
      pixels[offset + 1] = (x * 11 + y * 53) % 256;
      pixels[offset + 2] = (x * 71 + y * 29) % 256;
    }
  const ppm = join(out, "source.ppm"),
    source = join(out, "source.png");
  await writeFile(
    ppm,
    Buffer.concat([Buffer.from(`P6\n${sourceWidth} ${sourceHeight}\n255\n`), pixels]),
  );
  await run("ffmpeg", ["-v", "error", "-i", ppm, source]);
  await service.start();
  const importing = await call("asset.import", { requestId: randomUUID(), path: source });
  const imported = await poll(
    () => call("job.get", { jobId: importing.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: imported.published.output.assetId });
  const decoded = [];
  for (const padding of [0, 8]) {
    const created = await call("project.create", {
      requestId: randomUUID(),
      canvas: {
        width: width + 2 * padding,
        height: height + 2 * padding,
        background: "#000000ff",
        fps: { numerator: 30, denominator: 1 },
      },
    });
    const projectId = created.project.projectId;
    const edited = await call("edit.apply", {
      projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: randomUUID(),
      operations: [
        { operation: "track.add", label: "track", track: { kind: "video", order: 0 } },
        {
          operation: "place",
          label: "clip",
          clip: {
            trackId: { label: "track" },
            assetId: asset.assetId,
            streamId: asset.streams[0].streamId,
            source: { kind: "hold", atUs: 0 },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "clip" } },
          steps: [
            {
              processor: {
                type: "geometry",
                rect: { x: padding - 8, y: padding - 8, width: sourceWidth, height: sourceHeight },
              },
            },
          ],
        },
      ],
    });
    const request = { projectId, revisionId: edited.revision.revisionId, atUs: 0 };
    await poll(
      () => call("frame.get", request),
      (v) => v.state === "ready",
      "frame",
    );
    const file = join(out, `padding-${padding}.png`);
    const receipt = await call("frame.get", request, { output: file });
    const mcp = await service.mcp.callTool({ name: "frame.get", arguments: request });
    assert.equal(mcp.structuredContent.ok, true);
    assert.deepEqual(
      Buffer.from(mcp.content.find((v) => v.type === "image").data, "base64"),
      await readFile(file),
    );
    const raw = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        `crop=${width}:${height}:${padding}:${padding}`,
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { encoding: "buffer" },
    );
    decoded.push(raw.stdout);
    report.pictures.push({ padding, file, receipt, sha256: hash(await readFile(file)) });
    await call("project.delete", { projectId, requestId: randomUUID() });
  }
  assert.equal(decoded[0].length, width * height * 3);
  assert.equal(decoded[1].length, decoded[0].length);
  let maximum = 0,
    changed = 0;
  for (let i = 0; i < decoded[0].length; i++) {
    const difference = Math.abs(decoded[0][i] - decoded[1][i]);
    maximum = Math.max(maximum, difference);
    if (difference) changed++;
  }
  report.comparison = { maximum, changed };
  assert.equal(maximum, 0, "Canvas edges changed the composed artwork");
  const full = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      join(out, "padding-8.png"),
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  assert.equal(full.stdout.length, pixels.length);
  let sourceMaximum = 0;
  for (let i = 0; i < pixels.length; i++)
    sourceMaximum = Math.max(sourceMaximum, Math.abs(full.stdout[i] - pixels[i]));
  report.sourceMaximum = sourceMaximum;
  assert.ok(sourceMaximum <= 4, "Identity composition changed source pixels, including its edges");
  report.passed = true;
} finally {
  await service.stop();
  report.logs = service.logs;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, out }));
