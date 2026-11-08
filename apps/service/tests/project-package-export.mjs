import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { transcriptGenerationResource } from "@yap/core/transcript";
import { test } from "node:test";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { indexGenerationResource } from "@yap/core/screenshot-index";
import { sceneGenerationResource } from "@yap/core/scene-evidence";
import { ResourceReferences } from "@yap/core/references";
import { crashFixture } from "./fixtures/project-export-crash.mjs";
import { fixture, gate } from "./fixtures/project-export.mjs";

test("project package export owns resource pins until commit and reopens retained project bytes", async (t) => {
  const f = await fixture(t, { admission: false });
  const request = { ...f.request(), kind: "processed-package", leaf: "project.zip" };
  await f.exports.create(request);
  const references = new ResourceReferences(f.catalog);
  assert.deepEqual(
    references
      .dependencies({ kind: "export", id: request.exportId })
      .map(({ kind, id }) => [kind, id]),
    [["asset", f.asset.id]],
  );
  f.jobs.startAdmission((job) => f.exports.admit(job));
  await f.jobs.idle();
  const status = f.exports.status(request.exportId);
  assert.equal(status.state, "committed", JSON.stringify(status));
  assert.deepEqual(references.dependencies({ kind: "export", id: request.exportId }), []);
  assert.deepEqual(await readdir(f.output), ["project.zip"]);
  assert.ok((await readFile(join(f.output, "project.zip"))).length > 0);
  const admission = await f.packages.open(status.output);
  await f.jobs.idle();
  const opened = f.packages.status(admission.id);
  assert.equal(opened.state, "ready", JSON.stringify(opened));
  assert.equal(opened.project.id, f.projectId);
  f.packages.adopt(opened.packageHandle, "adopt");
  await f.jobs.idle();
  const adopted = f.packages.adopt(opened.packageHandle, "adopt");
  assert.equal(adopted.state, "ready", JSON.stringify(adopted));
  assert.notEqual(adopted.published.output.projectId, f.projectId);
  const document = f.projects.revision(adopted.published.output.projectId).document;
  assert.equal(document.clips[0].assetId, f.asset.id);
  assert.equal(await readFile(f.assets.path(document.clips[0].assetId), "utf8"), "source identity");
  await f.packages.closeAdmission(admission.id);
});

test("committed project package retains counted private cleanup until retry without republishing", async (t) => {
  let refuse = true,
    publicationCalls = 0;
  const f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        if (operation.startsWith("publication.")) publicationCalls++;
        if (operation === "packageWorkspace.remove" && refuse)
          throw new Error("generated private cleanup failure");
        return run(operation, ...args);
      },
  });
  const baseline = await f.storage.usage();
  const request = { ...f.request(), kind: "processed-package", leaf: "historical.zip" };
  await f.exports.create(request);
  await f.jobs.idle();
  const committed = f.exports.status(request.exportId);
  assert.equal(committed.state, "committed", JSON.stringify(committed));
  assert.equal(committed.cleanupPending, true);
  assert.deepEqual(
    f.exports
      .list({ unfinishedOnly: true })
      .exports.map((row) => [row.id, row.state, row.cleanupPending]),
    [[request.exportId, "committed", true]],
  );
  const original = await readFile(committed.output);
  const assembly = () =>
    f.catalog.catalog
      .prepare("SELECT assembly FROM export_intents WHERE exportId=?")
      .get(request.exportId).assembly;
  const reservation = JSON.parse(assembly());
  assert.ok(reservation.input.identity && reservation.zip.identity);
  async function bytes(directory) {
    let total = 0;
    for (const name of await readdir(directory)) {
      const path = join(directory, name),
        info = await stat(path);
      total += info.isDirectory() ? await bytes(path) : info.size;
    }
    return total;
  }
  const root = join(f.home, "package-exports");
  const owned =
    (await bytes(join(root, reservation.input.name))) +
    (await bytes(join(root, reservation.zip.name)));
  assert.ok(owned > 0);
  const retained = await f.storage.usage();
  assert.equal(retained.sharedBytes, baseline.sharedBytes + owned);
  assert.equal(retained.otherBytes, 0);
  const admitted = () =>
    f.catalog.catalog
      .prepare(
        "SELECT COUNT(*) AS n FROM export_intents WHERE receipt IS NULL OR abandoning=1 OR assembly IS NOT NULL",
      )
      .get().n;
  assert.equal(admitted(), 1);
  const moved = f.output + "-moved";
  await rename(f.output, moved);
  t.after(() => rename(moved, f.output).catch(() => {}));
  refuse = false;
  const before = publicationCalls;
  await f.exports.retry(request.exportId);
  await f.jobs.idle();
  assert.equal(
    publicationCalls,
    before,
    "Acknowledged publication needs no external access for private cleanup",
  );
  assert.equal(f.exports.status(request.exportId).state, "committed");
  assert.equal(assembly(), null);
  assert.equal(admitted(), 0);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await f.storage.usage()).sharedBytes, baseline.sharedBytes);
  assert.deepEqual(f.exports.list({ unfinishedOnly: true }).exports, []);
  assert.equal(f.exports.status(request.exportId).cleanupPending, false);
  assert.deepEqual(await readFile(join(moved, "historical.zip")), original);
  await rename(moved, f.output);
});

for (const gap of ["create", "copy", "write", "commit", "cleanup"]) {
  test(`project package actual owner death at ${gap} retains recoverable workspace identity`, async (t) => {
    const { reopened: f, exportId } = await crashFixture(
      t,
      `package-${gap}`,
      undefined,
      "processed-package",
    );
    const assembly = () =>
      f.catalog.catalog
        .prepare("SELECT assembly FROM export_intents WHERE exportId=?")
        .get(exportId).assembly;
    assert.ok(assembly());
    const destination = join(f.output, "recovered.zip");
    const before = await readFile(destination).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    assert.equal(!!before, ["commit", "cleanup"].includes(gap));
    f.exports.resumeRecovery();
    await f.jobs.idle();
    assert.equal(assembly(), null);
    assert.deepEqual(await readdir(join(f.home, "package-exports")), []);
    if (before) {
      assert.equal(f.exports.status(exportId).state, "committed");
      assert.deepEqual(await readFile(destination), before);
    } else {
      assert.notEqual(f.exports.status(exportId).state, "committed");
      await f.exports.retry(exportId);
      await f.jobs.idle();
      assert.equal(
        f.exports.status(exportId).state,
        "committed",
        JSON.stringify(f.exports.status(exportId)),
      );
    }
    const bytes = await readFile(destination);
    await f.exports.abandon(exportId);
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
  });
}

const sceneSamples = (request, shade = 0) => ({
  assetId: request.asset.assetId,
  streamId: request.asset.streamId,
  originUs: request.asset.originUs,
  sourceWidth: 160,
  sourceHeight: 96,
  decodedSamples: request.atSourceUs.length,
  readerOpens: 1,
  samples: request.atSourceUs.map((at, i) => ({
    requestedSourceUs: at,
    status: "available",
    actualSourceUs: at,
    sample: {
      value: String(at),
      timescale: 1000000,
      endValue: String(at + 1),
      endTimescale: 1000000,
    },
    width: 1,
    height: 1,
    rgbBase64: Buffer.from([shade, shade, shade]).toString("base64"),
    continuousFromPrevious: i > 0,
  })),
});

test("canceled package keeps admitted scene generation through regeneration and retry", async (t) => {
  const entered = gate(),
    release = gate(),
    previewEntered = gate(),
    previewRelease = gate();
  t.after(() => {
    release.resolve();
    previewRelease.resolve();
  });
  let block = true,
    shade = 0;
  const f = await fixture(t, {
    sourceSample: async (request) => sceneSamples(request, shade),
    render: async (request, signal, render) => {
      previewEntered.resolve();
      await previewRelease.promise;
      return render(request, signal);
    },
    wrap:
      (run) =>
      async (operation, ...args) => {
        if (operation === "archive.write" && block) {
          entered.resolve();
          await release.promise;
        }
        return run(operation, ...args);
      },
  });
  const selection = { assetId: f.asset.id, streamId: "video" };
  f.sceneProcessing.prepareSource(selection);
  await f.jobs.idle();
  const first = f.sceneProcessing.sourceStatus(selection);
  assert.equal(first.state, "ready", JSON.stringify(first));
  const old = first.published.evidence;
  const original = f.scenes.sourcePage({ identity: old, limit: 10 }).chunks;
  const request = { ...f.request(), kind: "processed-package", leaf: "scene.zip" };
  await f.preview.request({ projectId: f.projectId, revisionId: f.placed.revision.id });
  await previewEntered.promise;
  shade = 128;
  f.jobs.regenerate(first.jobId, first.published.generation);
  await f.exports.create(request);
  assert.equal(f.jobs.job(first.jobId).state, "queued");
  assert.equal(f.exports.status(request.exportId).state, "queued");
  previewRelease.resolve();
  await entered.promise;
  const references = new ResourceReferences(f.catalog);
  const pinned = references.dependencies({ kind: "export", id: request.exportId });
  assert.deepEqual(
    pinned.filter((entry) => entry.kind === "scene-generation").map(({ kind, id }) => [kind, id]),
    [["scene-generation", sceneGenerationResource(old)]],
  );
  const activeReplacement = f.sceneProcessing.sourceStatus(selection);
  assert.equal(activeReplacement.state, "ready");
  assert.notEqual(activeReplacement.published.evidence.generation, old.generation);
  assert.equal(f.jobs.job(f.exports.status(request.exportId).jobId).state, "running");
  await f.sceneProcessing.cleanup(new AbortController().signal);
  assert.deepEqual(f.scenes.sourcePage({ identity: old, limit: 10 }).chunks, original);
  f.exports.cancel(request.exportId);
  block = false;
  release.resolve();
  await f.jobs.idle();
  assert.equal(f.exports.status(request.exportId).state, "canceled");
  shade = 255;
  f.jobs.regenerate(first.jobId, activeReplacement.published.generation);
  await f.jobs.idle();
  const second = f.sceneProcessing.sourceStatus(selection);
  assert.equal(second.state, "ready", JSON.stringify(second));
  assert.notEqual(second.published.evidence.generation, old.generation);
  await f.sceneProcessing.cleanup(new AbortController().signal);
  assert.deepEqual(f.scenes.sourcePage({ identity: old, limit: 10 }).chunks, original);
  await f.exports.retry(request.exportId);
  await f.jobs.idle();
  const committed = f.exports.status(request.exportId);
  assert.equal(committed.state, "committed", JSON.stringify(committed));
  assert.deepEqual(references.dependencies({ kind: "export", id: request.exportId }), []);
  await f.sceneProcessing.cleanup(new AbortController().signal);
  assert.throws(() => f.scenes.metadata(old));
  const recipient = await fixture(t);
  const admission = await recipient.packages.open(committed.output);
  await recipient.jobs.idle();
  const opened = recipient.packages.status(admission.id);
  assert.equal(opened.state, "ready", JSON.stringify(opened));
  recipient.packages.adopt(opened.packageHandle, "old-scene");
  await recipient.jobs.idle();
  const adopted = recipient.packages.adopt(opened.packageHandle, "old-scene");
  assert.equal(adopted.state, "ready", JSON.stringify(adopted));
  assert.deepEqual(recipient.scenes.sourcePage({ identity: old, limit: 10 }).chunks, original);
  await recipient.packages.closeAdmission(admission.id);
});

test("canceled package keeps admitted transcript bytes through regeneration and retry", async (t) => {
  const entered = gate(),
    release = gate(),
    previewEntered = gate(),
    previewRelease = gate();
  t.after(() => {
    release.resolve();
    previewRelease.resolve();
  });
  let block = true,
    word = "original";
  const speech = transcription(() => word);
  const f = await fixture(t, {
    ...speech,
    render: async (request, signal, render) => {
      previewEntered.resolve();
      await previewRelease.promise;
      return render(request, signal);
    },
    wrap:
      (run) =>
      async (operation, ...args) => {
        if (operation === "archive.write" && block) {
          entered.resolve();
          await release.promise;
        }
        return run(operation, ...args);
      },
  });
  const selection = await placeVoice(f);
  f.transcripts.prepareSource(selection);
  await f.jobs.idle();
  const first = f.transcripts.sourceStatus(selection);
  assert.equal(first.state, "ready", JSON.stringify(first));
  const old = first.published.transcript;
  const original = f.transcriptRecords.wordRecords(old, { limit: 10 });
  assert.deepEqual(
    original.map((entry) => entry.text),
    ["original"],
  );
  const request = { ...f.request(), kind: "processed-package", leaf: "transcript.zip" };
  await f.preview.request({ projectId: f.projectId, revisionId: f.placed.revision.id });
  await previewEntered.promise;
  word = "active-newer";
  f.jobs.regenerate(first.jobId, first.published.generation);
  await f.exports.create(request);
  assert.equal(f.jobs.job(first.jobId).state, "queued");
  assert.equal(f.exports.status(request.exportId).state, "queued");
  previewRelease.resolve();
  await entered.promise;
  const references = new ResourceReferences(f.catalog);
  assert.deepEqual(
    references
      .dependencies({ kind: "export", id: request.exportId })
      .filter((entry) => entry.kind === "transcript-generation")
      .map(({ kind, id }) => [kind, id]),
    [["transcript-generation", transcriptGenerationResource(old)]],
  );
  const activeReplacement = f.transcripts.sourceStatus(selection);
  assert.equal(activeReplacement.state, "ready");
  assert.deepEqual(
    f.transcriptRecords
      .wordRecords(activeReplacement.published.transcript, { limit: 10 })
      .map((entry) => entry.text),
    ["active-newer"],
  );
  assert.equal(f.jobs.job(f.exports.status(request.exportId).jobId).state, "running");
  await f.transcripts.cleanup(new AbortController().signal);
  assert.deepEqual(f.transcriptRecords.wordRecords(old, { limit: 10 }), original);
  f.exports.cancel(request.exportId);
  block = false;
  release.resolve();
  await f.jobs.idle();
  assert.equal(f.exports.status(request.exportId).state, "canceled");
  word = "newer";
  f.jobs.regenerate(first.jobId, activeReplacement.published.generation);
  await f.jobs.idle();
  const second = f.transcripts.sourceStatus(selection);
  assert.equal(second.state, "ready", JSON.stringify(second));
  assert.notEqual(second.published.transcript.generation, old.generation);
  assert.deepEqual(
    f.transcriptRecords
      .wordRecords(second.published.transcript, { limit: 10 })
      .map((entry) => entry.text),
    ["newer"],
  );
  await f.transcripts.cleanup(new AbortController().signal);
  assert.deepEqual(f.transcriptRecords.wordRecords(old, { limit: 10 }), original);
  await f.exports.retry(request.exportId);
  await f.jobs.idle();
  const committed = f.exports.status(request.exportId);
  assert.equal(committed.state, "committed", JSON.stringify(committed));
  assert.deepEqual(references.dependencies({ kind: "export", id: request.exportId }), []);
  await f.transcripts.cleanup(new AbortController().signal);
  assert.throws(() => f.transcriptRecords.retainedGeneration(old), { code: "NOT_FOUND" });
  const recipient = await fixture(t);
  const admission = await recipient.packages.open(committed.output);
  await recipient.jobs.idle();
  const opened = recipient.packages.status(admission.id);
  assert.equal(opened.state, "ready", JSON.stringify(opened));
  recipient.packages.adopt(opened.packageHandle, "old-transcript");
  await recipient.jobs.idle();
  const adopted = recipient.packages.adopt(opened.packageHandle, "old-transcript");
  assert.equal(adopted.state, "ready", JSON.stringify(adopted));
  assert.deepEqual(recipient.transcriptRecords.wordRecords(old, { limit: 10 }), original);
  await recipient.packages.closeAdmission(admission.id);
});

/** A transcriber that publishes one word per available interval, without models or native inference. */
function transcription(word) {
  const models = {
    status: () => ({ state: "ready" }),
    nativeRequest: async () => ({ directory: "/unused-model-seam", files: [] }),
    modelDigest: "a".repeat(64),
    pins: {
      runtime: "FluidAudio",
      runtimeVersion: "0.15.7",
      runtimeRevision: "fixture-runtime",
      decoder: "parakeet-tdt-batch",
      model: "fixture-model",
      modelRevision: "fixture-revision",
    },
  };
  return {
    transcriptionModels: models,
    transcribe: async (request) => {
      const lines = request.track.available.map((source, ordinal) => ({
        ordinal,
        source,
        owned: source,
        state: "transcribed",
        words: [{ text: word(), source: { startUs: 100, endUs: 900000 }, confidence: 0.8 }],
      }));
      const body = lines.map((line) => JSON.stringify(line) + "\n").join("");
      await writeFile(request.output, body);
      return {
        execution: request.execution,
        available: request.track.available,
        output: {
          file: request.output,
          bytes: Buffer.byteLength(body),
          sha256: createHash("sha256").update(body).digest("hex"),
        },
        engine: {
          runtime: models.pins.runtime,
          runtimeVersion: models.pins.runtimeVersion,
          decoder: models.pins.decoder,
          encoderPrecision: "int8",
          computeUnits: "cpuAndNeuralEngine",
        },
        segments: lines.map(({ words, ...line }) => ({ ...line, wordCount: words.length })),
        wordCount: lines.length,
      };
    },
  };
}

/** Imports a one-second voice asset and places it in the fixture project. */
async function placeVoice(f) {
  const donor = join(f.home, "voice.wav");
  await writeFile(donor, "audio source identity");
  const voice = await f.assets.import(donor, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "audio",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [{ startUs: 0, endUs: 1000000, empty: false }],
      },
    ],
  }));
  f.projects.apply(f.projectId, {
    requestId: "voice",
    expectedRevisionId: f.placed.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          assetId: voice.id,
          streamId: "audio",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  return { assetId: voice.id, streamId: "audio" };
}

test("a project package leaves a stale derived transcript out and the recipient regenerates it", async (t) => {
  const f = await fixture(
    t,
    transcription(() => "older"),
  );
  const selection = await placeVoice(f);
  f.transcripts.prepareSource(selection);
  await f.jobs.idle();
  const ready = f.transcripts.sourceStatus(selection);
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  const old = ready.published.transcript;
  // What an older version left behind: its job key, publication and row all name its recipe.
  const foreign = (execution) => ({ ...execution, recipe: "source-windows-foreign-v0" });
  const job = f.catalog.catalog.prepare("SELECT input FROM jobs WHERE jobId=?").get(ready.jobId);
  const parsed = JSON.parse(job.input);
  const input = JSON.stringify({ ...parsed, execution: foreign(parsed.execution) });
  const digest = createHash("sha256").update(input).digest("hex");
  f.catalog.catalog
    .prepare("UPDATE jobs SET input=?,inputSha256=? WHERE jobId=?")
    .run(input, digest, ready.jobId);
  f.catalog.catalog
    .prepare("UPDATE artifacts SET input=?,inputSha256=? WHERE attemptId=?")
    .run(input, digest, old.generation);
  f.catalog.catalog
    .prepare("UPDATE transcript_generations SET execution=? WHERE generation=?")
    .run(JSON.stringify(foreign(old.execution)), old.generation);
  const pinned = f.packages.pin(f.projectId);
  assert.deepEqual(
    pinned.resources.filter((resource) => resource.kind === "transcript-generation"),
    [],
  );
  assert.deepEqual(pinned.stale, [
    { kind: "transcript-generation", id: transcriptGenerationResource(old) },
  ]);
  const request = { ...f.request(), kind: "processed-package", leaf: "stale.zip" };
  await f.exports.create(request);
  await f.jobs.idle();
  const committed = f.exports.status(request.exportId);
  assert.equal(committed.state, "committed", JSON.stringify(committed));
  assert.deepEqual(
    committed.issues.map((issue) => [issue.code, issue.evidence.id]),
    [["derived-stale-skipped", transcriptGenerationResource(old)]],
  );
  const recipient = await fixture(
    t,
    transcription(() => "fresh"),
  );
  const admission = await recipient.packages.open(committed.output);
  await recipient.jobs.idle();
  const opened = recipient.packages.status(admission.id);
  assert.equal(opened.state, "ready", JSON.stringify(opened));
  assert.deepEqual(opened.issues, [], "the package already left the stale transcript out");
  recipient.packages.adopt(opened.packageHandle, "stale");
  await recipient.jobs.idle();
  assert.equal(recipient.packages.adopt(opened.packageHandle, "stale").state, "ready");
  await recipient.packages.closeAdmission(admission.id);
  assert.equal(recipient.transcripts.sourceStatus(selection).state, "not_requested");
  recipient.transcripts.prepareSource(selection);
  await recipient.jobs.idle();
  const regenerated = recipient.transcripts.sourceStatus(selection);
  assert.equal(regenerated.state, "ready", JSON.stringify(regenerated));
  assert.deepEqual(
    recipient.transcriptRecords
      .wordRecords(regenerated.published.transcript, { limit: 10 })
      .map((entry) => entry.text),
    ["fresh"],
  );
});

function grayPNG(shade) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, shade]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const kind of ["source", "project"])
  test(`canceled package keeps admitted ${kind} index PNGs through regeneration and retry`, async (t) => {
    const entered = gate(),
      release = gate(),
      previewEntered = gate(),
      previewRelease = gate();
    t.after(() => {
      release.resolve();
      previewRelease.resolve();
    });
    let block = true;
    let png = grayPNG(0);
    const f = await fixture(t, {
      sourceSample: async (request) => sceneSamples(request),
      render: async (request, signal, render) => {
        previewEntered.resolve();
        await previewRelease.promise;
        return render(request, signal);
      },
      sourceFrame: async ({ asset, atUs, output }) => {
        await writeFile(output, png, { flag: "wx" });
        return {
          file: output,
          bytes: png.length,
          mediaType: "image/png",
          assetId: asset.assetId,
          streamId: asset.streamId,
          requestedSourceUs: atUs,
          actualSourceUs: atUs,
          sample: {
            value: String(atUs),
            timescale: 1000000,
            endValue: String(atUs + 1),
            endTimescale: 1000000,
            originUs: asset.originUs,
          },
          width: 1,
          height: 1,
          sourceWidth: 160,
          sourceHeight: 96,
          decodedSamples: 1,
          readerOpens: 1,
        };
      },
      projectFrame: async ({ window, output }) => {
        await writeFile(output, png, { flag: "wx" });
        const frame = [...window.frames()][0];
        return {
          file: output,
          bytes: png.length,
          mediaType: "image/png",
          profile: "h264-rec709",
          frame,
          width: 1,
          height: 1,
          sourceWidth: 160,
          sourceHeight: 96,
          decodedImages: 0,
          decodedSamples: 1,
          readerOpens: 1,
          pictures: frame.layers.map((layer) => ({
            kind: "video",
            status: "available",
            clipId: layer.clipId,
            assetId: layer.assetId,
            streamId: layer.streamId,
            requestedSourceUs: layer.sourceUs,
            actualSourceUs: layer.sourceUs,
            sample: { value: String(layer.sourceUs), timescale: 1000000, originUs: 0 },
          })),
        };
      },
      wrap:
        (run) =>
        async (operation, ...args) => {
          if (operation === "archive.write" && block) {
            entered.resolve();
            await release.promise;
          }
          return run(operation, ...args);
        },
    });
    const selection = { assetId: f.asset.id, streamId: "video" };
    f.sceneProcessing.prepareSource(selection);
    await f.jobs.idle();
    const requestIndex = () =>
      kind === "source"
        ? f.indexes.requestSource(selection)
        : f.indexes.requestProject({ projectId: f.projectId });
    const records = kind === "source" ? f.sourceIndex : f.projectIndex;
    requestIndex();
    await f.jobs.idle();
    const first = requestIndex();
    assert.equal(first.state, "ready", JSON.stringify(first));
    const old = first.published.evidence;
    const original = await readFile(records.portableImage(old, 0).path);
    assert.deepEqual(original, png);
    const request = { ...f.request(), kind: "processed-package", leaf: `${kind}-index.zip` };
    await f.preview.request({ projectId: f.projectId, revisionId: f.placed.revision.id });
    await previewEntered.promise;
    png = grayPNG(255);
    for (const { frame } of records.page({ identity: old, limit: 200 }).entries) {
      const input =
        kind === "source"
          ? { ...selection, atUs: frame.atUs, maxLongEdge: old.maxLongEdge }
          : {
              projectId: f.projectId,
              revisionId: old.revisionId,
              atUs: frame.atUs,
              maxLongEdge: old.maxLongEdge,
              tap: old.tap,
            };
      const status = f.frames.request(input);
      assert.equal(status.state, "ready", JSON.stringify(status));
      f.cache.remove(status.published.frame.cacheId);
    }
    f.jobs.regenerate(first.jobId, first.published.generation);
    await f.exports.create(request);
    assert.equal(f.jobs.job(first.jobId).state, "queued");
    assert.equal(f.exports.status(request.exportId).state, "queued");
    previewRelease.resolve();
    await entered.promise;
    const references = new ResourceReferences(f.catalog);
    assert.deepEqual(
      references
        .dependencies({ kind: "export", id: request.exportId })
        .filter((entry) => entry.kind === "index-generation")
        .map(({ kind, id }) => [kind, id]),
      [
        [
          "index-generation",
          indexGenerationResource(
            kind === "source"
              ? { kind: "asset", id: f.asset.id }
              : { kind: "project", id: f.projectId },
            old.generation,
          ),
        ],
      ],
    );
    const activeReplacement = requestIndex();
    assert.equal(activeReplacement.state, "ready", JSON.stringify(activeReplacement));
    assert.notEqual(activeReplacement.published.evidence.generation, old.generation);
    const replacementPNG = await readFile(
      records.portableImage(activeReplacement.published.evidence, 0).path,
    );
    assert.deepEqual(replacementPNG, png);
    assert.notDeepEqual(replacementPNG, original);
    assert.equal(f.jobs.job(f.exports.status(request.exportId).jobId).state, "running");
    await f.indexes.cleanup(new AbortController().signal);
    assert.deepEqual(await readFile(records.portableImage(old, 0).path), original);
    f.exports.cancel(request.exportId);
    block = false;
    release.resolve();
    await f.jobs.idle();
    assert.equal(f.exports.status(request.exportId).state, "canceled");
    f.jobs.regenerate(first.jobId, activeReplacement.published.generation);
    await f.jobs.idle();
    const second = requestIndex();
    assert.equal(second.state, "ready", JSON.stringify(second));
    assert.notEqual(second.published.evidence.generation, old.generation);
    await f.indexes.cleanup(new AbortController().signal);
    assert.deepEqual(await readFile(records.portableImage(old, 0).path), original);
    await f.exports.retry(request.exportId);
    await f.jobs.idle();
    const committed = f.exports.status(request.exportId);
    assert.equal(committed.state, "committed", JSON.stringify(committed));
    assert.deepEqual(references.dependencies({ kind: "export", id: request.exportId }), []);
    await f.indexes.cleanup(new AbortController().signal);
    assert.throws(() => records.portableImage(old, 0));
    const recipient = await fixture(t);
    const admission = await recipient.packages.open(committed.output);
    await recipient.jobs.idle();
    const opened = recipient.packages.status(admission.id);
    assert.equal(opened.state, "ready", JSON.stringify(opened));
    recipient.packages.adopt(opened.packageHandle, "old-source-index");
    await recipient.jobs.idle();
    const adopted = recipient.packages.adopt(opened.packageHandle, "old-source-index");
    assert.equal(adopted.state, "ready", JSON.stringify(adopted));
    const recipientRecords = kind === "source" ? recipient.sourceIndex : recipient.projectIndex;
    const adoptedMetadata =
      kind === "source"
        ? old
        : recipientRecords
            .portableGenerations({ kind: "project", id: adopted.published.output.projectId })
            .find((value) => value.generation === old.generation);
    assert.ok(adoptedMetadata);
    assert.deepEqual(
      await readFile(recipientRecords.portableImage(adoptedMetadata, 0).path),
      original,
    );
    await recipient.packages.closeAdmission(admission.id);
  });
