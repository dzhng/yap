import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { callLocal } from "@yap/client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { prepareLayersFixture } from "./layers-fixture.mjs";
import { layerTree, expectedRgba, compareGeometry } from "./layers-oracle.mjs";
import { layerCases } from "./layers-cases.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Freeze the native worker before the project-index journey");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "project-index-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-project-index-"));
const report = { passed: false, trace: [], checks: {} };
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const canvas = {
  width: 160,
  height: 96,
  fps: { numerator: 10, denominator: 1 },
  background: "#000000ff",
};

async function ready(input) {
  return poll(
    () => call("index.get", { ...input, limit: 1 }, { transport: "mcp" }),
    (value) => {
      assert.notEqual(value.state, "unavailable", JSON.stringify(value));
      return value.state === "ready";
    },
    "project index",
  );
}
async function inspect(input) {
  const first = await ready(input),
    metadata = first.page.metadata;
  const reference = Object.fromEntries(
    ["projectId", "revisionId", "generation", "tap", "maxLongEdge"].map((key) => [
      key,
      metadata[key],
    ]),
  );
  const entries = [...first.page.entries];
  let cursor = first.page.nextCursor;
  let afterOrdinal = -1;
  while (cursor) {
    assert.ok(cursor.afterOrdinal > afterOrdinal, "Index continuation must advance");
    afterOrdinal = cursor.afterOrdinal;
    const page = await call("index.get", { ...input, cursor, limit: 1 });
    assert.equal(page.page.metadata.generation, metadata.generation);
    entries.push(...page.page.entries);
    cursor = page.page.nextCursor;
  }
  const coverage = [];
  let afterSequence = -1;
  do {
    if (cursor) {
      assert.ok(cursor.afterSequence > afterSequence, "Coverage continuation must advance");
      afterSequence = cursor.afterSequence;
    }
    const page = await call("index.coverage", {
      ...reference,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    coverage.push(...page.coverage);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(entries.length, metadata.candidateCount);
  assert.deepEqual(
    entries.map((entry) => entry.candidate.ordinal),
    entries.map((_, ordinal) => ordinal),
  );
  for (const entry of entries) {
    assert.deepEqual(entry.frame.frame.visibleRange, entry.candidate.visibleRange);
    assert.deepEqual(entry.reference, { ...reference, ordinal: entry.candidate.ordinal });
    assert.deepEqual(
      coverage
        .filter((item) => item.ordinal === entry.candidate.ordinal)
        .map(({ project, ordinal, equality }) => ({ project, ordinal, equality })),
      [
        {
          project: entry.candidate.visibleRange,
          ordinal: entry.candidate.ordinal,
          equality: "sampled",
        },
      ],
    );
  }
  return { reference, metadata, entries, coverage };
}
async function image(reference, ordinal, name) {
  const output = join(out, `${name}.png`);
  const receipt = await call("index.frame", { ...reference, ordinal }, { output });
  const reply = await service.mcp.callTool({
    name: "index.frame",
    arguments: { ...reference, ordinal },
  });
  assert.equal(reply.structuredContent.ok, true, JSON.stringify(reply));
  const images = reply.content.filter((item) => item.type === "image");
  assert.equal(images.length, 1);
  const bytes = await readFile(output);
  assert.ok(bytes.equals(Buffer.from(images[0].data, "base64")));
  return { output, sha256: hash(bytes), receipt };
}
try {
  const fixtures = await prepareLayersFixture(home, out);
  await service.start();
  const created = await call("project.create", { requestId: "empty", canvas });
  const projectId = created.project.projectId;
  const empty = await inspect({ projectId });
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.coverage, []);
  assert.equal(empty.metadata.durationUs, 0);
  report.checks.empty = empty;

  const narration = fixtures.media.narration;
  const pending = await call("asset.import", { requestId: narration.sha256, path: narration.path });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (value) => value.state === "ready",
    "import narration",
  );
  const asset = await call("asset.get", { assetId: narration.sha256 });
  const edited = await call("edit.apply", {
    projectId,
    expectedRevisionId: created.revision.id,
    requestId: "audio-only",
    operations: [
      { operation: "track.add", label: "voice", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          assetId: asset.id,
          streamId: asset.streams[0].id,
          trackId: { label: "voice" },
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  const audioSelection = { projectId, revisionId: edited.revision.id, maxLongEdge: 160 };
  const frameHit = await service.arm("media.renderCompositionFrame");
  const pendingIndex = await poll(
    () => call("index.get", audioSelection),
    (value) => !!value.jobId,
    "project index admission",
  );
  await frameHit();
  const child = await call("frame.get", { ...audioSelection, atUs: 0 });
  await call("job.cancel", { jobId: child.jobId });
  const failed = await poll(
    () => call("job.get", { jobId: pendingIndex.jobId }),
    (value) => value.state === "failed",
    "project frame dependency failure",
  );
  assert.equal(failed.retryable, true);
  assert.equal(failed.errorDetails.dependency.jobId, child.jobId);
  assert.equal((await call("index.get", audioSelection)).state, "failed");
  await call("job.retry", { jobId: pendingIndex.jobId }, { transport: "mcp" });
  report.checks.canceledFrameRetry = {
    parentJobId: pendingIndex.jobId,
    childJobId: child.jobId,
    failed,
  };
  const audio = await inspect(audioSelection);
  assert.deepEqual(
    audio.entries.map((entry) => entry.candidate.sampleAtUs),
    [0, 900000],
  );
  assert.deepEqual(
    audio.coverage.map(({ project, ordinal, equality }) => ({ project, ordinal, equality })),
    [
      { project: { startUs: 0, endUs: 100000 }, ordinal: 0, equality: "sampled" },
      { project: { startUs: 100000, endUs: 900000 }, ordinal: null, equality: "unproven" },
      { project: { startUs: 900000, endUs: 1000000 }, ordinal: 1, equality: "sampled" },
    ],
  );
  audio.images = [];
  for (const entry of audio.entries) {
    const picture = await image(
      audio.reference,
      entry.candidate.ordinal,
      `background-${entry.candidate.ordinal}`,
    );
    const rgba = picture.output + ".rgba";
    await run(fixtures.pixelTool, [picture.output, rgba]);
    const pixels = await readFile(rgba);
    assert.equal(pixels.length, 160 * 96 * 4);
    assert.ok(
      pixels.every((value, index) => value === (index % 4 === 3 ? 255 : 0)),
      "Audio-only canvas must be opaque black",
    );
    audio.images.push(picture);
  }
  report.checks.audioOnly = audio;
  const media = {};
  for (const name of ["screen", "presenter"]) {
    const fixture = fixtures.media[name];
    const pending = await call("asset.import", { requestId: fixture.sha256, path: fixture.path });
    await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (value) => value.state === "ready",
      `import ${name}`,
    );
    const asset = await call("asset.get", { assetId: fixture.sha256 });
    media[name] = { assetId: asset.id, streamId: asset.streams[0].id };
    await rm(fixture.path);
  }
  const visual = await call("project.create", { requestId: "layered", canvas });
  const presenter = layerCases(canvas).find((item) => item.name === "presenter");
  const placed = await call(
    "edit.apply",
    {
      projectId: visual.project.projectId,
      expectedRevisionId: visual.revision.id,
      requestId: "held-screen-and-presenter",
      operations: [
        { operation: "track.add", label: "screen-track", track: { kind: "video", order: 0 } },
        { operation: "track.add", label: "presenter-track", track: { kind: "video", order: 1 } },
        {
          operation: "place",
          label: "screen",
          clip: {
            ...media.screen,
            trackId: { label: "screen-track" },
            source: { kind: "hold", atUs: 0 },
            placement: { kind: "project", range: { startUs: 0, endUs: 6000000 } },
          },
        },
        {
          operation: "place",
          label: "presenter",
          clip: {
            ...media.presenter,
            trackId: { label: "presenter-track" },
            source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
            placement: { kind: "project", range: { startUs: 2250000, endUs: 3250000 } },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "presenter" } },
          steps: presenter.stacks.presenter,
        },
      ],
    },
    { transport: "mcp" },
  );
  const composition = await inspect({
    projectId: visual.project.projectId,
    revisionId: placed.revision.id,
    maxLongEdge: 160,
  });
  assert.deepEqual(
    composition.entries.map((entry) => entry.candidate.sampleAtUs),
    [0, 2200000, 2300000, 3200000, 3300000, 5000000, 5900000],
  );
  assert.deepEqual(composition.metadata.scenes.map((scene) => scene.owner.assetId).sort(), [
    media.presenter.assetId,
  ]);
  composition.images = [];
  for (const entry of composition.entries) {
    const atUs = entry.candidate.sampleAtUs;
    const picture = await image(
      composition.reference,
      entry.candidate.ordinal,
      `composition-${atUs}`,
    );
    const direct = join(out, `direct-${atUs}.png`);
    await poll(
      () =>
        call(
          "frame.get",
          {
            projectId: composition.reference.projectId,
            revisionId: composition.reference.revisionId,
            atUs,
            maxLongEdge: 160,
          },
          { output: direct },
        ),
      (value) => value.state === "ready",
      "direct composite frame",
    );
    assert.equal(hash(await readFile(direct)), picture.sha256);
    const rgba = picture.output + ".rgba";
    await run(fixtures.pixelTool, [picture.output, rgba]);
    const stacks =
      atUs >= 2250000 && atUs < 3250000
        ? presenter.stacks
        : {
            presenter: [{ processor: { type: "opacity", opacity: 0 } }],
          };
    const verdict = compareGeometry(
      await readFile(rgba),
      expectedRgba(layerTree(canvas, fixtures.media, stacks).output),
      canvas.width,
      canvas.height,
    );
    composition.images.push({ atUs, ...picture, verdict });
  }
  report.checks.composition = composition;
  const tapImages = [];
  for (const point of ["dry", "processed"]) {
    const selected = await inspect({
      projectId: composition.reference.projectId,
      revisionId: composition.reference.revisionId,
      maxLongEdge: 160,
      tap: { target: { kind: "clip", id: placed.edit.labels.presenter }, point: { kind: point } },
    });
    const entry = selected.entries.find((item) => item.candidate.sampleAtUs === 2300000);
    assert.ok(entry);
    const picture = await image(selected.reference, entry.candidate.ordinal, `presenter-${point}`);
    const rgba = picture.output + ".rgba";
    await run(fixtures.pixelTool, [picture.output, rgba]);
    const surface = layerTree(canvas, fixtures.media, presenter.stacks).taps.get(
      `presenter/${point}`,
    );
    const verdict = compareGeometry(
      await readFile(rgba),
      expectedRgba(surface),
      canvas.width,
      canvas.height,
    );
    tapImages.push({ point, ...selected, picture, verdict });
  }
  assert.notEqual(tapImages[0].picture.sha256, tapImages[1].picture.sha256);
  report.checks.taps = tapImages;
  const batch = await call(
    "index.frames",
    { ...composition.reference, ordinals: [2, 999, 0, 2] },
    { transport: "mcp" },
  );
  assert.deepEqual(
    batch.items.map((item) => [item.ordinal, item.ok]),
    [
      [2, true],
      [999, false],
      [0, true],
      [2, true],
    ],
  );
  assert.deepEqual(batch.items[0].data.candidate, composition.entries[2].candidate);
  assert.deepEqual(batch.items[3].data.candidate, composition.entries[2].candidate);
  const retried = await call("job.retry", {
    jobId: (
      await call("index.get", {
        projectId: composition.reference.projectId,
        revisionId: composition.reference.revisionId,
        maxLongEdge: 160,
      })
    ).jobId,
  });
  assert.equal(retried.published.output.generation, composition.reference.generation);
  const firstPage = await call("index.get", {
    projectId: composition.reference.projectId,
    maxLongEdge: 160,
    limit: 1,
  });
  assert.ok(firstPage.page.nextCursor);
  const changedTap = { target: { kind: "output" }, point: { kind: "dry" } };
  assert.equal(
    (
      await call(
        "index.get",
        {
          projectId: composition.reference.projectId,
          tap: changedTap,
          cursor: firstPage.page.nextCursor,
        },
        { error: true },
      )
    ).code,
    "ARTIFACT_CHANGED",
  );
  for (const changed of [{ tap: changedTap }, { maxLongEdge: 320 }]) {
    assert.equal(
      (
        await call(
          "index.frame",
          { ...composition.reference, ...changed, ordinal: 0 },
          { error: true },
        )
      ).code,
      "ARTIFACT_CHANGED",
    );
  }
  const firstCoverage = await call("index.coverage", { ...composition.reference, limit: 1 });
  assert.ok(firstCoverage.nextCursor);
  assert.equal(
    (
      await call(
        "index.coverage",
        { ...composition.reference, candidateOrdinal: 0, cursor: firstCoverage.nextCursor },
        { error: true },
      )
    ).code,
    "ARTIFACT_CHANGED",
  );
  const changed = await call("edit.apply", {
    projectId: composition.reference.projectId,
    expectedRevisionId: placed.revision.id,
    requestId: "hide-presenter",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "clip", id: placed.edit.labels.presenter },
        steps: [{ processor: { type: "opacity", opacity: 0 } }],
      },
    ],
  });
  const old = await image(composition.reference, 2, "historical-before-restart");
  assert.equal(old.sha256, composition.images[2].sha256);
  await service.stop();
  await service.start();
  const continued = await call("index.get", {
    projectId: composition.reference.projectId,
    cursor: firstPage.page.nextCursor,
    limit: 1,
  });
  assert.equal(continued.revisionId, composition.reference.revisionId);
  assert.deepEqual(continued.page.entries[0].candidate, composition.entries[1].candidate);
  const historical = await image(composition.reference, 2, "historical-after-restart");
  assert.equal(historical.sha256, old.sha256);
  const current = await inspect({
    projectId: composition.reference.projectId,
    revisionId: changed.revision.id,
    maxLongEdge: 160,
  });
  const newEntry = current.entries.find((entry) => entry.candidate.sampleAtUs === 2300000);
  assert.ok(newEntry);
  const currentImage = await image(
    current.reference,
    newEntry.candidate.ordinal,
    "current-hidden-presenter",
  );
  assert.notEqual(currentImage.sha256, old.sha256);
  assert.equal(currentImage.sha256, composition.images[0].sha256);
  // CLI/MCP consume and close image deliveries; a public socket client can retain one until deletion.
  const leaseReply = await callLocal(service.socketPath, {
    id: randomUUID(),
    operation: "index.frame",
    params: { ...composition.reference, ordinal: 0 },
  });
  assert.equal(leaseReply.ok, true);
  report.trace.push({ operation: "index.frame", transport: "socket", ok: leaseReply.ok });
  const lease = leaseReply.data;
  const liveRead = await call("artifact.read", {
    token: lease.delivery.token,
    offset: 0,
    maxBytes: 16,
  });
  assert.equal(Buffer.from(liveRead.data, "base64").length, 16);
  await call("project.delete", { projectId: composition.reference.projectId });
  assert.equal(
    (await call("artifact.read", { token: lease.delivery.token, offset: 0 }, { error: true })).code,
    "ARTIFACT_EXPIRED",
  );
  assert.equal(
    (await call("index.frame", { ...composition.reference, ordinal: 0 }, { error: true })).code,
    "NOT_FOUND",
  );
  assert.equal(hash(await readFile(historical.output)), old.sha256);
  const sibling = await image(audio.reference, 0, "unrelated-project-after-delete");
  assert.equal(sibling.sha256, audio.images[0].sha256);
  report.checks.lifetime = {
    batch,
    readyRetry: retried,
    continuation: continued,
    old,
    historical,
    current: { reference: current.reference, image: currentImage },
    deletionRevoked: true,
    externalFilePreserved: true,
    unrelatedProjectPreserved: true,
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
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
