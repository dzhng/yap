import { rational, toTime } from "@yap/composition";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CatalogError } from "./catalog.js";
import type { AssetProbe, AssetStore } from "./assets.js";
import {
  assetOriginSchema,
  generatedVoiceOriginSchema,
  type AssetProvenance,
} from "./asset-origins.js";
import { readAudioWaveFile } from "./audio-wave.js";
import type { JobExecution, JobQueue, StagedJobResult } from "./jobs.js";
import type { Models } from "./models.js";
import { resolveVoiceSettings, voiceProfile, voiceProfileSha256 } from "./voice-profile.js";
import {
  voiceReceiptSchema,
  type VoiceReceipt,
  type ResolvedVoiceSettings,
  type VoiceGeneration,
} from "./voice-types.js";

export type VoiceGenerationInput = {
  modelId: string;
  reference: { assetId: string; streamId: string; origin?: unknown };
  referenceText: string;
  text: string;
  preset?: string | undefined;
  generation?: { [K in keyof VoiceGeneration]?: VoiceGeneration[K] | undefined } | undefined;
  seed?: string | undefined;
};
type ModelIdentity = {
  modelId: string;
  descriptorDigest: string;
  modelDigest: string;
  runtimeDigest: string;
};
type FrozenVoiceRequest = {
  model: ModelIdentity;
  profileSha256: string;
  reference: {
    assetId: string;
    streamId: string;
    frames: number;
    bytes: number;
    origin: AssetProvenance | null;
  };
  referenceText: string;
  text: string;
  settings: ResolvedVoiceSettings;
};
export type VoiceGenerator = (
  modelId: string,
  request: {
    reference: string;
    referenceText: string;
    text: string;
    generation: VoiceGeneration;
    seed: string;
    output: string;
  },
  signal: AbortSignal,
) => Promise<VoiceReceipt>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Existing jobs own execution; published assets own reference bytes, never an installed model. */
export class VoiceGenerationJobs {
  constructor(
    private readonly owners: {
      assets: AssetStore;
      jobs: JobQueue;
      models: Pick<Models, "list" | "runtime">;
      generate: VoiceGenerator;
      probe: AssetProbe;
      staging: string;
    },
  ) {}
  async recover() {
    await rm(this.owners.staging, { recursive: true, force: true });
    await mkdir(this.owners.staging, { recursive: true, mode: 0o700 });
  }
  private model(modelId: string): ModelIdentity {
    const registered = this.owners.models.list().find((model) => model.modelId === modelId);
    if (!registered || registered.purpose !== "voice" || !registered.runtimeDigest)
      throw new CatalogError("NOT_FOUND", "Model is not a registered voice model", {
        modelId,
        kind: "model",
      });
    if (registered.generationProfile?.id !== voiceProfile.id)
      throw new CatalogError(
        "UNSUPPORTED_MODEL",
        "Voice model has no supported immutable execution profile",
        { modelId },
      );
    return {
      modelId,
      descriptorDigest: registered.descriptorDigest,
      modelDigest: registered.modelDigest,
      runtimeDigest: registered.runtimeDigest,
    };
  }
  private origin(assetId: string, value: unknown): AssetProvenance | null {
    if (value === undefined) return null;
    const parsed = assetOriginSchema.safeParse(value);
    if (!parsed.success)
      throw new CatalogError("INVALID_PARAMS", "Reference origin is not typed asset provenance");
    let cursor: string | undefined;
    do {
      const page = this.owners.assets.origins(assetId, cursor ? { cursor } : {});
      for (const origin of page.origins)
        if (isDeepStrictEqual(assetOriginSchema.parse(origin), parsed.data)) {
          const selected = parsed.data;
          // Fixed schema fields already have schema order; this record has caller-defined keys.
          if (selected.kind === "voice-generation")
            selected.receipt.tokenizerIdentity = Object.fromEntries(
              Object.entries(selected.receipt.tokenizerIdentity).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            );
          return selected;
        }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    throw new CatalogError(
      "INVALID_PARAMS",
      "Selected reference origin is not stored on this asset",
    );
  }
  async request(input: VoiceGenerationInput) {
    const model = this.model(input.modelId);
    if (input.preset !== undefined && input.preset !== voiceProfile.id)
      throw new CatalogError(
        "INVALID_PARAMS",
        "Preset must name the registered immutable profile",
        { profileId: voiceProfile.id },
      );
    if (!input.text.trim() || !input.referenceText.trim())
      throw new CatalogError(
        "INVALID_PARAMS",
        "Exact reference transcript and desired text are required",
      );
    const settings = resolveVoiceSettings(input.generation, input.seed);
    const asset = this.owners.assets.get(input.reference.assetId);
    const stream = asset.streams.find((item) => item.id === input.reference.streamId);
    if (
      asset.originUs !== 0 ||
      asset.streams.length !== 1 ||
      !stream ||
      stream.kind !== "audio" ||
      !stream.decodable ||
      stream.sampleRate !== voiceProfile.reference.sampleRate ||
      stream.channels !== voiceProfile.reference.channels ||
      asset.bytes > voiceProfile.reference.maximumEncodedBytes
    )
      throw new CatalogError(
        "INVALID_REFERENCE",
        "Use audio.extract to retain a complete canonical voice reference",
      );
    let pcm: ReturnType<typeof readAudioWaveFile>;
    try {
      pcm = readAudioWaveFile(this.owners.assets.path(asset.id), asset.bytes);
    } catch (error) {
      if (error instanceof CatalogError && error.code === "INVALID_RESPONSE")
        throw new CatalogError(
          "INVALID_REFERENCE",
          "Use audio.extract to retain a complete mono24k Float32 reference",
        );
      throw error;
    }
    if (
      pcm.sampleRate !== voiceProfile.reference.sampleRate ||
      pcm.channels !== voiceProfile.reference.channels ||
      pcm.frames < 1 ||
      pcm.frames > voiceProfile.reference.maximumFrames
    )
      throw new CatalogError(
        "INVALID_REFERENCE",
        "Reference PCM is outside the registered execution profile",
      );
    const request: FrozenVoiceRequest = {
      model,
      profileSha256: voiceProfileSha256,
      reference: {
        assetId: asset.id,
        streamId: stream.id,
        frames: pcm.frames,
        bytes: asset.bytes,
        origin: this.origin(asset.id, input.reference.origin),
      },
      referenceText: input.referenceText,
      text: input.text,
      settings,
    };
    const identity = {
      target: { kind: "asset" as const, assetId: asset.id },
      artifact: "voice-generation",
      input: JSON.stringify(request),
    };
    if (Buffer.byteLength(identity.input) > voiceProfile.maximumRequestBytes)
      throw new CatalogError(
        "FRAME_TOO_LARGE",
        "Canonical voice request exceeds the registered request limit",
      );
    const saved = this.owners.jobs.status(identity);
    if (saved.jobId || saved.published) return saved;
    // Offline identity and saved lookup must precede this execution-only prerequisite.
    await this.owners.models.runtime(model.modelId, "voice");
    this.owners.jobs.submit({ ...identity, lane: "heavy" }, (job) => {
      this.owners.jobs.retainInputs(job.jobId, "asset", [asset.id]);
    });
    return this.owners.jobs.status(identity);
  }
  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    if (job.artifact !== "voice-generation")
      throw new CatalogError("UNSUPPORTED_JOB", "Not a voice generation job");
    const request = JSON.parse(job.input) as FrozenVoiceRequest;
    if (
      job.target.kind !== "asset" ||
      job.target.assetId !== request.reference.assetId ||
      !isDeepStrictEqual(this.model(request.model.modelId), request.model) ||
      request.profileSha256 !== voiceProfileSha256
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Frozen voice execution identity is unavailable");
    const output = join(this.owners.staging, `${job.attemptId}.wav`);
    let staged: Awaited<ReturnType<AssetStore["stage"]>> | undefined;
    try {
      const receipt = voiceReceiptSchema.parse(
        await this.owners.generate(
          request.model.modelId,
          {
            reference: this.owners.assets.path(request.reference.assetId),
            referenceText: request.referenceText,
            text: request.text,
            generation: request.settings.requested,
            seed: request.settings.seed,
            output,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      const { file, ...provenance } = receipt;
      if (
        file !== output ||
        receipt.referenceSha256 !== request.reference.assetId ||
        receipt.referenceFrames !== request.reference.frames ||
        receipt.referenceText !== request.referenceText ||
        receipt.text !== request.text ||
        receipt.seed !== request.settings.seed ||
        receipt.profileId !== request.settings.profileId ||
        receipt.profileSha256 !== request.profileSha256 ||
        receipt.descriptorDigest !== request.model.descriptorDigest ||
        receipt.modelDigest !== request.model.modelDigest ||
        receipt.runtimeDigest !== request.model.runtimeDigest ||
        !isDeepStrictEqual(receipt.generation, request.settings.requested) ||
        !isDeepStrictEqual(receipt.effectiveGeneration, request.settings.effective) ||
        !isDeepStrictEqual(receipt.filterModes, request.settings.filterModes) ||
        receipt.stopReason !== "eos"
      )
        throw new CatalogError("INVALID_RESPONSE", "Voice result differs from its frozen request");
      const actual = readAudioWaveFile(output);
      if (
        actual.frames !== receipt.frames ||
        actual.sampleRate !== receipt.sampleRate ||
        actual.channels !== receipt.channels ||
        receipt.durationUs !== Math.round((actual.frames * 1000000) / actual.sampleRate)
      )
        throw new CatalogError("INVALID_RESPONSE", "Generated WAV differs from its receipt");
      const origin = generatedVoiceOriginSchema.parse({
        kind: "voice-generation" as const,
        requestSha256: digest(job.input),
        modelId: request.model.modelId,
        reference: {
          assetId: request.reference.assetId,
          streamId: request.reference.streamId,
          originSha256:
            request.reference.origin === null
              ? null
              : digest(JSON.stringify(request.reference.origin)),
        },
        receipt: provenance,
      });
      staged = await this.owners.assets.stage(output, origin, this.owners.probe, signal);
      if (staged.asset.id !== receipt.sha256)
        throw new CatalogError(
          "INVALID_RESPONSE",
          "Published generation hash differs from receipt",
        );
      const stream = staged.asset.streams[0];
      if (
        staged.asset.streams.length !== 1 ||
        !stream ||
        stream.kind !== "audio" ||
        !stream.decodable ||
        stream.sampleRate !== receipt.sampleRate ||
        stream.channels !== receipt.channels
      )
        throw new CatalogError(
          "INVALID_RESPONSE",
          "Generated asset probe differs from its PCM profile",
        );
      const result = {
        assetId: staged.asset.id,
        streamId: stream.id,
        frames: receipt.frames,
        sampleRate: receipt.sampleRate,
        channels: receipt.channels,
        durationUs: toTime(rational(BigInt(actual.frames) * 1000000n, BigInt(actual.sampleRate))),
        origin,
      };
      const publication = staged;
      return {
        result: JSON.stringify(result),
        publish: () => {
          publication.publish({ pinnedFile: false });
          if (result.assetId !== request.reference.assetId)
            this.owners.assets.retain({ kind: "asset", id: result.assetId }, [
              request.reference.assetId,
            ]);
          this.owners.assets.retain({ kind: "job", id: job.jobId }, [result.assetId]);
          return undefined;
        },
        close: async () => {
          try {
            await publication.close();
          } finally {
            await rm(output, { force: true });
          }
        },
      };
    } catch (error) {
      try {
        await staged?.close();
      } finally {
        await rm(output, { force: true });
      }
      throw error;
    }
  }
}
