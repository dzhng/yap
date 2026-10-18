import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { Models } from "../../core/dist/models.js";
import { Catalog } from "../../core/dist/catalog.js";
import {
  jsonWorker,
  nativeResult,
  preparedModelWorker,
} from "../../../apps/service/dist/worker.js";

const { values } = parseArgs({
  options: {
    library: { type: "string" },
    reference: { type: "string" },
    output: { type: "string" },
    case: { type: "string", default: "all" },
    profile: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node alignment-runtime-parity.mjs --library <prepared-library> --reference <materialized09> --output <new-directory> [--case <id|all>] [--profile <sandbox-file>]\nReads a verified Models preparation; never prepares or downloads. An optional sandbox profile can additionally deny donor roots.",
  );
  process.exit(0);
}
for (const name of ["library", "reference", "output"]) assert(values[name], `Missing --${name}`);
const library = resolve(values.library);
const models = new Models(
  library,
  globalThis.fetch,
  undefined,
  new Catalog(join(library, "catalog.sqlite")),
);
try {
  const selected = models.alignment("nemo-ctc110");
  const runtime = await selected.runtime();
  const reference = resolve(values.reference),
    output = resolve(values.output);
  await mkdir(output, { mode: 0o700 });
  const profile = values.profile
    ? await readFile(resolve(values.profile), "utf8")
    : "(version 1)(allow default)(deny network*)";
  await writeFile(join(output, "sandbox.sb"), profile, { flag: "wx" });
  const worker = values.profile
    ? jsonWorker(
        {
          executable: "/usr/bin/sandbox-exec",
          args: ["-p", profile, runtime.python, "-I", "-B", runtime.entry],
          environment: {
            ...process.env,
            HF_HOME: runtime.cache,
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
            TOKENIZERS_PARALLELISM: "false",
            PYTHONDONTWRITEBYTECODE: "1",
            NUMBA_CACHE_DIR: runtime.cache,
          },
        },
        180000,
      )
    : preparedModelWorker(runtime, 180000);
  const load = async (path) => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return JSON.parse(gunzipSync(await readFile(path + ".gz")));
    }
  };
  const names =
    values.case === "all"
      ? [
          "constructed-repeats",
          "false-start",
          "fortunate-contextual",
          "fortunate-intact",
          "fortunate-truncated",
          "madison-tiny",
          "overlap25",
        ]
      : [values.case];
  for (const name of names) {
    assert(/^[a-z0-9-]+$/.test(name), "Case must identify one bounded frozen input");
    const raw = await load(join(reference, "nemo-ctc110", name + ".json"));
    const expected = await load(join(reference, "nemo-ctc110-alignment", name + ".json"));
    const directory = join(output, name);
    await mkdir(directory, { mode: 0o700 });
    const pcm = gunzipSync(await readFile(join(reference, "inputs", name + ".f32.gz")));
    assert.equal(createHash("sha256").update(pcm).digest("hex"), raw.pcmSha256);
    const pcmPath = join(directory, "input.f32"),
      report = join(directory, "output.json");
    await writeFile(pcmPath, pcm, { flag: "wx" });
    const request = {
      operation: "alignment.observe",
      params: {
        model: join(runtime.model, selected.checkpoint),
        modelSha256: selected.engine.modelSha256,
        pcm: pcmPath,
        pcmSha256: raw.pcmSha256,
        frames: raw.sourceFrames,
        sampleRate: 16000,
        text: expected.candidates[0].text,
        output: report,
      },
    };
    await writeFile(join(directory, "request.json"), JSON.stringify(request, null, 2) + "\n", {
      flag: "wx",
    });
    console.log(JSON.stringify({ name, state: "running" }));
    const started = performance.now();
    nativeResult(await worker(request.operation, request.params));
    const actual = await load(report),
      native = await load(report + ".native-unverified.json");
    assert.equal(
      native.bytesBase64,
      raw.nativeLogProbBytesBase64,
      "Complete native Float32 matrix: " + name,
    );
    assert.deepEqual(native.shape, raw.shape);
    for (const key of ["pcmSha256", "modelSha256", "modelConfig"])
      assert.deepEqual(actual[key], raw[key], name + ": " + key);
    const candidate = expected.candidates[0];
    for (const key of [
      "text",
      "ids",
      "status",
      "assignmentConfidence",
      "path",
      "frameLogScores",
      "nativePathMeanLogScore",
      "nativeNonblankMeanLogScore",
    ])
      assert.deepEqual(actual.candidate[key], candidate[key], name + ": " + key);
    assert.deepEqual(
      actual.candidate.spans,
      candidate.spans.map(
        ({ startSeconds: _startSeconds, endSeconds: _endSeconds, ...rest }) => rest,
      ),
    );
    const parity = {
      name,
      seconds: (performance.now() - started) / 1000,
      exactNativeMatrix: true,
      exactConditionalPath: true,
      runtimeDigest: runtime.runtimeDigest,
      matrixSha256: createHash("sha256")
        .update(Buffer.from(native.bytesBase64, "base64"))
        .digest("hex"),
    };
    assert.equal(
      (await selected.runtime()).runtimeDigest,
      runtime.runtimeDigest,
      "Inference must preserve prepared inventory",
    );
    await writeFile(join(directory, "parity.json"), JSON.stringify(parity, null, 2) + "\n", {
      flag: "wx",
    });
    console.log(JSON.stringify(parity));
  }
} finally {
  await models.settled();
}
