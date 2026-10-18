import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JourneyService, hash, poll } from "../source-evidence-fixture.mjs";
const [distribution, destination] = process.argv.slice(2);
assert.ok(
  distribution && destination && process.env.YAP_NATIVE,
  "Expected DISTRIBUTION NEW_DESTINATION and YAP_NATIVE",
);
const out = resolve(destination),
  home = await realpath(await mkdtemp("/tmp/sr-lufs-"));
await mkdir(out);
const receipt = await readFile(join(distribution, "receipt.json"));
process.env.YAP_TEST_FFMPEG = JSON.stringify({
  directory: resolve(distribution),
  receiptSha256: hash(receipt),
});
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: {},
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  cliOwnerSha256: hash(await readFile(process.env.YAP_NATIVE)),
  receiptSha256: hash(receipt),
};
const service = new JourneyService(
  home,
  report,
  undefined,
  new URL("./service.mjs", import.meta.url),
);
const pcm = Buffer.alloc(48000 * 6 * 4);
for (let i = 0; i < 48000 * 6; i++)
  pcm.writeFloatLE(0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000), i * 4);
const wave = Buffer.alloc(44 + pcm.length);
wave.write("RIFF");
wave.writeUInt32LE(wave.length - 8, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(3, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(48000, 24);
wave.writeUInt32LE(192000, 28);
wave.writeUInt16LE(4, 32);
wave.writeUInt16LE(32, 34);
wave.write("data", 36);
wave.writeUInt32LE(pcm.length, 40);
pcm.copy(wave, 44);
const sourcePath = join(out, "mono.wav");
await writeFile(sourcePath, wave, { flag: "wx" });
const call = service.call.bind(service);
try {
  await service.start();
  const imported = await call("asset.import", { requestId: "source", path: sourcePath });
  const job = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "source admission",
  );
  console.log("source admitted");
  const asset = await call("asset.get", { assetId: job.published.output.assetId });
  const selected = {
    assetId: asset.id,
    streamId: asset.streams.find((s) => s.kind === "audio").id,
  };
  const measure = (params, transport = "cli") =>
    poll(
      () => call("audio.measure", params, { transport }),
      (v) => v.state === "ready",
      "loudness",
    );
  report.checks.mono = await measure(selected);
  report.checks.mcp = await measure(selected, "mcp");
  report.checks.dualmono = await measure({ ...selected, channelInterpretation: "dual-mono" });
  report.checks.sampleOnly = await measure({ ...selected, truePeak: false });
  report.checks.short = await measure({ ...selected, range: { startUs: 0, endUs: 200000 } });
  console.log("source meter checks retained");
  const created = await call("project.create", {
    requestId: "project",
    canvas: {
      width: 32,
      height: 24,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const placed = await call("edit.apply", {
    projectId,
    expectedRevisionId: created.revision.revisionId,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "sound", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "sound" },
          ...selected,
          source: { kind: "range", range: { startUs: 0, endUs: 6000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 6000000 } },
          pitch: "preserve",
        },
      },
    ],
  });
  const project = { projectId, revisionId: placed.revision.revisionId };
  report.checks.project = await measure(project);
  const prepared = await poll(
    () => call("audio.prepare", project),
    (v) => v.state === "ready",
    "prepared signal",
  );
  report.checks.prepared = await measure({
    ...project,
    preparedResourceId: prepared.published.output.resourceId,
  });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  const analysis = (r) => r.published.output.analysis;
  assert.ok(Math.abs(analysis(report.checks.mono).measurement.integratedLufs + 23) < 0.1);
  assert.deepEqual(report.checks.mcp.published, report.checks.mono.published);
  assert.ok(
    Math.abs(
      analysis(report.checks.dualmono).measurement.integratedLufs -
        analysis(report.checks.mono).measurement.integratedLufs -
        3.0103,
    ) < 0.1,
  );
  assert.equal(analysis(report.checks.sampleOnly).measurement.truePeakDbtp, null);
  assert.equal(analysis(report.checks.short).measurement.integratedReason, "insufficient-duration");
  assert.equal(analysis(report.checks.project).scope, "full-signal");
  assert.equal(report.checks.project.published.output.revisionId, project.revisionId);
  assert.equal(
    analysis(report.checks.prepared).signalRecipe.preparedResourceId,
    prepared.published.output.resourceId,
  );
  assert.equal(hash(await readFile(sourcePath)), hash(wave));
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, checks: Object.keys(report.checks) }));
