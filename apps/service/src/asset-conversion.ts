import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { hashFile } from "@yap/core/files";
import { O_NOFOLLOW_ANY } from "@yap/core/open-flags";
import {
  hdrConversionOriginSchema,
  hdrConversionEvidenceMatchesMetadata,
  type HdrConversionOrigin,
} from "@yap/core/asset-origins";
import { withHdrDerivative, type HdrDerivativeEvidence } from "./hdr-conversion.js";
import { inspectFFmpegTools, type FFmpegInstallation } from "./ffmpeg-tools.js";
import type { MediaWorker } from "./worker.js";
import type { JobExecution, StagedJobResult } from "@yap/core/jobs";
import { mediaProbeSchema } from "@yap/core/assets";
import type { AssetStore } from "@yap/core/assets";
import { CatalogError } from "@yap/core/catalog";
import type { JobQueue } from "@yap/core/jobs";

export type AssetConversionInput = {
  assetId: string;
  streamIds: string[];
  recipe: "hdr-to-sdr-hable-1000nit-v1";
};
export type AssetConversionRuntime = {
  implementationId: string;
  receiptSha256: string;
  nativeExecutableSha256: string;
  ffmpegSha256: string;
  ffprobeSha256: string;
  ffmpeg: string;
  ffprobe: string;
  ownerExecutable: string;
};

export async function assetConversionRuntime(
  installation: FFmpegInstallation | undefined,
  ownerExecutable: string | undefined,
  signal: AbortSignal,
): Promise<AssetConversionRuntime | undefined> {
  if (!ownerExecutable) return;
  const tools = await inspectFFmpegTools(installation, signal, ownerExecutable);
  if (!tools.available) return;
  const canonicalNative = await realpath(ownerExecutable);
  const file = await open(
    canonicalNative,
    constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) return;
    const native = await hashFile(file, stat.size, signal);
    return {
      implementationId: "hdr-to-sdr-hable-1000nit-v1",
      receiptSha256: tools.receiptSha256,
      nativeExecutableSha256: native.sha256,
      ffmpegSha256: tools.executables.ffmpeg.sha256,
      ffprobeSha256: tools.executables.ffprobe.sha256,
      ffmpeg: tools.executables.ffmpeg.path,
      ffprobe: tools.executables.ffprobe.path,
      ownerExecutable: canonicalNative,
    };
  } finally {
    await file.close();
  }
}

const implementationIdentity = (
  runtime: AssetConversionRuntime,
): HdrConversionOrigin["implementation"] => ({
  implementationId: runtime.implementationId,
  receiptSha256: runtime.receiptSha256,
  nativeExecutableSha256: runtime.nativeExecutableSha256,
  ffmpegSha256: runtime.ffmpegSha256,
  ffprobeSha256: runtime.ffprobeSha256,
});

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function conversionEvidence(
  video: HdrDerivativeEvidence["source"],
  audio?: HdrDerivativeEvidence["sourceAudio"],
): HdrConversionOrigin["output"] {
  const support = (stream: typeof video.video | NonNullable<typeof audio>["audio"]) => {
    const segment = stream.segments.find((item) => !item.empty)!;
    return {
      streamId: stream.id,
      startUs: stream.startUs,
      endUs: stream.endUs,
      mediaStartUs: segment.mediaStartUs!,
      mediaDurationUs: segment.mediaDurationUs!,
    };
  };
  return {
    originUs: video.metadata.originUs,
    factsSha256: digest({
      originUs: video.metadata.originUs,
      video: video.video,
      ...(audio ? { audio: audio.audio } : {}),
    }),
    video: {
      ...support(video.video),
      samples: video.video.samples.count,
      presentedTimingSha256: video.video.samples.presentedTimingSha256,
    },
    ...(audio
      ? {
          audio: {
            ...support(audio.audio),
            frames: audio.audio.decodedAudioInspection.frames,
            sampleRate: audio.audio.sampleRate,
            channels: audio.audio.channels,
            pcmSha256: audio.audio.decodedAudioInspection.pcmSha256,
          },
        }
      : {}),
  };
}

/** Conversion admission borrows the existing durable asset/job owners. */
export class AssetConversionJobs {
  constructor(
    private readonly owners: {
      assets: AssetStore;
      jobs: JobQueue;
      runtime: (signal: AbortSignal) => Promise<AssetConversionRuntime | undefined>;
      worker: MediaWorker;
      staging: string;
    },
  ) {}

  async request(input: AssetConversionInput, signal: AbortSignal = new AbortController().signal) {
    const asset = this.owners.assets.get(input.assetId);
    if (input.recipe !== "hdr-to-sdr-hable-1000nit-v1")
      throw new CatalogError("INVALID_PARAMS", "Unknown conversion recipe");
    const streamIds = [...input.streamIds].sort();
    const streams = streamIds.map((id) => asset.streams.find((item) => item.id === id));
    if (
      streams.some(
        (item) => !item?.decodable || (item.kind !== "video" && item.kind !== "audio"),
      ) ||
      streams.filter((item) => item?.kind === "video").length !== 1 ||
      streams.filter((item) => item?.kind === "audio").length > 1
    )
      throw new CatalogError(
        "UNSUPPORTED_MEDIA",
        "Conversion selects one video and at most one audio stream",
      );
    const base = { assetId: asset.id, streamIds, recipe: input.recipe };
    const replay = {
      target: { kind: "asset" as const, assetId: asset.id },
      artifact: "asset-conversion",
      replayKey: digest(base),
    };
    const saved = this.owners.jobs.statusByReplayKey(replay);
    if (saved) return saved;
    const runtime = await this.owners.runtime(signal);
    if (!runtime)
      throw new CatalogError(
        "PREREQUISITE_MISSING",
        "Bundled HDR conversion runtime is unavailable",
      );
    const identity = {
      target: { kind: "asset" as const, assetId: asset.id },
      artifact: "asset-conversion",
      input: JSON.stringify({
        ...base,
        replayKey: replay.replayKey,
        runtime: implementationIdentity(runtime),
      }),
    };
    const raced = this.owners.jobs.statusByReplayKey(replay);
    if (raced) return raced;
    this.owners.jobs.submit({ ...identity, lane: "heavy" }, (job) => {
      this.owners.jobs.retainInputs(job.jobId, "asset", [asset.id]);
    });
    return this.owners.jobs.status(identity);
  }

  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    const request = JSON.parse(job.input) as AssetConversionInput & {
      runtime: HdrConversionOrigin["implementation"];
    };
    const runtime = await this.owners.runtime(signal);
    if (
      job.artifact !== "asset-conversion" ||
      job.target.kind !== "asset" ||
      job.target.assetId !== request.assetId ||
      request.recipe !== "hdr-to-sdr-hable-1000nit-v1" ||
      !runtime ||
      !isDeepStrictEqual(implementationIdentity(runtime), request.runtime)
    )
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Frozen HDR conversion implementation is unavailable",
      );
    const asset = this.owners.assets.get(request.assetId);
    const video = asset.streams.find(
      (item) => request.streamIds.includes(item.id) && item.kind === "video",
    )!;
    const audio = asset.streams.find(
      (item) => request.streamIds.includes(item.id) && item.kind === "audio",
    );
    const file = await open(
      await realpath(this.owners.assets.path(asset.id)),
      constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
    );
    let origin: HdrConversionOrigin | undefined;
    let staged: Awaited<ReturnType<AssetStore["stage"]>> | undefined;
    try {
      await withHdrDerivative(
        this.owners.worker,
        {
          attemptParent: this.owners.staging,
          source: { file, bytes: asset.bytes, sha256: asset.id },
          streamId: video.id,
          ...(audio ? { audioStreamId: audio.id } : {}),
          ffmpeg: runtime.ffmpeg,
          ffprobe: runtime.ffprobe,
          ownerExecutable: runtime.ownerExecutable,
        },
        signal,
        async (artifact) => {
          origin = hdrConversionOriginSchema.parse({
            kind: "hdr-conversion",
            recipe: request.recipe,
            family: artifact.evidence.family,
            implementation: request.runtime,
            source: {
              assetId: asset.id,
              ...conversionEvidence(artifact.evidence.source, artifact.evidence.sourceAudio),
            },
            output: conversionEvidence(artifact.evidence.output, artifact.evidence.outputAudio),
            clock: artifact.evidence.clock,
          });
          if (!hdrConversionEvidenceMatchesMetadata(origin.source, asset))
            throw new CatalogError(
              "ARTIFACT_CHANGED",
              "Fresh conversion support differs from its retained original metadata",
            );
          staged = await this.owners.assets.stage(
            artifact.path,
            origin,
            async () => artifact.evidence.output.metadata,
            signal,
            {
              path: artifact.path,
              bytes: artifact.bytes,
              identity: artifact.identity,
              sha256: artifact.sha256,
            },
          );
          const metadata = mediaProbeSchema.parse(staged.asset);
          if (!isDeepStrictEqual(metadata, artifact.evidence.output.metadata))
            throw new CatalogError(
              "ARTIFACT_CHANGED",
              "Retained derivative metadata differs from fresh conversion facts",
            );
        },
      );
      const publication = staged!;
      return {
        result: JSON.stringify({
          assetId: publication.asset.id,
          streamIds: publication.asset.streams.map((item) => item.id),
          origin,
        }),
        publish: () => {
          publication.publish({ pinnedFile: false });
          this.owners.assets.retain({ kind: "asset", id: publication.asset.id }, [asset.id]);
          this.owners.assets.retain({ kind: "job", id: job.jobId }, [publication.asset.id]);
          return undefined;
        },
        close: () => publication.close(),
      };
    } catch (error) {
      await staged?.close();
      throw error;
    } finally {
      await file.close();
    }
  }
}
