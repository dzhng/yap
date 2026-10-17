import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { resolveOutputSettings } from "../../composition/dist/index.js";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";
import { pointerFixture } from "./pointer-fixture.mjs";
import { compareLandmarks } from "./layers-oracle.mjs";
import { canonical, assertMatchedInputs } from "./encoded-appearance-inputs.mjs";
const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await mkdtemp("/tmp/sr-appearance-");
await mkdir(out);
const native = join(out, "native");
const report = {
  passed: false,
  scope: "Matched encoded appearance, not whole-slice acceptance or continuous playback",
  trace: [],
  cohorts: [],
  settings: resolveOutputSettings({ preset: "balanced" }),
  nativeSHA256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report, native),
  call = service.call.bind(service);
const frozen = join(root, "specs/done/agent-editing/assets/15-pointer-chain/input");
const template = JSON.parse(await readFile(join(frozen, "full.request.json"), "utf8"));
const decoder = join(home, "decode"),
  pixels = join(home, "pixels");
async function importAcquisition(donor) {
  const pending = await call("acquisition.import", { requestId: randomUUID(), path: donor });
  const ready = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "acquisition",
  );
  const acquisition = await call("acquisition.get", { acquisitionId: ready.target.acquisitionId });
  const binding = acquisition.bindings.find((v) => v.sourceRoles.includes("video"));
  return { assetId: binding.assetId, streamId: binding.streamId, acquisitionId: acquisition.id };
}
async function project(name, source, recorded, missing) {
  const canvas = recorded
    ? { width: 1920, height: 1080, fps: { numerator: 30, denominator: 1 }, background: "#000000ff" }
    : template.canvas;
  const duration = recorded ? 10000000 : 400000,
    start = recorded ? 35000000 : 800000;
  const created = await call("project.create", { requestId: randomUUID(), title: name, canvas });
  const ref = (label) => ({ label });
  const operations = [
    { operation: "group.add", label: "outer", group: { kind: "video", order: 0 } },
    {
      operation: "group.add",
      label: "inner",
      group: { kind: "video", order: 0, parentId: ref("outer") },
    },
    {
      operation: "track.add",
      label: "track",
      track: { kind: "video", order: 0, parentId: ref("inner") },
    },
    {
      operation: "place",
      label: "clip",
      clip: {
        ...source,
        trackId: ref("track"),
        source: { kind: "range", range: { startUs: start, endUs: start + duration } },
        placement: { kind: "project", range: { startUs: 0, endUs: duration } },
      },
    },
  ];
  const scopes = ["clip", "track", "inner", "outer", "output"];
  for (const [index, node] of template.processing.entries()) {
    if (recorded && index) continue;
    const steps = recorded
      ? [{ processor: { type: "pointer", trailUs: 600000 } }]
      : node.steps.map(({ processor, enabled }) => ({
          processor,
          enabled: processor.type === "pointer" && missing ? false : enabled,
        }));
    operations.push({
      operation: "processing.set",
      target:
        index === 4
          ? { kind: "output" }
          : { kind: index > 1 ? "group" : scopes[index], id: ref(scopes[index]) },
      steps,
    });
  }
  const edited = await call("edit.apply", {
    projectId: created.project.projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.id,
    operations,
  });
  return {
    name,
    projectId: created.project.projectId,
    revisionId: edited.revision.id,
    canvas,
    duration,
    source,
    recorded,
  };
}
async function picture(cohort, atUs, name) {
  const path = join(out, cohort.name, name + ".png");
  const receipt = await poll(
    () =>
      call(
        "frame.get",
        {
          projectId: cohort.projectId,
          revisionId: cohort.revisionId,
          atUs,
          maxLongEdge: Math.max(cohort.canvas.width, cohort.canvas.height),
        },
        { output: path },
      ),
    (v) => v.state === "ready",
    name,
  );
  const color = JSON.parse((await run(pixels, [path, path + ".rgba"])).stdout);
  return {
    atUs,
    path,
    color,
    pngSHA256: hash(await readFile(path)),
    rgbaSHA256: hash(await readFile(path + ".rgba")),
    receipt,
  };
}
async function movie(cohort, label, range) {
  const directory = join(out, cohort.name, label);
  await mkdir(directory);
  const before = new Set(await readdir(native));
  const path = join(directory, "movie.mp4");
  const receipt = await poll(
    () =>
      call(
        "preview.get",
        {
          projectId: cohort.projectId,
          revisionId: cohort.revisionId,
          settings: report.settings,
          ...(range ? { range } : {}),
        },
        { output: path },
      ),
    (v) => v.state === "ready",
    `${cohort.name}/${label}`,
  );
  const captures = (await readdir(native)).filter(
    (file) => file.endsWith(".json") && !before.has(file),
  );
  const records = await Promise.all(
    captures.map(async (file) => ({
      path: join(native, file),
      data: JSON.parse(await readFile(join(native, file), "utf8")),
    })),
  );
  const capture = records.find((v) => v.data.operation === "media.renderCompositionMovie");
  assert(capture);
  const prefix = capture.path.slice(0, -5);
  const frames = (await readFile(prefix + "-frames.jsonl", "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const pointers = capture.data.request.pointers
    ? (await readFile(prefix + "-pointers.jsonl", "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
    : [];
  await copyFile(prefix + "-frames.jsonl", join(directory, "compiled.frames.jsonl"));
  if (capture.data.request.pointers)
    await copyFile(prefix + "-pointers.jsonl", join(directory, "prepared.pointers.jsonl"));
  await copyFile(capture.path, join(directory, "native-request.json"));
  await run(decoder, [path, join(directory, "decoded")], { timeout: 120000 });
  const decoded = JSON.parse(await readFile(join(directory, "decoded/frames.json"), "utf8"));
  assert.equal(decoded.frames.length, frames.length);
  const start = range?.startUs ?? 0;
  for (let i = 0; i < frames.length; i++) {
    const expected = Math.max(start, frames[i].visibleRange.startUs) - start,
      pts = decoded.frames[i].pts;
    assert.equal(
      BigInt(pts.value) * 1000000n,
      BigInt(expected) * BigInt(pts.timescale),
      "Actual decoded PTS changed",
    );
  }
  return {
    label,
    path,
    range: range ?? { startUs: 0, endUs: cohort.duration },
    receipt,
    frames,
    pointers,
    decoded,
    sha256: hash(await readFile(path)),
  };
}
try {
  for (const [source, target] of [
    ["EncodedAppearanceFrames.swift", decoder],
    ["FrameImagePixels.swift", pixels],
  ])
    await run(
      "swiftc",
      ["-parse-as-library", join(root, "packages/test-harness/editing", source), "-o", target],
      { timeout: 120000 },
    );
  await service.start();
  const fixture = await pointerFixture(home);
  assert.equal(
    hash(await readFile(join(fixture.donor, "video.mov"))),
    hash(await readFile(join(frozen, "source.mov"))),
  );
  const source = await importAcquisition(fixture.donor);
  const shifted = join(home, "shifted");
  await mkdir(shifted);
  await copyFile(join(fixture.donor, "video.mov"), join(shifted, "video.mov"));
  const shiftedJournal = fixture.records.map((record) =>
    record.event === "cursorSamples"
      ? {
          ...record,
          data: {
            samples: record.data.samples.map((sample) => ({
              ...sample,
              x: sample.x + 12,
              globalX: sample.globalX + 12,
            })),
          },
        }
      : record,
  );
  await writeFile(
    join(shifted, "capture.journal.jsonl"),
    shiftedJournal.map((record, i) => JSON.stringify({ ...record, sequence: i + 1 })).join("\n") +
      "\n",
  );
  const shiftedSource = await importAcquisition(shifted);
  const recordedDonor = join(home, "recorded");
  await mkdir(recordedDonor);
  for (const file of ["video.mov", "narration.mov", "capture.journal.jsonl"])
    await copyFile(join(root, "fixtures/narrated-workbench", file), join(recordedDonor, file));
  const recordedSource = await importAcquisition(recordedDonor);
  const inputs = join(out, "inputs");
  await mkdir(inputs);
  report.inputs = [];
  for (const [name, donor] of [
    ["frozen", fixture.donor],
    ["shifted", shifted],
    ["recorded", recordedDonor],
  ]) {
    const journal = join(donor, "capture.journal.jsonl");
    await copyFile(journal, join(inputs, name + ".journal.jsonl"));
    report.inputs.push({
      name,
      videoSHA256: hash(await readFile(join(donor, "video.mov"))),
      journalSHA256: hash(await readFile(journal)),
    });
  }

  for (const [name, src, recorded, missing] of [
    ["frozen", source, false, false],
    ["shifted-control", shiftedSource, false, false],
    ["missing-control", source, false, true],
    ["recorded", recordedSource, true, false],
  ]) {
    const cohort = await project(name, src, recorded, missing);
    await mkdir(join(out, name));
    report.cohorts.push(cohort);
    const times = recorded
      ? [0, 333333, 666666, 966666, 3333333, 6666666, 9966666]
      : [0, 100000, 200000, 300000];
    cohort.pictures = [];
    for (const [i, time] of times.entries())
      cohort.pictures.push(await picture(cohort, time, `reference-${i}`));
    if (!recorded) {
      cohort.frozenComparison = [];
      for (const [i, picture] of cohort.pictures.entries()) {
        const expected = gunzipSync(await readFile(join(frozen, `intact-${i}.rgba.gz`))),
          actual = await readFile(picture.path + ".rgba");
        let result;
        try {
          compareLandmarks(actual, expected, 256, 160);
          result = { passed: true };
        } catch (error) {
          result = { passed: false, error: error.message };
        }
        cohort.frozenComparison.push({
          exactPixels: actual.equals(expected),
          originalLandmarkDiagnostic: result,
        });
        if (name === "frozen")
          assert.deepEqual(actual, expected, "Frozen pre-encode picture changed");
        else
          assert.equal(
            result.passed,
            false,
            "Deliberately wrong pointer passed original pre-encode geometry gate",
          );
      }
    }
    cohort.full = await movie(cohort, "full");
    if (name === "frozen") {
      const expectedFrames = (await readFile(join(frozen, "full.frames.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      const expectedPointers = (await readFile(join(frozen, "full.pointers.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(canonical(cohort.full.frames), canonical(expectedFrames));
      assert.deepEqual(canonical(cohort.full.pointers), canonical(expectedPointers));
    }
    if (name === "frozen" || recorded) {
      cohort.clipped = await movie(
        cohort,
        "range",
        recorded ? { startUs: 350001, endUs: 9650001 } : { startUs: 50001, endUs: 250001 },
      );
      assertMatchedInputs(cohort.full, cohort.clipped);
      const exportId = randomUUID(),
        output = join(out, name, "export.mp4");
      await call("export.create", {
        projectId: cohort.projectId,
        revisionId: cohort.revisionId,
        exportId,
        kind: "video",
        directory: join(out, name),
        leaf: "export.mp4",
        settings: report.settings,
      });
      cohort.export = await poll(
        () => call("export.status", { exportId }),
        (v) => v.state === "ready",
        "export",
      );
      assert.equal(hash(await readFile(output)), cohort.full.sha256);
    }
  }
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      report.logs = service.logs;
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
console.log(JSON.stringify({ passed: report.passed, out }));
