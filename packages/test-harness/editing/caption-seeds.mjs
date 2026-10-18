import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { copyModels, hash, poll, root } from "./source-evidence-fixture.mjs";

/** Real retained speech evidence, ordinary edits and independent package relocation. */
export async function captionSeeds({ service, call, out, home, font, picture, admit, report }) {
  assert.ok(process.env.YAP_ASR_REQUEST, "Select existing pinned speech models");
  const prepared = JSON.parse(await readFile(process.env.YAP_ASR_REQUEST, "utf8")).params.models;
  const model = await copyModels(home, prepared);
  assert.equal((await call("model.status", { modelId: "parakeet" })).state, "ready");
  report.seedRequests = [];
  const api = async (operation, params, options) => {
    const row = { operation, params };
    report.seedRequests.push(row);
    const reply = await call(operation, params, options);
    row.reply = reply;
    return reply;
  };
  const speech = await admit(join(root, "fixtures/narrated-workbench/narration.mov"));
  const source = {
    assetId: speech.id,
    streamId: speech.streams.find((stream) => stream.kind === "audio").id,
  };
  await api("transcript.transcribe", source);
  const transcript = await poll(
    () => api("transcript.get", { ...source, limit: 1000 }),
    (value) => value.state === "ready",
    "source words",
  );
  const sourceRows = transcript.page.rows;
  const selected = sourceRows.filter((row) => row.type === "word").slice(0, 5);
  assert.equal(selected.length, 5);
  const sourceRange = {
    startUs: selected[0].sourceRange.startUs,
    endUs: Math.max(...selected.map((row) => row.sourceRange.endUs)),
  };
  const duration = sourceRange.endUs - sourceRange.startUs,
    stride = duration + 500000;
  const created = await api("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 640,
      height: 180,
      fps: { numerator: 8, denominator: 1 },
      background: "#142032ff",
    },
  });
  const projectId = created.project.projectId;
  let revisionId = created.revision.id;
  const selection = () => ({ projectId, revisionId });
  async function edit(operations) {
    const result = await api("edit.apply", {
      projectId,
      expectedRevisionId: revisionId,
      requestId: randomUUID(),
      operations,
    });
    revisionId = result.revision.id;
    return result;
  }
  const placed = await edit([
    { operation: "track.add", label: "speech", track: { kind: "audio", order: 0 } },
    { operation: "track.add", label: "captions", track: { kind: "video", order: 0 } },
    ...[0, 1, 2].map((i) => ({
      operation: "place",
      label: "speech" + i,
      clip: {
        trackId: { label: "speech" },
        ...source,
        source: { kind: "range", range: sourceRange },
        placement: {
          kind: "project",
          range: { startUs: i * stride, endUs: i * stride + duration },
        },
      },
    })),
  ]);
  const projected = await poll(
    () => api("transcript.get", { ...selection(), limit: 1000 }),
    (value) => value.state === "ready",
    "occurrence words",
  );
  const style = {
    font: { assetId: font.id, postScriptName: "ArialMT" },
    width: 620,
    height: 100,
    size: 32,
    color: "#ffffffff",
    alignment: "center",
    wrap: true,
  };
  const cues = ["content", "clip", "project"].map((anchor, i) => {
    const rows = projected.page.rows.filter(
      (row) => row.type === "word" && row.clipId === placed.edit.labels["speech" + i],
    );
    assert.equal(rows.length, selected.length);
    assert.ok(rows.every((row) => row.generation === transcript.page.transcript.generation));
    return {
      trackId: placed.edit.labels.captions,
      label: "caption" + i,
      source,
      generation: rows[0].generation,
      occurrenceClipId: rows[0].clipId,
      words: rows.map((row) => ({ ordinal: row.ordinal, sourceRange: row.sourceRange })),
      separator: " ",
      anchor,
      style,
    };
  });
  const seedRequest = { projectId, expectedRevisionId: revisionId, requestId: randomUUID(), cues };
  const seeded = await api("text.seed", seedRequest, { transport: "mcp" });
  revisionId = seeded.revision.id;
  assert.deepEqual(await api("text.seed", seedRequest), seeded);
  const literal = selected.map((row) => row.text).join(" ");
  assert.deepEqual(
    seeded.revision.document.clips
      .filter((clip) => clip.source.kind === "text")
      .map((clip) => clip.source.text),
    [literal, literal, literal],
  );
  await edit(
    [0, 1, 2].map((i) => ({
      operation: "processing.set",
      target: { kind: "clip", id: seeded.edit.labels["caption" + i] },
      steps: [
        {
          processor: {
            type: "geometry",
            crop: { x: 0, y: 0, width: 620, height: 100 },
            rect: { x: 10, y: 40, width: 620, height: 100 },
            fit: "contain",
            scale: { x: 1, y: 1 },
            rotationDeg: 0,
            pivot: { x: 0.5, y: 0.5 },
          },
        },
      ],
    })),
  );
  const images = [];
  for (let i = 0; i < 3; i++) {
    const result = await picture(
      { ...selection(), atUs: i * stride + Math.floor(duration / 2) },
      "seeded-" + i,
    );
    assert.equal(result.receipt.pictures[0].layout.text, literal);
    images.push(result.bytes);
  }
  assert.deepEqual(images[0], images[1]);
  assert.deepEqual(images[1], images[2]);
  const movie = join(out, "seeded-speech.mp4");
  await poll(
    () => api("preview.get", selection(), { output: movie }),
    (value) => value.state === "ready",
    "seeded movie",
  );
  const exportId = randomUUID();
  await api("export.create", {
    ...selection(),
    exportId,
    kind: "video",
    directory: out,
    leaf: "seeded-speech-export.mp4",
  });
  const exported = await poll(
    () => api("export.status", { exportId }),
    (value) => value.state === "ready",
    "seeded export",
  );
  assert.deepEqual(await readFile(movie), await readFile(exported.output));
  report.checks.push({
    name: "real-repeated-transcript-seeding",
    model,
    source,
    generation: transcript.page.transcript.generation,
    literal,
    exactRepeatedPngs: true,
    exactPreviewExport: true,
  });

  const firstAt = Math.floor((duration * 3) / 4);
  const beforeSplit = await picture({ ...selection(), atUs: firstAt }, "before-split");
  await edit([
    { operation: "split", clipIds: [placed.edit.labels.speech0], atUs: Math.floor(duration / 2) },
  ]);
  assert.deepEqual(
    (await picture({ ...selection(), atUs: firstAt }, "after-split")).bytes,
    beforeSplit.bytes,
  );
  await edit([
    {
      operation: "retime",
      clipIds: [placed.edit.labels.speech1],
      durationUs: Math.floor(duration / 2),
      ripple: "none",
    },
    {
      operation: "retime",
      clipIds: [placed.edit.labels.speech2],
      durationUs: Math.floor(duration / 2),
      ripple: "none",
    },
  ]);
  assert.deepEqual(
    (
      await picture(
        { ...selection(), atUs: stride + Math.floor(duration / 4) },
        "retimed-clip-anchor",
      )
    ).bytes,
    images[1],
  );
  assert.deepEqual(
    (
      await picture(
        { ...selection(), atUs: 2 * stride + Math.floor((duration * 3) / 4) },
        "project-anchor-after-parent-retime",
      )
    ).bytes,
    images[2],
  );
  await edit([
    {
      operation: "trim",
      clipId: placed.edit.labels.speech1,
      range: {
        startUs: stride + Math.floor(duration / 8),
        endUs: stride + Math.floor(duration / 2),
      },
      ripple: "none",
    },
  ]);
  assert.deepEqual(
    (
      await picture(
        { ...selection(), atUs: stride + Math.floor(duration / 4) },
        "trimmed-retimed-caption",
      )
    ).bytes,
    images[1],
  );
  const repeatAt = 3 * stride;
  await edit([{ operation: "duplicate", clipIds: [placed.edit.labels.speech1], atUs: repeatAt }]);
  assert.deepEqual(
    (
      await picture(
        { ...selection(), atUs: repeatAt + Math.floor(duration / 4) },
        "repeated-retimed-caption",
      )
    ).bytes,
    images[1],
  );
  const removed = await edit([
    { operation: "remove", clipIds: [placed.edit.labels.speech0], ripple: "none" },
  ]);
  assert.ok(
    !removed.revision.document.clips.some((clip) => clip.id === placed.edit.labels.speech0),
  );
  const inherited = removed.revision.document.clips.find(
    (clip) => clip.seed?.occurrenceClipId === placed.edit.labels.speech0,
  );
  assert.ok(inherited);
  const provenance = inherited.seed;
  const corrected = await edit([
    {
      operation: "text.set",
      clipId: inherited.id,
      source: { ...inherited.source, text: "Explicit display correction" },
    },
  ]);
  assert.deepEqual(
    corrected.revision.document.clips.find((clip) => clip.id === inherited.id).seed,
    provenance,
  );
  const correctedImage = await picture({ ...selection(), atUs: firstAt }, "display-correction");
  assert.notDeepEqual(correctedImage.bytes, beforeSplit.bytes);
  assert.deepEqual((await api("transcript.get", { ...source, limit: 1000 })).page.rows, sourceRows);
  assert.deepEqual(await api("text.seed", seedRequest), seeded);
  const head = await api("project.get", { projectId });
  assert.equal(head.currentRevisionId, revisionId);
  for (const [name, patch] of [
    ["stale-selection-with-missing-generation", { generation: "absent" }],
    ["false-word", { words: [{ ordinal: 999999, sourceRange }] }],
    ["removed-origin", { occurrenceClipId: placed.edit.labels.speech0 }],
  ]) {
    const error = await api(
      "text.seed",
      {
        projectId,
        expectedRevisionId: revisionId,
        requestId: randomUUID(),
        cues: [{ ...cues[1], ...patch }],
      },
      { error: true },
    );
    assert.ok(["NOT_FOUND", "INVALID_EDIT"].includes(error.code));
    assert.equal((await api("project.get", { projectId })).currentRevisionId, revisionId);
    report.checks.push({ name, error });
  }
  report.checks.push({
    name: "seed-origin-through-structural-edits",
    exactSplitPixels: true,
    retimedAndRepeated: true,
    trimmed: true,
    projectAnchorFixed: true,
    removedOriginStillRetained: true,
    sourceWordsUnchanged: true,
  });

  const detached = await edit([
    {
      operation: "detach",
      clipIds: corrected.revision.document.clips
        .filter((clip) => clip.source.kind === "text")
        .map((clip) => clip.id),
    },
    {
      operation: "remove",
      clipIds: corrected.revision.document.clips
        .filter((clip) => clip.source.kind === "range")
        .map((clip) => clip.id),
      ripple: "none",
    },
  ]);
  assert.ok(detached.revision.document.clips.every((clip) => clip.source.kind === "text"));
  assert.deepEqual(
    (await picture({ ...selection(), atUs: firstAt }, "caption-only-current")).bytes,
    correctedImage.bytes,
  );
  const packageExport = randomUUID();
  await api("export.create", {
    ...selection(),
    requestId: packageExport,
    kind: "processed-package",
    directory: home,
    leaf: "captions.zip",
  });
  const packaged = await poll(
    () => api("export.status", { exportId: packageExport }),
    (value) => value.state === "ready",
    "caption package",
  );
  await service.stop();
  service.home = join(home, "recipient");
  await service.start();
  const opened = await api("package.open", { path: packaged.output });
  const ready = await poll(
    () => api("package.status", { admissionId: opened.id }),
    (value) => value.state === "ready",
    "open captions",
  );
  const adoptionId = randomUUID();
  const adopted = await poll(
    () => api("package.adopt", { packageHandle: ready.packageHandle, requestId: adoptionId }),
    (value) => value.state === "ready",
    "adopt captions",
  );
  const recipient = {
    projectId: adopted.published.output.projectId,
    revisionId: adopted.published.output.revisionId,
  };
  assert.deepEqual(
    (await picture({ ...recipient, atUs: firstAt }, "adopted-correction")).bytes,
    correctedImage.bytes,
  );
  const recipientRevision = await api("revision.get", recipient);
  assert.deepEqual(
    recipientRevision.revision.document.clips.find((clip) => clip.id === inherited.id).seed,
    provenance,
  );
  const restoredWords = await api("transcript.get", { ...source, limit: 1000 });
  assert.equal(restoredWords.state, "ready");
  assert.equal(restoredWords.page.transcript.generation, transcript.page.transcript.generation);
  assert.deepEqual(restoredWords.page.rows, sourceRows);
  const undoDetach = await api("edit.undo", {
    projectId: recipient.projectId,
    expectedRevisionId: recipient.revisionId,
    requestId: randomUUID(),
  });
  const undo = await api("edit.undo", {
    projectId: recipient.projectId,
    expectedRevisionId: undoDetach.id,
    requestId: randomUUID(),
  });
  assert.deepEqual(
    (
      await picture(
        { projectId: recipient.projectId, revisionId: undo.id, atUs: firstAt },
        "adopted-undo-correction",
      )
    ).bytes,
    beforeSplit.bytes,
  );
  report.checks.push({
    name: "seeded-package-history-without-models",
    exactCurrentAndUndoPixels: true,
    originalGeneration: restoredWords.page.transcript.generation,
    wordsHash: hash(JSON.stringify(restoredWords.page.rows)),
    provenance,
  });
}
