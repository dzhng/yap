import { CatalogError } from "./catalog.js";
import type { EvidenceIdentity, SourceTrailRead } from "./evidence.js";
import {
  PresentationEvidence,
  type PresentationPicture,
  type PresentationRecord,
} from "./presentation-evidence.js";
import { analyzeSceneObservations, type VisualScene } from "./scenes.js";
import { planVisualTrail, type PointerResetFloor } from "./trails.js";
import {
  comparePresentationTimes,
  floorMicroseconds,
  type PresentationInstant,
} from "./presentation-time.js";
import type { TimeRange } from "./presentation-time.js";

/** Integer times here are cursor-query cutoffs. Exact event support stays with the caller;
 * a fractional movie event does not claim its picture supports the earlier integer cutoff. */
function pointScene(
  picture: PresentationPicture,
  at: number,
  kept: TimeRange,
  source: PresentationEvidence,
  trailUs = 0,
): VisualScene {
  const sample = {
    requestedSourceUs: at,
    actualSourceUs: picture.actualSourceUs,
    distanceUs: Math.abs(at - picture.actualSourceUs),
    width: picture.width,
    height: picture.height,
    rgbBase64: picture.rgbBase64,
  };
  return {
    ...analyzeSceneObservations(
      {
        sourceWidth: source.receipt.sourceWidth,
        sourceHeight: source.receipt.sourceHeight,
        samples: [sample],
      },
      { kept, range: { startUs: Math.max(kept.startUs, at - trailUs), endUs: at } },
    ),
    reference: sample,
    futureComparison: null,
  };
}

/** Sequential point inspection only; the pointer schedule decides which moments to request. */
export class PresentationPointer {
  private busy = false;
  private readonly current;
  private readonly prior;
  constructor(
    private readonly source: PresentationEvidence,
    private readonly evidence: SourceTrailRead,
    private readonly identity: EvidenceIdentity,
    private readonly signal: AbortSignal,
  ) {
    this.current = source.cursor(signal);
    this.prior = source.cursor(signal);
  }
  private async exclusive<T>(run: () => Promise<T>) {
    if (this.busy)
      throw new CatalogError("INVALID_RANGE", "Pointer inspection requests must be sequential");
    this.busy = true;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }
  at(spanIndex: number, sourceUs: number) {
    return this.exclusive(async () =>
      this.inspect((await this.current.at(spanIndex, sourceUs)).record, sourceUs),
    );
  }
  /** Exact event membership stays separate from the integer observation-query cutoff. */
  atEvent(
    record: PresentationRecord,
    at: PresentationInstant,
    resetFloor: PointerResetFloor,
    trailUs = 0,
  ) {
    return this.exclusive(async () => {
      if (
        comparePresentationTimes(at, record.start) < 0 ||
        comparePresentationTimes(at, record.end) >= 0
      )
        throw new CatalogError(
          "INVALID_RANGE",
          "Pointer event escapes its exact presentation support",
        );
      return {
        at,
        observationCutoffUs: floorMicroseconds(at),
        inspection: await this.inspect(record, floorMicroseconds(at), resetFloor, at, trailUs),
      };
    });
  }
  private async inspect(
    record: PresentationRecord,
    sourceUs: number,
    resetFloor?: PointerResetFloor,
    eventTime?: PresentationInstant,
    trailUs = 0,
  ) {
    const spanIndex = record.spanIndex;
    if (record.empty)
      return {
        kind: "empty" as const,
        requestedSourceUs: sourceUs,
        record,
        pointer: null,
      };
    const kept = this.source.spans[spanIndex]!;
    const plan = await planVisualTrail(
      { kept, requestedSourceUs: sourceUs, trailUs },
      {
        evidence: this.evidence,
        identity: this.identity,
        scene: pointScene(record, sourceUs, kept, this.source, trailUs),
        ...(resetFloor ? { resetFloor } : {}),
        ...(eventTime
          ? { presentationClock: { at: eventTime, sampleTime: record.sampleTime } }
          : {}),
        readScene: async (at) => {
          const priorAt = Math.max(kept.startUs, at);
          const { record: previous } = await this.prior.at(spanIndex, priorAt);
          return previous.empty
            ? { scene: null }
            : {
                scene: pointScene(previous, priorAt, kept, this.source),
                presentationTime: previous.sampleTime,
              };
        },
      },
      this.signal,
    );
    return { kind: "picture" as const, record, plan };
  }
}
