import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(
  values.out && process.env.YAP_NATIVE,
  "Usage: YAP_NATIVE=WORKER node packages/test-harness/editing/tone-controls.mjs --out NEW_DIRECTORY",
);
const out = resolve(values.out);
await mkdir(out);
const home = await mkdtemp("/tmp/yap-tone-public-");
const recipe = {
  exposureEV: 0,
  contrast: 1,
  saturation: 1,
  neutralKelvin: 6500,
  neutralTint: 0,
  shadows: 0.35,
  highlights: 0.3,
};
const source = join(root, "specs/done/video-editing-feedback/assets/26-immutable-luts/dry.png");
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: [],
  cases: [],
  recipe,
  sourceSha256: hash(await readFile(source)),
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  referenceScriptSha256: hash(
    await readFile(join(root, "packages/test-harness/editing/tone-reference.swift")),
  ),
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
const ffmpeg =
  process.env.YAP_FFMPEG ?? join(root, "helpers/ffmpeg/.build/distribution/bin/ffmpeg");
const pixels = async (path, movie = false) =>
  Buffer.from(
    (
      await run(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          path,
          ...(movie
            ? [
                "-vf",
                "colorspace=all=bt709:trc=iec61966-2-1:range=pc,format=rgb24",
                "-fps_mode",
                "passthrough",
              ]
            : []),
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
const compare = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  let sum = 0,
    maximum = 0;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    sum += d;
    maximum = Math.max(maximum, d);
  }
  return { meanError: sum / actual.length, maximumError: maximum, bytes: actual.length };
};
const luma = (rgb, [x, y, w, h]) => {
  let sum = 0;
  for (let row = y; row < y + h; row++)
    for (let col = x; col < x + w; col++) {
      const i = (row * 320 + col) * 3;
      sum += rgb[i] * 0.2126 + rgb[i + 1] * 0.7152 + rgb[i + 2] * 0.0722;
    }
  return sum / (w * h);
};
const reference = (input, output, config = {}, reverse = false) =>
  run("swift", [
    join(root, "packages/test-harness/editing/tone-reference.swift"),
    input,
    output,
    JSON.stringify(config),
    String(reverse),
  ]);
const chart = join(out, "chart-source.png");
let completed = false;
let cleanupError;
try {
  await reference("chart", chart);
  await service.start();
  report.capabilities = await call("processing.capabilities", {}, { transport: "mcp" });
  const capability = report.capabilities.find((v) => v.type === "sdr-correction");
  assert.ok(
    capability.execution &&
      capability.implementationId.startsWith("coreimage-sdr-source-neutral-recovery-v2:"),
  );
  const make = async (path) => {
    const imported = await call("asset.import", { requestId: randomUUID(), path });
    const ready = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (v) => v.state === "ready",
      "import",
    );
    const asset = await call("asset.get", { assetId: ready.published.output.assetId });
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
      const result = await call("edit.apply", {
        projectId,
        expectedRevisionId: revisionId,
        requestId: randomUUID(),
        operations,
      });
      revisionId = result.revision.revisionId;
      return result;
    };
    await edit([
      { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "shot",
        clip: {
          trackId: { label: "v" },
          assetId: asset.id,
          streamId: asset.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 500000 } },
        },
      },
    ]);
    return {
      frame: async (name, config) => {
        if (config)
          await edit([
            {
              operation: "processing.set",
              target: { kind: "output" },
              steps: [{ processor: { type: "sdr-correction", ...config } }],
            },
          ]);
        const params = { projectId, revisionId, atUs: 1, maxLongEdge: 320 };
        const result = await poll(
          () => call("frame.get", params),
          (v) => v.state === "ready",
          name,
        );
        const file = join(out, name + ".png");
        await call("frame.get", params, { output: file });
        if (config)
          assert.ok(result.published.output.implementationId.includes(capability.implementationId));
        return { file, rgb: await pixels(file), result };
      },
      movie: async (name) => {
        const exportId = randomUUID();
        await call("export.create", {
          projectId,
          revisionId,
          exportId,
          kind: "video",
          directory: out,
          leaf: name + ".mp4",
        });
        const result = await poll(
          () => call("export.status", { exportId }),
          (v) => v.state === "ready" && !v.cleanupPending,
          name,
        );
        return { result, rgb: await pixels(result.output, true) };
      },
    };
  };
  const inputs = [
    {
      name: "chart",
      path: chart,
      masks: { face: [20, 110, 120, 50], wall: [180, 110, 120, 50], neutral: [70, 20, 30, 50] },
    },
    {
      name: "wall",
      path: source,
      masks: { face: [110, 44, 94, 115], wall: [238, 20, 75, 140], neutral: [20, 0, 55, 30] },
    },
  ];
  for (const input of inputs) {
    console.log(
      `Checking ${input.name}: identity, independent tone response, explicit region observations`,
    );
    const project = await make(input.path);
    const before = await project.frame(input.name + "-before");
    const identity = await project.frame(input.name + "-identity", {});
    assert.deepEqual(identity.rgb, before.rgb);
    for (const [name, config] of [
      ["shadows", { shadows: 0.2 }],
      ["highlights", { highlights: 0.3 }],
      ["grade", recipe],
      [
        "ordered",
        { ...recipe, exposureEV: -0.35, contrast: 1.03, saturation: 0.95, neutralKelvin: 6900 },
      ],
    ]) {
      const ref = join(out, `${input.name}-${name}-reference.png`);
      await reference(before.file, ref, config);
      const candidate = await project.frame(`${input.name}-${name}`, config);
      const delta = compare(candidate.rgb, await pixels(ref));
      const row = {
        input: input.name,
        name,
        config,
        comparison: delta,
        masks: input.masks,
        observations: {},
      };
      for (const [region, rect] of Object.entries(input.masks))
        row.observations[region] = {
          before: luma(before.rgb, rect),
          reference: luma(await pixels(ref), rect),
          candidate: luma(candidate.rgb, rect),
        };
      report.cases.push(row);
      await save();
      assert.ok(
        delta.maximumError <= 1,
        "Independent delivered PNG tone response <=1 code value, complete raster",
      );
      assert.notDeepEqual(
        candidate.rgb,
        before.rgb,
        "Explicit treatment must change delivered pixels",
      );
      if (name === "grade") {
        assert.ok(
          row.observations.face.candidate >= row.observations.face.before,
          "Frozen selected recipe retains/lifts this face region",
        );
        assert.ok(
          row.observations.wall.candidate < row.observations.wall.before,
          "Frozen selected recipe darkens this bright wall region",
        );
      }
      if (name === "ordered") {
        const reversed = join(out, `${input.name}-reversed-reference.png`);
        await reference(before.file, reversed, config, true);
        row.reversedOrderDifference = compare(candidate.rgb, await pixels(reversed));
        assert.ok(
          row.reversedOrderDifference.maximumError > 1,
          "Ordered reference must distinguish tone-before-exposure from declared tone-after-color",
        );
      }
    }
    if (input.name === "wall") {
      await project.frame("wall-delivery", recipe);
      const movie = await project.movie("wall-grade");
      const matched = await make(join(out, "wall-grade-reference.png"));
      const referenceMovie = await matched.movie("wall-reference");
      report.movie = {
        result: movie.result,
        reference: referenceMovie.result,
        rawReference: compare(
          movie.rgb,
          Buffer.concat(Array(2).fill(await pixels(join(out, "wall-grade-reference.png")))),
        ),
        matched: compare(movie.rgb, referenceMovie.rgb),
        frames: 2,
      };
      assert.equal(movie.rgb.length, 2 * 320 * 180 * 3);
      await save();
      assert.ok(
        report.movie.matched.meanError <= 1,
        "Matched full-raster two-frame movie reference MAE <=1",
      );
      for (const [name, path] of [
        ["wall-movie", movie.result.output],
        ["wall-reference-movie", referenceMovie.result.output],
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
    }
  }
  report.checks.push(
    "public CLI/MCP discovery and native delivered PNG identity",
    "all complete-raster tone references <=1 code value",
    "explicit chart and retained face/wall/neutral regions",
    "provider order distinguishes reversed reference",
    "all held-shot movie frames match encoded reference MAE<=1",
  );
  completed = true;
} finally {
  try {
    await service.stop();
    await rm(home, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  report.cleanup = { completed: !cleanupError };
  report.passed = completed && !cleanupError;
  await save();
}
if (cleanupError && completed) throw cleanupError;
console.log(
  JSON.stringify({
    passed: report.passed,
    out,
    checks: report.checks,
    movie: report.movie?.matched,
  }),
);
