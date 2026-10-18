import assert from "node:assert/strict";
import { mkdir, readFile, realpath, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { voiceProfile } from "../../core/dist/voice-profile.js";
import { Models } from "../../core/dist/models.js";
import { Catalog } from "../../core/dist/catalog.js";
import { mediaWorker } from "../../../apps/service/dist/worker.js";
import { voiceRenderer } from "../../../apps/service/dist/voice.js";
import { JourneyService, poll, root, run, hash } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["out", "runtime", "model", "native", "assembly", "profile"].map((key) => [
      key,
      { type: "string" },
    ]),
  ),
});
for (const key of ["out", "runtime", "model", "native", "assembly", "profile"])
  assert(values[key], `Missing --${key}`);
const out = resolve(values.out),
  home = join(out, "home");
await mkdir(out, { mode: 0o700 });
const capacity = await statfs(out);
assert(
  capacity.bavail * capacity.bsize >= 512 * 1024 * 1024,
  "Free capacity is below the preparation reserve; no adoption started",
);
process.env.YAP_NATIVE = resolve(values.native);
const report = {
  passed: false,
  scope:
    "Public local model preparation and private managed-receipt voice parity; no public generation or listening claim",
  trace: [],
  checks: [],
  capacityBefore: capacity.bavail * capacity.bsize,
};
const service = new JourneyService(home, report);
try {
  await service.start();
  const call = service.call.bind(service);
  const discovered = await call("model.list", {});
  assert.deepEqual(await call("model.list", {}, { transport: "mcp" }), discovered);
  report.discovery = discovered;
  assert.deepEqual(
    discovered.find((entry) => entry.modelId === voiceProfile.id)?.generationProfile,
    voiceProfile,
  );
  for (const modelId of ["parakeet", "qwen3-tts-icl-v1"])
    assert.partialDeepStrictEqual(await call("model.status", { modelId }), {
      state: "unavailable",
      presence: "absent",
    });
  assert.equal(
    (await call("model.status", { modelId: "missing" }, { error: true })).code,
    "NOT_FOUND",
  );
  const params = {
    modelId: "qwen3-tts-icl-v1",
    runtimeSource: resolve(values.runtime),
    modelSource: resolve(values.model),
  };
  assert.equal((await call("model.prepare", params)).state, "running");
  assert.equal((await call("model.prepare", params, { transport: "mcp" })).state, "running");
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  await poll(
    () => call("model.status", { modelId: "qwen3-tts-icl-v1" }, { transport: "mcp" }),
    (value) => value.state === "ready",
    "managed preparation",
  );
  assert.partialDeepStrictEqual(await call("model.prepare", { modelId: "qwen3-tts-icl-v1" }), {
    state: "ready",
    presence: "ready",
  });
  const started = performance.now();
  let verificationFinished = false;
  const readiness = call(
    "model.status",
    { modelId: "qwen3-tts-icl-v1" },
    { transport: "mcp" },
  ).finally(() => {
    verificationFinished = true;
  });
  await call("project.list", {}, { transport: "mcp" });
  assert.equal(
    verificationFinished,
    false,
    "Catalog reads must advance during the full runtime verification",
  );
  report.catalogReadMs = performance.now() - started;
  assert.partialDeepStrictEqual(await readiness, { state: "ready", presence: "ready" });
  await service.stop();
  await service.start();
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "qwen3-tts-icl-v1" }), {
    state: "ready",
    presence: "ready",
  });
  assert.deepEqual(await call("model.list", {}), discovered);
  await service.stop();
  const library = join(home, "library");
  const models = new Models(
    library,
    globalThis.fetch,
    undefined,
    new Catalog(join(library, "catalog.sqlite")),
  );
  const prepared = await models.runtime("qwen3-tts-icl-v1", "voice");
  report.prepared = prepared;
  assert.notEqual(await realpath(prepared.model), await realpath(values.model));
  const cases = JSON.parse(
    await readFile(join(root, "packages/test-harness/editing/voice/cases.json")),
  );
  const frozen = join(root, "specs/done/agent-editing/assets/18-voice");
  const renderer = voiceRenderer(
    mediaWorker({ YAP_NATIVE: resolve(values.native) }),
    models,
    "qwen3-tts-icl-v1",
    join(out, "workspace"),
  );
  for (const item of cases.replacements) {
    const output = join(out, `managed-${item.id}.wav`);
    const receipt = await renderer(
      {
        reference: join(frozen, "reference.wav"),
        referenceText: cases.reference.text,
        text: item.text,
        generation: cases.generation,
        seed: String(cases.seed),
        output,
      },
      new AbortController().signal,
    );
    const actual = await readFile(output);
    assert.deepEqual(actual, await readFile(join(frozen, `same-take-${item.id}.wav`)));
    report.checks.push({ text: item.id, exactWAVAndPCM: true, sha256: hash(actual), receipt });
  }
  const assembly = JSON.parse(await readFile(values.assembly));
  const donors = [
    assembly.sourceRoots.base,
    assembly.sourceRoots.venv,
    resolve(values.runtime),
    resolve(values.model),
    assembly.sourceRoots.entry,
  ];
  const denied = [
    ...new Set([...donors, ...(await Promise.all(donors.map((path) => realpath(path))))]),
  ];
  const profile = join(out, "donor-denial.sb");
  await writeFile(
    profile,
    `${await readFile(resolve(values.profile), "utf8")}\n${denied.map((path) => `(deny file* (subpath ${JSON.stringify(path)}))`).join("\n")}\n`,
  );
  const additionalDonors = join(out, "additional-donors.json");
  await writeFile(
    additionalDonors,
    JSON.stringify([
      join(resolve(values.runtime), "voice/worker.py"),
      join(resolve(values.model), ".gitattributes"),
      assembly.sourceRoots.entry,
    ]),
  );
  // Reuse the retained one-profile closure gate, now with managed paths resolved by Models.
  const bundle = resolve(prepared.entry, "../..");
  await run(
    process.execPath,
    [
      join(root, "packages/test-harness/editing/voice-runtime-relocation.mjs"),
      "--bundle",
      bundle,
      "--model",
      prepared.model,
      "--native",
      resolve(values.native),
      "--out",
      join(out, "donor-denied"),
      "--profile",
      profile,
      "--assembly",
      resolve(values.assembly),
      "--donors",
      additionalDonors,
    ],
    { timeout: 600000 },
  );
  report.donorDenied = JSON.parse(await readFile(join(out, "donor-denied/report.json")));
  // Runtime readiness verifies content on each call, including same-size mutations.
  await service.start();
  const originalEntry = await readFile(prepared.entry);
  const alteredEntry = Buffer.from(originalEntry);
  alteredEntry[0] ^= 0xff;
  try {
    await writeFile(prepared.entry, alteredEntry);
    assert.partialDeepStrictEqual(await call("model.status", { modelId: "qwen3-tts-icl-v1" }), {
      state: "failed",
      presence: "invalid",
    });
    assert.partialDeepStrictEqual(
      await call("model.status", { modelId: "qwen3-tts-icl-v1" }, { transport: "mcp" }),
      { state: "failed", presence: "invalid" },
    );
  } finally {
    await writeFile(prepared.entry, originalEntry);
  }
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "qwen3-tts-icl-v1" }), {
    state: "ready",
    presence: "ready",
  });
  report.sameSizeRuntimeMutation = { cli: "invalid", mcp: "invalid", restored: "ready" };
  report.capacityAfter = (await statfs(out)).bavail * capacity.bsize;
  report.passed = true;
} finally {
  await service.stop();
  report.logs = service.logs;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
