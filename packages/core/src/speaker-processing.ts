import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import { CatalogError } from "./catalog.js";
import {
  retainedPublicationSchema,
  type JobExecution,
  type JobQueue,
  type StagedJobResult,
} from "./jobs.js";
import { speakerEvidenceSourceSchema } from "./speaker-evidence.js";
import type { z } from "zod";
import { setImmediate } from "node:timers/promises";
import type { Models, PreparedRuntime } from "./models.js";
import {
  selectSpeakerSource,
  speakerSourceSchema,
  type SpeakerSourceInput,
} from "./source-speakers.js";
import type {
  SpeakerEvidenceStore,
  SpeakerEvidenceSource,
  SpeakerOperands,
  SpeakerEvidenceMetadata,
} from "./speaker-evidence.js";

import { selectSourceChannel, type SourceSelection } from "./source-selection.js";

const artifact = "source-speakers";
export type SpeakerObserver = (
  request: {
    selected: ReturnType<typeof selectSpeakerSource>;
    engine: SpeakerEvidenceSource["engine"];
    decoder: SpeakerEvidenceSource["decoder"];
    runtime: PreparedRuntime;
    checkpoint: string;
  },
  signal: AbortSignal,
) => Promise<{
  pcm: SpeakerEvidenceSource["pcm"];
  operands: SpeakerOperands;
  failure?: CatalogError;
}>;
export type SpeakerProcessingOptions = {
  assets: AssetStore;
  acquisitions: AcquisitionStore;
  models: Models;
  jobs: JobQueue;
  evidence: SpeakerEvidenceStore;
  observe: SpeakerObserver;
  decoder: SpeakerEvidenceSource["decoder"] | null;
};

/** Explicit source observations reuse model preparation and the shared job publication fence. */
export class SpeakerProcessing {
  constructor(private readonly options: SpeakerProcessingOptions) {}
  private selected(input: SpeakerSourceInput) {
    return selectSpeakerSource(this.options.assets, this.options.acquisitions, input);
  }
  private descriptor(selected: ReturnType<typeof selectSpeakerSource>) {
    return {
      streamId: selected.selection.streamId,
      acquisitionId: selected.selection.acquisitionId ?? null,
      supportDigest: selected.supportDigest,
      channel: selected.channel,
      originUs: selected.originUs,
      durationUs: selected.durationUs,
      observationRange: selected.sourceRange,
      decoder: this.options.decoder,
      engine: this.options.models.speaker(selected.modelId).engine,
    };
  }
  private identity(input: SpeakerSourceInput, decoder = this.options.decoder) {
    const selected = this.selected(input);
    return {
      target: { kind: "asset" as const, assetId: selected.selection.assetId },
      artifact,
      input: JSON.stringify({
        request: speakerSourceSchema.parse(input),
        source: { ...this.descriptor(selected), decoder },
      }),
    };
  }
  engine(modelId: string) {
    return this.options.models.speaker(modelId).engine;
  }
  resolveMany(
    selections: readonly SourceSelection[],
    choice: { channel: number; modelId: string },
  ) {
    const engine = this.engine(choice.modelId);
    return selections.map((selection) => {
      const selected = selectSourceChannel(this.options.assets, this.options.acquisitions, {
        ...selection,
        channel: choice.channel,
      });
      const evidence = this.options.evidence.latestObservations(selection.assetId, {
        streamId: selected.selection.streamId,
        acquisitionId: selected.selection.acquisitionId ?? null,
        supportDigest: selected.supportDigest,
        channel: selected.channel,
        originUs: selected.originUs,
        durationUs: selected.durationUs,
        engine,
      });
      return {
        selection,
        evidence,
        state: evidence.length ? "ready" : "unavailable",
        reason: evidence.length ? null : "source_evidence_unobserved",
        retryable: false,
        jobId: null,
      };
    });
  }
  sourceStatus(input: SpeakerSourceInput) {
    const selected = this.selected(input);
    const retained = this.options.evidence.latestObservation(
      input.assetId,
      this.descriptor(selected),
    );
    const identity = this.identity(input, retained?.source.decoder),
      status = this.options.jobs.status(identity);
    // Published evidence has no runtime dependency; readiness reads cannot prepare or invoke a model.
    const modelMissing =
      status.state === "not_requested" &&
      this.options.models.speaker(input.modelId).status().state !== "ready";
    const decoderMissing = status.state === "not_requested" && this.options.decoder === null;
    const unavailableReason = modelMissing
      ? "model_not_prepared"
      : decoderMissing
        ? "native_decoder_unavailable"
        : null;
    const published = status.published
      ? {
          generation: status.published.generation,
          issues: status.published.issues,
          evidence: JSON.parse(status.published.result) as SpeakerEvidenceMetadata,
        }
      : null;
    if (published) this.options.evidence.metadata(published.evidence);
    return {
      ...status,
      state: unavailableReason ? ("unavailable" as const) : status.state,
      reason: unavailableReason ?? status.reason,
      published,
    };
  }
  prepareSource(input: SpeakerSourceInput) {
    const status = this.sourceStatus(input);
    if (status.state !== "not_requested") return status;
    this.options.jobs.submit(
      () => ({ ...this.identity(input), lane: "heavy" }),
      (job) => {
        const owner = { kind: "job" as const, id: job.jobId };
        this.options.assets.retain(owner, [input.assetId]);
        if (input.acquisitionId !== undefined)
          this.options.acquisitions.retain(owner, [input.acquisitionId]);
      },
    );
    return this.sourceStatus(input);
  }
  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    if (job.target.kind !== "asset" || job.artifact !== artifact)
      throw new CatalogError("UNSUPPORTED_JOB", "Speaker processor cannot execute this job");
    const input = speakerSourceSchema.parse(JSON.parse(job.input).request);
    const selected = this.selected(input),
      descriptor = this.descriptor(selected);
    if (!descriptor.decoder)
      throw new CatalogError("NOT_READY", "Native speaker decoder is unavailable", {});
    if (job.target.assetId !== input.assetId || this.identity(input).input !== job.input)
      throw new CatalogError("ARTIFACT_CHANGED", "Speaker source or execution inputs changed");
    signal.throwIfAborted();
    const model = this.options.models.speaker(input.modelId),
      runtime = await model.runtime();
    if (
      !isDeepStrictEqual(
        {
          descriptorDigest: runtime.descriptorDigest,
          modelDigest: runtime.modelDigest,
          runtimeDigest: runtime.runtimeDigest,
        },
        {
          descriptorDigest: descriptor.engine.descriptorDigest,
          modelDigest: descriptor.engine.modelDigest,
          runtimeDigest: descriptor.engine.runtimeDigest,
        },
      )
    )
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Prepared speaker runtime differs from admitted identity",
      );
    signal.throwIfAborted();
    await this.cleanupAsset(input.assetId, signal);
    const observed = await this.options.observe(
      {
        selected,
        engine: descriptor.engine,
        decoder: descriptor.decoder,
        runtime,
        checkpoint: join(runtime.model, model.checkpoint),
      },
      signal,
    );
    signal.throwIfAborted();
    const identity = {
      owner: { kind: "asset" as const, assetId: input.assetId },
      sourceId: input.assetId,
      generation: job.attemptId,
      policy: "speaker-v1" as const,
    };
    const source = { ...descriptor, decoder: descriptor.decoder, pcm: observed.pcm };
    if (observed.failure) {
      const { captured } = this.options.evidence.capture(
        identity,
        source,
        observed.operands,
        job.jobId,
      );
      Object.assign(observed.failure.details, {
        generation: identity.generation,
        nativeReceiptSha256: captured.nativeReceiptSha256,
        reportSha256: captured.reportSha256,
        verified: false,
      });
      throw observed.failure;
    }
    const staged = this.options.evidence.stage(identity, source, observed.operands, job.jobId);
    return {
      result: JSON.stringify(staged.metadata),
      publish: staged.publish,
      close: staged.close,
    };
  }
  portablePublication(metadata: SpeakerEvidenceMetadata) {
    const receipt = this.options.jobs.retainedArtifact(
      metadata.owner,
      artifact,
      metadata.generation,
    );
    return receipt
      ? retainedPublicationSchema.parse({
          generation: receipt.generation,
          attemptId: receipt.attemptId,
          input: receipt.input,
        })
      : null;
  }
  /** Evidence publication and replay join the portable adopter's existing catalog transaction. */
  adoptPublication(
    metadata: SpeakerEvidenceMetadata,
    publication: z.infer<typeof retainedPublicationSchema>,
  ) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(publication.input);
    } catch {
      throw new CatalogError("INVALID_PACKAGE", "Speaker publication has invalid JSON");
    }
    const value = decoded as { request?: unknown; source?: unknown } | null;
    const parsed = speakerSourceSchema.safeParse(value?.request);
    if (!parsed.success)
      throw new CatalogError("INVALID_PACKAGE", "Speaker publication has invalid selection");
    const identity = this.identity(parsed.data, metadata.source.decoder);
    const source = speakerEvidenceSourceSchema.omit({ pcm: true }).strip().parse(metadata.source);
    if (
      metadata.owner.assetId !== parsed.data.assetId ||
      metadata.sourceId !== parsed.data.assetId ||
      publication.attemptId !== metadata.generation ||
      publication.input !== identity.input ||
      !isDeepStrictEqual(value?.source, source)
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Speaker publication differs from its source and generation",
      );
    // Speaker evidence publishes no issues.
    this.options.jobs.adoptArtifact(
      { ...identity, ...publication, result: JSON.stringify(metadata) },
      [],
    );
  }
  async cleanup(signal: AbortSignal): Promise<void> {
    let afterSequence = 0;
    let failure: unknown;
    for (;;) {
      signal.throwIfAborted();
      const page = this.options.assets.list({ afterSequence, limit: 100 });
      for (const asset of page.assets) {
        try {
          await this.cleanupAsset(asset.id, signal);
        } catch (error) {
          signal.throwIfAborted();
          failure ??= error;
        }
      }
      if (!page.nextCursor) break;
      afterSequence = page.nextCursor.afterSequence;
      await setImmediate(undefined, { signal });
    }
    if (failure) throw failure;
  }
  cleanupAsset(assetId: string, signal?: AbortSignal) {
    return this.options.evidence.reclaim(
      assetId,
      (generation) =>
        this.options.jobs.retainsAttempt({ kind: "asset", assetId }, artifact, generation),
      signal,
    );
  }
}
