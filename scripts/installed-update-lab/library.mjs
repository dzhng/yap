import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  seedCapture,
  importAcquisition,
  until,
} from "../../apps/macos/tests/fixtures/public-service.mjs";
import { journalRows } from "../../apps/macos/tests/fixtures/generated-capture.mjs";

const sha = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** Historical silent movie; the journal/lifecycle are synthetic fixture facts, not a new capture. */
export async function seedSource(home, media) {
  const recordingId = randomUUID(),
    sourceId = randomUUID();
  await seedCapture(home, { recordingId, sourceId, sourceDurationUs: 4_000_000 });
  const donor = join(home, "library/recordings", recordingId, "source");
  await copyFile(media, join(donor, "video.mov"));
  const rows = journalRows({ sourceId, width: 640, height: 360, samples: [] });
  await writeFile(
    join(donor, "capture.journal.jsonl"),
    rows.map((row, i) => JSON.stringify({ sequence: i + 1, ...row }) + "\n").join(""),
  );
  return { recordingId, sourceId, donor, sha256: await sha(media) };
}

export async function populateLibrary(home, source, call) {
  const data = async (operation, params = {}) => {
    const reply = await call(operation, params);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  const { acquisition, job } = await importAcquisition({ call }, source.donor);
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
  assert.ok(binding, "Source import must bind the retained video");
  const created = await data("project.create", {
    requestId: randomUUID(),
    title: "Installed update fixture",
    canvas: {
      width: 640,
      height: 360,
      fps: { numerator: 1, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const authored = await data("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "video" },
      {
        operation: "place",
        clip: {
          trackId: { label: "video" },
          assetId: binding.assetId,
          streamId: binding.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 4_000_000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 4_000_000 } },
        },
      },
    ],
  });
  // An editable package copies retained media; this proof performs no rendering or inference.
  const destination = join(home, "exports");
  await mkdir(destination, { mode: 0o700 });
  const exportId = randomUUID();
  await data("export.create", {
    projectId,
    revisionId: authored.revision.revisionId,
    requestId: exportId,
    kind: "processed-package",
    directory: destination,
    leaf: "fixture.zip",
  });
  await until(async () => {
    const result = await data("export.status", { exportId });
    assert.ok(
      !["failed", "canceled", "unavailable"].includes(result.state),
      JSON.stringify(result),
    );
    return result.state === "ready" && !result.cleanupPending;
  }, "Fixture export did not commit");
  return {
    ...source,
    acquisitionId: acquisition.id,
    assetId: binding.assetId,
    projectId,
    revisionId: authored.revision.revisionId,
    jobId: job.jobId,
    exportId,
    originalPath: join(source.donor, "video.mov"),
    exportPath: join(destination, "fixture.zip"),
  };
}

export async function observeLibrary(home, manifest, call) {
  const facts = {};
  for (const [name, operation, params] of [
    ["recording", "recording.get", { recordingId: manifest.recordingId }],
    ["acquisition", "acquisition.get", { acquisitionId: manifest.acquisitionId }],
    ["asset", "asset.get", { assetId: manifest.assetId }],
    ["project", "project.get", { projectId: manifest.projectId }],
    [
      "revision",
      "revision.get",
      { projectId: manifest.projectId, revisionId: manifest.revisionId },
    ],
    ["history", "revision.history", { projectId: manifest.projectId }],
    ["job", "job.get", { jobId: manifest.jobId }],
    ["export", "export.status", { exportId: manifest.exportId }],
  ]) {
    const reply = await call(operation, params);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    facts[name] = reply.data;
  }
  facts.originalSha256 = await sha(manifest.originalPath);
  facts.managedOriginalSha256 = await sha(join(home, "library/assets", manifest.assetId + ".mov"));
  facts.exportSha256 = await sha(manifest.exportPath);
  return facts;
}
