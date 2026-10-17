import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
assert.equal(process.argv.length, 3, "Provide a fresh output directory");
const out = resolve(process.argv[2]);
assert.ok(!existsSync(out));
await mkdir(out, { recursive: true });
assert.ok(process.env.YAP_NATIVE);
const home = await mkdtemp(join(tmpdir(), "opacity-public-"));
const report = {
  passed: false,
  trace: [],
  pictures: [],
  checks: {},
  runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  decoderSha256: hash(await readFile("/opt/homebrew/bin/ffmpeg")),
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const ref = (label) => ({ label });
async function picture(selection, name) {
  await poll(
    () => call("frame.get", selection),
    (v) => v.state === "ready",
    name,
  );
  const file = join(out, name + ".png");
  const result = await call("frame.get", selection, { output: file });
  const mcp = await service.mcp.callTool({ name: "frame.get", arguments: selection });
  assert.equal(mcp.structuredContent.ok, true);
  assert.deepEqual(
    Buffer.from(mcp.content.find((v) => v.type === "image").data, "base64"),
    await readFile(file),
  );
  const row = {
    name,
    file,
    sha256: hash(await readFile(file)),
    selection,
    receipt: result.published.output,
  };
  report.pictures.push(row);
  return row;
}
try {
  await service.start();
  const source = join(
    root,
    "specs/done/agent-editing/assets/10d-still-image-native/sources/png-6.png",
  );
  const pending = await call("asset.import", { requestId: randomUUID(), path: source });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: hash(await readFile(source)) });
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 40,
      height: 64,
      fps: { numerator: 8, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const authored = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "track", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: ref("track"),
          assetId: asset.id,
          streamId: asset.streams[0].id,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: ref("clip") },
        steps: [
          {
            label: "fade",
            processor: {
              type: "opacity",
              opacity: {
                keys: [
                  {
                    at: { numerator: 0, denominator: 1 },
                    value: 0,
                    interpolation: { cubic: [0, 1, 0, 1] },
                  },
                  { at: { numerator: 1, denominator: 1 }, value: 1, interpolation: "linear" },
                ],
              },
            },
          },
        ],
      },
    ],
  });
  const selection = { projectId, revisionId: authored.revision.id };
  const original = [];
  for (let i = 0; i < 8; i++)
    original.push(await picture({ ...selection, atUs: i * 125000 }, "curve-" + i));
  let current = authored;
  const clipId = authored.edit.labels.clip,
    stepId = authored.edit.labels.fade;
  for (let i = 0; i < 8; i++) {
    const value = 1 - (1 - Math.cbrt(i / 8)) ** 3;
    current = await call("edit.apply", {
      projectId,
      requestId: randomUUID(),
      expectedRevisionId: current.revision.id,
      operations: [
        {
          operation: "processing.set",
          target: { kind: "clip", id: clipId },
          steps: [{ id: stepId, processor: { type: "opacity", opacity: value } }],
        },
      ],
    });
    const control = await picture(
      { projectId, revisionId: current.revision.id, atUs: i * 125000 },
      "constant-" + i,
    );
    assert.equal(
      control.sha256,
      original[i].sha256,
      "Analytic easing/static native control differs",
    );
  }
  // Restore the original revision using the public revision operation before splitting.
  const restored = await call("edit.restore", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: current.revision.id,
    targetRevisionId: authored.revision.id,
  });
  const split = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: restored.id,
    operations: [{ operation: "split", clipIds: [clipId], atUs: 375001 }],
  });
  for (let i = 0; i < 8; i++)
    assert.equal(
      (await picture({ projectId, revisionId: split.revision.id, atUs: i * 125000 }, "split-" + i))
        .sha256,
      original[i].sha256,
    );
  const movie = join(out, "full.mp4");
  await poll(
    () => call("preview.get", selection, { output: movie }),
    (v) => v.state === "ready",
    "full preview",
  );
  const range = { startUs: 250001, endUs: 750001 },
    part = join(out, "range.mp4");
  await poll(
    () => call("preview.get", { ...selection, range }, { output: part }),
    (v) => v.state === "ready",
    "range preview",
  );
  const exportId = randomUUID();
  await call("export.create", {
    ...selection,
    kind: "video",
    exportId,
    directory: out,
    leaf: "export.mp4",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "export",
  );
  assert.deepEqual(await readFile(movie), await readFile(exported.output));
  const raw = async (path, output) => {
    await run("/opt/homebrew/bin/ffmpeg", [
      "-v",
      "error",
      "-i",
      path,
      "-vsync",
      "0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      output,
    ]);
    return readFile(output);
  };
  const full = await raw(movie, join(out, "full.rgba")),
    partial = await raw(part, join(out, "range.rgba")),
    frameBytes = 40 * 64 * 4;
  assert.equal(full.length, 8 * frameBytes);
  assert.equal(partial.length, 5 * frameBytes);
  const errors = [];
  for (let i = 0; i < 8; i++) {
    const png = await raw(original[i].file, join(out, "curve-" + i + ".rgba"));
    let sum = 0,
      max = 0;
    for (let j = 0; j < frameBytes; j++) {
      if (j % 4 === 3) continue;
      const delta = Math.abs(full[i * frameBytes + j] - png[j]);
      sum += delta;
      max = Math.max(max, delta);
    }
    errors.push({ frame: i, mean: sum / (40 * 64 * 3), max });
    assert.ok(errors.at(-1).mean <= 12, "Image fixture movie membership/layout tolerance exceeded");
  }
  const rangeErrors = [];
  for (let i = 0; i < 5; i++) {
    let sum = 0,
      max = 0;
    for (let j = 0; j < frameBytes; j++) {
      if (j % 4 === 3) continue;
      const delta = Math.abs(full[(i + 2) * frameBytes + j] - partial[i * frameBytes + j]);
      sum += delta;
      max = Math.max(max, delta);
    }
    rangeErrors.push({ frame: i, mean: sum / (40 * 64 * 3), max });
    assert.ok(rangeErrors.at(-1).mean <= 12);
  }
  report.checks = {
    analyticPictureControls: 8,
    pureSplitPictures: 8,
    previewExportExact: true,
    movieErrors: errors,
    fullRangeErrors: rangeErrors,
    encodedGate:
      "existing image fixture meanRGB<=12 membership/layout tolerance; not byte-exact color conformance",
  };
  const windowBase = await call("edit.restore", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: split.revision.id,
    targetRevisionId: authored.revision.id,
  });
  const unity = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: windowBase.id,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [{ id: stepId, processor: { type: "opacity", opacity: 1 } }],
      },
    ],
  });
  const dryOutput = await picture(
    { projectId, revisionId: unity.revision.id, atUs: 125000 },
    "window-unity-output",
  );
  const windowed = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: unity.revision.id,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [
          {
            id: stepId,
            processor: { type: "opacity", opacity: 0 },
            window: { kind: "project", range: { startUs: 200001, endUs: 300001 } },
          },
        ],
      },
    ],
  });
  const windowSelection = { projectId, revisionId: windowed.revision.id };
  const dryTap = { target: { kind: "clip", id: clipId }, point: { kind: "dry" } };
  for (const atUs of [125000, 250000, 375000]) {
    const processed = await picture({ ...windowSelection, atUs }, `window-${atUs}`);
    assert.equal(processed.sha256, atUs === 250000 ? original[0].sha256 : dryOutput.sha256);
    if (atUs === 250000) assert.notEqual(processed.sha256, dryOutput.sha256);
  }
  const retained = await poll(
    () => call("index.get", { ...windowSelection, limit: 100 }, { transport: "mcp" }),
    (value) => value.state === "ready",
    "windowed opacity index",
  );
  assert.deepEqual(
    retained.page.entries.map((entry) => entry.candidate.sampleAtUs),
    [0, 125000, 250000, 375000, 875000],
  );
  const reference = Object.fromEntries(
    ["projectId", "revisionId", "generation", "tap", "maxLongEdge"].map((key) => [
      key,
      retained.page.metadata[key],
    ]),
  );
  for (const entry of retained.page.entries) {
    const file = join(out, `window-index-${entry.candidate.ordinal}.png`);
    await call("index.frame", { ...reference, ordinal: entry.candidate.ordinal }, { output: file });
    const direct = await picture(
      { ...windowSelection, atUs: entry.candidate.sampleAtUs },
      `window-index-direct-${entry.candidate.ordinal}`,
    );
    assert.ok((await readFile(file)).equals(await readFile(direct.file)));
  }
  const dryIndex = await poll(
    () => call("index.get", { ...windowSelection, tap: dryTap, limit: 100 }),
    (value) => value.state === "ready",
    "dry opacity index",
  );
  assert.deepEqual(
    dryIndex.page.entries.map((entry) => entry.candidate.sampleAtUs),
    [0, 875000],
  );
  report.checks.activation = {
    range: { startUs: 200001, endUs: 300001 },
    index: retained,
    dryIndex,
    directAndRetainedExact: true,
  };
  report.passed = true;
  await call("project.delete", { projectId });
} catch (error) {
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await service.stop();
  report.serviceLogs = service.logs;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, out }));
