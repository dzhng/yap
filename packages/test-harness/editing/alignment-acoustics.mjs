import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { JourneyService, hash, poll, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: { home: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "Usage: YAP_NATIVE=<worker> node alignment-acoustics.mjs --home <prepared-scratch-home> --out <new-directory>\nRequires ready nemo-ctc110 in the scratch home; reuses matching retained inference. Creates source fixtures and public evidence, never edits originals. Do not use a personal library.",
  );
  process.exit(0);
}
assert.ok(values.home && values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
await mkdir(out, { mode: 0o700 });
const report = {
  passed: false,
  trace: [],
  checks: [],
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(resolve(values.home), report);
const call = service.call.bind(service);
const reference = join(root, "specs/done/video-editing-feedback/assets/09-local-alignment/inputs");
const manifest = JSON.parse(await readFile(join(reference, "manifest.json"), "utf8"));
const expectedEngine = JSON.parse(
  await readFile(join(reference, "../../10-word-attribution/preparation.json"), "utf8"),
).engine;
async function rawOperand(selection, operand, expectedDigest) {
  const parts = [];
  let cursor, digest;
  do {
    const result = await call(
      "alignment.get",
      { ...selection, view: "raw", operand, ...(cursor ? { cursor } : {}) },
      { transport: "mcp" },
    );
    assert.equal(result.state, "ready");
    const page = result.page;
    assert.equal(page.sha256, expectedDigest);
    digest ??= page.sha256;
    assert.equal(page.sha256, digest);
    parts.push(Buffer.from(page.bytesBase64, "base64"));
    cursor = page.nextCursor;
  } while (cursor);
  const bytes = Buffer.concat(parts);
  assert.equal(hash(bytes), digest);
  await writeFile(join(out, `${selection.assetId}-${operand}.json`), bytes);
  return JSON.parse(bytes.toString("utf8"));
}
try {
  await service.start();
  assert.equal((await call("model.status", { modelId: "nemo-ctc110" })).state, "ready");
  for (const name of ["fortunate-intact", "fortunate-truncated"]) {
    const input = manifest.cases.find((entry) => entry.id === name);
    const pcm = gunzipSync(await readFile(join(reference, `${name}.f32.gz`)));
    assert.equal(hash(pcm), input.pcmSha256);
    assert.equal(pcm.length, input.frames * 4);
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(pcm.length + 36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(3, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(64000, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(32, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    const path = join(out, `${name}.wav`);
    await writeFile(path, Buffer.concat([header, pcm]));
    const pending = await call("asset.import", { requestId: randomUUID(), path });
    const imported = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (job) => job.state === "ready",
      `${name} import`,
    );
    const asset = await call("asset.get", { assetId: imported.published.output.assetId });
    const selection = {
      assetId: asset.id,
      streamId: asset.streams.find((stream) => stream.kind === "audio").streamId,
      channel: 0,
      sourceRange: { startUs: 0, endUs: (input.frames * 1000000) / 16000 },
      text: "fortunate",
      modelId: "nemo-ctc110",
    };
    console.log(JSON.stringify({ name, state: "preparing" }));
    const preparing = await call("alignment.observe", selection);
    const ready = await poll(
      () => call("job.get", { jobId: preparing.jobId }),
      (job) => job.state === "ready",
      `${name} alignment`,
    );
    assert.equal(ready.published.output.source.pcm.sha256, hash(pcm));
    const published = ready.published.output;
    for (const [field, expected] of Object.entries(expectedEngine))
      assert.equal(published.source.engine[field], expected);
    const read = { assetId: asset.id, generation: ready.published.output.generation };
    const thresholds = [];
    for (const thresholdRMS of [0.01, 0]) {
      const request = { ...read, view: "acoustic", thresholdRMS, limit: 1000 };
      const observed = await call("alignment.get", request);
      assert.deepEqual(await call("alignment.get", request, { transport: "mcp" }), observed);
      assert.equal(observed.state, "ready");
      const page = observed.page;
      assert.deepEqual(page.evidence, published);
      assert.equal(page.nextCursor, null);
      assert.equal(page.acousticResolutionSamples, 160);
      assert.equal(page.noiseFloorInterpretation, "unknown");
      assert.equal(page.rows.length, Math.ceil(input.frames / 160));
      for (const [ordinal, cell] of page.rows.entries()) {
        const start = ordinal * 160,
          end = Math.min(input.frames, start + 160);
        let squares = 0,
          peak = 0;
        for (let sample = start; sample < end; sample++) {
          const value = pcm.readFloatLE(sample * 4);
          squares += value * value;
          peak = Math.max(peak, Math.abs(value));
        }
        const rms = Math.sqrt(squares / (end - start));
        assert.deepEqual(
          {
            ordinal: cell.ordinal,
            startSample: cell.startSample,
            endSample: cell.endSample,
            peak: cell.peak,
            sourceRange: cell.sourceRange,
            activity: cell.activity,
            thresholdRMS: cell.thresholdRMS,
            lexicalIdentity: cell.lexicalIdentity,
          },
          {
            ordinal,
            startSample: start,
            endSample: end,
            peak,
            sourceRange: { startUs: (start * 1000000) / 16000, endUs: (end * 1000000) / 16000 },
            activity: cell.rms >= thresholdRMS ? "active" : "quiet",
            thresholdRMS,
            lexicalIdentity: "unknown",
          },
        );
        // Nonnegative summation differs between JS and Python's compensated sum.
        // The sample count bounds double-precision forward error, independently of observed deltas.
        assert.ok(Math.abs(cell.rms - rms) <= (end - start + 2) * Number.EPSILON * rms);
      }
      const lowerDecile = page.rows.map((row) => row.rms).toSorted((a, b) => a - b)[
        Math.floor((page.rows.length - 1) / 10)
      ];
      assert.equal(page.evidence.observedLowerDecileRMS, lowerDecile);
      thresholds.push(observed);
    }
    const raw = await rawOperand(read, "report", published.reportSha256);
    assert.equal(
      raw.acoustic.observedLowerDecileRMS,
      ready.published.output.observedLowerDecileRMS,
    );
    const words = await call("alignment.get", { ...read, view: "words", limit: 1000 });
    assert.ok(
      words.page.rows.every(
        (row) => row.lexicalIdentity === "unknown" && row.assignmentConfidence === null,
      ),
    );
    const tail = thresholds[0].page.rows.at(-1);
    assert.equal(tail.activity, name === "fortunate-intact" ? "quiet" : "active");
    report.checks.push({
      name,
      selection,
      published: ready.published.output,
      thresholds,
      words,
      exactPCM: true,
      sampleSupportAndPeaksExact: true,
      rmsWithinForwardError: true,
      reusedPublishedInference: preparing.state === "ready",
      measuredTail: tail,
      lexicalCutVerdict: "unknown",
    });
  }
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  }
}
