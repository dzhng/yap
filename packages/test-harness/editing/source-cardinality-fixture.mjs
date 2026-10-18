import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";
import { hash, poll, root } from "./source-evidence-fixture.mjs";

export const occurrences = 1024;
export const rowLimit = 250;
export const leadingEmpty = 64;
export const sourceRange = { startUs: 350000, endUs: 450000 };
export const range = { startUs: 0, endUs: (occurrences - 1) * 200000 + 100000 };
const assetId = "491d34c0c2bff15f01d8be032bafa4ca1a96f6244ddc4ba2738bf7673678b49e";
const available = [
  { startUs: 0, endUs: 1000000 },
  { startUs: 1500000, endUs: 2500000 },
];
const observation = {
  sourceUs: 650000,
  globalX: 101,
  globalY: 202,
  x: 17,
  y: 23,
  buttons: 1,
  eligibility: "inside",
  geometryEpoch: 1,
};
export const sourceRow = {
  kind: "cursor",
  sourceAtUs: 400000,
  captureAtUs: 650000,
  sourceSequence: 2,
  observation,
};
const jsonHash = (value) => hash(JSON.stringify(value));

/** One authored journal, real native normalization and public admission for every identity. */
export async function prepareCardinality(home, out, call) {
  const directory = join(home, "donor");
  await mkdir(directory);
  const movie = join(root, "specs/done/agent-editing/assets/10d-public-scenes/authored-source.mov");
  assert.equal(hash(await readFile(movie)), assetId);
  await copyFile(movie, join(directory, "video.mov"));
  const records = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: "synthetic-source-cardinality",
        source: { kind: "window", windowID: 7 },
        width: 64,
        height: 48,
        microphone: false,
        systemAudio: false,
      },
    },
    { event: "origin", data: { hostUs: 1000000 } },
    {
      event: "geometry",
      data: {
        epoch: 1,
        hostUs: 1250000,
        sourceUs: 250000,
        geometry: {
          outputWidth: 64,
          outputHeight: 48,
          contentScale: 1,
          scaleFactor: 1,
          contentRect: { x: 0, y: 0, width: 64, height: 48 },
        },
      },
    },
    { event: "cursorSamples", data: { samples: [observation] } },
    { event: "finished", data: { state: "complete", durationUs: 2750000 } },
    { event: "lifecycle", data: { state: "complete" } },
  ];
  const journal = records
    .map((record, i) => JSON.stringify({ ...record, sequence: i + 1 }) + "\n")
    .join("");
  await writeFile(join(directory, "capture.journal.jsonl"), journal);
  await writeFile(join(out, "authored-journal.jsonl"), journal);
  const output = join(out, "normalized.jsonl");
  const normalization = nativeResult(
    await mediaWorker()("media.sourceEvidence", { directory, output }),
  );
  const normalizedBytes = await readFile(output);
  const normalized = normalizedBytes.toString().trim().split("\n").map(JSON.parse);
  assert.equal(normalization.cursorSamples, 1);
  assert.deepEqual(
    normalized.flatMap((record, i) =>
      record.event === "cursorSample" ? [{ sourceSequence: i + 1, observation: record.data }] : [],
    ),
    [{ sourceSequence: 2, observation }],
  );
  const acquisitions = [];
  for (let i = 0; i < occurrences; i++) {
    const imported = await call("acquisition.import", {
      path: directory,
      requestId: `source-${i}`,
    });
    const job = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (value) => value.state === "ready",
      "source acquisition",
    );
    const acquisition = await call("acquisition.get", { acquisitionId: job.target.acquisitionId });
    assert.equal(acquisition.journal.sha256, hash(journal));
    assert.equal(hash(await readFile(acquisition.evidence.receipt.file)), hash(normalizedBytes));
    assert.deepEqual(
      acquisition.bindings.map(
        ({ assetId, streamId, sourceRoles, sourceToAssetOffsetUs, available }) => ({
          assetId,
          streamId,
          sourceRoles,
          sourceToAssetOffsetUs,
          available,
        }),
      ),
      [
        {
          assetId,
          streamId: "track:1",
          sourceRoles: ["video"],
          sourceToAssetOffsetUs: -250000,
          available,
        },
      ],
    );
    acquisitions.push(acquisition);
    if ((i + 1) % 128 === 0) console.log(`Admitted ${i + 1}/${occurrences} acquisition identities`);
  }
  assert.equal(new Set(acquisitions.map(({ id }) => id)).size, occurrences);
  const asset = await call("asset.get", { assetId });
  assert.equal(asset.originUs, 250000);
  const catalog = await call("asset.list", { limit: 10 });
  assert.equal(catalog.assets.length, 1);
  assert.equal(catalog.assets[0].id, assetId);
  const fixture = {
    asset,
    acquisitions,
    normalization,
    normalizedSha256: hash(normalizedBytes),
    journalSha256: hash(journal),
    arms: [],
  };
  for (const cardinality of [512, 1024]) {
    const made = await call("project.create", {
      requestId: `project-${cardinality}`,
      canvas: {
        width: 64,
        height: 48,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const arm = {
      cardinality,
      projectId: made.project.projectId,
      revisionId: made.revision.revisionId,
      clipIds: [],
    };
    const apply = async (operations, requestId) => {
      const result = await call("edit.apply", {
        projectId: arm.projectId,
        expectedRevisionId: arm.revisionId,
        requestId,
        operations,
      });
      arm.revisionId = result.revision.revisionId;
      return result;
    };
    arm.trackId = (
      await apply(
        [{ operation: "track.add", label: "video", track: { kind: "video", order: 0 } }],
        "track",
      )
    ).edit.labels.video;
    let final;
    for (let first = 0; first < occurrences; first += 256) {
      final = await apply(
        Array.from({ length: 256 }, (_, offset) => {
          const i = first + offset;
          return {
            operation: "place",
            label: `clip-${i}`,
            clip: {
              trackId: arm.trackId,
              ...selection(fixture, i % cardinality),
              source: {
                kind: "range",
                range: i < leadingEmpty ? { startUs: 0, endUs: 100000 } : sourceRange,
              },
              placement: { kind: "project", range: placement(i) },
            },
          };
        }),
        `place-${first}`,
      );
      for (let i = first; i < first + 256; i++) arm.clipIds.push(final.edit.labels[`clip-${i}`]);
    }
    assert.equal(final.revision.ordinal, 5);
    assert.equal(final.revision.document.clips.length, occurrences);
    assert.deepEqual(final.revision.document.processing, []);
    assert.deepEqual(final.revision.document.groups, []);
    assert.equal(final.revision.document.tracks.length, 1);
    arm.revision = final.revision;
    fixture.arms.push(arm);
  }
  // Ignore only generated identities and the deliberately varied acquisition references.
  const shape = (arm) =>
    JSON.stringify(arm.revision.document, (key, value) =>
      key === "id" || key === "trackId" || key === "acquisitionId" ? "identity" : value,
    );
  assert.equal(shape(fixture.arms[0]), shape(fixture.arms[1]));
  return fixture;
}
const placement = (i) => ({ startUs: i * 200000, endUs: i * 200000 + 100000 });
const selection = (fixture, i) => ({
  assetId,
  streamId: "track:1",
  acquisitionId: fixture.acquisitions[i].id,
});
export function cardinalityOracle(fixture, arm) {
  assert.equal(arm.revision.ordinal, 5);
  assert.deepEqual(arm.revision.document.tracks, [{ id: arm.trackId, kind: "video", order: 0 }]);
  assert.deepEqual(arm.revision.document.groups, []);
  assert.deepEqual(arm.revision.document.processing, []);
  assert.deepEqual(
    arm.revision.document.clips.map(
      ({ id, trackId, assetId, streamId, acquisitionId, source, placement }) => ({
        id,
        trackId,
        assetId,
        streamId,
        acquisitionId,
        source,
        placement,
      }),
    ),
    arm.clipIds.map((id, i) => ({
      id,
      trackId: arm.trackId,
      ...selection(fixture, i % arm.cardinality),
      source: {
        kind: "range",
        range: i < leadingEmpty ? { startUs: 0, endUs: 100000 } : sourceRange,
      },
      placement: { kind: "project", range: placement(i) },
    })),
  );
  const dependencies = fixture.acquisitions
    .slice(0, arm.cardinality)
    .map((acquisition, i) => {
      const selected = selection(fixture, i);
      return {
        selection: selected,
        transcript: null,
        capture: {
          selection: selected,
          domain: "cursor",
          durationUs: 2500000,
          sourceToAssetOffsetUs: -250000,
          supportDigest: jsonHash(available),
          evidence: acquisition.evidence,
          coverage: [{ kind: "cursor", state: "ready", reason: null }],
        },
        state: "ready",
        reason: null,
        retryable: false,
        jobId: null,
      };
    })
    .sort((a, b) => (a.selection.acquisitionId < b.selection.acquisitionId ? -1 : 1));
  const rows = arm.clipIds.slice(leadingEmpty, leadingEmpty + rowLimit).map((clipId, offset) => {
    const i = leadingEmpty + offset;
    return {
      ...sourceRow,
      ...selection(fixture, i % arm.cardinality),
      clipId,
      trackId: arm.trackId,
      trackRank: 0,
      generation: fixture.acquisitions[i % arm.cardinality].evidence.generation,
      projectAtUs: i * 200000 + 50000,
    };
  });
  const coverage = arm.clipIds.map((clipId, i) => ({
    clipId,
    trackId: arm.trackId,
    projectRange: placement(i),
    available: [placement(i)],
    unavailable: [],
  }));
  return { dependencies, rows, coverage };
}
