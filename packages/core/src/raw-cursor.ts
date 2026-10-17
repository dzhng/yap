import { CatalogError } from "./catalog.js";
import type { SourceEvidenceMetadata } from "./evidence.js";
import type { SourceEvidenceReader } from "./evidence-read.js";
import type { TimeRange } from "./presentation-time.js";

export type CursorTarget =
  | { recordingId: string; packageHandle?: never }
  | { packageHandle: string; recordingId?: never };
export type RawCursorContinuation<Target extends CursorTarget> = Target & {
  sourceId: string;
  generation: string;
  sourceRange: TimeRange;
  afterSequence: number;
};
export type RawCursorOptions<Target extends CursorTarget> = {
  sourceRange: TimeRange;
  cursor?: RawCursorContinuation<Target> | undefined;
  limit?: number | undefined;
};

/** Source-time pages share their bounds and continuation identity across storage backends. */
export function readRawCursor<Target extends CursorTarget>(
  target: Target,
  input: RawCursorOptions<Target>,
  source: () => { metadata: SourceEvidenceMetadata; reader: Pick<SourceEvidenceReader, "page"> },
) {
  const { startUs, endUs } = input.sourceRange;
  if (
    !Number.isSafeInteger(startUs) ||
    !Number.isSafeInteger(endUs) ||
    startUs < 0 ||
    endUs <= startUs ||
    endUs - startUs > 60_000_000
  )
    throw new CatalogError("INVALID_RANGE", "Cursor range must be positive and at most 60 seconds");
  const { metadata, reader } = source();
  const cursor = input.cursor;
  if (
    cursor &&
    (("packageHandle" in target
      ? cursor.packageHandle !== target.packageHandle || cursor.recordingId !== undefined
      : cursor.recordingId !== target.recordingId || cursor.packageHandle !== undefined) ||
      cursor.sourceRange.startUs !== startUs ||
      cursor.sourceRange.endUs !== endUs)
  )
    throw new CatalogError("INVALID_PARAMS", "Cursor continuation used other filters");
  if (
    cursor &&
    (cursor.sourceId !== metadata.sourceId || cursor.generation !== metadata.generation)
  )
    throw new CatalogError("ARTIFACT_CHANGED", "Cursor continuation evidence changed");
  const sourceRange = { startUs, endUs };
  const page = reader.page({
    ...metadata,
    range: sourceRange,
    ...(cursor ? { afterSequence: cursor.afterSequence } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  return {
    ...target,
    sourceId: metadata.sourceId,
    sourceRevisionId: "r0",
    generation: metadata.generation,
    sourceRange,
    samples: page.samples,
    integrity: {
      finished: metadata.receipt.finished,
      incompleteTail: metadata.receipt.incompleteTail,
      invalidAtSequence: metadata.receipt.invalidAtSequence ?? null,
      lastSequence: metadata.receipt.lastSequence,
    },
    nextCursor:
      page.nextSequence === null
        ? null
        : {
            ...target,
            sourceId: metadata.sourceId,
            generation: metadata.generation,
            sourceRange,
            afterSequence: page.nextSequence,
          },
  };
}
