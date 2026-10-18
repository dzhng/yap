import { matchedMovieAudio } from "./matched-movie-audio.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { hash, poll, root, run } from "./source-evidence-fixture.mjs";
import { waveHeader } from "./audio-project-fixture.mjs";

/** The accepted public follow snapshot supplies a frozen input to the learned oracle. */
export async function denoiseFollow({
  call,
  prepare,
  inspect,
  projectAudio,
  movieDelivery,
  denoise,
  report,
  out,
}) {
  const packet = join(root, "specs/done/agent-editing/assets/15a3e-follow-learned-public");
  const earlier = join(root, "specs/done/agent-editing/assets/14e-public-retiming");
  const inputs = JSON.parse(await readFile(join(packet, "inputs.json"), "utf8"));
  const verification = JSON.parse(await readFile(join(earlier, "root-verification.json"), "utf8"));
  const reportBytes = gunzipSync(await readFile(join(earlier, "root-report.json.gz")));
  assert.equal(hash(reportBytes), verification.rootReportSha256);
  assert.equal(hash(reportBytes), inputs.reportSha256);
  const frozenReport = JSON.parse(reportBytes);
  const receipt = frozenReport.receipts["independent-follow-audio"];
  assert.equal(receipt.revisionId, inputs.revisionId);
  const frozenRevision = frozenReport.exchanges
    .map((exchange) => (exchange.response.structuredContent ?? exchange.response).data?.revision)
    .find((revision) => revision?.revisionId === inputs.revisionId);
  assert(frozenRevision);
  // The package head has output gain; the authenticated follow revision does not.
  assert(
    frozenRevision.document.processing.every((entry) =>
      entry.steps.every((step) => step.processor.type === "geometry"),
    ),
  );
  const packagePath = join(packet, "retained-package.zip");
  assert.equal(hash(await readFile(packagePath)), inputs.packageSha256);
  const frozenWave = gunzipSync(await readFile(join(packet, "follow-dry.wav.gz")));
  assert.equal(hash(frozenWave), inputs.dryFileSha256);
  const header = waveHeader(frozenWave, frozenWave.length);
  const frozen = frozenWave.subarray(header.offset, header.offset + header.bytes);
  assert.equal(hash(frozen), receipt.pcmSha256);
  assert.equal(header.frames, 216000);
  const record = (report.follow = {
    inputs,
    harnessSha256: hash(await readFile(import.meta.filename)),
    frozenPCM: receipt.pcmSha256,
    frozenRevision,
  });
  // The archive supplies authenticated original bytes, never old admission metadata.
  const document = frozenRevision.document;
  assert.deepEqual(document.groups, []);
  assert(document.clips.every((clip) => clip.placement.kind === "project" && !clip.acquisitionId));
  const imports = [];
  for (const assetId of new Set(document.clips.map((clip) => clip.assetId))) {
    const original = frozenReport.inputs.find((input) => input.sha256 === assetId);
    assert(original, "Frozen clip must reference authenticated original media");
    const member = `assets/${assetId}${extname(original.path)}`;
    const { stdout: bytes } = await run("unzip", ["-p", packagePath, member], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 ** 2,
      timeout: 30000,
    });
    assert.equal(hash(bytes), original.sha256);
    const path = join(out, `follow-original-${assetId}${extname(original.path)}`);
    await writeFile(path, bytes);
    const pending = await call("asset.import", { path, requestId: `follow-import-${assetId}` });
    const imported = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (value) => value.state === "ready",
      "follow original admission",
    );
    assert.equal(imported.published.output.assetId, assetId);
    imports.push({ assetId, member, bytes: bytes.length, sha256: hash(bytes) });
  }
  const made = await call("project.create", {
    requestId: "follow-reauthor",
    canvas: document.canvas,
  });
  const projectId = made.project.projectId;
  const operations = [
    ...document.tracks.map(({ id, ...track }) => ({ operation: "track.add", label: id, track })),
    ...document.clips.map(({ id, trackId, ...clip }) => ({
      operation: "place",
      label: id,
      clip: { ...clip, trackId: { label: trackId } },
    })),
    ...document.syncGroups.map(({ id, clipIds }) => ({
      operation: "link",
      label: id,
      clipIds: clipIds.map((label) => ({ label })),
    })),
    ...document.processing.map(({ target, steps }) => ({
      operation: "processing.set",
      target: { ...target, ...(target.id ? { id: { label: target.id } } : {}) },
      steps: steps.map(({ id, ...step }) => ({ ...step, label: id })),
    })),
  ];
  const authored = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: made.revision.revisionId,
      requestId: "follow-reauthor-document",
      operations,
    },
    { transport: "mcp" },
  );
  const revision = authored.revision;
  const identities = new Map(
    Object.entries(authored.edit.labels).map(([oldId, newId]) => [newId, oldId]),
  );
  assert.equal(identities.size, Object.keys(authored.edit.labels).length);
  const normalized = JSON.parse(
    JSON.stringify(revision.document, (_key, value) => identities.get(value) ?? value),
  );
  assert.deepEqual(
    normalized,
    document,
    "Public reauthoring changed more than generated identities",
  );
  record.reauthoring = { imports, identities: authored.edit.labels, revision, exactDocument: true };
  const drySelection = { projectId, revisionId: revision.revisionId };
  const target = { kind: "output" };
  const tap = { target, point: { kind: "processed" } };
  const range = { startUs: 0, endUs: 4500000 };
  await projectAudio(drySelection, tap, "follow-dry", frozen, 2, range);
  assert.equal(report.checks["follow-dry"].ready.published.output.preparedResourceId, null);
  const expected = denoise("follow-expected", frozen, 2);
  await writeFile(join(out, "follow-expected.f32"), expected);
  const reset = denoise("follow-reset-control", frozen.subarray(180000 * 8), 2);
  assert(!reset.subarray(0, 24000 * 8).equals(expected.subarray(180000 * 8, 204000 * 8)));
  record.resetAtLateDiffers = true;
  const changed = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: revision.revisionId,
      requestId: "follow-learned",
      operations: [
        {
          operation: "processing.set",
          target,
          steps: [{ processor: { type: "rnnoise", mix: 1 } }],
        },
      ],
    },
    { transport: "mcp" },
  );
  const selection = { projectId, revisionId: changed.revision.revisionId };
  const stack = await call("processing.get", { ...selection, target });
  record.stack = stack;
  const lateRange = { startUs: 3750000, endUs: 4250000 };
  await projectAudio(selection, tap, "follow-late-before-full", expected, 2, lateRange);
  assert.equal(
    report.checks["follow-late-before-full"].ready.published.output.preparedResourceId,
    null,
  );
  await call("audio.get", report.checks["follow-late-before-full"].params, { transport: "mcp" });
  const attachment = report.exchanges.at(-1).response.content.find((item) => item.type === "audio");
  assert(attachment);
  assert.equal(
    hash(Buffer.from(attachment.data, "base64")),
    report.checks["follow-late-before-full"].sha256,
  );
  await projectAudio(selection, tap, "follow-full", expected, 2, range);
  const prepared = await prepare(selection);
  await inspect(prepared, 3250000, 4250000, "follow-prepared-excerpt", 1, expected, 2);
  const followClip = revision.document.clips.find((clip) => clip.pitch === "follow");
  assert(followClip);
  let witness;
  for (const file of (await readdir(join(out, "native"))).filter((name) =>
    name.startsWith("mix-"),
  )) {
    const mix = JSON.parse(await readFile(join(out, "native", file), "utf8"));
    if (mix.request.range.start === 180000 && mix.request.range.end === 204000) {
      assert(!mix.request.clips.some((clip) => clip.clipId === followClip.id));
      assert(mix.request.state.clips.some((clip) => clip.clipId === followClip.id));
      assert.equal(mix.response.data.sourceWork.preparedRetimeRuns, 1);
      witness = { file, followOnlyInState: true, preparedRetimeRuns: 1 };
    }
  }
  assert(witness);
  record.movie = await movieDelivery(selection, "follow-");
  Object.assign(
    record.movie,
    await matchedMovieAudio({
      call,
      out,
      canvas: document.canvas,
      name: "follow-",
      expected,
      wrong: frozen,
      range: { startUs: 1000000, endUs: 3000000 },
    }),
  );
  record.movie.dryAACDiffers = record.movie.control.differs;
  const dryMovie = await movieDelivery(drySelection, "follow-dry-");
  record.movie.video = {};
  for (const kind of ["full", "range"]) {
    const frames = [];
    for (const prefix of ["follow-", "follow-dry-"]) {
      const { stdout } = await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          join(out, prefix + kind + "-preview.mp4"),
          "-map",
          "0:v:0",
          "-f",
          "framemd5",
          "-",
        ],
        { maxBuffer: 4000000 },
      );
      frames.push(stdout);
    }
    assert.equal(frames[0], frames[1], "Learned processing changed decoded video frames");
    await writeFile(join(out, "follow-" + kind + "-video.framemd5"), frames[0]);
    const frameCount = frames[0].split("\n").filter((line) => line && !line.startsWith("#")).length;
    assert.equal(frameCount, record.movie[kind].frameCount);
    assert(frameCount > 0);
    record.movie.video[kind] = {
      allFramesMatchDry: true,
      frameMD5Sha256: hash(frames[0]),
      frameCount,
    };
  }
  record.movie.dry = dryMovie;
  record.selection = selection;
  record.prepared = prepared;
  record.lateState = witness;
  record.lateMCPMatchesCLI = true;
}
