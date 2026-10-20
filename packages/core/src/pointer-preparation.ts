import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import type { SourceEvidenceReader } from "./evidence-read.js";
import { CaptureSourceRead } from "./capture-source-read.js";
import { selectSource, sourceSelectionSchema, type SourceSelection } from "./source-selection.js";
import { PresentationEvidence, type PresentationReceipt } from "./presentation-evidence.js";
import { JobDependencyLost, type JobAdmission, type JobExecution, type JobQueue } from "./jobs.js";
import type { DerivedCache } from "./cache.js";
import { submitCachedDerivative } from "./cached-derivative.js";
import { CatalogError, dependencyRefusal } from "./catalog.js";

const recipeSchema = z.strictObject({
  selection: sourceSelectionSchema.extend({ acquisitionId: z.string().min(1) }),
  generation: z.string().min(1),
  supportDigest: z.string().min(1),
  implementationId: z.string().min(1),
});
type Artifact = { cacheId: string; receipt: PresentationReceipt };
export type PointerHistoryRenderer = {
  implementationId: string;
  render(
    request: {
      source: string;
      streamId: string;
      clockOffsetUs: number;
      spans: readonly { startUs: number; endUs: number }[];
      output: string;
    },
    signal: AbortSignal,
  ): Promise<PresentationReceipt>;
};

/** Queued exact history is source-owned; clip transforms and trail duration do not duplicate decoding. */
export class PointerPreparation {
  private readonly capture: CaptureSourceRead;
  constructor(
    private readonly owners: {
      assets: AssetStore;
      acquisitions: AcquisitionStore;
      evidence: SourceEvidenceReader;
      jobs: JobQueue;
      cache: DerivedCache;
      renderer: PointerHistoryRenderer;
    },
  ) {
    if (!owners.renderer.implementationId)
      throw new Error("Pointer history renderer requires an implementation identity");
    this.capture = new CaptureSourceRead(owners.assets, owners.acquisitions, owners.evidence);
  }
  plan(selection: SourceSelection) {
    const selected = selectSource(this.owners.assets, this.owners.acquisitions, selection);
    const history = this.capture.presentation(selection);
    const context = this.capture.resolve(selection, "cursor");
    if (history.evidence.receipt.cursorSamples < 1 || history.evidence.receipt.geometryRecords < 1)
      throw new CatalogError(
        "UNAVAILABLE",
        "Capture has no cursor or geometry observations for pointer preparation",
        {
          cursorSamples: history.evidence.receipt.cursorSamples,
          geometryRecords: history.evidence.receipt.geometryRecords,
        },
      );
    if (selected.stream.kind !== "video")
      throw new CatalogError("UNSUPPORTED_MEDIA", "Pointer history requires captured video");
    const recipe = recipeSchema.parse({
      selection: selected.selection,
      generation: history.evidence.generation,
      supportDigest: selected.supportDigest,
      implementationId: this.owners.renderer.implementationId,
    });
    return {
      recipe,
      history,
      selected,
      dimensions: { width: selected.stream.width, height: selected.stream.height },
      sourceToAssetOffsetUs: context.sourceToAssetOffsetUs,
    };
  }
  private identity(recipe: z.infer<typeof recipeSchema>) {
    return {
      target: { kind: "acquisition" as const, id: recipe.selection.acquisitionId },
      artifact: "pointer-presentation",
      input: JSON.stringify(recipe),
    };
  }
  /** Called during parent admission, before a heavy render occupies the worker lane. */
  request(selection: SourceSelection) {
    const { recipe } = this.plan(selection);
    return submitCachedDerivative<Artifact>(
      this.owners.jobs,
      this.owners.cache,
      this.identity(recipe),
      "heavy",
      {
        admitted: (job) => {
          this.owners.jobs.retainInputs(job.jobId, "asset", [recipe.selection.assetId]);
          this.owners.jobs.retainInputs(job.jobId, "acquisition", [recipe.selection.acquisitionId]);
        },
      },
    );
  }
  retry(selection: SourceSelection) {
    const status = this.request(selection);
    if (
      status.jobId &&
      status.retryable &&
      !["queued", "processing", "ready"].includes(status.state)
    )
      this.owners.jobs.retry(status.jobId);
  }
  admit(selections: readonly SourceSelection[]): ReturnType<JobAdmission> {
    // Retained job receipts still account for files evicted since publication.
    let knownBytes = 0;
    for (const selection of selections) {
      const status = this.owners.jobs.status(this.identity(this.plan(selection).recipe));
      if (status.published)
        knownBytes += (JSON.parse(status.published.result) as Artifact).receipt.bytes;
    }
    this.owners.cache.checkCapacity(knownBytes);
    for (const selection of selections) {
      const status = this.request(selection);
      if (status.published) continue;
      if (["failed", "unavailable", "not_requested"].includes(status.state))
        throw dependencyRefusal(
          status.state === "unavailable" ? "UNAVAILABLE" : "DEPENDENCY_FAILED",
          status.reason ?? "Pointer history is unavailable",
          { dependency: status.jobId },
          status.retryable,
        );
      if (!status.jobId)
        throw new CatalogError("INVALID_STATE", "Pointer history has no job identity");
      return { state: "waiting", dependency: status.jobId };
    }
    return { state: "ready" };
  }
  /** Producer leases prevent a heavy index from waiting on a frame's evicted heavy history. */
  async withReady<T>(
    selections: readonly SourceSelection[],
    consume: () => Promise<T>,
  ): Promise<T> {
    const leases = [];
    try {
      for (const selection of selections) {
        const { recipe } = this.plan(selection);
        const status = this.owners.jobs.status(this.identity(recipe));
        if (!status.published)
          throw new JobDependencyLost("Pointer history publication disappeared");
        const artifact = JSON.parse(status.published.result) as Artifact;
        const lease = this.owners.cache.acquire(artifact.cacheId);
        if (!lease) throw new JobDependencyLost("Pointer history cache disappeared");
        leases.push(lease);
      }
      return await consume();
    } finally {
      for (const lease of leases) lease.release();
    }
  }
  async execute({ job, signal }: JobExecution) {
    const parsed = recipeSchema.safeParse(JSON.parse(job.input));
    if (
      job.artifact !== "pointer-presentation" ||
      job.target.kind !== "acquisition" ||
      !parsed.success ||
      parsed.data.selection.acquisitionId !== job.target.id
    )
      throw new CatalogError(
        "UNSUPPORTED_JOB",
        "Pointer history job does not name its acquisition",
      );
    if (parsed.data.implementationId !== this.owners.renderer.implementationId)
      throw new CatalogError("NOT_READY", "Pinned pointer history renderer is unavailable", {});
    const plan = this.plan(parsed.data.selection);
    if (!isDeepStrictEqual(plan.recipe, parsed.data))
      throw new CatalogError("ARTIFACT_CHANGED", "Pinned pointer history inputs changed");
    const output = this.owners.cache.reserve(job.target);
    try {
      const receipt = await this.owners.renderer.render(
        { ...plan.history, output: output.path },
        signal,
      );
      signal.throwIfAborted();
      if (receipt.file !== output.path)
        throw new CatalogError("INVALID_RESPONSE", "Pointer history changed its output path");
      const history = await PresentationEvidence.open(receipt, plan.history.spans, signal);
      try {
        if (
          receipt.sourceWidth !== plan.dimensions.width ||
          receipt.sourceHeight !== plan.dimensions.height
        )
          throw new CatalogError(
            "INVALID_RESPONSE",
            "Pointer history changed its source dimensions",
          );
      } finally {
        await history.close();
      }
      const cached = await this.owners.cache.publish(output.id);
      signal.throwIfAborted();
      if (cached.bytes !== receipt.bytes)
        throw new CatalogError("INVALID_RESPONSE", "Pointer history publication changed its bytes");
      return JSON.stringify({ cacheId: output.id, receipt } satisfies Artifact);
    } catch (error) {
      this.owners.cache.remove(output.id);
      throw error;
    }
  }
  /** Never queues child work; the cache descriptor lease encloses sampling and output preparation. */
  async withHistory<T>(
    selection: SourceSelection,
    signal: AbortSignal,
    consume: (context: {
      plan: ReturnType<PointerPreparation["plan"]>;
      presentation: PresentationEvidence;
    }) => Promise<T>,
  ) {
    const plan = this.plan(selection);
    const status = this.owners.jobs.status(this.identity(plan.recipe));
    if (!status.published) throw new JobDependencyLost("Exact pointer history is not prepared");
    const artifact = JSON.parse(status.published.result) as Artifact;
    let opened = false;
    return this.owners.cache
      .withDescriptor(artifact.cacheId, async (lease) => {
        opened = true;
        if (artifact.receipt.bytes !== lease.bytes)
          throw new CatalogError("INVALID_EVIDENCE", "Pointer history changed its cache size");
        const presentation = await PresentationEvidence.fromDescriptor(
          artifact.receipt,
          plan.history.spans,
          lease.fd,
          signal,
        );
        try {
          return await consume({ plan, presentation });
        } finally {
          await presentation.close();
        }
      })
      .catch((error: unknown) => {
        if (!opened && error instanceof CatalogError && error.code === "ARTIFACT_EXPIRED")
          throw new JobDependencyLost("Pointer history cache disappeared");
        throw error;
      });
  }
}
