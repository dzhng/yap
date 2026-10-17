import { join } from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { setImmediate } from "node:timers/promises";
import type { Issue, ProcessingTap, SelectionRange } from "@yap/composition";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import { CatalogError } from "./catalog.js";
import {
  retainedPublicationSchema,
  type JobQueue,
  type JobExecution,
  type StagedJobResult,
} from "./jobs.js";
import type { Models, PreparedRuntime } from "./models.js";
import {
  selectAlignmentSource,
  alignmentSourceSchema,
  type AlignmentSourceInput,
} from "./source-alignment.js";
import type { AlignmentEvidenceStore, AlignmentEvidenceMetadata } from "./alignment-evidence.js";
import {
  alignmentEvidenceSourceSchema,
  type AlignmentEvidenceSource,
  type AlignmentOperands,
} from "./alignment-operands.js";

const artifact = "source-alignment";
const projectArtifact = "project-alignment";
export type ProjectAlignmentRequest = {
  projectId: string;
  revisionId?: string | undefined;
  preparedResourceId: string;
  tap: ProcessingTap;
  range: SelectionRange;
  channel: number;
  text: string;
  modelId: string;
};
export type ResolvedProjectAlignment = {
  source: AlignmentSourceInput;
  projectId: string;
  revisionId: string;
  preparedResourceId: string;
};
export type AlignmentObserver = (
  request: {
    selected: ReturnType<typeof selectAlignmentSource>;
    engine: AlignmentEvidenceSource["engine"];
    decoder: AlignmentEvidenceSource["decoder"];
    runtime: PreparedRuntime;
    checkpoint: string;
  },
  signal: AbortSignal,
) => Promise<{
  pcm: AlignmentEvidenceSource["pcm"];
  operands: AlignmentOperands;
  failure?: CatalogError;
}>;
type AlignmentDescriptorSource = Omit<AlignmentEvidenceSource, "pcm" | "decoder">;
export type AlignmentProcessingOptions = {
  assets: AssetStore;
  acquisitions: AcquisitionStore;
  models: Models;
  jobs: JobQueue;
  evidence: AlignmentEvidenceStore;
  observe: AlignmentObserver;
  decoder: AlignmentEvidenceSource["decoder"] | null;
  project?: {
    /**
     * Admit the request against its revision. The source keeps the applied range; `issues` reports
     * a clamp to this request only, since the applied range keys the work.
     */
    resolve(input: ProjectAlignmentRequest): ResolvedProjectAlignment & { issues?: Issue[] };
  };
};
/** Explicit work shares Models readiness, job replay, source retention and publication fences. */
export class AlignmentProcessing {
  constructor(private readonly options: AlignmentProcessingOptions) {}
  private descriptor(input: AlignmentSourceInput) {
    const selected = selectAlignmentSource(this.options.assets, this.options.acquisitions, input);
    return {
      selected,
      source: {
        streamId: selected.selection.streamId,
        acquisitionId: selected.selection.acquisitionId ?? null,
        supportDigest: selected.supportDigest,
        channel: selected.channel,
        originUs: selected.originUs,
        durationUs: selected.durationUs,
        observationRange: selected.sourceRange,
        text: selected.text,
        engine: this.options.models.alignment(input.modelId).engine,
      },
    };
  }
  private identity(input: AlignmentSourceInput, decoder = this.options.decoder) {
    const { source } = this.descriptor(input);
    return {
      target: { kind: "asset" as const, assetId: input.assetId },
      artifact,
      input: JSON.stringify({
        request: alignmentSourceSchema.parse(input),
        source: { ...source, decoder },
      }),
    };
  }
  sourceStatus(input: AlignmentSourceInput) {
    const { source } = this.descriptor(input),
      retained = this.options.evidence.latestObservation(input.assetId, source),
      status = this.options.jobs.status(this.identity(input, retained?.source.decoder));
    const reason =
      status.state !== "not_requested"
        ? null
        : this.options.models.alignment(input.modelId).status().state !== "ready"
          ? "model_not_prepared"
          : this.options.decoder === null
            ? "native_decoder_unavailable"
            : null;
    const published = status.published
      ? {
          generation: status.published.generation,
          issues: status.published.issues,
          evidence: JSON.parse(status.published.result) as AlignmentEvidenceMetadata,
        }
      : null;
    if (published) this.options.evidence.metadata(published.evidence);
    return {
      ...status,
      state: reason ? ("unavailable" as const) : status.state,
      reason: reason ?? status.reason,
      published,
    };
  }
  prepareSource(input: AlignmentSourceInput) {
    input = alignmentSourceSchema.parse(input);
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
  prepareProject(input: ProjectAlignmentRequest) {
    if (!this.options.project)
      throw new CatalogError("UNSUPPORTED_JOB", "Project alignment is unavailable");
    const { issues = [], ...resolved } = this.options.project.resolve(input),
      identity = {
        target: {
          kind: "project" as const,
          projectId: resolved.projectId,
          revisionId: resolved.revisionId,
        },
        artifact: projectArtifact,
        // Keyed by the applied range, so an overrun shares the applied range's evidence.
        input: JSON.stringify({
          request: { ...input, range: resolved.source.sourceRange },
          resolved,
        }),
      },
      status = this.options.jobs.status(identity),
      model = this.options.models.alignment(input.modelId),
      reason =
        status.state !== "not_requested"
          ? null
          : model.status().state !== "ready"
            ? "model_not_prepared"
            : this.options.decoder === null
              ? "native_decoder_unavailable"
              : null,
      published = status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            evidence: JSON.parse(status.published.result) as AlignmentEvidenceMetadata,
          }
        : null;
    if (published) this.options.evidence.metadata(published.evidence);
    if (status.state === "not_requested" && reason === null) {
      this.options.jobs.submit(
        () => ({ ...identity, lane: "heavy" }),
        (job) =>
          this.options.assets.retain({ kind: "job", id: job.jobId }, [resolved.source.assetId]),
      );
      const next = this.options.jobs.status(identity),
        nextPublished = next.published
          ? {
              generation: next.published.generation,
              issues: next.published.issues,
              evidence: JSON.parse(next.published.result) as AlignmentEvidenceMetadata,
            }
          : null;
      if (nextPublished) this.options.evidence.metadata(nextPublished.evidence);
      return {
        ...next,
        state: next.state,
        reason: next.reason,
        published: nextPublished,
        projectId: resolved.projectId,
        revisionId: resolved.revisionId,
        preparedResourceId: resolved.preparedResourceId,
        assetId: resolved.source.assetId,
        issues,
      };
    }
    return {
      ...status,
      state: reason ? ("unavailable" as const) : status.state,
      reason: reason ?? status.reason,
      published,
      projectId: resolved.projectId,
      revisionId: resolved.revisionId,
      preparedResourceId: resolved.preparedResourceId,
      assetId: resolved.source.assetId,
      issues,
    };
  }
  async execute({ job, signal }: JobExecution): Promise<StagedJobResult> {
    const project = job.target.kind === "project" && job.artifact === projectArtifact;
    if (!project && (job.target.kind !== "asset" || job.artifact !== artifact))
      throw new CatalogError("UNSUPPORTED_JOB", "Alignment processor cannot execute this job");
    let input: AlignmentSourceInput,
      selected: ReturnType<typeof selectAlignmentSource>,
      source: AlignmentDescriptorSource,
      projectOwner: { kind: "project"; projectId: string } | undefined;
    if (project) {
      if (!this.options.project)
        throw new CatalogError("UNSUPPORTED_JOB", "Project alignment is unavailable");
      const value = JSON.parse(job.input) as {
          request: ProjectAlignmentRequest;
          resolved: ResolvedProjectAlignment;
        },
        { issues: _, ...resolved } = this.options.project.resolve(value.request);
      if (!isDeepStrictEqual(resolved, value.resolved))
        throw new CatalogError(
          "ARTIFACT_CHANGED",
          "Prepared project tap or alignment input changed",
        );
      if (
        job.target.kind !== "project" ||
        job.target.projectId !== resolved.projectId ||
        job.target.revisionId !== resolved.revisionId
      )
        throw new CatalogError("ARTIFACT_CHANGED", "Prepared project revision changed");
      projectOwner = { kind: "project", projectId: resolved.projectId };
      input = alignmentSourceSchema.parse(resolved.source);
      ({ selected, source } = this.descriptor(input));
    } else {
      input = alignmentSourceSchema.parse(JSON.parse(job.input).request);
      ({ selected, source } = this.descriptor(input));
    }
    const decoder = this.options.decoder;
    if (!decoder)
      throw new CatalogError("NOT_READY", "Native alignment decoder is unavailable", {});
    if (
      !project &&
      (job.target.kind !== "asset" ||
        job.target.assetId !== input.assetId ||
        this.identity(input).input !== job.input)
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Alignment source or execution inputs changed");
    signal.throwIfAborted();
    const model = this.options.models.alignment(input.modelId),
      runtime = await model.runtime();
    if (
      runtime.descriptorDigest !== source.engine.descriptorDigest ||
      runtime.modelDigest !== source.engine.modelDigest ||
      runtime.runtimeDigest !== source.engine.runtimeDigest
    )
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Prepared alignment runtime differs from admitted identity",
      );
    signal.throwIfAborted();
    await this.cleanupAsset(
      input.assetId,
      signal,
      projectOwner
        ? (generation) =>
            this.options.jobs.retainsAttempt(projectOwner!, projectArtifact, generation)
        : undefined,
    );
    const observed = await this.options.observe(
      {
        selected,
        engine: source.engine,
        decoder,
        runtime,
        checkpoint: join(runtime.model, model.checkpoint),
      },
      signal,
    );
    signal.throwIfAborted();
    const identity = {
        owner: { kind: "asset" as const, assetId: input.assetId },
        generation: job.attemptId,
        policy: "alignment-v1" as const,
      },
      descriptor = { ...source, decoder, pcm: observed.pcm };
    if (
      !isDeepStrictEqual(observed.pcm.sampleRate, selected.expectedPCM.sampleRate) ||
      observed.pcm.frames !== selected.expectedPCM.frames
    )
      throw new CatalogError(
        "INVALID_EVIDENCE",
        "Alignment PCM differs from the selected sample count",
      );
    if (observed.failure) {
      const { captured } = this.options.evidence.capture(
        identity,
        descriptor,
        observed.operands,
        job.jobId,
      );
      Object.assign(observed.failure.details, {
        generation: identity.generation,
        nativeReceiptSha256: captured.nativeReceiptSha256,
        reportSha256: captured.reportSha256,
        correspondenceSha256: captured.correspondenceSha256,
        verified: false,
      });
      throw observed.failure;
    }
    const staged = this.options.evidence.stage(identity, descriptor, observed.operands, job.jobId);
    return {
      result: JSON.stringify(staged.metadata),
      publish: staged.publish,
      close: staged.close,
    };
  }
  cleanupAsset(
    assetId: string,
    signal?: AbortSignal,
    keep: (generation: string) => boolean = (generation) =>
      this.options.jobs.retainsAttempt({ kind: "asset", assetId }, artifact, generation),
  ) {
    return this.options.evidence.reclaim(assetId, keep, signal);
  }
  portablePublication(metadata: AlignmentEvidenceMetadata) {
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
  adoptPublication(
    metadata: AlignmentEvidenceMetadata,
    publication: z.infer<typeof retainedPublicationSchema>,
  ) {
    let value: { request?: unknown; source?: unknown } | null;
    try {
      value = JSON.parse(publication.input);
    } catch {
      throw new CatalogError("INVALID_PACKAGE", "Alignment publication has invalid JSON");
    }
    const parsed = alignmentSourceSchema.safeParse(value?.request);
    if (!parsed.success)
      throw new CatalogError("INVALID_PACKAGE", "Alignment publication has invalid selection");
    const identity = this.identity(parsed.data, metadata.source.decoder),
      source = alignmentEvidenceSourceSchema.omit({ pcm: true }).strip().parse(metadata.source);
    if (
      metadata.owner.assetId !== parsed.data.assetId ||
      publication.attemptId !== metadata.generation ||
      publication.input !== identity.input ||
      !isDeepStrictEqual(value?.source, source)
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Alignment publication differs from its source and generation",
      );
    // Alignment publishes no issues; a project request reports its own clamp.
    this.options.jobs.adoptArtifact(
      { ...identity, ...publication, result: JSON.stringify(metadata) },
      [],
    );
  }
  async cleanup(signal: AbortSignal) {
    let cursor: string | undefined;
    let failure: unknown;
    for (;;) {
      signal.throwIfAborted();
      const page = this.options.assets.list({ ...(cursor ? { cursor } : {}), limit: 100 });
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
