import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startProjectService } from "../../../apps/service/dist/project-service.js";
import { mediaWorker } from "../../../apps/service/dist/worker.js";

// Barriers hold real native replies. Declared test probe overrides never change decoding results.
const probeOverrides = process.env.YAP_TEST_PROBE_OVERRIDES
  ? JSON.parse(await readFile(process.env.YAP_TEST_PROBE_OVERRIDES, "utf8"))
  : [];
const unavailableOperations = new Set(
  JSON.parse(process.env.YAP_TEST_UNAVAILABLE_OPERATIONS ?? "[]"),
);
const native = mediaWorker();
let armed;
let speechOrdinal = 0;
let audioOrdinal = 0;
let visualOrdinal = 0;
let pictureOrdinal = 0;
process.on("message", (message) => {
  if (message?.type === "barrier.arm") {
    if (armed) throw new Error("A native barrier is already armed");
    armed = message;
    process.send({ type: "barrier.armed", id: message.id });
  }
});
const worker = async (operation, params, options) => {
  if (unavailableOperations.has(operation))
    return {
      ok: false,
      error: {
        code: "NOT_READY",
        message: "Deliberately unavailable fixture operation",
        retryable: true,
        details: {},
      },
    };
  const result = await native(operation, params, options);
  if (operation === "media.probe" && result.ok && probeOverrides.length) {
    const digest = createHash("sha256")
      .update(await readFile(params.path))
      .digest("hex");
    const override = probeOverrides.find((value) => value.sha256 === digest);
    if (override) {
      const stream = result.data.streams.find((value) => value.id === override.streamId);
      assert.equal(stream?.kind, "video");
      Object.assign(stream, {
        startUs: override.startUs,
        endUs: override.endUs,
        segments: override.segments,
      });
      process.send({ type: "fixture.probe", id: digest, override });
    }
  }
  if (process.argv[3] && operation === "media.sourceVisualSamples" && result.ok) {
    const directory = process.argv[3];
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `visual-${process.pid}-${visualOrdinal++}.json`),
      JSON.stringify(
        {
          request: params,
          response: {
            ...result.data,
            samples: result.data.samples.map(({ rgbBase64: _rgbBase64, ...sample }) => sample),
          },
        },
        null,
        2,
      ),
    );
  }
  if (process.argv[3] && operation === "media.sourceAudio") {
    const directory = process.argv[3];
    await mkdir(directory, { recursive: true });
    const prefix = join(directory, `audio-${audioOrdinal++}`);
    await writeFile(`${prefix}-request.json`, JSON.stringify(params, null, 2));
    await writeFile(`${prefix}-response.json`, JSON.stringify(result, null, 2));
  }
  if (process.argv[3] && operation === "media.convertSelectedAudio") {
    const directory = process.argv[3];
    await mkdir(directory, { recursive: true });
    const prefix = join(directory, `conversion-${process.pid}-${audioOrdinal++}`);
    await writeFile(
      `${prefix}.json`,
      JSON.stringify({ request: params, response: result }, null, 2),
    );
    await copyFile(params.source, `${prefix}-selected.wav`);
    if (result.ok) await copyFile(result.data.file, `${prefix}-output.wav`);
  }
  if (process.argv[3] && operation === "speech.transcribe" && result.ok) {
    const directory = process.argv[3];
    await mkdir(directory, { recursive: true });
    const prefix = join(directory, `speech-${speechOrdinal++}`);
    await writeFile(`${prefix}-request.json`, JSON.stringify(params, null, 2));
    await writeFile(`${prefix}-response.json`, JSON.stringify(result, null, 2));
    await copyFile(params.output, `${prefix}.jsonl`);
  }
  if (
    process.argv[3] &&
    [
      "media.presentationEvidence",
      "media.renderCompositionFrame",
      "media.renderCompositionMovie",
    ].includes(operation)
  ) {
    const directory = process.argv[3];
    await mkdir(directory, { recursive: true });
    const prefix = join(directory, `picture-${process.pid}-${pictureOrdinal++}`);
    await writeFile(
      `${prefix}.json`,
      JSON.stringify({ operation, request: params, response: result }, null, 2),
    );
    if (params.pointers) await copyFile(params.pointers.file, `${prefix}-pointers.jsonl`);
    if (params.frames) await copyFile(params.frames, `${prefix}-frames.jsonl`);
    if (result.ok && result.data.file) await copyFile(result.data.file, `${prefix}-output`);
  }
  if (process.argv[3] && operation === "media.mixCompositionAudio") {
    await mkdir(process.argv[3], { recursive: true });
    const request = params.planFile ? JSON.parse(await readFile(params.planFile, "utf8")) : params;
    await writeFile(
      join(process.argv[3], `mix-${audioOrdinal++}.json`),
      JSON.stringify({ request, response: result }),
    );
  }
  if (armed?.operation === operation && --armed.remaining === 0) {
    const fault = armed;
    armed = undefined;
    if (!result.ok) throw new Error(JSON.stringify(result));
    await new Promise((resolve) => {
      const done = () => {
        options.signal?.removeEventListener("abort", done);
        resolve();
      };
      options.signal?.addEventListener("abort", done, { once: true });
      process.send({ type: "barrier.hit", id: fault.id, operation, nativeSucceeded: true });
      if (options.signal?.aborted) done();
    });
  }
  return result;
};
try {
  const service = await startProjectService({
    home: process.argv[2],
    worker,
    ...(process.env.YAP_TEST_FFMPEG_INSTALLATION
      ? {
          ffmpeg: JSON.parse(process.env.YAP_TEST_FFMPEG_INSTALLATION),
        }
      : {}),
  });
  let closing;
  const close = () => (closing ??= service.close().then(() => process.disconnect()));
  process.on("message", (message) => {
    if (message === "close") void close();
  });
  process.on("disconnect", () => {
    void close();
  });
  process.send({ socketPath: service.socketPath });
} catch (error) {
  process.send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  process.disconnect();
  process.exitCode = 1;
}
