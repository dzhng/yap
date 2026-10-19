import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, poll, hash } from "./source-evidence-fixture.mjs";
import { writeSourceWave } from "./audio-project-fixture.mjs";
const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await mkdtemp("/tmp/sr-job-inspection-");
await mkdir(out);
const source = join(out, "source.wav");
await writeSourceWave(source, { source: 0, seconds: 1 });
const report = {
  passed: false,
  home,
  trace: [],
  jobs: [],
  unprofiled: [],
  profiled: [],
  scope:
    "Matched public prepared-audio recipes admitted then canceled. SQL capture separated from latency observations; no long DSP, whole-service constant-memory or throughput claim.",
  harnessSha256: hash(await readFile(import.meta.filename)),
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
let service = new JourneyService(home, report);
async function snapshot(enable = false) {
  const id = randomUUID();
  service.child.send({ id, type: "profile.snapshot", enable });
  return poll(
    () => service.barriers.get(id + "/profile.snapshot") ?? {},
    (v) => !!v.memory,
    "profile snapshot",
  );
}
try {
  await service.start();
  const admitted = await service.call("asset.import", { requestId: "source", path: source });
  const imported = await poll(
    () => service.call("job.get", { jobId: admitted.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await service.call("asset.get", { assetId: imported.published.output.assetId });
  for (const count of [1, 10000]) {
    const started = performance.now();
    const made = await service.call("project.create", {
      requestId: "project-" + count,
      canvas: {
        width: 16,
        height: 16,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    let revision = made.revision;
    for (let start = 0; start < count; start += 500) {
      const operations = [];
      if (start === 0)
        operations.push({
          operation: "track.add",
          label: "audio",
          track: { kind: "audio", order: 0 },
        });
      for (let i = start; i < Math.min(start + 500, count); i++)
        operations.push({
          operation: "place",
          clip: {
            trackId: start === 0 ? { label: "audio" } : revision.document.tracks[0].id,
            assetId: asset.assetId,
            streamId: asset.streams[0].streamId,
            source: { kind: "range", range: { startUs: 0, endUs: 720000 } },
            placement: { kind: "project", range: { startUs: i * 720000, endUs: (i + 1) * 720000 } },
          },
        });
      if (start + 500 >= count)
        operations.push({
          operation: "processing.set",
          target: { kind: "output" },
          steps: [{ processor: { type: "rnnoise" } }],
        });
      revision = (
        await service.call(
          "edit.apply",
          {
            projectId: made.project.projectId,
            expectedRevisionId: revision.revisionId,
            requestId: "place-" + start,
            operations,
          },
          { transport: "mcp" },
        )
      ).revision;
    }
    const setupMs = performance.now() - started;
    const barrier = count === 1 ? await service.arm("media.mixCompositionAudio") : null;
    const requested = await service.call("audio.prepare", {
      projectId: made.project.projectId,
      revisionId: revision.revisionId,
    });
    if (barrier) await barrier();
    const canceled = await service.call(
      "job.cancel",
      { jobId: requested.jobId },
      { transport: "mcp" },
    );
    assert.equal(canceled.state, "canceled");
    assert.equal(canceled.published, null);
    report.jobs.push({
      count,
      setupMs,
      projectId: made.project.projectId,
      revisionId: revision.revisionId,
      jobId: requested.jobId,
      canceled,
    });
  }

  await service.stop();
  const db = new DatabaseSync(join(home, "library/catalog.sqlite"), { readOnly: true });
  const cases = db
    .prepare(
      "SELECT jobId,state,length(CAST(input AS BLOB)) inputBytes FROM jobs WHERE artifact='prepared-audio' ORDER BY length(input)",
    )
    .all();
  assert.equal(cases.length, 2);
  assert(cases.every((j) => j.state === "canceled"));
  report.cases = cases;
  report.storage = db
    .prepare(
      "SELECT name,sum(pgsize) bytes FROM dbstat WHERE name LIKE '%jobs%' OR name LIKE '%artifacts%' GROUP BY name",
    )
    .all();
  for (const job of cases) {
    const raw = db.prepare("SELECT input FROM jobs WHERE jobId=?").get(job.jobId).input;
    assert.equal(
      hash(Buffer.from(raw)),
      report.jobs.find((j) => j.jobId === job.jobId).canceled.inputSha256,
    );
  }
  db.close();
  service = new JourneyService(
    home,
    report,
    undefined,
    new URL("./job-inspection-service.mjs", import.meta.url),
  );
  await service.start();
  report.start = await snapshot();
  for (const [transport, rounds] of [
    ["mcp", 10],
    ["cli", 3],
  ])
    for (let i = 0; i < rounds; i++)
      for (const job of cases) {
        const at = performance.now();
        const value = await service.call("job.get", { jobId: job.jobId }, { transport });
        assert.deepEqual(value, report.jobs.find((j) => j.jobId === job.jobId).canceled);
        report.unprofiled.push({
          inputBytes: job.inputBytes,
          transport,
          ms: performance.now() - at,
          responseBytes: Buffer.byteLength(JSON.stringify(value)),
        });
      }
  report.afterUnprofiled = await snapshot();
  for (const job of cases) {
    await snapshot(true);
    const at = performance.now();
    await service.call("job.get", { jobId: job.jobId }, { transport: "mcp" });
    const ms = performance.now() - at;
    const data = await snapshot(false);
    report.profiled.push({ inputBytes: job.inputBytes, ms, ...data });
    assert(data.queries.length > 0, "instrumentation must observe the real read");
    assert(
      data.queries.every(
        (q) => q.returnedInputCharacters === 0 && q.returnedContentCharacters === 0,
      ),
      "status must not hydrate recipes or revision documents",
    );
    assert(
      data.queries.every((q) => q.boundStringCharacters < cases[0].inputBytes),
      "status must not bind even the smallest recipe",
    );
  }
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    try {
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
console.log(
  JSON.stringify({ passed: report.passed, cases: report.cases, profiled: report.profiled }),
);
