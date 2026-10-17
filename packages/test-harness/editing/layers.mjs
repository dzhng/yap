import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { layerTree, expectedRgba, compareGeometry, compareLandmarks } from "./layers-oracle.mjs";
import { layerCases } from "./layers-cases.mjs";
import { prepareLayersFixture } from "./layers-fixture.mjs";

const { values } = parseArgs({
  options: { case: { type: "string", default: "presenter-and-screen" }, out: { type: "string" } },
});
assert.equal(values.case, "presenter-and-screen");
assert.ok(process.env.YAP_NATIVE, "Freeze the native compositor before running the layer journey");
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "layers-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-layers-"));
const report = { passed: false, trace: [], checks: {}, frames: [] };
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");
const ref = (label) => ({ label });
const target = (name, identify = ref) =>
  name === "output"
    ? { kind: "output" }
    : {
        kind: ["inner", "outer"].includes(name)
          ? "group"
          : name.endsWith("Track")
            ? "track"
            : "clip",
        id: identify(name),
      };
const scenarioNames = new Set([
  "presenter",
  "presenter-reversed",
  "nested-taps",
  "order-placement-crop",
  "order-crop-placement",
  "parent-opacity",
  "child-opacity",
  "rotated-crop",
  "output-transparent-margin",
  "output-mirror",
]);
let deliveryOrdinal = 0;
async function delivered(params, name) {
  const ready = await poll(
    () => call("frame.get", params),
    (v) => v.state === "ready",
    name,
  );
  const file = join(out, `${deliveryOrdinal++}-${name}.png`);
  const cli = await call("frame.get", params, { output: file });
  const mcp = await service.mcp.callTool({ name: "frame.get", arguments: params });
  assert.equal(mcp.structuredContent.ok, true);
  const images = mcp.content.filter((item) => item.type === "image");
  assert.equal(images.length, 1);
  const bytes = await readFile(file);
  assert.ok(
    bytes.equals(Buffer.from(images[0].data, "base64")),
    "CLI and MCP deliver different frames",
  );
  assert.equal(cli.revisionId, ready.revisionId);
  return { file, receipt: cli.published.output };
}
async function imported(fixture) {
  const pending = await call("asset.import", { requestId: fixture.sha256, path: fixture.path });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "layer import",
  );
  const asset = await call("asset.get", { assetId: fixture.sha256 });
  return { assetId: asset.id, streamId: asset.streams[0].id };
}
async function createProject(canvas, media, suffix, scenario) {
  const processing = Object.entries(scenario.stacks)
    .filter(([name, steps]) => name !== "reversed" && steps.length)
    .map(([name, steps]) => ({ operation: "processing.set", target: target(name), steps }));
  const initial = await call("project.create", {
    requestId: suffix,
    canvas: { ...canvas, fps: { numerator: 10, denominator: 1 }, background: "#000000ff" },
  });
  const projectId = initial.project.projectId;
  const place = (label, track, source) => ({
    operation: "place",
    label,
    clip: {
      ...source,
      trackId: ref(track),
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  });
  const edit = await call("edit.apply", {
    projectId,
    requestId: `${suffix}-placements`,
    expectedRevisionId: initial.revision.id,
    operations: [
      { operation: "group.add", label: "outer", group: { kind: "video", order: 0 } },
      {
        operation: "group.add",
        label: "inner",
        group: { kind: "video", order: 0, parentId: ref("outer") },
      },
      {
        operation: "track.add",
        label: "screenTrack",
        track: { kind: "video", order: scenario.stacks.reversed ? 1 : 0, parentId: ref("inner") },
      },
      {
        operation: "track.add",
        label: "presenterTrack",
        track: { kind: "video", order: scenario.stacks.reversed ? 0 : 1, parentId: ref("inner") },
      },
      { operation: "track.add", label: "voice-track", track: { kind: "audio", order: 1 } },
      place("screen", "screenTrack", media[scenario.sources?.screen ?? "screen"]),
      place("presenter", "presenterTrack", media[scenario.sources?.presenter ?? "presenter"]),
      place("voice", "voice-track", media.narration),
      ...processing,
    ],
  });
  return { projectId, revisionId: edit.revision.id, labels: edit.edit.labels };
}
async function deliveryBytes(delivery) {
  const chunks = [];
  let offset = 0;
  while (offset < delivery.bytes) {
    const part = await call(
      "artifact.read",
      { token: delivery.token, offset, maxBytes: 65536 },
      { transport: "mcp" },
    );
    const bytes = Buffer.from(part.data, "base64");
    assert.ok(bytes.length > 0);
    assert.equal(part.nextOffset, offset + bytes.length);
    chunks.push(bytes);
    offset = part.nextOffset;
  }
  assert.equal(offset, delivery.bytes);
  await call("artifact.close", { token: delivery.token }, { transport: "mcp" });
  return Buffer.concat(chunks);
}
async function audioParity(selection, original, name) {
  const file = join(out, name + ".wav");
  const ready = await poll(
    () => call("audio.get", selection, { output: file }),
    (v) => v.state === "ready",
    "unchanged audio",
  );
  const decoded = (
    await run(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-i", file, "-f", "f32le", "-c:a", "pcm_f32le", "pipe:1"],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    )
  ).stdout;
  const start = Math.floor((selection.range.startUs * 48000) / 1000000),
    end = Math.floor((selection.range.endUs * 48000) / 1000000);
  const probe = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_streams",
        "-of",
        "json",
        file,
      ])
    ).stdout,
  ).streams[0];
  assert.equal(probe.sample_rate, "48000");
  assert.equal(probe.channels, 2);
  assert.equal(probe.codec_name, "pcm_f32le");
  assert.equal(probe.time_base, "1/48000");
  assert.equal(probe.duration_ts, end - start);
  assert.ok(
    decoded.equals(original.subarray(start * 8, end * 8)),
    "Geometry changed narration PCM or phase",
  );
  return {
    range: selection.range,
    pcmSha256: hash(decoded),
    frames: end - start,
    receipt: ready.published.output,
  };
}
async function movieGeometry(file, surface, canvas, range, fixtures, name) {
  const directory = join(out, `${name}-${range.startUs}-decoded`);
  await mkdir(directory);
  const request = join(directory, "request.json");
  // Independent 10fps clock: range starts with the preceding global sample,
  // subsequent images start at each global boundary strictly before range end.
  const times = [0];
  for (let us = (Math.floor(range.startUs / 100000) + 1) * 100000; us < range.endUs; us += 100000)
    times.push(us - range.startUs);
  await writeFile(request, JSON.stringify({ movie: file, output: directory, timesUs: times }));
  const sample = JSON.parse(
    (await run(join(home, "frame-reference"), [request], { timeout: 60000 })).stdout,
  );
  const expected = expectedRgba(surface),
    results = [];
  for (const frame of sample) {
    assert.equal(frame.status, "available", frame.error);
    const rgba = frame.file + ".rgba";
    await run(fixtures.pixelTool, [frame.file, rgba]);
    const actual = await readFile(rgba);
    const verdict = compareLandmarks(actual, expected, canvas.width, canvas.height);
    let sum = 0,
      maximum = 0,
      above = 0;
    for (let pixel = 0; pixel < canvas.width * canvas.height; pixel++) {
      let edge = 0;
      for (let c = 0; c < 3; c++) {
        const delta = Math.abs(actual[pixel * 4 + c] - expected[pixel * 4 + c]);
        sum += delta;
        maximum = Math.max(maximum, delta);
        edge = Math.max(edge, delta);
      }
      if (edge > 2) above++;
    }
    results.push({
      sample: frame,
      verdict,
      codecError: {
        maximum,
        mae: sum / (canvas.width * canvas.height * 3),
        aboveLosslessThreshold: above,
      },
    });
  }
  const metadata = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time,duration_time",
        "-of",
        "json",
        file,
      ])
    ).stdout,
  );
  assert.deepEqual(
    metadata.frames.map((f) => Math.round(Number(f.best_effort_timestamp_time) * 1000000)),
    times,
  );
  assert.deepEqual(
    metadata.frames.map((f) => Math.round(Number(f.duration_time) * 1000000)),
    times.map((at, i) => (times[i + 1] ?? range.endUs - range.startUs) - at),
  );
  return results;
}
try {
  const fixtures = await prepareLayersFixture(home, out);
  await service.start();
  const media = {};
  for (const [name, fixture] of Object.entries(fixtures.media))
    media[name] = await imported(fixture);
  // Imported bytes are now owned by the library. Every subsequent render must survive loss of donor paths.
  for (const fixture of Object.values(fixtures.media)) await rm(fixture.path);
  const retained = [];
  for (const canvas of [
    { width: 160, height: 96 },
    { width: 128, height: 128 },
  ]) {
    for (const scenario of layerCases(canvas).filter((s) => scenarioNames.has(s.name))) {
      const name = `${canvas.width}x${canvas.height}-${scenario.name}`;
      const project = await createProject(canvas, media, name, scenario);
      const surfaces = {
        screen: fixtures.media[scenario.sources?.screen ?? "screen"],
        presenter: fixtures.media[scenario.sources?.presenter ?? "presenter"],
      };
      const oracle = layerTree(canvas, surfaces, scenario.stacks);
      const taps = scenario.taps
        ? [...oracle.taps.entries()]
        : [["output/processed", oracle.output]];
      const row = { name, canvas, project, frames: [] };
      report.frames.push(row);
      for (const [tapName, surface] of taps) {
        const [rawName, point] = tapName.split("/"),
          selected = rawName.replace("-track", "Track");
        const tap = {
          target: target(selected, (n) => project.labels[n]),
          point: point.startsWith("after:")
            ? { kind: "after-step", stepId: project.labels[point.slice(6)] }
            : { kind: point },
        };
        const params = {
          projectId: project.projectId,
          revisionId: project.revisionId,
          atUs: 450001,
          maxLongEdge: Math.max(canvas.width, canvas.height),
          tap,
        };
        const picture = await delivered(
          params,
          `${name}-${tapName.replaceAll("/", "-").replaceAll(":", "-")}`,
        );
        const rgba = picture.file + ".rgba";
        await run(fixtures.pixelTool, [picture.file, rgba]);
        const expected = expectedRgba(surface),
          actual = await readFile(rgba);
        const verdict = compareGeometry(actual, expected, canvas.width, canvas.height);
        assert.equal(picture.receipt.frame.sampleAtUs, 400000);
        const sourceNames =
          selected === "screen" || selected === "screenTrack"
            ? ["screen"]
            : selected === "presenter" || selected === "presenterTrack"
              ? ["presenter"]
              : scenario.stacks.reversed
                ? ["presenter", "screen"]
                : ["screen", "presenter"];
        assert.deepEqual(
          picture.receipt.pictures.map((p) => [
            p.clipId,
            p.assetId,
            p.streamId,
            p.requestedSourceUs,
            p.actualSourceUs,
            p.status,
          ]),
          sourceNames.map((n) => [
            project.labels[n],
            media[scenario.sources?.[n] ?? n].assetId,
            media[scenario.sources?.[n] ?? n].streamId,
            400000,
            400000,
            "available",
          ]),
        );
        row.frames.push({
          tapName,
          ...picture,
          verdict,
          sha256: hash(await readFile(picture.file)),
        });
      }
      if (["presenter", "rotated-crop", "output-mirror"].includes(scenario.name)) {
        row.movies = [];
        for (const range of [
          { startUs: 0, endUs: 1000000 },
          { startUs: 123457, endUs: 812349 },
        ]) {
          const selection = { projectId: project.projectId, revisionId: project.revisionId, range };
          const file = join(out, `${name}-${range.startUs}.mp4`);
          const ready = await poll(
            () => call("preview.get", selection, { output: file }),
            (v) => v.state === "ready",
            name,
          );
          assert.deepEqual(ready.range, range);
          const mcp = await call("preview.get", selection, { transport: "mcp" });
          assert.ok((await deliveryBytes(mcp.delivery)).equals(await readFile(file)));
          const frames = await movieGeometry(file, oracle.output, canvas, range, fixtures, name);
          const audio = await audioParity(
            selection,
            fixtures.media.narration.pcm,
            `${name}-${range.startUs}`,
          );
          row.movies.push({ range, file, frames, audio });
          if (range.startUs === 0) {
            const request = {
              projectId: project.projectId,
              revisionId: project.revisionId,
              kind: "video",
              exportId: randomUUID(),
              directory: out,
              leaf: `${name}-export.mp4`,
            };
            await call("export.create", request);
            const exported = await poll(
              () => call("export.status", { exportId: request.exportId }, { transport: "mcp" }),
              (v) => v.state === "ready",
              "layer export",
            );
            assert.ok((await readFile(exported.output)).equals(await readFile(file)));
            row.export = { request, receipt: exported.receipt, output: exported.output };
          }
        }
      }
      if (scenario.movie === "nonopaque" || scenario.name === "output-transparent-margin") {
        const request = await call("preview.get", {
          projectId: project.projectId,
          revisionId: project.revisionId,
        });
        const failed = await poll(
          () => call("job.get", { jobId: request.jobId }),
          (v) => v.state === "failed",
          "transparent movie refusal",
        );
        assert.equal(failed.errorCode, "NOT_READY");
        assert.equal(failed.retryable, false);
        row.movieRefusal = {
          code: failed.errorCode,
          reason: failed.reason,
          retryable: failed.retryable,
        };
      }
      retained.push(row);
      await save("report.json", report);
      console.log(`PASS ${name}: ${row.frames.length} public taps`);
    }
  }
  const nested = retained.find((row) => row.name === "160x96-nested-taps");
  const before = nested.frames.find((frame) => frame.tapName === "screen/after:screen-place");
  const after = nested.frames.find((frame) => frame.tapName === "screen/processed");
  const beforePixels = await readFile(before.file + ".rgba"),
    afterPixels = await readFile(after.file + ".rgba");
  assert.throws(() => compareGeometry(beforePixels, afterPixels, 160, 96));
  report.checks.wrongTapRejected = true;
  for (const [a, b] of [
    ["presenter", "presenter-reversed"],
    ["order-placement-crop", "order-crop-placement"],
    ["parent-opacity", "child-opacity"],
  ]) {
    const left = retained.find((row) => row.name === `160x96-${a}`).frames[0];
    const right = retained.find((row) => row.name === `160x96-${b}`).frames[0];
    assert.notEqual(left.sha256, right.sha256, `${a}/${b} lost its noncommuting behavior`);
  }
  report.checks.noncommutingPairsDifferent = true;
  const edited = await createProject(
    { width: 160, height: 96 },
    media,
    "processed-split",
    layerCases({ width: 160, height: 96 }).find((s) => s.name === "presenter"),
  );
  const splitAtUs = 333333;
  const split = await call(
    "edit.apply",
    {
      projectId: edited.projectId,
      expectedRevisionId: edited.revisionId,
      requestId: "split-processed-presenter",
      operations: [
        {
          operation: "split",
          clipIds: [edited.labels.presenter],
          atUs: splitAtUs,
          rightLabels: [{ clipId: edited.labels.presenter, label: "right" }],
        },
      ],
    },
    { transport: "mcp" },
  );
  const splitFrames = [];
  for (const atUs of [0, 300000, splitAtUs - 1, splitAtUs, splitAtUs + 1, 400000, 999999]) {
    const original = await delivered(
      { projectId: edited.projectId, revisionId: edited.revisionId, atUs },
      `split-original-${atUs}`,
    );
    const divided = await delivered(
      { projectId: edited.projectId, revisionId: split.revision.id, atUs },
      `split-divided-${atUs}`,
    );
    assert.equal(
      hash(await readFile(divided.file)),
      hash(await readFile(original.file)),
      `Pure processed split changed picture at ${atUs}`,
    );
    assert.equal(divided.receipt.frame.sampleAtUs, original.receipt.frame.sampleAtUs);
    splitFrames.push({ atUs, original, divided, sha256: hash(await readFile(divided.file)) });
  }
  report.checks.processedSplit = { splitAtUs, frames: splitFrames };
  const splitMovie = join(out, "processed-split.mp4");
  const splitSelection = { projectId: edited.projectId, revisionId: split.revision.id };
  await poll(
    () => call("preview.get", splitSelection, { output: splitMovie }),
    (v) => v.state === "ready",
    "processed split preview",
  );
  const splitCanvas = { width: 160, height: 96 };
  const splitSurface = layerTree(
    splitCanvas,
    fixtures.media,
    layerCases(splitCanvas).find((s) => s.name === "presenter").stacks,
  ).output;
  report.checks.processedSplit.movie = await movieGeometry(
    splitMovie,
    splitSurface,
    splitCanvas,
    { startUs: 0, endUs: 1000000 },
    fixtures,
    "processed-split",
  );
  report.checks.processedSplit.audio = await audioParity(
    { ...splitSelection, range: { startUs: 0, endUs: 1000000 } },
    fixtures.media.narration.pcm,
    "processed-split",
  );
  const independent = await call("edit.apply", {
    projectId: edited.projectId,
    expectedRevisionId: split.revision.id,
    requestId: "reset-right-presenter-processing",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: split.edit.labels.right },
        steps: [],
      },
    ],
  });
  const resetFrames = [];
  for (const atUs of [100000, 600000]) {
    const before = await delivered({ ...splitSelection, atUs }, `independent-before-${atUs}`);
    const after = await delivered(
      { projectId: edited.projectId, revisionId: independent.revision.id, atUs },
      `independent-after-${atUs}`,
    );
    const beforeBytes = await readFile(before.file),
      afterBytes = await readFile(after.file);
    if (atUs < splitAtUs)
      assert.ok(afterBytes.equals(beforeBytes), "Editing right piece changed left piece");
    else {
      assert.ok(
        !afterBytes.equals(beforeBytes),
        "Clearing the right layout did not change its picture",
      );
      const rgba = after.file + ".rgba";
      await run(fixtures.pixelTool, [after.file, rgba]);
      const expected = expectedRgba(layerTree(splitCanvas, fixtures.media, {}).output);
      compareGeometry(await readFile(rgba), expected, splitCanvas.width, splitCanvas.height);
    }
    resetFrames.push({
      atUs,
      before,
      after,
      beforeSha256: hash(beforeBytes),
      afterSha256: hash(afterBytes),
    });
  }
  report.checks.independentSplitProcessing = resetFrames;
  const duplicate = await call("edit.apply", {
    projectId: edited.projectId,
    expectedRevisionId: independent.revision.id,
    requestId: "duplicate-processed-left",
    operations: [
      {
        operation: "duplicate",
        clipIds: [edited.labels.presenter],
        atUs: 1200000,
        copyLabels: [{ clipId: edited.labels.presenter, label: "copy" }],
      },
    ],
  });
  const duplicateFrames = [];
  for (const sourceUs of [0, 100000, 300000]) {
    const original = await delivered(
      {
        projectId: edited.projectId,
        revisionId: independent.revision.id,
        atUs: sourceUs,
        tap: {
          target: { kind: "clip", id: edited.labels.presenter },
          point: { kind: "processed" },
        },
      },
      `duplicate-original-${sourceUs}`,
    );
    const copy = await delivered(
      {
        projectId: edited.projectId,
        revisionId: duplicate.revision.id,
        atUs: sourceUs + 1200000,
        tap: {
          target: { kind: "clip", id: duplicate.edit.labels.copy },
          point: { kind: "processed" },
        },
      },
      `duplicate-copy-${sourceUs}`,
    );
    assert.equal(
      hash(await readFile(copy.file)),
      hash(await readFile(original.file)),
      "Duplicating a processed clip changed its clip-level picture",
    );
    assert.equal(copy.receipt.pictures.length, 1);
    assert.equal(copy.receipt.pictures[0].clipId, duplicate.edit.labels.copy);
    assert.equal(copy.receipt.pictures[0].assetId, media.presenter.assetId);
    assert.equal(copy.receipt.pictures[0].requestedSourceUs, sourceUs);
    assert.equal(copy.receipt.pictures[0].actualSourceUs, sourceUs);
    duplicateFrames.push({ sourceUs, original, copy, sha256: hash(await readFile(copy.file)) });
  }
  report.checks.processedDuplicate = duplicateFrames;
  const moved = await call(
    "edit.apply",
    {
      projectId: edited.projectId,
      expectedRevisionId: duplicate.revision.id,
      requestId: "move-processed-copy",
      operations: [
        { operation: "move", clipIds: [duplicate.edit.labels.copy], atUs: 2000000, ripple: "none" },
      ],
    },
    { transport: "mcp" },
  );
  const movedFrames = [];
  for (const reference of duplicateFrames) {
    const picture = await delivered(
      {
        projectId: edited.projectId,
        revisionId: moved.revision.id,
        atUs: reference.sourceUs + 2000000,
        tap: {
          target: { kind: "clip", id: duplicate.edit.labels.copy },
          point: { kind: "processed" },
        },
      },
      `moved-copy-${reference.sourceUs}`,
    );
    assert.equal(
      hash(await readFile(picture.file)),
      reference.sha256,
      "Moving a processed copy changed its picture",
    );
    assert.equal(picture.receipt.pictures.length, 1);
    assert.equal(picture.receipt.pictures[0].clipId, duplicate.edit.labels.copy);
    assert.equal(picture.receipt.pictures[0].requestedSourceUs, reference.sourceUs);
    assert.equal(picture.receipt.pictures[0].actualSourceUs, reference.sourceUs);
    movedFrames.push({ sourceUs: reference.sourceUs, ...picture, sha256: reference.sha256 });
  }
  report.checks.processedMove = movedFrames;
  const trimmed = await call("edit.apply", {
    projectId: edited.projectId,
    expectedRevisionId: moved.revision.id,
    requestId: "trim-processed-copy",
    operations: [
      {
        operation: "trim",
        clipId: duplicate.edit.labels.copy,
        range: { startUs: 2100000, endUs: 2300001 },
        ripple: "none",
      },
    ],
  });
  const trimmedFrames = [];
  for (const sourceUs of [100000, 300000]) {
    const reference = duplicateFrames.find((frame) => frame.sourceUs === sourceUs);
    const picture = await delivered(
      {
        projectId: edited.projectId,
        revisionId: trimmed.revision.id,
        atUs: sourceUs + 2000000,
        tap: {
          target: { kind: "clip", id: duplicate.edit.labels.copy },
          point: { kind: "processed" },
        },
      },
      `trimmed-copy-${sourceUs}`,
    );
    assert.equal(
      hash(await readFile(picture.file)),
      reference.sha256,
      "Trimming a processed copy changed its surviving picture",
    );
    assert.equal(picture.receipt.pictures.length, 1);
    assert.equal(picture.receipt.pictures[0].requestedSourceUs, sourceUs);
    assert.equal(picture.receipt.pictures[0].actualSourceUs, sourceUs);
    trimmedFrames.push({ sourceUs, ...picture, sha256: reference.sha256 });
  }
  const removed = [];
  for (const atUs of [1300000, 2050000]) {
    const picture = await delivered(
      {
        projectId: edited.projectId,
        revisionId: trimmed.revision.id,
        atUs,
        tap: {
          target: { kind: "clip", id: duplicate.edit.labels.copy },
          point: { kind: "processed" },
        },
      },
      `removed-copy-${atUs}`,
    );
    assert.equal(picture.receipt.readerOpens, 0);
    assert.deepEqual(picture.receipt.pictures, []);
    const rgba = picture.file + ".rgba";
    await run(fixtures.pixelTool, [picture.file, rgba]);
    assert.ok(
      (await readFile(rgba)).every((value) => value === 0),
      "Moved or trimmed-away clip tap must be transparent",
    );
    removed.push({ atUs, ...picture });
  }
  const protectedOriginal = await delivered(
    {
      projectId: edited.projectId,
      revisionId: trimmed.revision.id,
      atUs: 100000,
      tap: { target: { kind: "clip", id: edited.labels.presenter }, point: { kind: "processed" } },
    },
    "copy-edits-protected-original",
  );
  assert.equal(
    hash(await readFile(protectedOriginal.file)),
    duplicateFrames[1].sha256,
    "Editing the copy changed its original clip",
  );
  report.checks.processedTrim = { frames: trimmedFrames, removed, protectedOriginal };
  const first = retained.find((r) => r.name === "160x96-presenter"),
    old = first.project;
  const newLayout = {
    label: "new-layout",
    processor: { type: "geometry", rect: { x: 0, y: 0, width: 24, height: 40 }, fit: "stretch" },
  };
  const changed = await call("edit.apply", {
    projectId: old.projectId,
    requestId: "new-layout",
    expectedRevisionId: old.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: old.labels.presenter },
        steps: [newLayout],
      },
    ],
  });
  await service.stop();
  await service.start();
  const historical = await delivered(
    { projectId: old.projectId, revisionId: old.revisionId, atUs: 450001 },
    "historical",
  );
  assert.equal(hash(await readFile(historical.file)), first.frames[0].sha256);
  const current = await delivered({ projectId: old.projectId, atUs: 450001 }, "current");
  assert.notEqual(hash(await readFile(current.file)), first.frames[0].sha256);
  assert.equal(current.receipt.revisionId, changed.revision.id);
  const currentRgba = current.file + ".rgba";
  await run(fixtures.pixelTool, [current.file, currentRgba]);
  const currentExpected = expectedRgba(
    layerTree(first.canvas, fixtures.media, { presenter: [newLayout] }).output,
  );
  const currentVerdict = compareGeometry(
    await readFile(currentRgba),
    currentExpected,
    first.canvas.width,
    first.canvas.height,
  );
  report.checks.restartedLayout = currentVerdict;
  const lease = await call(
    "preview.get",
    { projectId: old.projectId, revisionId: old.revisionId },
    { transport: "mcp" },
  );
  await call("project.delete", { projectId: old.projectId });
  assert.equal(
    (await call("frame.get", { projectId: old.projectId, atUs: 450001 }, { error: true })).code,
    "NOT_FOUND",
  );
  assert.equal(
    (
      await call(
        "artifact.read",
        { token: lease.delivery.token, offset: 0 },
        { transport: "mcp", error: true },
      )
    ).code,
    "ARTIFACT_EXPIRED",
  );
  assert.equal(hash(await readFile(first.export.output)), first.export.receipt.sha256);
  // Re-render retained source bytes through a fresh project after donor unlink and original project deletion.
  const again = await createProject(
    first.canvas,
    media,
    "retained-again",
    layerCases(first.canvas).find((s) => s.name === "presenter"),
  );
  const recovered = await delivered(
    { projectId: again.projectId, revisionId: again.revisionId, atUs: 450001 },
    "retained-again",
  );
  assert.equal(hash(await readFile(recovered.file)), first.frames[0].sha256);
  report.checks.lifetime = {
    donorsRemoved: true,
    oldRevisionExact: true,
    newRevisionDifferent: true,
    deletedLeaseRevoked: true,
    externalExportPreserved: true,
    retainedSourcesRerendered: true,
  };
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await service.stop().catch((error) => {
    report.passed = false;
    report.shutdownError = error.message;
    process.exitCode = 1;
  });
  try {
    await save("report.json", report);
    await writeFile(join(out, "service.log"), service.logs.join(""));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
