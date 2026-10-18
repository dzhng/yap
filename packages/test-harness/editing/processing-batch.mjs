import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { JourneyService, poll, hash, run } from "./source-evidence-fixture.mjs";
import { sourcePeriod, waveHeader } from "./audio-project-fixture.mjs";
const { values } = parseArgs({
  options: { out: { type: "string" }, home: { type: "string" }, request: { type: "string" } },
});
assert(values.out && values.home && values.request && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = join(out, "home"),
  original = JSON.parse(await readFile(resolve(values.request))),
  report = {
    passed: false,
    trace: [],
    checks: {},
    normalization:
      "Identical operations and complete pre-edit document; public restore requires new requestId/expectedRevisionId. No SQL head/receipt changes.",
    nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
    harnessSha256: hash(await readFile(import.meta.filename)),
  };
await mkdir(out);
await run("cp", ["-cR", resolve(values.home), home]);
const service = new JourneyService(home, report);
try {
  await service.start();
  const frozen = await service.call("edit.apply", original, { transport: "mcp" });
  await writeFile(out + "/original-replay.json", JSON.stringify(frozen));
  const projectId = original.projectId;
  const before = await service.call("revision.get", {
    projectId,
    revisionId: original.expectedRevisionId,
  });
  const head = await service.call("project.get", { projectId });
  const restored = await service.call("edit.restore", {
    projectId,
    expectedRevisionId: head.currentRevisionId,
    targetRevisionId: before.revision.revisionId,
    requestId: randomUUID(),
  });
  assert.deepEqual(restored.document, before.revision.document);
  report.inputDocumentSha256 = hash(Buffer.from(JSON.stringify(restored.document)));
  report.operationsSha256 = hash(Buffer.from(JSON.stringify(original.operations)));
  const request = { ...original, expectedRevisionId: restored.id, requestId: randomUUID() };
  await writeFile(out + "/request.json", JSON.stringify(request));
  let at = performance.now();
  const changed = await service.call("edit.apply", request, { transport: "mcp" });
  report.applyMs = performance.now() - at;
  assert.deepEqual(changed.edit, frozen.edit);
  assert.deepEqual(changed.revision.document, frozen.revision.document);
  assert.equal(changed.revision.ordinal, restored.ordinal + 1);
  report.checks.exactOriginalEditAndDocument = true;
  at = performance.now();
  assert.deepEqual(await service.call("edit.apply", request, { transport: "mcp" }), changed);
  report.replayMs = performance.now() - at;
  report.checks.oneCommitReplay = true;
  const expected = sourcePeriod(0).subarray(0, 4800 * 8);
  async function audio(revisionId, name, range, oracle) {
    const params = { projectId, revisionId, range };
    at = performance.now();
    const ready = await poll(
      () => service.call("audio.get", params),
      (v) => v.state === "ready",
      name,
    );
    const file = out + "/" + name + ".wav";
    await service.call("audio.get", params, { output: file });
    const bytes = await readFile(file),
      header = waveHeader(bytes, bytes.length);
    assert.deepEqual(bytes.subarray(header.offset), oracle);
    report.checks[name] = {
      ready,
      ms: performance.now() - at,
      sha256: hash(bytes),
      exactPCM: true,
    };
    return bytes.subarray(header.offset);
  }
  await audio(changed.revision.revisionId, "full", { startUs: 0, endUs: 100000 }, expected);
  await audio(
    changed.revision.revisionId,
    "late",
    { startUs: 50000, endUs: 100000 },
    expected.subarray(2400 * 8),
  );
  const stack = changed.revision.document.processing.find((s) => s.steps.length === 128);
  assert(stack);
  assert.equal(stack.steps.at(-1).processor.gain, 0.5);
  const negative = await service.call("edit.apply", {
    projectId,
    expectedRevisionId: changed.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "processing.set", target: stack.target, steps: stack.steps.slice(0, -1) },
    ],
  });
  const expectedWithoutGain = Buffer.from(expected);
  for (let i = 0; i < expectedWithoutGain.length; i += 4)
    expectedWithoutGain.writeFloatLE(Math.fround(expectedWithoutGain.readFloatLE(i) * 2), i);
  const actual = await audio(
    negative.revision.revisionId,
    "missing-gain",
    { startUs: 0, endUs: 100000 },
    expectedWithoutGain,
  );
  assert.notDeepEqual(actual, expected);
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(out + "/report.json", JSON.stringify(report, null, 2));
  if (report.passed) await rm(home, { recursive: true, force: true });
}
