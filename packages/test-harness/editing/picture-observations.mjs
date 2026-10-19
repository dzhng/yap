import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, poll, run, root, hash } from "./source-evidence-fixture.mjs";
import { pictureObservationsSchema, pictureObservationRequestSchema } from "@yap/protocol";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "media-root": { type: "string" },
    case: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "YAP_NATIVE=ABSOLUTE_WORKER node picture-observations.mjs --out EMPTY_DIRECTORY --media-root CERTIFIED_CORPUS_DIRECTORY [--case chart|alpha|dark|border|rotated|graham|madison|lily]\nPublic CLI/MCP observations, read-only PNG parity, independently decoded histogram operands and retained indexes. Explicit exposure controls are scratch project edits; originals remain intact. No models/devices.",
  );
  process.exit(0);
}
assert.ok(
  values.out &&
    isAbsolute(values.out) &&
    process.env.YAP_NATIVE &&
    isAbsolute(process.env.YAP_NATIVE),
);
const assets = join(root, "specs/done/video-editing-feedback/assets/14-picture-statistics");
const controls = JSON.parse(await readFile(join(assets, "controls.json")));
const manifest = JSON.parse(
  await readFile(join(root, "fixtures/video-editing-feedback/manifest.json")),
);
const rect = (id, x, y, width, height) => ({ regionId: id, rect: { x, y, width, height } });
const masks = {
  graham: [
    rect("face-area", 215, 75, 70, 70),
    rect("wall", 15, 80, 100, 80),
    rect("whiteboard", 155, 40, 55, 35),
  ],
  madison: [
    rect("face-area", 200, 65, 80, 110),
    rect("wall", 10, 75, 70, 100),
    rect("curtain-highlight", 350, 60, 80, 180),
  ],
  lily: [
    rect("face-area", 200, 105, 75, 130),
    rect("wall", 335, 30, 110, 85),
    rect("forehead-highlight", 245, 110, 20, 18),
  ],
};
const cameras = Object.keys(masks).map((id) => {
  const item = manifest.cases.find((v) => v.id === `${id}-picture`);
  return {
    id,
    file: values["media-root"] && join(values["media-root"], item.derivative.file),
    sha256: item.derivative.sha256,
    width: 480,
    height: 270,
    durationUs: 3_000_000,
    regions: masks[id],
    camera: true,
  };
});
const cases = [
  ...controls.map((c) => ({
    ...c,
    file: join(assets, c.file),
    regions: [rect("outside", -10, -10, 2, 2), rect("clipped", -1, 0, 2, 1)],
  })),
  ...cameras,
].filter((c) => !values.case || c.id === values.case);
assert.ok(
  cases.length && cases.every((c) => c.file),
  "Select a known case and supply --media-root for cameras",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true });
assert.deepEqual(await readdir(out), []);
const home = await mkdtemp("/tmp/yap-picture-observations-");
const report = {
  passed: false,
  scope:
    "Selected opaque-only delivered-sRGB raster measurements; masks are explicit rectangles, not face detection or grade targets",
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
  trace: [],
  cases: [],
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const save = (p, v) => writeFile(p, JSON.stringify(v) + "\n");
let decode = 0;
try {
  const pixels = join(home, "pixels");
  await run("swiftc", [
    "-parse-as-library",
    join(root, "packages/test-harness/editing/FrameImagePixels.swift"),
    "-o",
    pixels,
  ]);
  async function prove(file, observations) {
    const o = pictureObservationsSchema.parse(observations),
      raw = join(home, `pixels-${decode++}`);
    const profile = JSON.parse((await run(pixels, [file, raw])).stdout),
      bytes = await readFile(raw);
    await rm(raw);
    assert.equal(hash(bytes), o.rgbaSha256);
    assert.deepEqual([profile.width, profile.height], [o.width, o.height]);
    assert.equal(profile.outputProfile, o.measurementProfile.name);
    // Independent delivered-PNG operands; alpha is premultiplied, with only alpha255 contributing.
    for (const r of [o.full, ...o.regions]) {
      const histograms = Array.from({ length: 4 }, () => Array(256).fill(0));
      let opaque = 0,
        transparent = 0,
        partial = 0;
      if (r.sampledRect) {
        const q = r.sampledRect;
        for (let y = q.y; y < q.y + q.height; y++)
          for (let x = q.x; x < q.x + q.width; x++) {
            const i = (y * o.width + x) * 4;
            if (bytes[i + 3] === 0) {
              transparent++;
              continue;
            }
            if (bytes[i + 3] !== 255) {
              partial++;
              continue;
            }
            opaque++;
            for (let c = 0; c < 3; c++) histograms[c][bytes[i + c]]++;
            histograms[3][
              Math.round(0.2126 * bytes[i] + 0.7152 * bytes[i + 1] + 0.0722 * bytes[i + 2])
            ]++;
          }
      }
      assert.deepEqual(histograms, [
        r.channels.red.histogram,
        r.channels.green.histogram,
        r.channels.blue.histogram,
        r.luma.histogram,
      ]);
      assert.deepEqual(
        [opaque, transparent, partial],
        [r.coverage.opaquePixels, r.coverage.transparentPixels, r.coverage.partialAlphaPixels],
      );
    }
    return {
      decodedProfile: profile,
      pngSha256: hash(await readFile(file)),
      rgbaSha256: hash(bytes),
      allMasksAndChannelsMatch: true,
    };
  }
  await service.start();
  for (const c of cases) {
    assert.equal(hash(await readFile(c.file)), c.sha256, `${c.id} immutable fixture identity`);
    const directory = join(out, c.id);
    await mkdir(directory);
    const ack = await call("asset.import", { path: c.file, requestId: `import-${c.id}` });
    const imported = await poll(
      () => call("job.get", { jobId: ack.jobId }),
      (v) => v.state === "ready",
      "import",
    );
    const asset = await call("asset.get", { assetId: imported.published.output.assetId }),
      stream = asset.streams.find((v) => v.kind === (c.camera ? "video" : "image"));
    const source = { assetId: asset.assetId, streamId: stream.streamId };
    const observations = pictureObservationRequestSchema.parse({ regions: c.regions });
    const row = { id: c.id, inputSha256: c.sha256, source, observations, frames: [] };
    report.cases.push(row);
    async function inspect(kind, selection, atUs) {
      const params = {
        ...selection,
        ...(atUs === undefined ? {} : { atUs }),
        maxLongEdge: c.camera ? 480 : 4,
        observations,
      };
      await poll(
        () => call("frame.get", params, { transport: "mcp" }),
        (v) => v.state === "ready",
        kind,
      );
      const file = join(directory, `${kind}.png`),
        status = await call("frame.get", params, { output: file });
      const receipt = status.published.output;
      assert.deepEqual(receipt.observations.request, observations);
      const proof = await prove(file, receipt.observations);
      const plainParams = { ...params };
      delete plainParams.observations;
      await poll(
        () => call("frame.get", plainParams, { transport: "mcp" }),
        (v) => v.state === "ready",
        `${kind} plain`,
      );
      const plainFile = join(directory, `${kind}-plain.png`),
        plain = await call("frame.get", plainParams, { output: plainFile });
      assert.equal(
        hash(await readFile(plainFile)),
        proof.pngSha256,
        "Observations must leave delivered PNG unchanged",
      );
      assert.notEqual(plain.jobId, status.jobId, "Measurements use a distinct retained derivative");
      const result = { kind, params, receipt, proof, plainPngSha256: proof.pngSha256 };
      row.frames.push(result);
      return result;
    }
    await inspect("source", source, c.camera ? 0 : undefined);
    if (c.camera) {
      const created = await call("project.create", {
        requestId: `create-${c.id}`,
        canvas: {
          width: 1920,
          height: 1080,
          fps: { numerator: 24, denominator: 1 },
          background: "#000000ff",
        },
      });
      const edit = await call("edit.apply", {
        projectId: created.project.projectId,
        expectedRevisionId: created.revision.revisionId,
        requestId: `place-${c.id}`,
        operations: [
          { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
          {
            operation: "place",
            clip: {
              ...source,
              trackId: { label: "video" },
              source: { kind: "range", range: { startUs: 0, endUs: c.durationUs } },
              placement: { kind: "project", range: { startUs: 0, endUs: c.durationUs } },
            },
          },
        ],
      });
      const project = {
        projectId: created.project.projectId,
        revisionId: edit.revision.revisionId,
      };
      await inspect("project", project, 0);
      if (c.id === "graham") {
        for (const [name, exposureEV] of [
          ["dark-exposure", -4],
          ["bright-exposure", 4],
        ]) {
          const changed = await call("edit.apply", {
            projectId: project.projectId,
            expectedRevisionId: project.revisionId,
            requestId: name,
            operations: [
              {
                operation: "processing.set",
                target: { kind: "output" },
                steps: [{ processor: { type: "sdr-correction", exposureEV } }],
              },
            ],
          });
          project.revisionId = changed.revision.revisionId;
          await inspect(name, project, 0);
        }
        const original = row.frames.find((f) => f.kind === "project").receipt.observations.full
          .luma;
        assert.ok(
          row.frames.find((f) => f.kind === "dark-exposure").receipt.observations.full.luma.mean <
            original.mean,
        );
        assert.ok(
          row.frames.find((f) => f.kind === "bright-exposure").receipt.observations.full.luma
            .brightFraction > original.brightFraction,
        );
        for (const [kind, selection] of [
          ["source-index", source],
          ["project-index", { ...project, maxLongEdge: 480 }],
        ]) {
          const input = { ...selection, observations: {}, limit: 1 };
          const ready = await poll(
            () => call("index.get", input, { transport: "mcp" }),
            (v) => v.state === "ready",
            kind,
          );
          assert.ok(ready.entries.length > 0);
          const pages = [ready],
            delivered = [];
          for (;;) {
            const page = pages.at(-1);
            for (const entry of page.entries) {
              const file = join(directory, `${kind}-${entry.candidate.ordinal}.png`);
              const receipt = await call("index.frame", entry.reference, { output: file });
              delivered.push({
                reference: entry.reference,
                receipt,
                proof: await prove(file, entry.frame.observations),
              });
            }
            if (!page.nextCursor) break;
            pages.push(
              await call("index.get", { ...input, cursor: page.nextCursor }, { transport: "mcp" }),
            );
          }
          assert.equal(delivered.length, ready.metadata.candidateCount);
          row[kind] = { pages, delivered };
        }
      }
    }
    assert.equal(hash(await readFile(c.file)), c.sha256, "Original fixture bytes stay intact");
  }
  report.passed = true;
} finally {
  await service.stop();
  report.logs = service.logs;
  await save(join(out, "report.json"), report);
  await rm(home, { recursive: true, force: true });
}
