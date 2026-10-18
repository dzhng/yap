import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({
  options: {
    duration: { type: "string", default: "1" },
    pointer: { type: "boolean", default: false },
    order: { type: "string", default: "compact,balanced,sharp" },
    out: { type: "string" },
    start: { type: "string", default: "0" },
  },
});
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  startUs = Number(values.start),
  durationUs = Number(values.duration) * 1000000;
assert(
  Number.isSafeInteger(durationUs) &&
    durationUs >= 1000000 &&
    durationUs <= 30000000 &&
    durationUs % 1000000 === 0,
);
assert(Number.isSafeInteger(startUs) && startUs >= 0);
await mkdir(out);
const home = await mkdtemp("/tmp/sr-quality-");
const report = {
  passed: false,
  trace: [],
  sourceStartUs: startUs,
  durationUs,
  references: [],
  variants: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  presetPromoted: false,
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
try {
  await service.start();
  const source = join(root, "fixtures/narrated-workbench/video.mov");
  const admitted = await call("asset.import", { requestId: randomUUID(), path: source });
  await poll(
    () => call("job.get", { jobId: admitted.jobId }),
    (v) => v.state === "ready",
    "source import",
  );
  const asset = await call("asset.get", { assetId: hash(await readFile(source)) });
  report.source = asset;
  let acquisitionId;
  if (values.pointer) {
    const donor = join(home, "donor");
    await mkdir(donor);
    for (const name of ["video.mov", "narration.mov", "capture.journal.jsonl"])
      await copyFile(join(root, "fixtures/narrated-workbench", name), join(donor, name));
    const pending = await call("acquisition.import", { requestId: randomUUID(), path: donor });
    const ready = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (value) => value.state === "ready",
      "actual pointer journal",
    );
    const acquisition = await call("acquisition.get", {
      acquisitionId: ready.target.acquisitionId,
    });
    assert(acquisition.bindings.some((binding) => binding.assetId === asset.id));
    acquisitionId = acquisition.id;
    report.acquisition = acquisition;
  }
  const created = await call("project.create", {
    requestId: randomUUID(),
    title: "Encoding quality study",
    canvas: {
      width: 1920,
      height: 1080,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const edited = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "screen" },
      {
        operation: "place",
        label: "screen-clip",
        clip: {
          trackId: { label: "screen" },
          assetId: asset.id,
          ...(acquisitionId ? { acquisitionId } : {}),
          streamId: asset.streams.find((x) => x.kind === "video").streamId,
          source: { kind: "range", range: { startUs, endUs: startUs + durationUs } },
          placement: { kind: "project", range: { startUs: 0, endUs: durationUs } },
        },
      },
      ...(values.pointer
        ? [
            {
              operation: "processing.set",
              target: { kind: "clip", id: { label: "screen-clip" } },
              steps: [{ processor: { type: "pointer", trailUs: 600000 } }],
            },
          ]
        : []),
    ],
  });
  report.project = edited;
  const frameCount = (durationUs * 30) / 1000000;
  const indices = [0, Math.floor(frameCount / 3), Math.floor((frameCount * 2) / 3), frameCount - 1];
  for (const index of indices) {
    const atUs = Math.floor((index * 1000000) / 30),
      path = join(out, `reference-${index}.png`);
    const params = { projectId, atUs, maxLongEdge: 1920 };
    await poll(
      () => call("frame.get", params),
      (v) => v.state === "ready",
      "reference",
    );
    const result = await call("frame.get", params, { output: path });
    report.references.push({
      index,
      atUs,
      path,
      sha256: hash(await readFile(path)),
      receipt: result,
    });
  }
  const order = values.order.split(",");
  assert.deepEqual([...order].sort(), ["balanced", "compact", "sharp"]);
  report.order = order;
  for (const preset of order) {
    const path = join(out, `${preset}.mp4`),
      params = { projectId, settings: { preset } };
    const ready = await poll(
      () => call("preview.get", params),
      (v) => v.state === "ready",
      preset,
    );
    await call("preview.get", params, { output: path });
    const prefix = join(out, `${preset}-%02d.png`);
    await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        "select=" + indices.map((index) => `eq(n\\,${index})`).join("+"),
        "-fps_mode",
        "passthrough",
        prefix,
      ],
      { timeout: 60000 },
    );
    report.variants.push({
      preset,
      path,
      bytes: (await readFile(path)).length,
      sha256: hash(await readFile(path)),
      settings: ready.published.output.settings,
      encodedVideo: ready.published.output.encodedVideo,
    });
  }
  report.passed = true;
} finally {
  try {
    await service.stop();
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, out, presetPromoted: false }));
