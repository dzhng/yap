import { z } from "zod";
import { toTime, type TimeValue } from "@yap/composition";
import { CatalogError } from "./catalog.js";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import {
  selectSource,
  type SourceSelectionRead,
  type SourceSelection,
} from "./source-selection.js";
import type { SceneProcessing } from "./scene-processing.js";
import type { SceneEvidenceStore, SceneEvidenceMetadata } from "./scene-evidence.js";
import { sceneSampleSourceTime } from "./source-scenes.js";
export type SceneContext = {
  state: string;
  reason: string | null;
  retryable: boolean;
  jobId: string | null;
  evidence: SceneEvidenceMetadata | null;
};
export type SceneRow = {
  kind: "scene";
  sourceAtUs: TimeValue;
  sourceOrdinal: number;
  observation: {
    sample: NonNullable<
      ReturnType<SceneEvidenceStore["boundaryPage"]>["boundaries"][number]["sample"]
    >;
  };
};
export const scenePositionSchema = z.strictObject({
  after: z
    .strictObject({
      actualSourceUs: z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
      ordinal: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .nullable(),
  done: z.boolean(),
});
export type ScenePosition = z.infer<typeof scenePositionSchema>;
export const initialScene = (): ScenePosition => ({ after: null, done: false });
/** Reads published scene generations only; physical clocks remain exact through range filtering. */
export class SourceSceneRead {
  constructor(
    private readonly options: {
      assets: AssetStore;
      acquisitions: AcquisitionStore;
      processing: SceneProcessing;
      records: SceneEvidenceStore;
    },
  ) {}
  resolve(
    selection: SourceSelection,
    prepare = false,
    sources?: SourceSelectionRead,
  ): SceneContext {
    const selected =
      sources?.get(selection) ??
      selectSource(this.options.assets, this.options.acquisitions, selection);
    if (selected.stream.kind !== "video")
      return {
        state: "unavailable",
        reason: "requires_video",
        retryable: false,
        jobId: null,
        evidence: null,
      };
    const status = prepare
      ? this.options.processing.publishedSource(selection)
      : this.options.processing.sourceStatus(selection, sources);
    return {
      state: status.state,
      reason: status.reason,
      retryable: status.retryable,
      jobId: status.jobId,
      evidence: status.published?.evidence ?? null,
    };
  }
  coverage(
    context: SceneContext,
    range: { startUs: number; endUs: number },
    afterStartUs?: number,
    limit = 1,
  ) {
    if (!context.evidence)
      throw new CatalogError("PREREQUISITE_MISSING", "Scene coverage has no published generation");
    return this.options.records.sourceWindowPage({
      identity: context.evidence,
      range,
      ...(afterStartUs === undefined ? {} : { afterStartUs }),
      limit,
    });
  }
  next(
    context: SceneContext,
    range: { startUs: number; endUs: number },
    position: ScenePosition,
    budget: { remaining: number },
  ): SceneRow | null | undefined {
    if (!context.evidence || position.done) return null;
    while (budget.remaining > 0) {
      budget.remaining--;
      const page = this.options.records.boundaryPage({
        identity: context.evidence,
        range,
        ...(position.after ? { after: position.after } : {}),
        limit: 1,
      });
      position.after = page.next;
      position.done = page.next === null;
      const row = page.boundaries[0];
      if (row) {
        if (!row.sample)
          throw new CatalogError("INVALID_EVIDENCE", "Asset scenes require physical sample clocks");
        return {
          kind: "scene",
          sourceAtUs: toTime(sceneSampleSourceTime(row.sample, row.sample.originUs)),
          sourceOrdinal: row.ordinal,
          observation: { sample: row.sample },
        };
      }
      if (position.done) return null;
    }
    return undefined;
  }
}
