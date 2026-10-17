import { outputPresets } from "../../../packages/composition/dist/index.js";
import { startProjectService } from "../../../apps/service/dist/project-service.js";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mediaWorker } from "../../../apps/service/dist/worker.js";

// One-shot fixture barriers control commit entry and reply timing. All bytes and publication
// receipts come from the production native worker; ordinary requests pass through.
if (process.env.YAP_TEST_AUDIO_DEFAULT_BITRATE)
  outputPresets.balanced.audio.rateControl = {
    mode: "constant",
    bitrate: Number(process.env.YAP_TEST_AUDIO_DEFAULT_BITRATE),
  };
const native = mediaWorker();
let armed,
  holding = false;
process.on("message", (message) => {
  if (message?.type === "fault.arm") {
    if (armed || holding) throw new Error("A publication fault is already armed");
    armed = message;
    process.send({ type: "fault.armed", id: message.id });
  }
});
async function hold(fault, signal, result) {
  await new Promise((resolve) => {
    const done = () => {
      signal?.removeEventListener("abort", done);
      holding = false;
      resolve();
    };
    holding = true;
    signal?.addEventListener("abort", done, { once: true });
    process.send({ type: "fault.hit", id: fault.id, point: fault.point, result });
    if (signal?.aborted) done();
  });
}
const worker = async (operation, params, options) => {
  if (process.argv[3]) {
    await mkdir(process.argv[3], { recursive: true });
    await appendFile(
      join(process.argv[3], "operations.jsonl"),
      JSON.stringify({ operation, params }) + "\n",
    );
  }
  if (JSON.parse(process.env.YAP_TEST_UNAVAILABLE_OPERATIONS ?? "[]").includes(operation))
    return {
      ok: false,
      error: {
        code: "NOT_READY",
        message: "Unavailable fixture operation",
        retryable: false,
        details: {},
      },
    };
  const fault =
    (operation === "publication.commit" && armed?.point !== "after-encode") ||
    (operation === "media.encodeAudioFile" && armed?.point === "after-encode")
      ? armed
      : undefined;
  if (!fault) return native(operation, params, options);
  armed = undefined;
  if (fault.point === "before-commit") await hold(fault, options?.signal);
  const result = await native(operation, params, options);
  if (fault.point === "after-commit" || fault.point === "after-encode") {
    if (!result.ok || (fault.point === "after-commit" && result.data?.state !== "ready"))
      throw new Error(`Expected real committed publication: ${JSON.stringify(result)}`);
    await hold(fault, options?.signal, result);
  }
  return result;
};
try {
  const service = await startProjectService({ home: process.argv[2], worker });
  let closing;
  const close = () =>
    (closing ??= (async () => {
      await service.close();
      if (process.connected) process.disconnect();
    })());
  const shutdown = () => {
    void close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.send({ socketPath: service.socketPath });
  process.on("message", (message) => {
    if (message === "close") shutdown();
  });
  process.on("disconnect", shutdown);
} catch (error) {
  process.send({ error: { code: error.code, message: error.message, retryable: error.retryable } });
  process.disconnect();
  process.exitCode = 1;
}
