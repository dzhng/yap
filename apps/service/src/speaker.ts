import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { CatalogError } from "@yap/core/catalog";
import type { SpeakerObserver } from "@yap/core/speaker-processing";
import { sourceChannelPCM } from "./source-channel.js";
import { withRenderAttempt } from "./render.js";
import { preparedModelWorker, type MediaWorker } from "./worker.js";

async function operand(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new CatalogError("INVALID_EVIDENCE", "Speaker operand exceeds bounded regular storage");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
/** Capture original sidecar files while the render-attempt owner still retains their workspace. */
export function speakerObserver(native: MediaWorker, workspace: string): SpeakerObserver {
  return async (request, signal) => {
    const model = preparedModelWorker(request.runtime, 600000);
    const worker: MediaWorker = (operation, params, options) =>
      (operation === "speaker.observe" ? model : native)(operation, params, options);
    return withRenderAttempt(
      worker,
      workspace,
      signal,
      async (directory, execute) => {
        const pcmPath = join(directory, "speaker.f32");
        const output = join(directory, "speaker-report.json");
        const { selected, decoder } = request;
        const receipt = await sourceChannelPCM(execute, selected, decoder, pcmPath, signal);
        const result = await execute(
          "speaker.observe",
          {
            model: request.checkpoint,
            pcm: pcmPath,
            pcmSha256: receipt.sha256,
            frameCount: receipt.frames,
            sampleRate: receipt.sampleRate,
            output,
          },
          { signal, timeoutMs: 600000 },
        );
        const operands = {
          nativeReceipt: await operand(output + ".native-unverified.json"),
          report: await operand(output),
        };
        return {
          pcm: {
            sha256: receipt.sha256,
            sampleRate: receipt.sampleRate,
            frameCount: receipt.frames,
          },
          operands,
          ...(result.ok
            ? {}
            : {
                failure: new CatalogError(
                  result.error.code,
                  result.error.message,
                  result.error.details,
                ),
              }),
        };
      },
      async (observed) => observed,
    );
  };
}
