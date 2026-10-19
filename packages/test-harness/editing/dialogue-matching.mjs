import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";
const [distribution, fixtures, destination] = process.argv.slice(2);
assert.ok(
  distribution && fixtures && destination && process.env.YAP_NATIVE,
  "Usage: YAP_NATIVE=... node dialogue-matching.mjs FFMPEG_DISTRIBUTION DIALOGUE_FIXTURES NEW_OUTPUT",
);
const out = resolve(destination),
  input = resolve(fixtures);
await mkdir(out);
const manifest = JSON.parse(await readFile(join(input, "manifest.json"), "utf8"));
const receipt = await readFile(join(distribution, "receipt.json"));
process.env.YAP_TEST_FFMPEG = JSON.stringify({
  directory: resolve(distribution),
  receiptSha256: hash(receipt),
});
const home = await realpath(await mkdtemp("/tmp/yap-dialogue-"));
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: {},
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  receiptSha256: hash(receipt),
  inputs: manifest,
};
const service = new JourneyService(
  home,
  report,
  undefined,
  new URL("./loudness/service.mjs", import.meta.url),
);
const call = service.call.bind(service);
const compressor = {
  enabled: true,
  processor: {
    type: "compressor",
    thresholdDbfs: -24,
    ratio: 2,
    kneeDb: 6,
    attackMs: 5,
    releaseMs: 50,
    makeupGainDb: 3,
    detector: { kind: "input" },
  },
};
try {
  await service.start();
  const assets = [];
  for (const c of manifest.cases) {
    const path = join(input, c.path);
    assert.equal(hash(await readFile(path)), c.sha256);
    const imported = await call("asset.import", { requestId: c.name, path });
    const admitted = await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (v) => v.state === "ready",
      "source admission",
    );
    const asset = await call("asset.get", { assetId: admitted.published.output.assetId });
    assets.push({
      assetId: asset.assetId,
      streamId: asset.streams.find((s) => s.kind === "audio").streamId,
    });
  }
  const created = await call("project.create", {
    requestId: "project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  let edited = await call("edit.apply", {
    projectId,
    expectedRevisionId: created.revision.revisionId,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "dialogue", track: { kind: "audio", order: 0 } },
      ...assets.map((asset, i) => ({
        operation: "place",
        clip: {
          trackId: { label: "dialogue" },
          ...asset,
          source: { kind: "range", range: { startUs: 0, endUs: 8000000 } },
          placement: { kind: "project", range: { startUs: i * 8000000, endUs: (i + 1) * 8000000 } },
        },
      })),
    ],
  });
  const clips = edited.revision.document.clips;
  assert.equal(clips.length, 2);
  edited = await call("edit.apply", {
    projectId,
    expectedRevisionId: edited.revision.revisionId,
    requestId: "compressors",
    operations: clips.map((c) => ({
      operation: "processing.set",
      target: { kind: "clip", id: c.id },
      steps: [compressor],
    })),
  });
  const measure = async (clip, i, name, revisionId) => {
    const params = {
      projectId,
      revisionId,
      range: { startUs: i * 8000000, endUs: (i + 1) * 8000000 },
      tap: { target: { kind: "clip", id: clip.id }, point: { kind: "processed" } },
    };
    await poll(
      () => call("audio.measure", params),
      (v) => v.state === "ready",
      name,
    );
    const path = join(out, name + ".json");
    await call("audio.measure", params, { output: path });
    return JSON.parse(await readFile(path, "utf8"));
  };
  const before = [];
  for (let i = 0; i < clips.length; i++)
    before.push(await measure(clips[i], i, "before-" + i, edited.revision.revisionId));
  console.log("Two real processed speaker measurements delivered");
  const request = {
    projectId,
    revisionId: edited.revision.revisionId,
    targetIntegratedLufs: -26,
    gainBounds: { minimumDb: -24, maximumDb: 24 },
    truePeakCeilingDbtp: -2,
    minimumDurationUs: 400000,
    clips: clips.map((clip, i) => ({
      clipId: clip.id,
      evidence: before[i],
    })),
  };
  await writeFile(join(out, "proposal-request.json"), JSON.stringify(request, null, 2));
  const response = spawnSync(
    process.execPath,
    [new URL("../../../skills/yap/scripts/dialogue-proposals.mjs", import.meta.url).pathname],
    { input: JSON.stringify(request), encoding: "utf8", timeout: 5000 },
  );
  await writeFile(join(out, "proposal-response.json"), response.stdout || response.stderr);
  assert.equal(response.status, 0, response.stderr);
  const proposal = JSON.parse(response.stdout);
  assert.ok(
    proposal.proposals.every((p) => p.status === "proposed"),
    JSON.stringify(proposal),
  );
  assert.ok(
    Math.abs(proposal.proposals[0].gainDb - proposal.proposals[1].gainDb) > 6,
    "Quiet host must receive independent correction",
  );
  edited = await call("edit.apply", {
    projectId,
    expectedRevisionId: proposal.revisionId,
    requestId: "match",
    operations: proposal.proposals.map((p) => ({
      operation: "processing.set",
      target: { kind: "clip", id: p.clipId },
      steps: [
        ...edited.revision.document.processing.find(
          (stack) => stack.target.kind === "clip" && stack.target.id === p.clipId,
        ).steps,
        p.gainStep,
      ],
    })),
  });
  const after = [];
  for (let i = 0; i < clips.length; i++)
    after.push(await measure(clips[i], i, "after-" + i, edited.revision.revisionId));
  for (const evidence of after) {
    assert.ok(
      Math.abs(evidence.measurement.integratedLufs - request.targetIntegratedLufs) <= 0.2,
      JSON.stringify(evidence.measurement),
    );
    assert.ok(evidence.measurement.truePeakDbtp <= request.truePeakCeilingDbtp + 0.15);
  }
  report.checks.matching = {
    before: before.map((e) => e.measurement),
    proposal,
    after: after.map((e) => e.measurement),
  };
  console.log("Both real hosts match independently after explicit gain edits");
  const normalized = await call("edit.apply", {
    projectId,
    expectedRevisionId: edited.revision.revisionId,
    requestId: "master",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            enabled: true,
            processor: {
              type: "normalization",
              mode: "dynamic",
              targetIntegratedLufs: -20,
              truePeakCeilingDbtp: -1,
              maxLoudnessRangeLu: 7,
            },
          },
        ],
      },
    ],
  });
  const selection = { projectId, revisionId: normalized.revision.revisionId };
  const prepared = await poll(
    () => call("audio.prepare", selection),
    (v) => v.state === "ready",
    "strict master",
  );
  await poll(
    () => call("audio.measure", selection),
    (v) => v.state === "ready",
    "master measurement",
  );
  await call("audio.measure", selection, { output: join(out, "master.json") });
  await call(
    "audio.get",
    { ...selection, range: { startUs: 0, endUs: 16000000 } },
    { output: join(out, "master.wav") },
  );
  const master = JSON.parse(await readFile(join(out, "master.json"), "utf8"));
  assert.ok(Math.abs(master.measurement.integratedLufs + 20) <= 0.2);
  assert.ok(master.measurement.truePeakDbtp <= -1 + 0.15);
  assert.ok(master.measurement.loudnessRangeLu <= 7 + 0.2);
  report.checks.master = {
    prepared,
    measurement: master,
    outputSha256: hash(await readFile(join(out, "master.wav"))),
  };
  for (const c of manifest.cases) assert.equal(hash(await readFile(join(input, c.path))), c.sha256);
  report.passed = true;
  console.log("Strict complete master passes; original fixture bytes unchanged");
} finally {
  await service.stop();
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
