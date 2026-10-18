import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const expected = {
  nativeEvidenceSha256: "2b721288aba5eac0582c8878343fb496168f319617b03c7a57a69b344c960860",
  gatesSha256: "48038db6feef214f74d1b20961abddf7789a9fe4a6b70f22464c0dfbe5a16d77",
  failureAuditSha256: "e7df9a25628a27694bc9a4e53dd1f47f322c21da5a82c01507e54fd63b13ba00",
  workerSha256: "1d2980d63cce3e420528551a0b639af5f2aef84478457dbdbbc5edcf4b230161",
  hosts: ["graham", "madison", "lily"],
  framesPerHost: 72,
  failedHost: "graham",
  failedOrdinals: [44, 45, ...Array.from({ length: 25 }, (_, index) => index + 47)],
  sourceHashes: {
    graham: "5ce578840a41a665fe10da3c11046ef097b799f3e10a130669ef4081727b9118",
    madison: "4abc85f54c9464a1bca85504e1410cc961eb69e23b37c376504342e2d9f29483",
    lily: "331d500a758eaed329f0b073de6f8c2258b1bdd12188ede4323b5fc6d8f9fd7a",
  },
};

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const closeEnough = (actual, expectedValue) => Math.abs(actual - expectedValue) <= 1e-12;
const expectedAtUs = (ordinal) => Math.ceil((ordinal * 1_000_000) / 24);

function intersectionOverUnion(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

function assertObservation(frame, zone, minimumIoU) {
  const observations = frame.observations;
  assert.equal(observations.recipe, "vision-face-rectangles-v1", "face recipe changed");
  assert.match(observations.implementationId, /^vision-face-rectangles-v1:revision-[1-9][0-9]*:/);
  assert.equal(observations.coordinateSpace, "delivered-top-left-pixels");
  assert.equal(observations.width, 640);
  assert.equal(observations.height, 360);
  assert.equal(observations.status, "available");
  assert.equal(observations.faces.length, 1);
  const face = observations.faces[0];
  assert.equal(face.faceId, "face-0");
  assert.ok(Number.isFinite(face.confidence) && face.confidence >= 0 && face.confidence <= 1);
  const box = face.boundingBox;
  assert.ok(box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0);
  assert.ok(box.x + box.width <= observations.width && box.y + box.height <= observations.height);
  const overlap = intersectionOverUnion(box, zone);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const inside =
    center.x >= zone.x &&
    center.x <= zone.x + zone.width &&
    center.y >= zone.y &&
    center.y <= zone.y + zone.height;
  assert.equal(inside, true, "detected center escaped the authored zone");
  const expectedPassed = overlap >= minimumIoU;
  assert.equal(
    frame.localization?.passed,
    expectedPassed,
    "localization status disagrees with box IoU",
  );
  const failures = frame.localization?.failures ?? [];
  if (expectedPassed) assert.deepEqual(failures, [], "passing localization retained a failure");
  else {
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^Independent zone IoU [0-9.]+ below [0-9.]+$/);
    const [, reported, threshold] = failures[0].match(
      /^Independent zone IoU ([0-9.]+) below ([0-9.]+)$/,
    );
    assert.ok(closeEnough(Number(reported), overlap), "localized failure metric changed");
    assert.equal(Number(threshold), minimumIoU);
  }
  return { overlap, centerInside: inside };
}

/** Replay retained full-face evidence and keep its known red verdict executable. */
export async function replayFaceLocalization(reportPath) {
  const resolvedReport = resolve(reportPath);
  const reportBytes = await readFile(resolvedReport);
  assert.equal(
    digest(reportBytes),
    expected.nativeEvidenceSha256,
    "native evidence identity changed",
  );
  const report = JSON.parse(reportBytes);
  const assetsDirectory = dirname(resolvedReport);
  const gatesPath = join(assetsDirectory, "gates.json");
  const gatesBytes = await readFile(gatesPath);
  assert.equal(digest(gatesBytes), expected.gatesSha256, "face gates identity changed");
  const gates = JSON.parse(gatesBytes);
  assert.equal(report.gatesSha256, expected.gatesSha256, "report gate binding changed");
  assert.equal(report.workerSha256, expected.workerSha256, "native worker identity changed");
  assert.equal(report.scope, gates.scope, "face evidence scope changed");
  assert.deepEqual(
    report.cases.map((entry) => entry.id),
    expected.hosts,
    "host set changed",
  );
  assert.equal(gates.localization.minimumBoxIoU, 0.5, "full-face IoU contract changed");
  assert.equal(gates.localization.centerInsideAuthoredZone, true);

  const failedRows = [];
  let passingFrames = 0;
  for (const host of report.cases) {
    assert.equal(host.inputSha256, expected.sourceHashes[host.id], `${host.id} source changed`);
    assert.equal(host.source.assetId, host.inputSha256, `${host.id} source binding changed`);
    assert.equal(host.frames.length, expected.framesPerHost, `${host.id} frame count changed`);
    const zone = gates.faces[host.id];
    assert.ok(zone, `${host.id} authored zone missing`);
    for (const [ordinal, frame] of host.frames.entries()) {
      assert.equal(frame.ordinal, ordinal, `${host.id} frame ordinal changed`);
      assert.equal(frame.atUs, expectedAtUs(ordinal), `${host.id}/${ordinal} sample clock changed`);
      assert.equal(frame.receipt.atUs, frame.atUs, `${host.id}/${ordinal} receipt clock changed`);
      assert.equal(frame.receipt.faceObservations?.recipe, "vision-face-rectangles-v1");
      assert.deepEqual(
        frame.receipt.faceObservations,
        frame.observations,
        `${host.id}/${ordinal} receipt observation changed`,
      );
      const result = assertObservation(frame, zone, gates.localization.minimumBoxIoU);
      if (frame.localization.passed) passingFrames++;
      else failedRows.push({ host: host.id, ordinal, overlap: result.overlap });
    }
  }
  const failedOrdinals = failedRows
    .filter((row) => row.host === expected.failedHost)
    .map((row) => row.ordinal);
  assert.deepEqual(failedOrdinals, expected.failedOrdinals, "failed ordinal set changed");
  assert.equal(failedRows.length, expected.failedOrdinals.length, "failed frame count changed");
  assert.deepEqual(
    failedRows.map((row) => row.host),
    expected.failedOrdinals.map(() => expected.failedHost),
    "failure host changed",
  );
  const failedIoU = failedRows.map((row) => row.overlap);
  assert.ok(failedIoU.every((value) => value < gates.localization.minimumBoxIoU));

  const auditBytes = await readFile(join(assetsDirectory, "failure-audit.json"));
  assert.equal(digest(auditBytes), expected.failureAuditSha256, "failure audit identity changed");
  const audit = JSON.parse(auditBytes);
  assert.equal(audit.schema, "face-localization-failure-audit-v1");
  assert.equal(audit.evidence.nativeEvidenceSha256, expected.nativeEvidenceSha256);
  assert.equal(audit.evidence.gatesSha256, expected.gatesSha256);
  assert.equal(audit.evidence.workerSha256, expected.workerSha256);
  assert.equal(audit.failure.host, expected.failedHost);
  assert.equal(audit.failure.failedFrameCount, failedRows.length);
  assert.deepEqual(audit.failure.failedOrdinals, expected.failedOrdinals);
  assert.ok(closeEnough(Math.min(...failedIoU), audit.failure.iou.minimum));
  assert.ok(closeEnough(Math.max(...failedIoU), audit.failure.iou.maximum));
  assert.ok(
    failedRows.every(
      ({ host, ordinal }) =>
        host === expected.failedHost && expected.failedOrdinals.includes(ordinal),
    ),
  );
  assert.equal(audit.failure.centerInsideAuthoredZone, true);
  assert.match(audit.interpretation, /Do not widen boxes/);

  return {
    hosts: expected.hosts,
    framesPerHost: expected.framesPerHost,
    passingFrames,
    failedFrames: failedRows.length,
    failedHost: expected.failedHost,
    failedOrdinals: expected.failedOrdinals,
    minFailedIoU: Math.min(...failedIoU),
    maxFailedIoU: Math.max(...failedIoU),
    allFailedCentersInsideAuthoredZones: audit.failure.centerInsideAuthoredZone,
    status: "open",
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  assert(process.argv[2], "Usage: node face-localization-replay.mjs <native-evidence.json>");
  console.log(JSON.stringify(await replayFaceLocalization(process.argv[2])));
}
