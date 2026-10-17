import { rational, toTime, type TimeValue } from "@yap/composition";
import { z } from "zod";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CatalogError } from "./catalog.js";
import type { AssetStore, AssetProbe } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import type { ProjectStore } from "./projects.js";
import {
  audioDimensionsSchema,
  audioRenditionSchema,
  extractionOriginSchema,
  type ExtractionOrigin,
} from "./asset-origins.js";
import { MediaAudioInspection, type MediaAudioInput } from "./audio-inspection.js";
import { readAudioWaveFile } from "./audio-wave.js";
import { selectSource } from "./source-selection.js";
import type { JobExecution, JobQueue, StagedJobResult } from "./jobs.js";
import { resourceKinds } from "./references.js";

type Rendition = z.infer<typeof audioRenditionSchema>;
export type AudioExtractionInput = MediaAudioInput & { rendition: Rendition };
export type SelectedAudioConverter = {
  implementationId: string;
  convert(
    request: {
      source: string;
      output: string;
      input: z.infer<typeof audioDimensionsSchema>;
    } & Rendition,
    signal: AbortSignal,
  ): Promise<unknown>;
};
const conversionSchema = extractionOriginSchema.shape.conversion;
const conversionReceipt = conversionSchema
  .extend({
    file: z.string(),
    mediaType: z.literal("audio/wav"),
    bytes: z.int().positive(),
    input: audioDimensionsSchema.strip(),
    output: audioDimensionsSchema.strip(),
  })
  .strip();
type Recipe = ReturnType<MediaAudioInspection["recipe"]>;
type Request = {
  selection: MediaAudioInput;
  wholeSource: boolean;
  rendition: Rendition;
  recipe: Recipe["identity"];
  processingSha256: string | null;
  conversionImplementationId: string;
};
export type ExtractedAudio = {
  assetId: string;
  streamId: string;
  sampleRate: number;
  channels: 1 | 2;
  frames: number;
  durationUs: TimeValue;
  origin: ExtractionOrigin;
};

/** Durable excerpts share audio selection/rendering and immutable assets, but do not own donors. */
export class AudioExtraction {
  constructor(
    private readonly owners: {
      assets: AssetStore;
      acquisitions: AcquisitionStore;
      projects: ProjectStore;
      audio: MediaAudioInspection;
      jobs: JobQueue;
      converter: SelectedAudioConverter;
      probe: AssetProbe;
      staging: string;
    },
  ) {}
  async recover() {
    await rm(this.owners.staging, { recursive: true, force: true });
    await mkdir(this.owners.staging, { recursive: true, mode: 0o700 });
  }
  request(input: AudioExtractionInput) {
    const { rendition, ...selection } = input;
    if ("projectId" in selection && (!selection.revisionId || !selection.range || !selection.tap))
      throw new CatalogError(
        "INVALID_PARAMS",
        "Extraction requires a pinned project revision, range and tap",
      );
    const recipe = this.owners.audio.recipe(selection);
    const request: Request = {
      selection:
        "projectId" in recipe.selection
          ? {
              ...recipe.selection,
              preparedResourceId:
                "preparedResourceId" in recipe.options ? recipe.options.preparedResourceId : null,
            }
          : recipe.selection,
      wholeSource: !("projectId" in selection) && selection.range === undefined,
      rendition: audioRenditionSchema.parse(rendition),
      recipe: recipe.identity,
      processingSha256: "processingSha256" in recipe ? recipe.processingSha256 : null,
      conversionImplementationId: this.owners.converter.implementationId,
    };
    const identity = {
      target: recipe.identity.target,
      artifact: "audio-extract",
      input: JSON.stringify(request),
    };
    if (!this.owners.jobs.status(identity).published) {
      this.owners.jobs.submit({ ...identity, lane: "heavy" }, (job) => {
        const dependencies =
          "projectId" in request.selection
            ? this.owners.projects.revisionDependencies(
                request.selection.projectId,
                request.selection.revisionId!,
              )
            : [
                { kind: "asset" as const, id: request.selection.assetId },
                ...(request.selection.acquisitionId
                  ? [{ kind: "acquisition" as const, id: request.selection.acquisitionId }]
                  : []),
              ];
        for (const kind of resourceKinds)
          this.owners.jobs.retainInputs(
            job.jobId,
            kind,
            dependencies.filter((d) => d.kind === kind).map((d) => d.id),
          );
      });
    }
    return this.owners.jobs.status(identity);
  }
  private completeSource(request: Request) {
    if (!request.wholeSource || "projectId" in request.selection) return null;
    const source = selectSource(this.owners.assets, this.owners.acquisitions, {
      assetId: request.selection.assetId,
      streamId: request.selection.streamId,
      ...(request.selection.acquisitionId
        ? { acquisitionId: request.selection.acquisitionId }
        : {}),
    });
    const asset = this.owners.assets.get(request.selection.assetId);
    if (
      asset.originUs !== 0 ||
      asset.streams.length !== 1 ||
      source.stream.bounds.startUs !== 0 ||
      !isDeepStrictEqual(source.track.available, [source.stream.bounds])
    )
      return null;
    let dimensions: ReturnType<typeof readAudioWaveFile>;
    try {
      dimensions = readAudioWaveFile(this.owners.assets.path(asset.id), asset.bytes);
    } catch (error) {
      if (error instanceof CatalogError && error.code === "INVALID_RESPONSE") return null;
      throw error;
    }
    if (dimensions.frames === 0) return null;
    return { dimensions, source, path: this.owners.assets.path(asset.id) };
  }
  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    if (job.artifact !== "audio-extract")
      throw new CatalogError("UNSUPPORTED_JOB", "Not an audio extraction job");
    const request = JSON.parse(job.input) as Request;
    if (!isDeepStrictEqual(job.target, request.recipe.target))
      throw new CatalogError("ARTIFACT_CHANGED", "Extraction target differs from its recipe");
    if (request.conversionImplementationId !== this.owners.converter.implementationId)
      throw new CatalogError("NOT_READY", "Pinned PCM converter is unavailable", {});
    const current = this.owners.audio.recipe(request.selection);
    if (
      !isDeepStrictEqual(current.identity, request.recipe) ||
      ("processingSha256" in current ? current.processingSha256 : null) !== request.processingSha256
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Pinned audio selection changed");
    const selectedPath = join(this.owners.staging, `${job.attemptId}-selected.wav`);
    const outputPath = join(this.owners.staging, `${job.attemptId}.wav`);
    let staged: Awaited<ReturnType<AssetStore["stage"]>> | undefined;
    try {
      signal.throwIfAborted();
      const complete = this.completeSource(request);
      const canonical =
        complete &&
        complete.dimensions.sampleRate === request.rendition.sampleRate &&
        complete.dimensions.channels === request.rendition.channels
          ? complete
          : null;
      let origin: ExtractionOrigin;
      let resultPath: string;
      if (canonical) {
        const { sampleRate, channels, frames } = canonical.dimensions;
        const dimensions = { sampleRate, channels, frames };
        origin = {
          kind: "extraction",
          selection: {
            kind: "source",
            ...canonical.source.selection,
            range: canonical.source.stream.bounds,
            sampleRange: { start: 0, end: frames },
            supportDigest: canonical.source.supportDigest,
            unavailable: [],
          },
          selectionImplementationId: "verified-whole-source-v1",
          input: dimensions,
          output: dimensions,
          conversion: {
            implementationId: "verified-wav-copy-v1",
            channelPolicy: "preserve",
            contextPolicy: "complete-source",
          },
        };
        resultPath = canonical.path;
      } else {
        const selected = complete
          ? {
              ...complete.dimensions,
              ...complete.source.selection,
              file: complete.path,
              range: complete.source.stream.bounds,
              sampleRange: { start: 0, end: complete.dimensions.frames },
              supportDigest: complete.source.supportDigest,
              unavailable: [],
              implementationId: "verified-whole-source-v1",
            }
          : (await this.owners.audio.renderSelection(request.recipe, selectedPath, signal)).value;
        const input = {
          sampleRate: selected.sampleRate,
          channels: selected.channels,
          frames: selected.frames,
        };
        const reply = conversionReceipt.parse(
          await this.owners.converter.convert(
            { source: selected.file, output: outputPath, input, ...request.rendition },
            signal,
          ),
        );
        const frames = Number(
          (BigInt(input.frames) * BigInt(request.rendition.sampleRate)) / BigInt(input.sampleRate),
        );
        const expected = { ...request.rendition, frames };
        if (
          reply.file !== outputPath ||
          reply.implementationId !== request.conversionImplementationId ||
          reply.contextPolicy !== "complete-selected-pcm-zero-origin" ||
          !isDeepStrictEqual(reply.input, input) ||
          !isDeepStrictEqual(reply.output, expected) ||
          reply.channelPolicy !==
            (input.channels === expected.channels
              ? "preserve"
              : expected.channels === 1
                ? "equal-weight-double-rounded-float32"
                : "duplicate")
        )
          throw new CatalogError(
            "INVALID_RESPONSE",
            "Converted PCM receipt differs from selected input or requested rendition",
          );
        const actual = readAudioWaveFile(outputPath, reply.bytes);
        if (
          actual.sampleRate !== expected.sampleRate ||
          actual.channels !== expected.channels ||
          actual.frames !== frames
        )
          throw new CatalogError("INVALID_RESPONSE", "Converted WAV differs from its receipt");
        origin = {
          kind: "extraction",
          selection:
            "projectId" in selected
              ? {
                  kind: "project",
                  projectId: selected.projectId,
                  revisionId: selected.revisionId,
                  range: selected.range,
                  tap: selected.tap,
                  sampleRange: selected.sampleRange,
                  processingSha256: request.processingSha256!,
                  unavailable: selected.unavailable,
                }
              : {
                  kind: "source",
                  assetId: selected.assetId,
                  streamId: selected.streamId,
                  ...(selected.acquisitionId ? { acquisitionId: selected.acquisitionId } : {}),
                  range: selected.range,
                  sampleRange: selected.sampleRange,
                  supportDigest: selected.supportDigest,
                  unavailable: selected.unavailable,
                },
          selectionImplementationId: selected.implementationId,
          input,
          output: expected,
          conversion: {
            implementationId: reply.implementationId,
            channelPolicy: reply.channelPolicy,
            contextPolicy: reply.contextPolicy,
          },
        };
        resultPath = outputPath;
      }
      origin = extractionOriginSchema.parse(origin);
      staged = await this.owners.assets.stage(resultPath, origin, this.owners.probe, signal);
      if (canonical && staged.asset.id !== canonical.source.selection.assetId)
        throw new CatalogError("ARTIFACT_CHANGED", "Canonical donor bytes changed");
      const stream = staged.asset.streams[0];
      if (
        staged.asset.streams.length !== 1 ||
        !stream ||
        stream.kind !== "audio" ||
        !stream.decodable ||
        stream.sampleRate !== origin.output.sampleRate ||
        stream.channels !== origin.output.channels
      )
        throw new CatalogError(
          "INVALID_RESPONSE",
          "Extracted asset probe differs from its PCM profile",
        );
      const result: ExtractedAudio = {
        assetId: staged.asset.id,
        streamId: stream.id,
        ...origin.output,
        durationUs: toTime(
          rational(BigInt(origin.output.frames) * 1000000n, BigInt(origin.output.sampleRate)),
        ),
        origin,
      };
      const publication = staged;
      return {
        result: JSON.stringify(result),
        publish: () => {
          publication.publish({ pinnedFile: false });
          this.owners.assets.retain({ kind: "job", id: job.jobId }, [result.assetId]);
          return undefined;
        },
        close: async () => {
          try {
            await publication.close();
          } finally {
            await rm(selectedPath, { force: true });
            await rm(outputPath, { force: true });
          }
        },
      };
    } catch (error) {
      try {
        await staged?.close();
      } finally {
        await rm(selectedPath, { force: true });
        await rm(outputPath, { force: true });
      }
      throw error;
    }
  }
}
