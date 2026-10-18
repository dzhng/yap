import { omit } from "@yap/composition";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, poll, run, root, hash } from "./source-evidence-fixture.mjs";
import {
  compareBlendRaster,
  verifyBlendMovieSupport,
  selectBlendCases,
  verifyBlendReferenceIdentity,
} from "./blend-reference.mjs";
import { verifyPicturePixels } from "./decoded-picture-proof.mjs";

const { values } = parseArgs({
  options: { out: { type: "string" }, case: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "YAP_NATIVE=ABSOLUTE_WORKER node blend-public.mjs --out ABSOLUTE_EMPTY_DIRECTORY [--case RETAINED_CASE]\nBuild protocol/composition/client/core/service/CLI first. Uses frozen blend-sheet operands, real CLI/MCP, a scratch library, delivered PNG/movie/export verification, and no devices/models.",
  );
  process.exit(0);
}
assert.ok(
  values.out &&
    isAbsolute(values.out) &&
    process.env.YAP_NATIVE &&
    isAbsolute(process.env.YAP_NATIVE),
);
const operands = join(root, "specs/done/video-editing-feedback/assets/24-blend-sheet");
const frozen = JSON.parse(await readFile(join(operands, "report.json")));
const cases = selectBlendCases(frozen.cases, values.case);
const out = resolve(values.out);
await mkdir(out);
const home = await mkdtemp("/tmp/yap-blend-public-");
const report = {
  passed: false,
  scope:
    "Actual CLI/MCP authoring/readback, full-raster delivered PNG, sampled decoded preview and committed export; frozen independent reference",
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
  trace: [],
  exchanges: [],
  cases: [],
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
try {
  const pixels = join(home, "pixels"),
    movieReader = join(home, "movie-reader"),
    supportReader = join(home, "support-reader");
  for (const [source, executable] of [
    ["FrameImagePixels.swift", pixels],
    ["FrameColorReference.swift", movieReader],
    ["FrameSampleSupport.swift", supportReader],
  ])
    await run(
      "swiftc",
      ["-parse-as-library", join(root, "packages/test-harness/editing", source), "-o", executable],
      { timeout: 120000 },
    );
  let observationOrdinal = 0;
  async function observe(file, { width, height }) {
    const raw = join(home, `pixels-${observationOrdinal++}.rgba`);
    const observation = JSON.parse((await run(pixels, [file, raw], { timeout: 60000 })).stdout);
    verifyPicturePixels(observation);
    assert.deepEqual([observation.width, observation.height], [width, height]);
    const bytes = await readFile(raw);
    await rm(raw);
    return { observation, bytes };
  }
  await service.start();
  report.capabilities = await call("processing.capabilities", {});
  const capability = report.capabilities.find((item) => item.type === "blend");
  assert.equal(capability.execution, true, "Public blend discovery must report native readiness");
  assert.ok(capability.implementationId);
  for (const item of cases) {
    await mkdir(join(out, item.scenario));
    const directory = await realpath(join(out, item.scenario));
    const { document } = item;
    const imported = {};
    for (const id of ["below", "above"]) {
      const path = join(operands, item.scenario, id + ".png");
      assert.equal(hash(await readFile(path)), item.artifacts[id + ".png"]);
      const ack = await call("asset.import", { path, requestId: `${item.scenario}-${id}` });
      const ready = await poll(
        () => call("job.get", { jobId: ack.jobId }),
        (value) => value.state === "ready",
        "import",
      );
      const asset = await call("asset.get", { assetId: ready.published.output.assetId });
      const stream = asset.streams.find((stream) => stream.kind === "image");
      assert.ok(stream);
      imported[id] = { assetId: asset.id, streamId: stream.id };
    }
    const created = await call("project.create", {
      requestId: `create-${item.scenario}`,
      canvas: document.canvas,
    });
    const projectId = created.project.projectId;
    const ref = (id) => ({ label: id });
    const operations = [
      ...document.groups.toReversed().map(({ id, parentId, ...group }) => ({
        operation: "group.add",
        label: id,
        group: { ...group, ...(parentId ? { parentId: ref(parentId) } : {}) },
      })),
      ...document.tracks.map(({ id, parentId, ...track }) => ({
        operation: "track.add",
        label: id,
        track: { ...track, ...(parentId ? { parentId: ref(parentId) } : {}) },
      })),
      ...document.clips.map(({ id, trackId, assetId, ...clip }) => ({
        operation: "place",
        label: `clip-${id}`,
        clip: { ...omit(clip, "streamId"), ...imported[assetId], trackId: ref(trackId) },
      })),
      ...document.processing.map(({ target, steps }) => ({
        operation: "processing.set",
        target: { kind: target.kind, id: ref(target.id) },
        steps: steps.map(({ processor, enabled }) => ({ processor, enabled })),
      })),
    ];
    const edited = await call("edit.apply", {
      projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: `author-${item.scenario}`,
      operations,
    });
    const revisionId = edited.revision.revisionId;
    const target = { kind: "track", id: edited.edit.labels.above };
    const retained = await call(
      "processing.get",
      { projectId, revisionId, target },
      { transport: "mcp" },
    );
    assert.deepEqual(
      retained.steps.map((step) => step.processor),
      [{ type: "blend", mode: item.mode }],
    );
    const referenceFile = join(operands, item.scenario, "reference.png");
    verifyBlendReferenceIdentity(item.scenario, hash(await readFile(referenceFile)), frozen.cases);
    const reference = await observe(referenceFile, document.canvas);
    const png = join(directory, "frame.png");
    const frameParams = { projectId, revisionId, atUs: 0, maxLongEdge: document.canvas.width };
    const frame = await poll(
      () => call("frame.get", frameParams, { output: png }),
      (value) => value.state === "ready",
      "public frame",
    );
    assert.equal(frame.revisionId, revisionId);
    const actual = await observe(png, document.canvas);
    const { width, height } = document.canvas;
    const row = {
      scenario: item.scenario,
      mode: item.mode,
      projectId,
      revisionId,
      authored: edited.revision.document,
      readback: retained,
      frame,
      observation: actual.observation,
      arithmetic: compareBlendRaster(actual.bytes, reference.bytes, { width, height, limit: 2 }),
      fileSha256: hash(await readFile(png)),
      movie: [],
    };
    const movie = join(directory, "preview.mp4"),
      settings = { preset: "sharp" };
    const preview = await poll(
      () => call("preview.get", { projectId, revisionId, settings }, { output: movie }),
      (value) => value.state === "ready",
      "public preview",
    );
    assert.equal(preview.revisionId, revisionId);
    const supportRequest = join(directory, "movie-support-request.json");
    await writeFile(
      supportRequest,
      JSON.stringify({
        file: movie,
        points: [
          { numerator: 0, denominator: 1 },
          { numerator: 100000, denominator: 1 },
        ],
      }),
    );
    row.support = JSON.parse(
      (await run(supportReader, [supportRequest], { timeout: 60000 })).stdout,
    );
    verifyBlendMovieSupport(row.support);
    const decoded = join(directory, "movie-frames");
    await mkdir(decoded);
    const request = join(directory, "movie-read.json");
    await writeFile(request, JSON.stringify({ movie, output: decoded, timesUs: [0, 100000] }));
    const reads = JSON.parse((await run(movieReader, [request], { timeout: 60000 })).stdout);
    for (const read of reads) {
      assert.equal(read.status, "available", read.error);
      assert.equal((Number(read.actualValue) * 1000000) / read.actualTimescale, read.requestedUs);
      const sample = await observe(read.file, document.canvas);
      row.movie.push({
        read,
        observation: sample.observation,
        arithmetic: compareBlendRaster(sample.bytes, reference.bytes, {
          width,
          height,
          limit: 8,
          interior: item.scenario !== "vignette",
        }),
      });
    }
    const requestId = randomUUID();
    const exportRequest = {
      projectId,
      revisionId,
      requestId,
      kind: "video",
      directory,
      leaf: "export.mp4",
      settings,
    };
    const created = await call("export.create", exportRequest);
    const exportId = created.exportId;
    const exported = await poll(
      () => call("export.status", { exportId }, { transport: "mcp" }),
      (value) => value.state === "ready",
      "public export",
    );
    assert.equal(exported.output, join(directory, exportRequest.leaf));
    assert.equal(exported.exportId, exportId);
    assert.equal(exported.projectId, projectId);
    assert.equal(exported.snapshot.revisionId, revisionId);
    assert.deepEqual(exported.destination, { directory, leaf: exportRequest.leaf });
    assert.equal(
      exported.receipt.sha256,
      hash(await readFile(movie)),
      "Export must publish the already verified pinned preview bytes",
    );
    assert.equal(hash(await readFile(exported.output)), exported.receipt.sha256);
    row.preview = preview;
    row.export = exported;
    report.cases.push(row);
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(
      `PASS public ${item.scenario}: frame max ${row.arithmetic.maximum}; movie max ${Math.max(...row.movie.map((sample) => sample.arithmetic.maximum))}; exact preview/export bytes`,
    );
  }
  for (const item of cases)
    for (const id of ["below", "above"])
      assert.equal(
        hash(await readFile(join(operands, item.scenario, id + ".png"))),
        item.artifacts[id + ".png"],
        "Original operand changed",
      );
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
