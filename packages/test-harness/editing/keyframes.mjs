import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveOutputSettings } from "../../composition/dist/index.js";
import { captureKeyframeAppearance } from "./keyframe-appearance.mjs";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({
  options: {
    case: { type: "string" },
    out: { type: "string" },
    convenience: { type: "boolean", default: false },
    appearance: { type: "boolean", default: false },
  },
});
if (values.case === "moved-retimed-split-zoom") {
  assert(!values.convenience && !values.appearance);
  const { runRetimedZoom } = await import("./retimed-zoom.mjs");
  await runRetimedZoom(values.out);
  process.exit(0);
}
assert.ok(["moved-split-zoom", "moved-split-pose", "moved-split-geometry"].includes(values.case));
assert.ok(!values.convenience || values.case === "moved-split-zoom");
const pose = values.case !== "moved-split-zoom";
const box = values.case === "moved-split-geometry";
assert.ok(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
assert.ok(!existsSync(out));
await mkdir(out);
const home = await mkdtemp(join(tmpdir(), "zoom-public-"));
const report = {
  passed: false,
  case: values.case,
  convenience: values.convenience,
  settings: resolveOutputSettings({ preset: "balanced" }),
  trace: [],
  pictures: [],
  checks: {},
  runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
  decoderSha256: hash(await readFile("/opt/homebrew/bin/ffmpeg")),
};
const service = new JourneyService(
    home,
    report,
    values.appearance ? join(out, "native") : undefined,
  ),
  call = service.call.bind(service);
const ref = (label) => ({ label }),
  fraction = (numerator, denominator = 1) => ({ numerator, denominator });
async function picture(selection, name) {
  await poll(
    () => call("frame.get", selection),
    (v) => v.state === "ready",
    name,
  );
  const file = join(out, name + ".png"),
    result = await call("frame.get", selection, { output: file });
  const mcp = await service.mcp.callTool({ name: "frame.get", arguments: selection });
  assert.equal(mcp.structuredContent.ok, true);
  assert.deepEqual(
    Buffer.from(mcp.content.find((v) => v.type === "image").data, "base64"),
    await readFile(file),
  );
  const row = {
    name,
    selection,
    file,
    sha256: hash(await readFile(file)),
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
    }),
    projectId = created.project.projectId;
  let head = created.revision.revisionId;
  const edit = async (operations) => {
    const result = await call("edit.apply", {
      projectId,
      expectedRevisionId: head,
      requestId: randomUUID(),
      operations,
    });
    head = result.revision.revisionId;
    return result;
  };
  const scale = {
    keys: [
      { at: fraction(0), value: 0.5, interpolation: { cubic: [1 / 3, 0, 2 / 3, 1] } },
      { at: fraction(1), value: 1.5, interpolation: "linear" },
    ],
  };
  const linear = (first, last) => ({
    keys: [
      { at: fraction(0), value: first, interpolation: "linear" },
      { at: fraction(1), value: last, interpolation: "linear" },
    ],
  });
  const geometry = (t) => {
    const e = t === undefined ? undefined : 3 * t * t - 2 * t * t * t;
    const value = e === undefined ? scale : (1 - e) * 0.5 + e * 1.5;
    const parameter = (first, last) =>
      t === undefined ? linear(first, last) : (1 - t) * first + t * last;
    return {
      type: "geometry",
      scale: { x: value, y: value },
      ...(box
        ? {
            crop: {
              x: parameter(-4, 4),
              y: parameter(-8, 8),
              width: parameter(32, 48),
              height: parameter(48, 80),
            },
            pivot: { x: parameter(0.25, 0.75), y: parameter(0.75, 0.25) },
          }
        : {}),
      ...(pose
        ? {
            rect: {
              x: t === undefined ? linear(-8, 8) : (1 - t) * -8 + t * 8,
              y: t === undefined ? linear(4, -4) : (1 - t) * 4 + t * -4,
              width: box ? parameter(32, 48) : 40,
              height: box ? parameter(80, 48) : 64,
            },
            rotationDeg:
              e === undefined
                ? {
                    keys: [
                      {
                        at: fraction(0),
                        value: -30,
                        interpolation: { cubic: [1 / 3, 0, 2 / 3, 1] },
                      },
                      { at: fraction(1), value: 30, interpolation: "linear" },
                    ],
                  }
                : (1 - e) * -30 + e * 30,
          }
        : {}),
    };
  };
  const authored = await edit([
    { operation: "track.add", label: "track", track: { kind: "video", order: 0 } },
    {
      operation: "place",
      label: "clip",
      clip: {
        trackId: ref("track"),
        assetId: asset.id,
        streamId: asset.streams[0].streamId,
        source: { kind: "hold", atUs: 0 },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
      },
    },
    values.convenience
      ? {
          operation: "zoom",
          target: { kind: "clip", id: ref("clip") },
          from: 0.5,
          to: 1.5,
          interpolation: { cubic: [1 / 3, 0, 2 / 3, 1] },
          window: { kind: "clip", clipId: ref("clip"), start: fraction(0), end: fraction(1) },
          label: "zoom",
        }
      : {
          operation: "processing.set",
          target: { kind: "clip", id: ref("clip") },
          steps: [{ label: "zoom", processor: geometry() }],
        },
  ]);
  const clipId = authored.edit.labels.clip,
    stepId = authored.edit.labels.zoom;
  const original = [];
  for (let i = 0; i < 8; i++)
    original.push(
      await picture(
        { projectId, revisionId: authored.revision.revisionId, atUs: i * 125000 },
        "zoom-" + i,
      ),
    );
  if (box) {
    const before = await call("processing.get", {
      projectId,
      revisionId: head,
      target: { kind: "clip", id: clipId },
    });
    for (const [index, [slot, unit]] of [
      ["crop.width", 1],
      ["crop.height", 1],
      ["rect.width", 1],
      ["rect.height", 1],
      ["pivot.x", 1],
      ["pivot.y", 1],
      ["crop.width", Number.MIN_VALUE],
    ].entries()) {
      const [field, component] = slot.split(".");
      const invalid = structuredClone(geometry());
      invalid[field][component] =
        field === "pivot"
          ? {
              keys: [
                { at: fraction(0), value: 0.2, interpolation: { cubic: [1 / 3, 5, 2 / 3, 5] } },
                { at: fraction(1), value: 0.8, interpolation: "linear" },
              ],
            }
          : {
              keys: [
                { at: fraction(0), value: unit, interpolation: { cubic: [1 / 3, -1, 2 / 3, -2] } },
                { at: fraction(1), value: 2 * unit, interpolation: "linear" },
              ],
            };
      const failure = await call(
        "edit.apply",
        {
          projectId,
          expectedRevisionId: head,
          requestId: randomUUID(),
          operations: [
            {
              operation: "processing.set",
              target: { kind: "clip", id: clipId },
              steps: [{ id: stepId, processor: invalid }],
            },
          ],
        },
        { error: true, transport: index % 2 ? "mcp" : "cli" },
      );
      assert.equal(failure.code, "INVALID_EDIT");
      assert.deepEqual(
        await call("processing.get", {
          projectId,
          revisionId: head,
          target: { kind: "clip", id: clipId },
        }),
        before,
      );
    }
  }
  const controls = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 8;
    const control = await edit([
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [{ id: stepId, processor: geometry(t) }],
      },
    ]);
    controls.push(
      await picture(
        { projectId, revisionId: control.revision.revisionId, atUs: i * 125000 },
        "constant-" + i,
      ),
    );
    assert.equal(
      controls[i].sha256,
      original[i].sha256,
      "Analytic static geometry control differs",
    );
  }
  const restored = await call("edit.restore", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: head,
    targetRevisionId: authored.revision.revisionId,
  });
  head = restored.id;
  const moved = await edit([
    { operation: "move", clipIds: [clipId], atUs: 2000000, ripple: "none" },
  ]);
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await picture(
          { projectId, revisionId: moved.revision.revisionId, atUs: 2000000 + i * 125000 },
          "moved-" + i,
        )
      ).sha256,
      original[i].sha256,
    );
  const split = await edit([{ operation: "split", clipIds: [clipId], atUs: 2375001 }]);
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await picture(
          { projectId, revisionId: split.revision.revisionId, atUs: 2000000 + i * 125000 },
          "split-" + i,
        )
      ).sha256,
      original[i].sha256,
    );
  const right = split.edit.clipLineage
    .find((row) => row.originalId === clipId)
    .clipIds.find((id) => id !== clipId);
  const trimmed = await edit([
    {
      operation: "trim",
      clipId: right,
      range: { startUs: 2500000, endUs: 2900000 },
      ripple: "none",
    },
  ]);
  for (let i = 4; i < 8; i++)
    assert.equal(
      (
        await picture(
          { projectId, revisionId: trimmed.revision.revisionId, atUs: 2000000 + i * 125000 },
          "trim-" + i,
        )
      ).sha256,
      original[i].sha256,
    );
  const stack = await call("processing.get", {
    projectId,
    revisionId: head,
    target: { kind: "clip", id: clipId },
  });
  const windowed = await edit([
    {
      operation: "processing.set",
      target: { kind: "clip", id: clipId },
      steps: stack.steps.map((step) => ({
        ...step,
        window: { kind: "clip", clipId, start: fraction(1, 8), end: fraction(1, 4) },
      })),
    },
  ]);
  for (const [i, expected] of [
    [0, controls[4]],
    [1, original[1]],
    [2, controls[4]],
  ])
    assert.equal(
      (
        await picture(
          { projectId, revisionId: windowed.revision.revisionId, atUs: 2000000 + i * 125000 },
          "window-" + i,
        )
      ).sha256,
      expected.sha256,
      "Window activation differs from exact processed/dry control",
    );
  const selection = { projectId, revisionId: split.revision.revisionId, settings: report.settings };
  const fullPath = join(out, "full.mp4"),
    rangePath = join(out, "range.mp4");
  await poll(
    () => call("preview.get", selection, { output: fullPath }),
    (v) => v.state === "ready",
    "full preview",
  );
  await poll(
    () =>
      call(
        "preview.get",
        { ...selection, range: { startUs: 2250001, endUs: 2750001 } },
        { output: rangePath },
      ),
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
  assert.deepEqual(await readFile(fullPath), await readFile(exported.output));
  const decode = async (path, name) => {
    const file = join(out, name + ".rgba");
    await run("/opt/homebrew/bin/ffmpeg", [
      "-v",
      "error",
      "-i",
      path,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      file,
    ]);
    return readFile(file);
  };
  const full = await decode(fullPath, "full"),
    range = await decode(rangePath, "range"),
    frameBytes = 40 * 64 * 4;
  assert.equal(full.length, 24 * frameBytes);
  assert.equal(range.length, 5 * frameBytes);
  const error = (a, b) => {
    let sum = 0,
      max = 0;
    for (let j = 0; j < frameBytes; j++)
      if (j % 4 !== 3) {
        const delta = Math.abs(a[j] - b[j]);
        sum += delta;
        max = Math.max(max, delta);
      }
    return { mean: sum / (40 * 64 * 3), max };
  };
  const movieErrors = [],
    rangeErrors = [];
  for (let i = 0; i < 8; i++) {
    const e = error(
      full.subarray((i + 16) * frameBytes, (i + 17) * frameBytes),
      await decode(original[i].file, "reference-" + i),
    );
    assert.ok(e.mean <= 12);
    movieErrors.push(e);
  }
  for (let i = 0; i < 5; i++) {
    const e = error(
      full.subarray((i + 18) * frameBytes, (i + 19) * frameBytes),
      range.subarray(i * frameBytes, (i + 1) * frameBytes),
    );
    assert.ok(e.mean <= 12);
    rangeErrors.push(e);
  }
  report.checks = {
    wholeCurveRefusals: box ? 7 : 0,
    analyticStaticControls: 8,
    movedPictures: 8,
    splitPictures: 8,
    trimmedPictures: 4,
    activationPictures: 3,
    previewExportExact: true,
    movieErrors,
    rangeErrors,
    encodedGate:
      "existing meanRGB<=12 still-image membership/layout tolerance; not strict color conformance",
  };
  if (values.appearance)
    report.appearance = await captureKeyframeAppearance({
      out,
      home,
      report,
      call,
      geometry,
      original,
      projectId,
      clipId,
      stepId,
      movedRevisionId: moved.revision.revisionId,
      head,
      fullPath,
      rangePath,
    });
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
console.log(JSON.stringify({ passed: report.passed, pictures: report.pictures.length, out }));
