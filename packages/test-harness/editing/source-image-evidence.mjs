import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { callLocal } from "@yap/client";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "A frozen native still-image worker is required");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "source-image-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "source-image-public-"));
const report = { passed: false, trace: [], pictures: [], checks: {} };
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const fixture = join(root, "specs/done/agent-editing/assets/10d-still-image-native");
const ready = (params) =>
  poll(
    () => call("frame.get", params, { transport: "mcp" }),
    (v) => v.state === "ready",
    "image frame",
  );
const imported = async (path) => {
  const pending = await call("asset.import", { requestId: randomUUID(), path });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "image import",
  );
  return call("asset.get", { assetId: hash(await readFile(path)) });
};
const noClock = (value) => {
  for (const key of [
    "atUs",
    "sample",
    "originUs",
    "supportDigest",
    "requestedSourceUs",
    "actualSourceUs",
    "acquisitionId",
  ])
    assert.equal(Object.hasOwn(value, key), false, `Image invented ${key}`);
};
try {
  await service.start();
  const pixels = join(home, "pixels");
  await run("swiftc", [
    "-parse-as-library",
    join(root, "packages/test-harness/editing/FrameImagePixels.swift"),
    "-o",
    pixels,
  ]);
  for (const kind of ["png", "jpeg"])
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const name = `${kind}-${orientation}`,
        source = join(home, `${name}.${kind}`);
      await copyFile(join(fixture, "sources", `${name}.${kind}`), source);
      const asset = await imported(source),
        selection = { assetId: asset.id, streamId: asset.streams[0].id };
      const first = await ready(selection),
        file = join(out, `${name}-cli.png`);
      const delivered = await call("frame.get", selection, { output: file });
      const mcp = await service.mcp.callTool({ name: "frame.get", arguments: selection });
      assert.equal(mcp.structuredContent.ok, true);
      const images = mcp.content.filter((item) => item.type === "image");
      assert.equal(images.length, 1);
      assert.equal(images[0].mimeType, "image/png");
      assert.ok(Buffer.from(images[0].data, "base64").equals(await readFile(file)));
      assert.ok(
        (await readFile(file)).equals(await readFile(join(fixture, `${name}.png`))),
        "Public bytes changed already-reviewed native pixels",
      );
      noClock(delivered);
      noClock(delivered.published.output);
      assert.equal(delivered.published.output.kind, "image");
      assert.equal(delivered.published.generation, first.published.generation);
      assert.equal(mcp.structuredContent.data.published.generation, first.published.generation);
      const raw = file + ".rgba",
        normalization = JSON.parse((await run(pixels, [file, raw])).stdout);
      const actual = await readFile(raw),
        expected = await readFile(join(fixture, "sources", `${name}.${kind}.reference.rgba`));
      assert.equal(actual.length, expected.length);
      let maximumError = 0;
      for (let i = 0; i < actual.length; i++)
        maximumError = Math.max(maximumError, Math.abs(actual[i] - expected[i]));
      assert.ok(
        maximumError <= 2,
        "Public image diverged from independent oriented RGBA reference",
      );
      assert.equal(delivered.published.output.orientation, orientation);
      assert.equal(delivered.published.output.hasAlpha, kind === "png");
      report.pictures.push({
        name,
        selection,
        receipt: delivered.published.output,
        generation: first.published.generation,
        file,
        sha256: hash(await readFile(file)),
        maximumError,
        normalization,
      });
    }
  const selected = report.pictures.find((item) => item.name === "png-6"),
    selection = selected.selection;
  const bounded = await ready({ ...selection, maxLongEdge: 17 });
  assert.deepEqual([bounded.published.output.width, bounded.published.output.height], [11, 17]);
  const boundedFile = join(out, "bounded-cli.png");
  await call("frame.get", { ...selection, maxLongEdge: 17 }, { output: boundedFile });
  assert.ok((await readFile(boundedFile)).equals(await readFile(join(fixture, "bounded.png"))));
  report.checks.bounded = { width: 11, height: 17, byteEqualNativePrerequisite: true };

  const direct = async (operation, params) => {
    const result = await callLocal(service.socketPath, { id: randomUUID(), operation, params });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const opened = await direct("frame.get", selection);
  const chunk = await call(
    "artifact.read",
    { token: opened.delivery.token, offset: 0, maxBytes: 65536 },
    { transport: "mcp" },
  );
  assert.ok(Buffer.from(chunk.data, "base64").equals(await readFile(selected.file)));
  await call("artifact.close", { token: opened.delivery.token }, { transport: "mcp" });
  assert.equal(
    (await call("artifact.read", { token: opened.delivery.token, offset: 0 }, { error: true }))
      .code,
    "ARTIFACT_EXPIRED",
  );
  report.checks.explicitDeliveryClose = true;

  // Remove only an owned scratch cache file to exercise disposable-image regeneration.
  const evicted = await direct("frame.get", selection);
  await call("artifact.close", { token: evicted.delivery.token });
  await rm(evicted.published.output.file);
  const regenerated = await ready(selection);
  assert.notEqual(regenerated.published.generation, selected.generation);
  assert.equal(regenerated.jobId, opened.jobId);
  report.checks.cacheRegeneration = true;

  const stale = await direct("frame.get", selection);
  await service.stop();
  // Original import files are disposable: owned assets and cached PNGs must survive.
  for (const item of report.pictures)
    await rm(join(home, `${item.name}.${item.name.split("-")[0]}`));
  await service.start();
  assert.equal(
    (
      await call(
        "artifact.read",
        { token: stale.delivery.token, offset: 0 },
        { error: true, transport: "mcp" },
      )
    ).code,
    "ARTIFACT_EXPIRED",
  );
  const restarted = await ready(selection);
  assert.equal(restarted.published.generation, regenerated.published.generation);
  const restartedFile = join(out, "restart-cli.png");
  await call("frame.get", selection, { output: restartedFile });
  assert.ok((await readFile(restartedFile)).equals(await readFile(selected.file)));
  report.checks.restart = {
    originalsRemoved: true,
    generationUnchanged: true,
    staleDeliveryExpired: true,
  };

  for (const [name, crash, maxLongEdge] of [
    ["cancel", false, 41],
    ["crash", true, 43],
  ]) {
    const params = { ...selection, maxLongEdge },
      hit = await service.arm("media.sourceImage");
    const pending = await call("frame.get", params, { transport: "mcp" });
    await hit();
    if (crash) {
      await service.stop(true);
      await service.start();
    } else await call("job.cancel", { jobId: pending.jobId }, { transport: "mcp" });
    await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === (crash ? "failed" : "canceled"),
      `${name} job`,
    );
    const stopped = await call("frame.get", params, { transport: "mcp" });
    assert.equal(stopped.state, crash ? "failed" : "idle");
    assert.equal(stopped.reason, crash ? "interrupted" : "canceled");
    assert.equal(stopped.retryable, true);
    assert.equal(stopped.published, null);
    assert.equal(stopped.jobId, pending.jobId);
    const retry = await call("job.retry", { jobId: stopped.jobId }, { transport: "mcp" });
    assert.equal(retry.jobId, pending.jobId);
    const recovered = await ready(params);
    noClock(recovered.published.output);
    await call("frame.get", params, { output: join(out, `${name}-retry-cli.png`) });
    report.checks[name] = { nativeReplyHeld: true, retrySameJob: true, ready: true };
  }

  const initial = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 40,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = initial.project.projectId;
  await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: initial.revision.id,
    operations: [
      { operation: "track.add", label: "pictures", track: { kind: "video", order: 0 } },
      {
        operation: "place",
        label: "photo",
        clip: {
          ...selection,
          trackId: { label: "pictures" },
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  await call("project.delete", { projectId }, { transport: "mcp" });
  assert.equal((await call("asset.get", { assetId: selection.assetId })).id, selection.assetId);
  assert.equal((await ready(selection)).published.generation, restarted.published.generation);
  report.checks.projectDeletion = { rawImagePreserved: true, assetDeletionPublicSurface: false };

  const video = await imported(join(root, "specs/done/agent-editing/assets/00-corpus/a.mov"));
  const videoSelection = {
    assetId: video.id,
    streamId: video.streams.find((stream) => stream.kind === "video").id,
  };
  for (const [params, code] of [
    [{ ...selection, atUs: 0 }, "UNSUPPORTED_MEDIA"],
    [{ ...selection, acquisitionId: "not-a-time-context" }, "INVALID_PARAMS"],
    [{ ...selection, streamId: "missing" }, "INVALID_PARAMS"],
    [videoSelection, "INVALID_PARAMS"],
    [{ ...selection, maxLongEdge: 0 }, "INVALID_PARAMS"],
    [{ ...selection, originUs: 0 }, "INVALID_PARAMS"],
  ])
    assert.equal((await call("frame.get", params, { error: true, transport: "mcp" })).code, code);
  const batch = await call("frame.batch", { ...selection, atUs: [0] }, { transport: "mcp" });
  assert.equal(batch.items[0].ok, false);
  assert.equal(batch.items[0].error.code, "UNSUPPORTED_MEDIA");
  const videoReady = await ready({ ...videoSelection, atUs: 0 });
  assert.equal(videoReady.published.output.requestedSourceUs, 0);
  assert.ok(videoReady.published.output.sample);
  assert.ok(videoReady.supportDigest);
  const videoFile = join(out, "preserved-video-cli.png");
  await call("frame.get", { ...videoSelection, atUs: 0 }, { output: videoFile });
  assert.ok(
    (await readFile(videoFile)).equals(await readFile(join(fixture, "video-a.mov-1600.png"))),
  );
  report.checks.invalidSelectorsAndTimedVideoPreservation = true;
  report.worker = {
    path: process.env.YAP_NATIVE,
    sha256: hash(await readFile(process.env.YAP_NATIVE)),
  };
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  try {
    await service.stop();
  } catch (error) {
    report.shutdownError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
