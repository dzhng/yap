import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compositionAsset } from "../../core/dist/assets.js";
import {
  createCompiler,
  createSourceRangeProjection,
  validateComposition,
} from "../../composition/dist/index.js";
import { hash, poll, run } from "./source-evidence-fixture.mjs";

/** Public authored/rendered occurrences, with engine projection labeled separately from public queries. */
export async function projectMasks(service, contexts, physicalTranscript, out) {
  const call = service.call.bind(service);
  const binding = contexts[0].binding;
  const asset = await call("asset.get", { assetId: binding.assetId });
  const created = await call("project.create", {
    requestId: "different-context-occurrences",
    title: "Source context journey",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 1, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const selected = [contexts[0].context.id, contexts[1].context.id, undefined];
  const edited = await call("edit.apply", {
    projectId,
    expectedRevisionId: created.revision.revisionId,
    requestId: "place-contexts",
    operations: [
      { operation: "track.add", label: "speech", track: { kind: "audio", order: 0 } },
      ...selected.map((acquisitionId, i) => ({
        operation: "place",
        label: `voice-${i}`,
        clip: {
          trackId: { label: "speech" },
          assetId: binding.assetId,
          streamId: binding.streamId,
          ...(acquisitionId ? { acquisitionId } : {}),
          source: { kind: "range", range: { startUs: 0, endUs: 12500000 } },
          placement: {
            kind: "project",
            range: { startUs: i * 13000000, endUs: i * 13000000 + 12500000 },
          },
        },
      })),
    ],
  });
  const model = validateComposition(
    edited.revision.document,
    [compositionAsset(asset)],
    contexts.map(({ context }) => ({
      id: context.id,
      bindings: context.bindings.map(({ assetId, streamId, available }) => ({
        assetId,
        streamId,
        available,
      })),
    })),
  );
  const word = physicalTranscript.page.rows.find(
    (r) => r.type === "word" && r.sourceRange.startUs < 2000000 && r.sourceRange.endUs > 2000000,
  );
  assert.ok(word, "Retained speech must have a word straddling the authored acquisition hole");
  const projector = createSourceRangeProjection(model);
  const projections = selected.map((_, i) =>
    projector.clip(edited.edit.labels[`voice-${i}`], word.sourceRange),
  );
  assert.deepEqual(
    projections.map((p) => p.completeness),
    ["partial", "whole", "whole"],
  );
  const compiled = [
    ...createCompiler(model, edited.revision.revisionId).audio({ startUs: 0, endUs: 38500000 }),
  ];
  assert.equal(compiled.length, 3, "Every occurrence must have an audio schedule");
  for (const [index, record] of compiled.entries()) {
    const expected =
      index === 0
        ? [
            [0, 2000000],
            [3000000, 6000000],
            [6500000, 12000000],
          ]
        : [
            [0, 6000000],
            [6500000, 12500000],
          ];
    assert.equal(record.clipId, edited.edit.labels[`voice-${index}`]);
    assert.deepEqual(
      record.available,
      expected.map(([start, end]) => ({
        start: ((start + index * 13000000) * 48000) / 1000000,
        end: ((end + index * 13000000) * 48000) / 1000000,
      })),
    );
    assert.deepEqual(
      record.context.map((c) => c.source),
      expected.map(([startUs, endUs]) => ({ startUs, endUs })),
    );
  }
  const file = join(out, "different-contexts.mp4");
  const preview = await poll(
    () =>
      call("preview.get", { projectId, revisionId: edited.revision.revisionId }, { output: file }),
    (v) => v.state === "ready",
    "three-context actual movie",
  );
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 16 * 1024 ** 2, timeout: 30000 },
  );
  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length / 4);
  const rms = (start, end) => {
    const range = samples.subarray(Math.ceil(start * 48000), Math.floor(end * 48000));
    assert.ok(range.length > 0);
    return Math.sqrt(range.reduce((sum, v) => sum + v * v, 0) / range.length);
  };
  const retained = selected.map((_, i) => rms(i * 13 + 1.1, i * 13 + 1.7));
  assert.ok(
    retained.every((v) => v > 0.001),
    `Retained speech was silenced: ${retained}`,
  );
  const hole = selected.map((_, i) => rms(i * 13 + 2.1, i * 13 + 2.9));
  assert.ok(hole[0] < 0.0001, `Excluded context samples leaked into movie: ${hole}`);
  assert.ok(
    hole[1] > 0.001 && hole[2] > 0.001,
    `Full context and physical speech missing: ${hole}`,
  );
  assert.ok(
    Math.abs(hole[1] - hole[2]) / Math.max(hole[1], hole[2]) < 0.03,
    "Equivalent full context and physical audio levels diverged",
  );
  const physicalHole = selected.map((_, i) => rms(i * 13 + 6.1, i * 13 + 6.4));
  assert.ok(
    physicalHole.every((v) => v < 0.0001),
    `Physical empty edit acquired samples: ${physicalHole}`,
  );
  return {
    projectId,
    revisionId: edited.revision.revisionId,
    document: edited.revision.document,
    word,
    projections,
    compiled,
    preview,
    movieSha256: hash(await readFile(file)),
    retainedRms: retained,
    holeRms: hole,
    physicalHoleRms: physicalHole,
    evidenceBoundary:
      "Live CLI/MCP project authoring and native delivered movie PCM; projection/compiler inspected through existing pure engine, not a public occurrence-query endpoint",
  };
}
