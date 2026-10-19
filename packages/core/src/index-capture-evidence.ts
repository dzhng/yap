import { captureToAssetUs, type CaptureSourceRead } from "./capture-source-read.js";
import type { SourceEvidenceReader } from "./evidence-read.js";
import type { IndexMoment, IndexPointerSample } from "./source-index-selection.js";

export type IndexCaptureOwners = {
  evidence?: SourceEvidenceReader | undefined;
  capture?: Pick<CaptureSourceRead, "marks" | "resolve"> | undefined;
};

/**
 * What a recording's journal adds to picture selection: a moment at each live mark, pin and click
 * (retractions already applied by the capture reader, the one owner of marks) and the pointer
 * path that lets coverage notice pointing around. Times are asset microseconds, converted by the
 * capture reader's clock. A selection without an acquisition has neither.
 */
export function indexCaptureEvidence(
  selection: { assetId: string; streamId: string; acquisitionId?: string | undefined },
  owners: IndexCaptureOwners,
): { moments: IndexMoment[]; pointerSamples: IndexPointerSample[] } {
  const { acquisitionId } = selection;
  if (!acquisitionId || !owners.evidence || !owners.capture)
    return { moments: [], pointerSamples: [] };
  // Only the source selection: the capture reader parses it strictly, and an index identity
  // carries far more than a selection.
  const source = { assetId: selection.assetId, streamId: selection.streamId, acquisitionId };
  const context = owners.capture.resolve(source, "cursor");
  if (!context.evidence) return { moments: [], pointerSamples: [] };
  const moments = owners.capture
    .marks(source)
    .map((mark) => ({
      sourceUs: mark.assetUs,
      kind: mark.kind === "stroke" ? ("mark" as const) : mark.kind,
      markId: mark.id,
    }))
    .sort((a, b) => a.sourceUs - b.sourceUs);
  const pointerSamples: IndexPointerSample[] = [];
  let afterSequence: number | undefined;
  for (;;) {
    const page = owners.evidence.page({
      ...context.evidence,
      range: { startUs: 0, endUs: Number.MAX_SAFE_INTEGER },
      ...(afterSequence === undefined ? {} : { afterSequence }),
      limit: 5000,
    });
    pointerSamples.push(
      ...page.samples.map((sample) => ({
        sourceUs: captureToAssetUs(sample.sourceUs, context.sourceToAssetOffsetUs),
        x: typeof sample.x === "number" ? sample.x : null,
        y: typeof sample.y === "number" ? sample.y : null,
      })),
    );
    if (page.nextSequence === null) break;
    afterSequence = page.nextSequence;
  }
  pointerSamples.sort((a, b) => a.sourceUs - b.sourceUs);
  return { moments, pointerSamples };
}
