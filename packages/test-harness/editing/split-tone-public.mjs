import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(
  values.out && process.env.YAP_NATIVE,
  "Usage: YAP_NATIVE=WORKER node packages/test-harness/editing/split-tone-public.mjs --out NEW_DIRECTORY",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const home = await mkdtemp("/tmp/yap-split-tone-public-");
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  masks: {
    neutral: { x: 0, y: 0, width: 320, height: 90 },
    shadowColor: { x: 0, y: 90, width: 160, height: 90 },
    highlightNeutral: { x: 160, y: 90, width: 160, height: 90 },
  },
  recipe: {
    source: "caller-authored immutable 33^3 .cube",
    interpretation: "linear-sRGB",
    formula: "red=-0.4*x^3+0.6*x^2+0.8*x; green=x; blue=0.4*x^3-0.6*x^2+1.2*x",
  },
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report, join(out, "native"));
const ffmpeg =
  process.env.YAP_FFMPEG ?? join(root, "helpers/ffmpeg/.build/distribution/bin/ffmpeg");
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const pixels = async (path) =>
  Buffer.from(
    (
      await run(
        ffmpeg,
        ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        {
          encoding: "buffer",
        },
      )
    ).stdout,
  );
const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encoded = (v) =>
  Math.max(0, Math.min(1, v)) <= 0.0031308
    ? Math.max(0, Math.min(1, v)) * 12.92
    : 1.055 * Math.max(0, Math.min(1, v)) ** (1 / 2.4) - 0.055;
const split = (x, channel) =>
  channel === 0
    ? -0.4 * x ** 3 + 0.6 * x ** 2 + 0.8 * x
    : channel === 1
      ? x
      : 0.4 * x ** 3 - 0.6 * x ** 2 + 1.2 * x;
const referencePixels = (source) => {
  const expected = Buffer.alloc(source.length);
  for (let i = 0; i < source.length; i += 3)
    for (let c = 0; c < 3; c++)
      expected[i + c] = Math.round(encoded(split(linear(source[i + c] / 255), c)) * 255);
  return expected;
};
const compare = (actual, expected, rect = { x: 0, y: 0, width: 320, height: 180 }) => {
  let sum = 0;
  let maximum = 0;
  let channels = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++)
    for (let x = rect.x; x < rect.x + rect.width; x++)
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(actual[(y * 320 + x) * 3 + c] - expected[(y * 320 + x) * 3 + c]);
        sum += delta;
        maximum = Math.max(maximum, delta);
        channels++;
      }
  return { meanError: sum / channels, maximumError: maximum, channels };
};
const meanRGB = (rgb, rect) => {
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++)
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const offset = (y * 320 + x) * 3;
      for (let c = 0; c < 3; c++) sum[c] += rgb[offset + c];
      count++;
    }
  return sum.map((value) => value / count);
};
try {
  await service.start();
  const call = service.call.bind(service);
  const capabilities = await call("processing.capabilities", {}, { transport: "mcp" });
  const lutCapability = capabilities.find((value) => value.type === "lut");
  assert.ok(
    lutCapability?.execution &&
      lutCapability.implementationId?.startsWith("coreimage-unit-linear-srgb-cube-trilinear-v1:"),
    "public LUT capability must advertise the immutable native execution recipe",
  );
  report.capability = lutCapability;

  const importAsset = async (path) => {
    const imported = await call("asset.import", { requestId: randomUUID(), path });
    const ready = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (value) => value.state === "ready",
      "import",
    );
    return call("asset.get", { assetId: ready.published.output.assetId }, { transport: "mcp" });
  };
  const chart = join(out, "chart-source.png");
  await run("swift", [
    join(root, "packages/test-harness/editing/tone-reference.swift"),
    "chart",
    chart,
    "{}",
    "false",
  ]);
  const source = await importAsset(chart);
  const lut = await importAsset(
    join(root, "specs/done/video-editing-feedback/assets/25-tone-controls/split-tone/split.cube"),
  );
  assert.deepEqual(lut.lut, {
    format: "cube-3d",
    size: 33,
    domain: "unit",
    ordering: "red-fastest",
  });
  report.assets = {
    source: { id: source.id, sha256: hash(await readFile(chart)) },
    lut: {
      id: lut.id,
      sha256: hash(
        await readFile(
          join(
            root,
            "specs/done/video-editing-feedback/assets/25-tone-controls/split-tone/split.cube",
          ),
        ),
      ),
    },
  };

  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 320,
      height: 180,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const placed = await call("edit.apply", {
    projectId: project.project.projectId,
    expectedRevisionId: project.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "shot",
        clip: {
          trackId: { label: "v" },
          assetId: source.id,
          streamId: source.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 500000 } },
        },
      },
    ],
  });
  const target = { kind: "clip", id: placed.edit.labels.shot };
  const request = {
    projectId: project.project.projectId,
    revisionId: placed.revision.revisionId,
    atUs: 1,
    maxLongEdge: 320,
  };
  const beforeResult = await poll(
    () => call("frame.get", request),
    (value) => value.state === "ready",
    "before",
  );
  const beforePath = join(out, "before.png");
  await call("frame.get", request, { output: beforePath });
  const before = await pixels(beforePath);
  const gradedEdit = await call("edit.apply", {
    projectId: project.project.projectId,
    expectedRevisionId: placed.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      {
        operation: "processing.set",
        target,
        steps: [
          {
            processor: {
              type: "lut",
              assetId: lut.id,
              colorSpace: "linear-srgb",
              interpolation: "trilinear",
            },
          },
        ],
      },
    ],
  });
  const gradedRequest = { ...request, revisionId: gradedEdit.revision.revisionId };
  const gradedResult = await poll(
    () => call("frame.get", gradedRequest),
    (value) => value.state === "ready",
    "graded",
  );
  const gradedPath = join(out, "graded.png");
  await call("frame.get", gradedRequest, { output: gradedPath });
  const graded = await pixels(gradedPath);
  const expected = referencePixels(before);
  report.comparison = compare(graded, expected);
  report.regions = Object.fromEntries(
    Object.entries(report.masks).map(([name, rect]) => [
      name,
      {
        before: meanRGB(before, rect),
        expected: meanRGB(expected, rect),
        candidate: meanRGB(graded, rect),
        comparison: compare(graded, expected, rect),
      },
    ]),
  );
  report.frame = {
    implementationId: gradedResult.published.output.implementationId,
    before: beforeResult.published.output.implementationId,
  };
  assert.ok(
    report.comparison.maximumError <= 1,
    "public split-tone delivery must match the independent curve within one code value",
  );
  assert.ok(
    report.regions.neutral.comparison.meanError <= 1,
    "neutral mask must retain the same split-tone response",
  );
  assert.ok(
    report.regions.shadowColor.comparison.meanError <= 1,
    "shadow color mask must retain the same split-tone response",
  );
  assert.ok(
    report.regions.highlightNeutral.comparison.meanError <= 1,
    "highlight neutral mask must retain the same split-tone response",
  );
  assert.notDeepEqual(graded, before, "explicit split tone must change delivered pixels");
  report.checks.push(
    "public CLI/MCP LUT discovery and immutable import",
    "independent linear-sRGB split-tone curve matches complete delivered raster within one code value",
    "neutral, shadow-color and highlight-neutral masks are retained and checked",
    "explicit split tone changes delivered pixels",
  );
  report.passed = true;
} finally {
  await save();
  await service.stop();
  await rm(home, { recursive: true, force: true });
}
await save();
console.log(
  JSON.stringify({
    passed: report.passed,
    out,
    checks: report.checks,
    comparison: report.comparison,
    regions: report.regions,
  }),
);
