import { CatalogError } from "./catalog.js";
import type { TimeRange } from "./presentation-time.js";

/** Measured visual change, not recognition of a scene's meaning. */
export const scenePolicy = Object.freeze({
  id: "rgb-spatial-change-v3",
  stepUs: 200_000,
  maximumRangeUs: 10_000_000,
  changedChannelDelta: 24,
  stillnessChannelRange: 2,
  gridColumns: 8,
  gridRows: 8,
  activeCellFraction: 0.05,
  broadPixelFraction: 0.3,
  spatialPixelFraction: 0.04,
  broadCellFraction: 0.5,
});
/** The widest sample grid a scene interval yields: a predecessor, each step through it, and its endpoint. */
export const sceneSampleLimits = Object.freeze({
  count: scenePolicy.maximumRangeUs / scenePolicy.stepUs + 2,
  spanUs: scenePolicy.maximumRangeUs + scenePolicy.stepUs,
});
export type VisualSample = {
  requestedSourceUs: number;
  actualSourceUs: number;
  distanceUs: number;
  width: number;
  height: number;
  rgbBase64: string;
};
export type VisualObservations = {
  sourceWidth: number;
  sourceHeight: number;
  samples: VisualSample[];
};
export type VisualSampler = (
  request: { ownerId: string; source: string; kept: TimeRange; atSourceUs: number[] },
  signal: AbortSignal,
) => Promise<VisualObservations>;
export type VisualComparison = {
  previousActualSourceUs: number;
  actualSourceUs: number;
  changedPixelFraction: number;
  changedCellFraction: number;
  meanAbsoluteChannelDifference: number;
  boundary: boolean;
};
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
function interval(range: TimeRange): void {
  if (!integer(range.startUs) || !integer(range.endUs) || range.endUs <= range.startUs)
    throw new CatalogError("INVALID_RANGE", "Scene analysis requires a nonempty source interval");
}
type VisualRaster = Pick<VisualSample, "width" | "height" | "rgbBase64">;
function rasterBytes(sample: VisualRaster): Buffer {
  if (
    !Number.isInteger(sample.width) ||
    sample.width < 1 ||
    sample.width > 64 ||
    !Number.isInteger(sample.height) ||
    sample.height < 1 ||
    sample.height > 64
  )
    invalid("Invalid visual sample dimensions");
  const bytes = sample.width * sample.height * 3;
  if (sample.rgbBase64.length !== 4 * Math.ceil(bytes / 3)) invalid("Invalid RGB byte length");
  const result = Buffer.from(sample.rgbBase64, "base64");
  if (result.length !== bytes || result.toString("base64") !== sample.rgbBase64)
    invalid("Invalid RGB encoding");
  return result;
}
function pixels(sample: VisualSample): Buffer {
  if (
    !integer(sample.requestedSourceUs) ||
    !integer(sample.actualSourceUs) ||
    sample.distanceUs !== Math.abs(sample.actualSourceUs - sample.requestedSourceUs)
  )
    invalid("Invalid visual sample timing or dimensions");
  return rasterBytes(sample);
}

/** Explicit pairs make chunk continuity and repeated held frames share one comparison policy. */
export function compareVisualSamples(
  previous: VisualSample,
  current: VisualSample,
): VisualComparison {
  const before = pixels(previous),
    after = pixels(current);
  if (
    current.actualSourceUs <= previous.actualSourceUs ||
    current.width !== previous.width ||
    current.height !== previous.height
  )
    invalid("Visual comparison requires later source time and matching raster dimensions");
  return {
    previousActualSourceUs: previous.actualSourceUs,
    actualSourceUs: current.actualSourceUs,
    ...measureVisualChange(before, after, current.width, current.height),
  };
}

/** Pixel policy is independent of the clock; exact presentation timestamps can round alike. */
export function compareVisualRasters(previous: VisualRaster, current: VisualRaster) {
  const before = rasterBytes(previous),
    after = rasterBytes(current);
  if (previous.width !== current.width || previous.height !== current.height)
    invalid("Visual comparison requires matching raster dimensions");
  return measureVisualChange(before, after, current.width, current.height);
}
function measureVisualChange(before: Buffer, after: Buffer, width: number, height: number) {
  const columns = Math.min(scenePolicy.gridColumns, width);
  const rows = Math.min(scenePolicy.gridRows, height);
  const changed = new Uint16Array(columns * rows),
    total = new Uint16Array(columns * rows);
  let changedPixels = 0,
    channelDifference = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const differences = [0, 1, 2].map((channel) =>
        Math.abs(before[offset + channel]! - after[offset + channel]!),
      );
      channelDifference += differences[0]! + differences[1]! + differences[2]!;
      const cell = Math.floor((y * rows) / height) * columns + Math.floor((x * columns) / width);
      total[cell] = total[cell]! + 1;
      if (Math.max(...differences) >= scenePolicy.changedChannelDelta) {
        changedPixels++;
        changed[cell] = changed[cell]! + 1;
      }
    }
  }
  const changedPixelFraction = changedPixels / (width * height);
  const changedCellFraction =
    Array.from(changed).filter((count, i) => count / total[i]! >= scenePolicy.activeCellFraction)
      .length / changed.length;
  return {
    changedPixelFraction,
    changedCellFraction,
    meanAbsoluteChannelDifference: channelDifference / (before.length * 255),
    boundary:
      changedPixelFraction >= scenePolicy.broadPixelFraction ||
      (changedPixelFraction >= scenePolicy.spatialPixelFraction &&
        changedCellFraction >= scenePolicy.broadCellFraction),
  };
}

/** Whole-recording chunks can pass the preceding chunk's final observation without a second detector. */
export function analyzeVisualSamples(samples: readonly VisualSample[], previous?: VisualSample) {
  if (samples.length === 0 || samples.length > sceneSampleLimits.count)
    invalid(`Visual analysis requires 1...${sceneSampleLimits.count} observations`);
  const comparisons: VisualComparison[] = [];
  let last = previous;
  if (last) pixels(last);
  for (const sample of samples) {
    pixels(sample);
    if (last) {
      if (
        sample.requestedSourceUs <= last.requestedSourceUs ||
        sample.actualSourceUs < last.actualSourceUs
      )
        invalid("Visual observations must progress in request and source order");
      if (sample.actualSourceUs === last.actualSourceUs) {
        if (
          sample.width !== last.width ||
          sample.height !== last.height ||
          sample.rgbBase64 !== last.rgbBase64
        )
          invalid("A held source sample cannot change its pixels");
      } else comparisons.push(compareVisualSamples(last, sample));
    }
    last = sample;
  }
  return { policy: scenePolicy.id, comparisons, lastSample: last! };
}

/** Source-anchored grid plus one predecessor and endpoint; selection remains native's job. */
export function sceneSampleTimes(range: TimeRange, kept: TimeRange): number[] {
  interval(range);
  interval(kept);
  if (
    range.startUs < kept.startUs ||
    range.endUs > kept.endUs ||
    range.endUs - range.startUs > scenePolicy.maximumRangeUs
  )
    throw new CatalogError(
      "INVALID_RANGE",
      "Scene interval must fit the kept span and ten-second limit",
    );
  const step = scenePolicy.stepUs;
  const first = Math.max(kept.startUs, Math.ceil(range.startUs / step) * step - step);
  const endpoint = Math.min(range.endUs, kept.endUs - 1);
  const times = [first];
  for (let at = (Math.floor(first / step) + 1) * step; at <= endpoint; at += step) times.push(at);
  if (times.at(-1)! < endpoint) times.push(endpoint);
  return times;
}

export async function observeVisualSamples(
  request: Parameters<VisualSampler>[0],
  sample: VisualSampler,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const observed = await sample(request, signal);
  signal.throwIfAborted();
  if (
    !Number.isSafeInteger(observed.sourceWidth) ||
    observed.sourceWidth < 1 ||
    !Number.isSafeInteger(observed.sourceHeight) ||
    observed.sourceHeight < 1 ||
    observed.samples.length !== request.atSourceUs.length
  )
    invalid("Incomplete visual observation batch");
  for (const [index, value] of observed.samples.entries()) {
    if (
      value.requestedSourceUs !== request.atSourceUs[index] ||
      value.actualSourceUs < request.kept.startUs ||
      value.actualSourceUs >= request.kept.endUs
    )
      invalid("Visual sample escapes its requested grid or retained span");
  }
  return observed;
}

export function analyzeSceneObservations(
  observed: VisualObservations,
  request: { kept: TimeRange; range: TimeRange },
) {
  const analyzed = analyzeVisualSamples(observed.samples);
  return {
    ...analyzed,
    range: request.range,
    kept: request.kept,
    sourceWidth: observed.sourceWidth,
    sourceHeight: observed.sourceHeight,
    coverage: observed.samples.map(
      ({ requestedSourceUs, actualSourceUs, distanceUs, width, height }) => ({
        requestedSourceUs,
        actualSourceUs,
        distanceUs,
        width,
        height,
      }),
    ),
    boundaries: analyzed.comparisons
      .filter(
        (pair) =>
          pair.boundary &&
          pair.actualSourceUs >= request.range.startUs &&
          pair.actualSourceUs <= request.range.endUs,
      )
      .map((pair) => ({ kind: "scene" as const, atSourceUs: pair.actualSourceUs })),
  };
}

export type VisualScene = ReturnType<typeof analyzeSceneObservations> & {
  reference: VisualSample;
  futureComparison: VisualComparison | null;
};

/** Canonical source evidence keeps its rounding envelope across every chunk and coverage window. */
export class SourceSceneAnalysis {
  private throughUs = 0;
  private minimum: Buffer | undefined;
  private maximum: Buffer | undefined;
  private runStartUs = 0;
  private recent: { sample: VisualSample; stillnessRunStartUs: number }[] = [];

  constructor(
    private readonly ownerId: string,
    private readonly source: string,
    private readonly durationUs: number,
    private readonly sample: VisualSampler,
  ) {}

  async analyze(range: TimeRange, signal: AbortSignal) {
    const kept = { startUs: 0, endUs: this.durationUs };
    const atSourceUs = sceneSampleTimes(range, kept);
    if (range.startUs !== this.throughUs)
      invalid("Canonical scene analysis requires contiguous source chunks");
    const observed = await observeVisualSamples(
      { ownerId: this.ownerId, source: this.source, kept, atSourceUs },
      this.sample,
      signal,
    );
    // Canonical scene boundaries derive from comparisons; the frame-local range filter does not apply.
    const { policy, comparisons, sourceWidth, sourceHeight, ...observation } =
      analyzeSceneObservations(observed, { range, kept });
    const coverage = observed.samples.map((sample, index) => {
      const last = this.recent.at(-1);
      let stillnessRunStartUs: number;
      if (last && sample.requestedSourceUs <= last.sample.requestedSourceUs) {
        // Adjacent chunks repeat the preceding grid point and their shared endpoint.
        const overlap = this.recent.find(
          (point) => point.sample.requestedSourceUs === sample.requestedSourceUs,
        );
        if (
          !overlap ||
          overlap.sample.actualSourceUs !== sample.actualSourceUs ||
          overlap.sample.rgbBase64 !== sample.rgbBase64
        )
          invalid("Overlapping scene observations changed");
        stillnessRunStartUs = overlap.stillnessRunStartUs;
      } else {
        const rgb = pixels(sample);
        if (
          last &&
          (sample.actualSourceUs < last.sample.actualSourceUs ||
            sample.width !== last.sample.width ||
            sample.height !== last.sample.height)
        )
          invalid("Canonical visual observations changed order or dimensions");
        if (
          last &&
          sample.actualSourceUs === last.sample.actualSourceUs &&
          sample.rgbBase64 !== last.sample.rgbBase64
        )
          invalid("A held source sample cannot change its pixels");
        let within = !!this.minimum;
        if (within) {
          for (let i = 0; i < rgb.length; i++) {
            if (
              Math.max(this.maximum![i]!, rgb[i]!) - Math.min(this.minimum![i]!, rgb[i]!) >
              scenePolicy.stillnessChannelRange
            ) {
              within = false;
              break;
            }
          }
        }
        if (!within) {
          this.minimum = Buffer.from(rgb);
          this.maximum = Buffer.from(rgb);
          this.runStartUs = sample.actualSourceUs;
        } else {
          for (let i = 0; i < rgb.length; i++) {
            this.minimum![i] = Math.min(this.minimum![i]!, rgb[i]!);
            this.maximum![i] = Math.max(this.maximum![i]!, rgb[i]!);
          }
        }
        stillnessRunStartUs = this.runStartUs;
        this.recent.push({ sample, stillnessRunStartUs });
        if (this.recent.length > 2) this.recent.shift();
      }
      return { ...observation.coverage[index]!, stillnessRunStartUs };
    });
    this.throughUs = range.endUs;
    return { policy, range, kept, sourceWidth, sourceHeight, comparisons, coverage };
  }
}

/** A future video selection can veto past pointing; it never advances the cursor's clock. */
export async function analyzeFrameScene(
  request: {
    ownerId: string;
    source: string;
    kept: TimeRange;
    requestedSourceUs: number;
    trailUs: number;
  },
  sample: VisualSampler,
  signal: AbortSignal,
) {
  interval(request.kept);
  const at = request.requestedSourceUs;
  if (
    !integer(at) ||
    at < request.kept.startUs ||
    at >= request.kept.endUs ||
    !integer(request.trailUs) ||
    request.trailUs > scenePolicy.maximumRangeUs
  )
    throw new CatalogError(
      "INVALID_RANGE",
      "Frame scene evidence requires a retained time and at most ten seconds of history",
    );
  const range = { startUs: Math.max(request.kept.startUs, at - request.trailUs), endUs: at };
  const local = analyzeSceneObservations(
    await observeVisualSamples(
      {
        ownerId: request.ownerId,
        source: request.source,
        kept: request.kept,
        atSourceUs: range.startUs === at ? [at] : sceneSampleTimes(range, request.kept),
      },
      sample,
      signal,
    ),
    { kept: request.kept, range },
  );
  let reference = local.lastSample;
  let futureComparison: VisualComparison | null = null;
  if (local.lastSample.actualSourceUs > at) {
    // Narrow only the analysis search prefix, so the same nearest selector finds the last
    // sample at or before the request. Final image selection retains the original kept span.
    let past: VisualObservations | undefined;
    try {
      past = await observeVisualSamples(
        {
          ownerId: request.ownerId,
          source: request.source,
          kept: { startUs: request.kept.startUs, endUs: at + 1 },
          atSourceUs: [at],
        },
        sample,
        signal,
      );
    } catch (error) {
      // A span that starts between frames, as after a cut, shows nothing before its first retained
      // picture: that picture is the reference, with no earlier state to compare.
      if (!(error instanceof CatalogError && error.code === "UNAVAILABLE")) throw error;
    }
    if (past) {
      if (past.sourceWidth !== local.sourceWidth || past.sourceHeight !== local.sourceHeight)
        invalid("Reference image dimensions changed within one immutable source");
      reference = past.samples[0]!;
      futureComparison = compareVisualSamples(reference, local.lastSample);
    }
  }
  return { ...local, reference, futureComparison };
}
