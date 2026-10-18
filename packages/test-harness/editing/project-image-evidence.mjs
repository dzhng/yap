import assert from "node:assert/strict";
import { callLocal } from "@yap/client";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Freeze a native worker before running this journey");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "project-image-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "project-image-public-"));
const report = { passed: false, trace: [], pictures: [], checks: {} };
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const ref = (label) => ({ label });
const fixture = join(root, "specs/done/agent-editing/assets/10d-still-image-native/sources");
async function importImage(name) {
  const path = name.startsWith("/") ? name : join(fixture, name),
    bytes = await readFile(path);
  const pending = await call("asset.import", { requestId: randomUUID(), path });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "import image",
  );
  const asset = await call("asset.get", { assetId: hash(bytes) });
  return { assetId: asset.id, streamId: asset.streams[0].streamId };
}
async function picture(selection, name) {
  const ready = await poll(
    () => call("frame.get", selection),
    (v) => v.state === "ready",
    name,
  );
  const file = join(out, `${name}.png`);
  const delivered = await call("frame.get", selection, { output: file });
  const mcp = await service.mcp.callTool({ name: "frame.get", arguments: selection });
  assert.equal(mcp.structuredContent.ok, true);
  assert.ok(
    Buffer.from(mcp.content.find((v) => v.type === "image").data, "base64").equals(
      await readFile(file),
    ),
  );
  const frame = delivered.published.output;
  for (const layer of frame.frame.layers) {
    assert.equal(Object.hasOwn(layer, "sourceUs"), layer.kind === "video");
  }
  for (const selected of frame.pictures) {
    if (selected.kind !== "image") continue;
    for (const key of ["requestedSourceUs", "actualSourceUs", "sample"])
      assert.equal(Object.hasOwn(selected, key), false);
  }
  if (frame.frame.layers.every((v) => v.kind === "image")) assert.equal(frame.decodedSamples, 0);
  const row = { name, selection, file, sha256: hash(await readFile(file)), receipt: frame };
  report.pictures.push(row);
  return { ...row, ready };
}
try {
  await service.start();
  const png = await importImage("png-6.png"),
    jpeg = await importImage("jpeg-2.jpeg");
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 40,
      height: 64,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const edit = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", label: "base", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "overlay", track: { kind: "video", order: 1 } },
      ...[
        ["first", "base", png, 0, 600000],
        ["repeat", "base", png, 1200000, 2000000],
        ["card", "overlay", jpeg, 300000, 1400000],
      ].map(([label, track, source, startUs, endUs]) => ({
        operation: "place",
        label,
        clip: {
          ...source,
          trackId: ref(track),
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs, endUs } },
        },
      })),
      {
        operation: "processing.set",
        target: { kind: "clip", id: ref("card") },
        steps: [
          {
            label: "layout",
            processor: {
              type: "geometry",
              fit: "stretch",
              rect: { x: 12, y: 12, width: 24, height: 16 },
            },
          },
        ],
      },
    ],
  });
  const selection = { projectId, revisionId: edit.revision.revisionId };
  for (const atUs of [
    0, 299999, 300000, 599999, 600000, 1199999, 1200000, 1399999, 1400000, 1999999,
  ])
    await picture({ ...selection, atUs }, `frame-${atUs}`);
  assert.equal(
    report.pictures[0].sha256,
    report.pictures.at(-1).sha256,
    "Repeated image changed pixels",
  );
  assert.notEqual(
    report.pictures[0].sha256,
    report.pictures[2].sha256,
    "Overlay failed to change pixels",
  );
  report.checks.placement = report.pictures.map((p) => ({
    atUs: p.selection.atUs,
    clips: p.receipt.frame.layers.map((v) => v.clipId),
  }));
  assert.deepEqual(
    report.checks.placement.map((p) => p.clips.length),
    [1, 1, 2, 2, 1, 1, 2, 2, 1, 1],
  );
  const pixelTool = join(home, "pixels");
  await run("swiftc", [
    "-parse-as-library",
    join(root, "packages/test-harness/editing/FrameImagePixels.swift"),
    "-o",
    pixelTool,
  ]);
  const actualFile = join(out, "baseline.rgba");
  await run(pixelTool, [report.pictures[0].file, actualFile]);
  const actual = await readFile(actualFile),
    pixelReference = await readFile(join(fixture, "png-6.png.reference.rgba"));
  assert.equal(actual.length, pixelReference.length);
  let opaqueMaximum = 0,
    opaquePixels = 0;
  for (let i = 0; i < actual.length; i += 4)
    if (pixelReference[i + 3] === 255) {
      opaquePixels++;
      for (let c = 0; c < 3; c++)
        opaqueMaximum = Math.max(opaqueMaximum, Math.abs(actual[i + c] - pixelReference[i + c]));
    }
  assert.ok(opaqueMaximum <= 2, `Oriented image landmarks moved: ${opaqueMaximum}`);
  report.checks.orientation = { opaquePixels, opaqueMaximum };
  const movie = join(out, "preview.mp4");
  const preview = await poll(
    () => call("preview.get", selection, { output: movie }),
    (v) => v.state === "ready",
    "image preview",
  );
  report.checks.preview = preview;
  const request = {
    ...selection,
    kind: "video",
    requestId: randomUUID(),
    directory: out,
    leaf: "export.mp4",
  };
  const createdExport = await call("export.create", request);
  const exportId = createdExport.exportId;
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "image export",
  );
  assert.ok((await readFile(movie)).equals(await readFile(exported.output)));
  const index = await poll(
    () => call("index.get", { ...selection, limit: 100 }),
    (v) => v.state === "ready",
    "image index",
  );
  report.checks.index = index;
  assert.ok(index.page.entries.length > 2);
  assert.deepEqual(index.page.metadata.scenes, []);
  for (const entry of index.page.entries) {
    assert.ok(entry.frame.pictures.every((v) => v.kind === "image"));
    assert.ok(entry.candidate.reasons.every((v) => v.kind !== "scene"));
  }
  const reference = Object.fromEntries(
    ["projectId", "revisionId", "generation", "tap", "maxLongEdge"].map((key) => [
      key,
      index.page.metadata[key],
    ]),
  );
  for (const entry of index.page.entries) {
    const file = join(out, `index-${entry.candidate.ordinal}.png`);
    await call("index.frame", { ...reference, ordinal: entry.candidate.ordinal }, { output: file });
    const direct = await picture(
      { ...selection, atUs: entry.candidate.sampleAtUs },
      `index-direct-${entry.candidate.ordinal}`,
    );
    assert.ok((await readFile(file)).equals(await readFile(direct.file)));
  }
  const moviePixels = await run(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", movie, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"],
    { encoding: "buffer", maxBuffer: 1024 * 1024 },
  );
  const movieBytes = moviePixels.stdout,
    frameBytes = 40 * 64 * 4;
  assert.equal(movieBytes.length, 20 * frameBytes);
  const movieErrors = [];
  for (const [ordinal, directOrdinal] of [
    [0, 0],
    [3, 2],
    [6, 4],
    [12, 6],
    [14, 8],
    [19, 9],
  ]) {
    const raw = join(out, `comparison-${ordinal}.rgba`);
    await run(pixelTool, [report.pictures[directOrdinal].file, raw]);
    const still = await readFile(raw),
      decoded = movieBytes.subarray(ordinal * frameBytes, (ordinal + 1) * frameBytes);
    let difference = 0;
    for (let i = 0; i < frameBytes; i++)
      if (i % 4 !== 3) difference += Math.abs(still[i] - decoded[i]);
    const mae = difference / (40 * 64 * 3);
    assert.ok(mae < 12, `Movie ${ordinal} differs from matching project picture: ${mae}`);
    movieErrors.push({ ordinal, mae });
  }
  report.checks.movieMembership = movieErrors;
  const card = edit.edit.labels.card;
  const stack = [
    {
      label: "place",
      processor: { type: "geometry", fit: "stretch", rect: { x: 4, y: 4, width: 32, height: 40 } },
    },
    {
      label: "crop",
      processor: {
        type: "geometry",
        crop: { x: 4, y: 4, width: 16, height: 24 },
        fit: "stretch",
        rect: { x: 0, y: 0, width: 40, height: 64 },
      },
    },
    { label: "opacity", processor: { type: "opacity", opacity: 0.5 } },
  ];
  const changed = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: edit.revision.revisionId,
    operations: [{ operation: "processing.set", target: { kind: "clip", id: card }, steps: stack }],
  });
  const processed = await picture({ projectId, atUs: 400000 }, "processed-order-a");
  const dry = await picture(
    {
      projectId,
      atUs: 400000,
      tap: { target: { kind: "clip", id: card }, point: { kind: "dry" } },
    },
    "dry-card",
  );
  assert.notEqual(processed.sha256, report.pictures[2].sha256);
  const reversed = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: changed.revision.revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: card },
        steps: [stack[1], stack[0], stack[2]],
      },
    ],
  });
  const reordered = await picture({ projectId, atUs: 400000 }, "processed-order-b");
  assert.notEqual(processed.sha256, reordered.sha256, "Image processing stack order had no effect");
  assert.equal(
    (
      await picture(
        {
          projectId,
          atUs: 400000,
          tap: { target: { kind: "clip", id: card }, point: { kind: "dry" } },
        },
        "dry-card-reordered",
      )
    ).sha256,
    dry.sha256,
  );
  const historical = await picture({ ...selection, atUs: 300000 }, "historical");
  assert.equal(historical.sha256, report.pictures[2].sha256);
  const direct = async (operation, params) => {
    const result = await callLocal(service.socketPath, { id: randomUUID(), operation, params });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const evicted = await direct("frame.get", { ...selection, atUs: 0 });
  await call("artifact.close", { token: evicted.delivery.token });
  await rm(evicted.published.output.file);
  const regenerated = await picture({ ...selection, atUs: 0 }, "regenerated");
  assert.notEqual(regenerated.ready.published.generation, evicted.published.generation);
  assert.equal(regenerated.sha256, report.pictures[0].sha256);
  await service.stop();
  await service.start();
  assert.equal(
    (await picture({ ...selection, atUs: 0 }, "restarted-history")).sha256,
    report.pictures[0].sha256,
  );
  const indexedFile = join(out, "restarted-index.png");
  await call("index.frame", { ...reference, ordinal: 0 }, { output: indexedFile });
  assert.equal(hash(await readFile(indexedFile)), report.pictures[0].sha256);
  const lease = await direct("frame.get", { ...selection, atUs: 0 });
  await call("project.delete", { projectId });
  assert.equal(
    (await call("artifact.read", { token: lease.delivery.token, offset: 0 }, { error: true })).code,
    "ARTIFACT_EXPIRED",
  );
  assert.equal(
    (await call("index.frame", { ...reference, ordinal: 0 }, { error: true })).code,
    "NOT_FOUND",
  );
  await poll(
    () => call("frame.get", png),
    (v) => v.state === "ready",
    "raw image retained after project deletion",
  );
  assert.ok((await readFile(movie)).equals(await readFile(exported.output)));
  report.checks.lifecycle = {
    cacheRegeneration: true,
    historicalPixels: true,
    restart: true,
    indexRetained: true,
    deletionRevokesDelivery: true,
    sourceRetained: true,
    externalExportRetained: true,
  };
  report.checks.processing = {
    firstRevision: changed.revision.revisionId,
    reversedRevision: reversed.revision.revisionId,
    orderedPixelsDiffer: true,
    dryUnchanged: true,
  };
  const videoFile = join(home, "blue.mov");
  await run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=40x64:r=10:d=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    videoFile,
  ]);
  const video = await importImage(videoFile);
  const mixed = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 40,
      height: 64,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const mixedId = mixed.project.projectId;
  const mixedEdit = await call("edit.apply", {
    projectId: mixedId,
    requestId: randomUUID(),
    expectedRevisionId: mixed.revision.revisionId,
    operations: [
      { operation: "track.add", label: "video-track", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "image-track", track: { kind: "video", order: 1 } },
      {
        operation: "place",
        label: "video",
        clip: {
          ...video,
          trackId: ref("video-track"),
          source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
        },
      },
      {
        operation: "place",
        label: "image",
        clip: {
          ...png,
          trackId: ref("image-track"),
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 300000, endUs: 1400000 } },
        },
      },
    ],
  });
  const mixedFrame = await picture({ projectId: mixedId, atUs: 400000 }, "image-over-video");
  const videoFrame = await picture(
    {
      projectId: mixedId,
      atUs: 400000,
      tap: { target: { kind: "clip", id: mixedEdit.edit.labels.video }, point: { kind: "dry" } },
    },
    "underlying-video",
  );
  const mixedRaw = join(out, "mixed.rgba"),
    videoRaw = join(out, "video.rgba");
  await run(pixelTool, [mixedFrame.file, mixedRaw]);
  await run(pixelTool, [videoFrame.file, videoRaw]);
  const mixedPixels = await readFile(mixedRaw),
    videoPixels = await readFile(videoRaw);
  let partialPixels = 0,
    transparentPixels = 0,
    transparentMaximum = 0,
    imageMaximum = 0;
  for (let i = 0; i < pixelReference.length; i += 4) {
    if (pixelReference[i + 3] === 0) {
      transparentPixels++;
      for (let c = 0; c < 3; c++)
        transparentMaximum = Math.max(
          transparentMaximum,
          Math.abs(mixedPixels[i + c] - videoPixels[i + c]),
        );
    } else if (pixelReference[i + 3] < 255) {
      partialPixels++;
      for (let c = 0; c < 3; c++) {
        const source = Math.min(
          255,
          Math.round((pixelReference[i + c] * 255) / pixelReference[i + 3]),
        );
        const low = Math.min(source, videoPixels[i + c]);
        const high = Math.max(source, videoPixels[i + c]);
        if (high - low > 4)
          assert.ok(
            mixedPixels[i + c] > low && mixedPixels[i + c] < high,
            "Partial alpha must retain both image and video",
          );
      }
    } else if (pixelReference[i + 3] === 255) {
      for (let c = 0; c < 3; c++)
        imageMaximum = Math.max(imageMaximum, Math.abs(mixedPixels[i + c] - pixelReference[i + c]));
    }
  }
  assert.ok(
    transparentPixels > 100 && transparentMaximum <= 1 && imageMaximum <= 2,
    "Image/video alpha composition changed underlying or opaque pixels",
  );
  await poll(
    () => call("preview.get", { projectId: mixedId }, { output: join(out, "mixed-preview.mp4") }),
    (v) => v.state === "ready",
    "mixed preview",
  );
  const mixedIndex = await poll(
    () => call("index.get", { projectId: mixedId, limit: 100 }),
    (v) => v.state === "ready",
    "mixed index",
  );
  assert.equal(
    mixedIndex.page.metadata.scenes.length,
    1,
    "Only advancing video requires source scene evidence",
  );
  assert.ok(partialPixels > 0);
  report.checks.mixed = {
    partialPixels,
    transparentPixels,
    transparentMaximum,
    imageMaximum,
    index: mixedIndex.page.metadata,
  };
  await call("project.delete", { projectId: mixedId });
  report.passed = true;
} catch (error) {
  report.error = String(error.stack ?? error);
  throw error;
} finally {
  await service.stop();
  report.serviceLogs = service.logs;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, out, pictures: report.pictures.length }));
