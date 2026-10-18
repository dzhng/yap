import {
  admitReadRange,
  fromTime,
  compare,
  type SelectionRange,
  omit,
  type Issue,
} from "@yap/composition";
import { z } from "zod";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import { selectSource, sourceSelectionSchema, type SourceSelection } from "./source-selection.js";
import { CatalogError, dependencyRefusal } from "./catalog.js";
import {
  retainedPublicationSchema,
  type JobExecution,
  type JobQueue,
  type StagedJobResult,
} from "./jobs.js";
import type { Models } from "./models.js";
import {
  transcriptPolicy,
  speechExecution,
  historicalSpeechExecutionSchema,
  currentTranscript,
  portableTranscript,
  publicTranscriptMetadata,
  parsePublicTranscriptMetadata,
  publicTranscriptIssues,
  type PortableTranscript,
  type SpeechTranscriber,
  type TranscriptStore,
  type TranscriptIdentity,
  type TranscriptSource,
  type TranscriptMetadata,
  type SpeechExecution,
  type TranscriptExecutionSelection,
  type IndexedTranscript,
} from "./transcript.js";

const artifact = "transcript";
// Native PCM decoding is an execution input, separate from portable transcript schema policy.
const decoderExecution = "native-audio-v6";
export type TranscriptPreparation = SourceSelection & TranscriptExecutionSelection;

export type PortableTranscriptPublication = z.infer<typeof retainedPublicationSchema>;
/** The model owner as transcription sees it: readiness, the verified file list and its pins. */
export type TranscriptionModels = Omit<ReturnType<Models["transcription"]>, "notPrepared"> & {
  /** Optional for lightweight embedded owners and test doubles. */
  notPrepared?: () => CatalogError;
};

type AssetDomain = { assets: AssetStore; acquisitions: AcquisitionStore };
export type TranscriptProcessingOptions = {
  jobs: JobQueue;
  transcripts: TranscriptStore;
  models: TranscriptionModels;
  transcribe: SpeechTranscriber;
  asset: AssetDomain;
};
function selectedAudio(domain: AssetDomain, selection: SourceSelection) {
  const selected = selectSource(domain.assets, domain.acquisitions, {
    assetId: selection.assetId,
    streamId: selection.streamId,
    ...(selection.acquisitionId === undefined ? {} : { acquisitionId: selection.acquisitionId }),
  });
  if (selected.stream.kind !== "audio")
    throw new CatalogError("UNSUPPORTED_MEDIA", "Transcription requires an audio stream");
  return selected;
}
function sourceDescriptor(selected: ReturnType<typeof selectedAudio>): TranscriptSource {
  return {
    kind: "asset",
    streamId: selected.selection.streamId,
    ...(selected.selection.acquisitionId === undefined
      ? {}
      : { acquisitionId: selected.selection.acquisitionId }),
    supportDigest: selected.supportDigest,
    durationUs: selected.durationUs,
  };
}
export function assetTranscriptOwner(assets: AssetStore, acquisitions: AcquisitionStore) {
  return (identity: TranscriptIdentity, source: TranscriptSource): void => {
    if (
      identity.owner.kind !== "asset" ||
      source.kind !== "asset" ||
      identity.sourceId !== identity.owner.assetId
    )
      throw new CatalogError("INVALID_EVIDENCE", "Asset transcript requires an asset source");
    const selected = selectedAudio(
      { assets, acquisitions },
      {
        assetId: identity.owner.assetId,
        streamId: source.streamId,
        ...(source.acquisitionId === undefined ? {} : { acquisitionId: source.acquisitionId }),
      },
    );
    if (!isDeepStrictEqual(sourceDescriptor(selected), source))
      throw new CatalogError("ARTIFACT_CHANGED", "Transcript source support changed");
  };
}

/** Selected sources share one queue, model owner and raw indexer. */
export class TranscriptProcessing {
  private readonly jobs: JobQueue;
  private readonly transcripts: TranscriptStore;
  private readonly models: TranscriptionModels;
  private readonly transcribe: SpeechTranscriber;
  private readonly asset: AssetDomain;
  constructor(options: TranscriptProcessingOptions) {
    ({
      jobs: this.jobs,
      transcripts: this.transcripts,
      models: this.models,
      transcribe: this.transcribe,
      asset: this.asset,
    } = options);
  }
  private execution() {
    return { modelDigest: this.models.modelDigest, pins: this.models.pins, decoderExecution };
  }
  /** Pin the same native/model identity when a project job owns fresh recognition. */
  recognitionExecution() {
    return { ...this.execution(), policy: transcriptPolicy };
  }
  recognitionReadiness() {
    return this.models.status();
  }
  recognitionNotPrepared() {
    return this.models.notPrepared?.().details ?? {};
  }
  private sourceIdentity(
    selected: ReturnType<typeof selectedAudio>,
    execution: ReturnType<TranscriptProcessing["execution"]>,
    scope: SpeechExecution,
  ) {
    return {
      target: { kind: "asset" as const, assetId: selected.selection.assetId },
      artifact,
      input: JSON.stringify({
        selection: selected.selection,
        source: sourceDescriptor(selected),
        modelDigest: execution.modelDigest,
        pins: execution.pins,
        policy: transcriptPolicy,
        decoderExecution: execution.decoderExecution,
        execution: scope,
      }),
    };
  }

  private portableSelection(value: PortableTranscript) {
    const selected = selectedAudio(this.asset, {
      assetId: value.owner.assetId,
      streamId: value.source.streamId,
      ...(value.source.acquisitionId === undefined
        ? {}
        : { acquisitionId: value.source.acquisitionId }),
    });
    if (
      !isDeepStrictEqual(sourceDescriptor(selected), value.source) ||
      compare(fromTime(selected.track.sourceOffsetUs), fromTime(value.track.sourceOffsetUs)) !==
        0 ||
      selected.track.streamId !== value.track.streamId
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Transcript source and track differ from retained selection",
      );
    return selected;
  }
  portable(value: PortableTranscript): {
    available: SelectionRange[];
    publication: PortableTranscriptPublication | null;
  } {
    const selected = this.portableSelection(value);
    // A stale generation travels only as evidence a revision pins, never as a publication.
    const receipt = currentTranscript(value)
      ? this.jobs.retainedArtifact(value.owner, artifact, value.generation)
      : null;
    if (receipt && !isDeepStrictEqual(portableTranscript(JSON.parse(receipt.result)), value))
      throw new CatalogError(
        "INVALID_STORAGE",
        "Transcript publication differs from owned metadata",
      );
    return {
      available: selected.track.available,
      publication: receipt
        ? retainedPublicationSchema.parse({
            generation: receipt.generation,
            attemptId: receipt.attemptId,
            input: receipt.input,
          })
        : null,
    };
  }
  adoptPublication(
    metadata: TranscriptMetadata,
    available: SelectionRange[],
    publication: PortableTranscriptPublication | null,
    issues: readonly Issue[],
  ): void {
    const value = portableTranscript(metadata),
      selected = this.portableSelection(value);
    if (
      !isDeepStrictEqual(available, selected.track.available) ||
      metadata.track.source !== selected.track.source
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Transcript media binding differs from local source",
      );
    if (!publication || !currentTranscript(value)) return;
    let input: unknown;
    try {
      input = JSON.parse(publication.input);
    } catch {
      throw new CatalogError("INVALID_PACKAGE", "Invalid transcript publication input");
    }
    const parsed = z
      .object({
        decoderExecution: z.string().min(1).max(256),
        execution: historicalSpeechExecutionSchema,
      })
      .safeParse(input);
    if (!parsed.success)
      throw new CatalogError("INVALID_PACKAGE", "Transcript publication has no decoder identity");
    const { modelDigest, ...pins } = omit(
      value.engine,
      "encoderPrecision",
      "computeUnits",
      "policy",
      "kindPolicy",
    );
    const identity = this.sourceIdentity(
      selected,
      {
        modelDigest,
        pins,
        decoderExecution: parsed.data.decoderExecution,
      },
      value.execution,
    );
    if (
      !isDeepStrictEqual(parsed.data.execution, value.execution) ||
      publication.attemptId !== value.generation ||
      !isDeepStrictEqual(JSON.parse(identity.input), input)
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Transcript publication differs from source or engine identity",
      );
    this.jobs.adoptArtifact(
      { ...identity, ...publication, result: JSON.stringify(publicTranscriptMetadata(metadata)) },
      issues,
    );
  }
  /**
   * The execution range is clamped to the source before it forms the speech-execution identity,
   * so a clamped request and a request for its applied range share one generation. The clamp is
   * reported per request, never stored with the shared generation.
   */
  private admitSource(selection: TranscriptPreparation) {
    const selected = selectedAudio(this.asset, selection);
    const admitted = selection.executionRange
      ? admitReadRange(selection.executionRange, { startUs: 0, endUs: selected.durationUs })
      : null;
    const scope = speechExecution({
      ...selection,
      executionRange: admitted?.range ?? selection.executionRange,
    });
    return { selected, scope, issues: admitted?.issues ?? [] };
  }

  sourceStatus(selection: TranscriptPreparation & { generation?: string | undefined }) {
    const { selected, scope, issues } = this.admitSource(selection);
    let status = this.jobs.status(this.sourceIdentity(selected, this.execution(), scope));
    if (selection.generation !== undefined) {
      const owner = { kind: "asset" as const, assetId: selection.assetId };
      const retained = this.jobs.retainedArtifact(owner, artifact, selection.generation);
      const stale = this.transcripts.isStale({ owner, generation: selection.generation });
      if (!retained || stale)
        throw new CatalogError("NOT_FOUND", "Retained transcript generation is unavailable", {
          generation: selection.generation,
          ...(stale ? { stale: true } : {}),
        });
      const metadata = parsePublicTranscriptMetadata(JSON.parse(retained.result));
      if (!isDeepStrictEqual(metadata.source, sourceDescriptor(selected)))
        throw new CatalogError(
          "ARTIFACT_CHANGED",
          "Transcript generation belongs to another selected source",
        );
      status = {
        state: "ready",
        jobId: null,
        reason: null,
        retryable: false,
        published: { ...retained, issues: this.jobs.issues(retained) },
      };
    }
    const models = this.models.status();
    const reason = !selected.track.available.length
      ? "no_audio"
      : status.state === "not_requested" && models.state !== "ready"
        ? "model_not_prepared"
        : null;
    return {
      ...selected.selection,
      state: reason ? "unavailable" : status.state,
      reason: reason ?? status.reason,
      retryable: reason ? reason === "model_not_prepared" : status.retryable,
      jobId: reason ? null : status.jobId,
      published:
        reason || !status.published
          ? null
          : {
              generation: status.published.generation,
              issues: status.published.issues,
              transcript: parsePublicTranscriptMetadata(JSON.parse(status.published.result)),
            },
      models,
      dependencies: [],
      issues,
    };
  }

  prepareSource(selection: TranscriptPreparation): void {
    const status = this.sourceStatus(selection);
    if (status.state !== "not_requested" || status.reason !== null) return;
    this.jobs.submit(
      () => {
        const { selected, scope } = this.admitSource(selection);
        return { ...this.sourceIdentity(selected, this.execution(), scope), lane: "heavy" };
      },
      (job) => {
        const owner = { kind: "job" as const, id: job.jobId };
        this.asset.assets.retain(owner, [selection.assetId]);
        if (selection.acquisitionId !== undefined)
          this.asset.acquisitions.retain(owner, [selection.acquisitionId]);
      },
    );
  }

  retrySource(selection: TranscriptPreparation) {
    const status = this.sourceStatus(selection);
    if (!status.jobId && status.state === "ready") return status;
    if (!status.jobId)
      throw dependencyRefusal(
        status.reason === "model_not_prepared" ? "MODEL_NOT_PREPARED" : "UNAVAILABLE",
        status.reason ?? "Source transcript has not been requested; use transcript.transcribe",
        status.reason === "model_not_prepared" ? (this.models.notPrepared?.().details ?? {}) : {},
        status.retryable,
      );
    if (
      ["failed", "unavailable", "canceled"].includes(this.jobs.job(status.jobId).state) &&
      this.models.status().state !== "ready"
    )
      throw (
        this.models.notPrepared?.() ??
        new CatalogError("MODEL_NOT_PREPARED", "Speech models are not prepared", {})
      );
    this.jobs.retry(status.jobId);
    return this.sourceStatus(selection);
  }

  /** A stale publication is forgotten with its job, so its generation is reclaimed unless a revision pins it. */
  private cleanupAsset(assetId: string, signal: AbortSignal) {
    const owner = { kind: "asset" as const, assetId };
    return this.transcripts.reclaim(
      owner,
      (generation) =>
        this.jobs.retainsAttempt(owner, artifact, generation) &&
        (!this.transcripts.isStale({ owner, generation }) ||
          !this.jobs.forgetPublication(owner, artifact, generation)),
      signal,
    );
  }

  /** The caller's shared job owns this fresh attempt and retains its generation before execution. */
  async recognizeSource(selection: SourceSelection, generation: string, signal: AbortSignal) {
    const selected = selectedAudio(this.asset, selection);
    if (!selected.track.available.length) throw new CatalogError("UNAVAILABLE", "no_audio");
    if (this.models.status().state !== "ready")
      throw (
        this.models.notPrepared?.() ??
        new CatalogError("MODEL_NOT_PREPARED", "Speech models are not prepared", {})
      );
    await this.cleanupAsset(selection.assetId, signal);
    return this.transcribeSource(
      {
        owner: { kind: "asset", assetId: selection.assetId },
        sourceId: selection.assetId,
        generation,
      },
      sourceDescriptor(selected),
      selected.track,
      speechExecution(),
      signal,
    );
  }

  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    if (job.target.kind !== "asset" || job.artifact !== artifact)
      throw new CatalogError("UNSUPPORTED_JOB", "Transcript processor cannot execute this job");
    const selection = sourceSelectionSchema.parse(JSON.parse(job.input).selection);
    // A job an older version queued names its own recipe; the input comparison below retires it.
    const scope = historicalSpeechExecutionSchema.parse(JSON.parse(job.input).execution);
    const selected = selectedAudio(this.asset, selection);
    if (
      job.target.assetId !== selection.assetId ||
      job.input !== this.sourceIdentity(selected, this.execution(), scope).input
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Transcript source or model inputs changed");
    if (!selected.track.available.length) throw new CatalogError("UNAVAILABLE", "no_audio");
    if (this.models.status().state !== "ready")
      throw new CatalogError("MODEL_NOT_PREPARED", "Speech models are not prepared", {});
    await this.cleanupAsset(selection.assetId, signal);
    const { transcript, issues } = await this.transcribeSource(
      {
        owner: { kind: "asset", assetId: selection.assetId },
        sourceId: selection.assetId,
        generation: job.attemptId,
      },
      sourceDescriptor(selected),
      selected.track,
      scope,
      signal,
    );
    return {
      result: JSON.stringify(publicTranscriptMetadata(transcript)),
      issues: publicTranscriptIssues(issues),
    };
  }

  private async transcribeSource(
    identity: TranscriptIdentity,
    source: TranscriptSource,
    track: Parameters<SpeechTranscriber>[0]["track"],
    execution: SpeechExecution,
    signal: AbortSignal,
  ): Promise<IndexedTranscript> {
    signal.throwIfAborted();
    const output = await this.transcripts.reserve(identity);
    try {
      const request = { models: await this.models.nativeRequest(), track, output, execution };
      const receipt = await this.transcribe(request, signal);
      signal.throwIfAborted();
      const indexed = await this.transcripts.ingest({
        identity,
        source,
        request,
        receipt,
        pins: { ...this.models.pins, modelDigest: this.models.modelDigest },
        signal,
      });
      signal.throwIfAborted();
      return indexed;
    } catch (error) {
      await this.transcripts.remove(identity);
      throw error;
    }
  }

  async cleanup(signal: AbortSignal): Promise<void> {
    let cursor: string | undefined;
    let failure: unknown;
    for (;;) {
      signal.throwIfAborted();
      const page = this.asset.assets.list({ ...(cursor ? { cursor } : {}), limit: 100 });
      for (const asset of page.assets) {
        try {
          await this.cleanupAsset(asset.id, signal);
        } catch (error) {
          signal.throwIfAborted();
          failure ??= error;
        }
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      await setImmediate(undefined, { signal });
    }
    if (failure) throw failure;
  }
}
