import { isDeepStrictEqual } from "node:util";
import {
  resolveVoiceSettings,
  voiceReceiptSchema,
  type VoiceReceipt,
  voiceProfile,
  voiceProfileSha256,
  type VoiceGeneration,
} from "@yap/core/voice-profile";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CatalogError } from "@yap/core/catalog";
import { copyImportedFile, hashFile } from "@yap/core/files";
import { withRenderedFile } from "./render.js";
import { preparedModelWorker, nativeResult, type MediaWorker } from "./worker.js";
import type { Models } from "@yap/core/models";

// Worker responses may add fields; durable receipts retain only this registered semantic shape.
const workerReceiptSchema = voiceReceiptSchema.strip().extend({
  generation: voiceReceiptSchema.shape.generation.strip(),
  effectiveGeneration: voiceReceiptSchema.shape.effectiveGeneration.strip(),
  filterModes: voiceReceiptSchema.shape.filterModes.strip(),
  prefill: voiceReceiptSchema.shape.prefill.strip(),
});

export type VoiceRequest = Readonly<{
  reference: string;
  referenceText: string;
  text: string;
  generation?: Partial<VoiceGeneration>;
  seed?: string;
  output: string;
}>;

/** Registered generation executor; durable jobs and asset admission remain separate owners. */
export function voiceRenderer(
  native: MediaWorker,
  models: Models,
  modelId: string,
  workspace: string,
) {
  return async (
    request: VoiceRequest,
    signal: AbortSignal,
    timeoutMs = 600_000,
  ): Promise<VoiceReceipt> => {
    if (![workspace, request.reference, request.output].every(isAbsolute))
      throw new CatalogError(
        "INVALID_REQUEST",
        "Voice preparation and media paths must be absolute",
      );
    signal.throwIfAborted();
    if (modelId !== voiceProfile.id)
      throw new CatalogError("NOT_FOUND", "Voice execution profile is not registered", {
        kind: "model",
        modelId,
      });
    const settings = resolveVoiceSettings(request.generation, request.seed);
    const destination = await lstat(request.output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (destination) throw new CatalogError("INVALID_REQUEST", "Voice destination already exists");
    const preparation = await models.runtime(modelId, "voice");
    signal.throwIfAborted();
    const voice = preparedModelWorker(preparation, timeoutMs);
    // Workspace cleanup stays native; both bindings share the exact process lifetime owner.
    const worker: MediaWorker = (operation, params, options) =>
      (operation === "voice.generate" ? voice : native)(operation, params, options);
    return (await withRenderedFile(
      worker,
      { attemptParent: workspace, output: request.output, filename: "audio.wav" },
      signal,
      async (output, execute) => {
        const reference = join(dirname(output), "reference.wav");
        const retained = await copyImportedFile(
          request.reference,
          reference,
          signal,
          undefined,
          voiceProfile.reference.maximumEncodedBytes,
        );
        const raw = nativeResult(
          await execute(
            "voice.generate",
            {
              model: preparation.model,
              reference,
              referenceText: request.referenceText,
              text: request.text,
              generation: settings.requested,
              seed: settings.seed,
              output,
            },
            { signal, timeoutMs },
          ),
        ) as Record<string, unknown>;
        const parsed = workerReceiptSchema.safeParse({
          ...raw,
          descriptorDigest: preparation.descriptorDigest,
          runtimeDigest: preparation.runtimeDigest,
          modelDigest: preparation.modelDigest,
        });
        if (!parsed.success)
          throw new CatalogError("INVALID_RESPONSE", "Voice receipt has an invalid shape", {
            issues: parsed.error.issues,
          });
        const receipt = parsed.data;
        if (
          receipt.file !== output ||
          receipt.referenceSha256 !== retained.sha256 ||
          receipt.profileId !== settings.profileId ||
          receipt.profileSha256 !== voiceProfileSha256 ||
          receipt.seed !== settings.seed ||
          receipt.text !== request.text ||
          receipt.referenceText !== request.referenceText ||
          !isDeepStrictEqual(receipt.generation, settings.requested) ||
          !isDeepStrictEqual(receipt.effectiveGeneration, settings.effective) ||
          !isDeepStrictEqual(receipt.filterModes, settings.filterModes) ||
          receipt.sampleRate !== voiceProfile.reference.sampleRate ||
          receipt.channels !== voiceProfile.reference.channels ||
          receipt.referenceFrames > voiceProfile.reference.maximumFrames ||
          receipt.prefill.referenceTextTokens > voiceProfile.maximumPrefillPositions ||
          receipt.prefill.targetTextTokens > voiceProfile.maximumTargetTokens ||
          receipt.prefill.referenceCodes > voiceProfile.reference.maximumCodecPositions ||
          receipt.prefill.inputTokens > voiceProfile.maximumPrefillPositions ||
          Object.keys(receipt.tokenizerIdentity).length !== voiceProfile.tokenizerFiles.length ||
          !voiceProfile.tokenizerFiles.every((file) => file in receipt.tokenizerIdentity) ||
          receipt.generatedTokens >= settings.requested.max_tokens ||
          receipt.runtimeRevision !== preparation.runtimeRevision ||
          receipt.modelRevision !== preparation.modelRevision
        )
          throw new CatalogError(
            "INVALID_RESPONSE",
            "Voice receipt differs from the prepared request",
          );
        const file = await open(output, "r");
        try {
          const size = (await file.stat()).size;
          const actual = await hashFile(file, size, signal);
          if (actual.sha256 !== receipt.sha256)
            throw new CatalogError("INVALID_RESPONSE", "Voice output differs from its receipt");
        } finally {
          await file.close();
        }
        return receipt;
      },
    )) as VoiceReceipt;
  };
}
