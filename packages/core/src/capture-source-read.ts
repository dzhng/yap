import { JOURNAL_RECORD_BYTES } from "@yap/protocol";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  intervalIndex,
  fromTime,
  timeUs,
  toTime,
  toSignedTime,
  subtract,
  add,
  compare,
  ceil,
  floor,
  sourceAvailability,
  type TimeValue,
  type SignedTimeValue,
  admitMicrosecondRange,
} from "@yap/composition";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import type { SourceEvidenceReader } from "./evidence-read.js";
import { journalCapabilities, type SourceEvidenceMetadata } from "./evidence.js";
import { CatalogError } from "./catalog.js";
import { selectSource, SourceSelectionRead, type SourceSelection } from "./source-selection.js";

// Leave headroom for transport envelopes beneath the public eight-MiB frame bound.
export function boundSourceEvidenceResponse(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024)
    throw new CatalogError(
      "LIMIT_EXCEEDED",
      "Source evidence response exceeds 4MiB; narrow the range, tracks or page limit",
    );
}
export type CaptureSourceInput = SourceSelection & {
  sourceRange?: { startUs: number; endUs: number } | undefined;
  limit?: number | undefined;
  cursor?: unknown;
};
export type CaptureDomain = "events" | "cursor";
type PointKind = "pause" | "geometry" | "cursor" | "mark" | "interruption";
export type CaptureCoverage = {
  kind: string;
  state: "ready" | "unavailable";
  reason: string | null;
};
export type CaptureContext = {
  selection: SourceSelection;
  domain: CaptureDomain;
  durationUs: TimeValue;
  sourceToAssetOffsetUs: SignedTimeValue;
  supportDigest: string;
  evidence: SourceEvidenceMetadata | null;
  coverage: CaptureCoverage[];
  marks: JournalMark[];
};
export type CaptureMarkPoint = {
  hostUs: number;
  globalX: number;
  globalY: number;
  x: number | null;
  y: number | null;
};
/** A live mark as callers read it: `assetUs` is asset microseconds, the clock every reader uses. */
export type CaptureMark = {
  assetUs: number;
  hostUs: number;
  epoch: number;
  id: string;
  kind: "stroke" | "pin" | "click";
  points: CaptureMarkPoint[];
  pin?: number;
  window?: Record<string, unknown>;
};
// The journal's own form: capture-clock `sourceUs` and the order it was written in.
type JournalMark = Omit<CaptureMark, "assetUs"> & { sourceUs: number; sequence: number };
export type CaptureRow = {
  kind: PointKind;
  sourceAtUs: TimeValue;
  captureAtUs: number;
  sourceSequence: number;
  observation: Record<string, unknown>;
};
type Head = { after: [number, number] | null; done: boolean; row: CaptureRow | null };
export type CapturePosition = Record<PointKind, Head>;
export const initialCapture = (): CapturePosition => ({
  cursor: { after: null, done: false, row: null },
  pause: { after: null, done: false, row: null },
  geometry: { after: null, done: false, row: null },
  mark: { after: null, done: false, row: null },
  interruption: { after: null, done: false, row: null },
});
const index = { cursor: "cursor", pause: "pauses", geometry: "geometry", mark: "marks" } as const;
const sourcePositionSchema = z.strictObject({
  after: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable(),
  done: z.boolean(),
});
export const capturePositionSchema = z.strictObject({
  cursor: sourcePositionSchema,
  pause: sourcePositionSchema,
  geometry: sourcePositionSchema,
  mark: sourcePositionSchema,
  interruption: sourcePositionSchema,
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The one capture-to-asset clock conversion: assetUs = captureUs + sourceToAssetOffsetUs. */
function captureToAsset(captureUs: number, sourceToAssetOffsetUs: SignedTimeValue): TimeValue {
  return toTime(add(fromTime(captureUs), fromTime(sourceToAssetOffsetUs)));
}
/** The same conversion as a plain number, for readers that compare and sort times. */
export function captureToAssetUs(
  captureUs: number,
  sourceToAssetOffsetUs: SignedTimeValue,
): number {
  return timeUs(captureToAsset(captureUs, sourceToAssetOffsetUs));
}

/** Explicit capture authority and clock conversion, shared by source and project inspection. */
export class CaptureSourceRead {
  constructor(
    private readonly assets: AssetStore,
    private readonly acquisitions: AcquisitionStore,
    private readonly records: SourceEvidenceReader,
  ) {}
  resolve(
    selection: SourceSelection,
    domain: CaptureDomain,
    sources = new SourceSelectionRead(this.assets, this.acquisitions),
  ): CaptureContext {
    return this.context(sources.get(selection), domain);
  }
  resolveMany(selections: readonly SourceSelection[], domain: CaptureDomain): CaptureContext[] {
    const sources = new SourceSelectionRead(this.assets, this.acquisitions, selections);
    return selections.map((selection) => this.resolve(selection, domain, sources));
  }
  /** A take's live marks in capture order, retractions applied, in asset time: the one reader of marks. */
  marks(selection: SourceSelection): CaptureMark[] {
    const context = this.resolve(selection, "events");
    if (
      !context.evidence ||
      !context.coverage.some((item) => item.kind === "mark" && item.state === "ready")
    )
      return [];
    return this.readMarks(context.evidence).map(({ sequence: _sequence, sourceUs, ...mark }) => ({
      assetUs: captureToAssetUs(sourceUs, context.sourceToAssetOffsetUs),
      ...mark,
    }));
  }
  private context(
    selected: ReturnType<SourceSelectionRead["get"]>,
    domain: CaptureDomain,
  ): CaptureContext {
    const acquisition = selected.acquisition;
    const binding = selected.binding;
    const visual = selected.stream.kind === "video" && binding?.sourceRoles.includes("video");
    const capability = (kind: string, applicable = true): CaptureCoverage => ({
      kind,
      state: acquisition && applicable ? "ready" : "unavailable",
      reason: !acquisition
        ? "capture_context_missing"
        : applicable
          ? null
          : "requires_captured_video",
    });
    const receipt = acquisition?.evidence.receipt;
    const completion = receipt?.completion;
    const terminal = receipt?.lastLifecycle?.state;
    const interruptionReason = !acquisition
      ? "capture_context_missing"
      : receipt?.incompleteTail || receipt?.invalidAtSequence != null
        ? "capture_completion_untrusted"
        : !completion
          ? "capture_completion_unknown"
          : terminal &&
              ["complete", "interrupted", "canceled"].includes(terminal) &&
              terminal !== completion.state
            ? "capture_completion_conflict"
            : null;
    const coverage =
      domain === "cursor"
        ? [capability("cursor", !!visual)]
        : [
            capability("pause"),
            capability("geometry", !!visual),
            capability("mark", !!visual),
            { kind: "unplaced_geometry", state: "unavailable" as const, reason: "no_source_time" },
            {
              kind: "interruption",
              state: interruptionReason ? ("unavailable" as const) : ("ready" as const),
              reason: interruptionReason,
            },
            ...["scene", "cut"].map((kind) => ({
              kind,
              state: "unavailable" as const,
              reason: "unsupported",
            })),
          ];
    const marks: JournalMark[] = [];
    return {
      selection: selected.selection,
      domain,
      durationUs: selected.durationUs,
      sourceToAssetOffsetUs: binding?.sourceToAssetOffsetUs ?? 0,
      supportDigest: selected.supportDigest,
      evidence: acquisition?.evidence ?? null,
      coverage,
      marks,
    };
  }
  private readMarks(identity: SourceEvidenceMetadata): JournalMark[] {
    const rows = [] as { sequence: number; sourceUs: number; data: Record<string, unknown> }[];
    let after: [number, number] | null = null;
    for (;;) {
      const page = this.records.eventRecords(identity, "marks", after, 256);
      if (!page.length) break;
      for (const row of page)
        rows.push({
          sequence: row.sequence,
          sourceUs: row.sourceUs!,
          data: JSON.parse(row.content),
        });
      after = [page.at(-1)!.sourceUs!, page.at(-1)!.sequence];
    }
    const retracted = new Set(
      rows.map((row) => row.data.retracts).filter((id): id is string => typeof id === "string"),
    );
    return rows
      .filter((row) => row.data.retracts == null && !retracted.has(row.data.id as string))
      .map((row) => {
        const data = row.data;
        return {
          sourceUs: row.sourceUs,
          sequence: row.sequence,
          hostUs: data.hostUs as number,
          epoch: data.epoch as number,
          id: data.id as string,
          kind: data.kind as CaptureMark["kind"],
          points: data.points as CaptureMarkPoint[],
          ...(data.pin === undefined ? {} : { pin: data.pin as number }),
          ...(data.window === undefined ? {} : { window: data.window as Record<string, unknown> }),
        };
      });
  }
  /** Pointer history keeps the acquisition clock, independently of an edited clip range.
   * assetUs = captureUs + sourceToAssetOffsetUs; containerUs = assetUs + originUs. */
  presentation(selection: SourceSelection) {
    const context = this.resolve(selection, "cursor");
    if (!context.evidence || context.coverage.some((item) => item.state !== "ready"))
      throw new CatalogError("UNAVAILABLE", "Pointer history requires captured-video authority", {
        coverage: context.coverage,
      });
    const selected = selectSource(this.assets, this.acquisitions, selection);
    const clockOffsetUs = toSignedTime(
      subtract(fromTime(context.sourceToAssetOffsetUs), fromTime(selected.track.sourceOffsetUs)),
    );
    const span = {
      startUs: ceil(
        subtract(fromTime(selected.stream.bounds.startUs), fromTime(context.sourceToAssetOffsetUs)),
      ),
      endUs: ceil(
        subtract(fromTime(selected.stream.bounds.endUs), fromTime(context.sourceToAssetOffsetUs)),
      ),
    };
    if (
      typeof clockOffsetUs !== "number" ||
      !Number.isSafeInteger(clockOffsetUs) ||
      !Number.isSafeInteger(span.startUs) ||
      !Number.isSafeInteger(span.endUs) ||
      span.startUs < 0 ||
      span.endUs <= span.startUs
    )
      throw new CatalogError(
        "INVALID_EVIDENCE",
        "Capture presentation clock exceeds its valid source history",
      );
    return {
      source: selected.track.source,
      streamId: selection.streamId,
      clockOffsetUs,
      spans: [span],
      evidence: context.evidence,
    };
  }
  /** undefined means bounded work exhausted; null means this source window is complete. */
  next(
    context: CaptureContext,
    range: { startUs: number; endUs: number },
    state: CapturePosition,
    budget: { remaining: number },
  ): CaptureRow | null | undefined {
    if (!context.evidence) return null;
    const kinds = context.coverage
      .filter((c) => c.state === "ready")
      .map((c) => c.kind as PointKind);
    const captureRange = {
      startUs: Math.max(
        0,
        ceil(subtract(fromTime(range.startUs), fromTime(context.sourceToAssetOffsetUs))),
      ),
      endUs: Math.max(
        0,
        ceil(subtract(fromTime(range.endUs), fromTime(context.sourceToAssetOffsetUs))),
      ),
    };
    for (const kind of kinds) {
      const position = state[kind];
      if (position.row || position.done) continue;
      if (budget.remaining-- <= 0) return undefined;
      if (kind === "mark") {
        if (!context.marks.length && context.evidence)
          context.marks = this.readMarks(context.evidence);
        const next = context.marks.find(
          (mark) =>
            mark.sourceUs >= captureRange.startUs &&
            mark.sourceUs < captureRange.endUs &&
            (position.after === null ||
              mark.sourceUs > position.after[0] ||
              (mark.sourceUs === position.after[0] && mark.sequence > position.after[1])),
        );
        if (!next) {
          position.done = true;
          continue;
        }
        position.row = {
          kind,
          sourceAtUs: captureToAsset(next.sourceUs, context.sourceToAssetOffsetUs),
          captureAtUs: next.sourceUs,
          sourceSequence: next.sequence,
          observation: (() => {
            const { sequence: _sequence, ...mark } = next;
            return mark as Record<string, unknown>;
          })(),
        };
        continue;
      }
      if (kind === "interruption") {
        position.done = true;
        const completion = context.evidence.receipt.completion;
        if (completion?.state === "interrupted") {
          const source = fromTime(
            captureToAsset(completion.durationUs, context.sourceToAssetOffsetUs),
          );
          if (
            compare(source, fromTime(range.startUs)) > 0 &&
            compare(source, fromTime(range.endUs)) <= 0
          ) {
            position.done = false;
            position.row = {
              kind,
              sourceAtUs: toTime(source),
              captureAtUs: completion.durationUs,
              sourceSequence: completion.sequence,
              observation: {
                state: completion.state,
                durationUs: completion.durationUs,
                ...(completion.failureCode == null ? {} : { failureCode: completion.failureCode }),
                ...(completion.failureMessage == null
                  ? {}
                  : { failureMessage: completion.failureMessage }),
              },
            };
          }
        }
        continue;
      }
      if (captureRange.startUs >= captureRange.endUs) {
        position.done = true;
        continue;
      }
      const row = this.records.pointRecords(
        context.evidence,
        index[kind],
        captureRange,
        position.after,
        1,
      )[0];
      if (!row) {
        position.done = true;
        continue;
      }
      const captureAtUs = row.sourceUs!;
      position.row = {
        kind,
        sourceAtUs: captureToAsset(captureAtUs, context.sourceToAssetOffsetUs),
        captureAtUs,
        sourceSequence: row.sequence,
        observation: JSON.parse(row.content),
      };
    }
    const head = kinds
      .map((kind) => state[kind].row)
      .filter((row): row is CaptureRow => !!row)
      .sort(
        (a, b) =>
          compare(fromTime(a.sourceAtUs), fromTime(b.sourceAtUs)) ||
          a.sourceSequence - b.sourceSequence ||
          a.kind.localeCompare(b.kind),
      )[0];
    if (!head) return null;
    state[head.kind].row = null;
    if (head.kind === "interruption") state[head.kind].done = true;
    state[head.kind].after = [head.captureAtUs, head.sourceSequence];
    return head;
  }
  events(input: CaptureSourceInput) {
    return this.get(input, "events");
  }
  cursor(input: CaptureSourceInput) {
    return this.get(input, "cursor");
  }
  private get(input: CaptureSourceInput, domain: CaptureDomain) {
    const selection = {
      assetId: input.assetId,
      streamId: input.streamId,
      ...(input.acquisitionId === undefined ? {} : { acquisitionId: input.acquisitionId }),
    };
    const context = this.resolve(selection, domain);
    const whole = { startUs: 0, endUs: ceil(fromTime(context.durationUs)) },
      requested = input.sourceRange ?? whole;
    const limit = input.limit ?? (domain === "events" ? 100 : 1000),
      maximum = domain === "events" ? 1000 : 5000;
    const admitted = admitMicrosecondRange(requested, whole),
      range = admitted.range;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
      throw new CatalogError("INVALID_PARAMS", `Limit must be 1 to ${maximum}`);
    // The selection and range are the caller's filters; the resolved evidence is the pin.
    const query = digest({ selection, range }),
      reference = digest({ context, range });
    let position = initialCapture();
    if (input.cursor !== undefined) {
      const cursor = z
        .strictObject({ query: z.string(), reference: z.string(), position: capturePositionSchema })
        .safeParse(input.cursor);
      if (!cursor.success)
        throw new CatalogError("INVALID_PARAMS", "Invalid capture evidence cursor");
      if (cursor.data.query !== query)
        throw new CatalogError("INVALID_PARAMS", "Capture continuation used other filters");
      if (cursor.data.reference !== reference)
        throw new CatalogError("ARTIFACT_CHANGED", "Capture evidence changed");
      for (const kind of Object.keys(position) as PointKind[])
        position[kind] = { ...cursor.data.position[kind], row: null };
    }
    const selected = selectSource(this.assets, this.acquisitions, selection);
    const available = intervalIndex(selected.track.available, (r) => ({
      start: fromTime(r.startUs),
      end: fromTime(r.endUs),
    }));
    const rows: CaptureRow[] = [];
    const budget = { remaining: 128 };
    let more = true;
    let rowBytes = 0;
    while (rows.length < limit) {
      const before = Object.fromEntries(
        Object.entries(position).map(([kind, head]) => [kind, { ...head }]),
      ) as CapturePosition;
      const row = this.next(context, range, position, budget);
      if (row === undefined) break;
      if (row === null) {
        more = false;
        break;
      }
      const at = fromTime(row.sourceAtUs);
      if ((row.kind === "interruption" ? available.before(at) : available(at)).length) {
        const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length && rowBytes + bytes > JOURNAL_RECORD_BYTES) {
          position = before;
          break;
        }
        rowBytes += bytes;
        rows.push(row);
      }
    }
    if (
      domain === "cursor" &&
      input.cursor === undefined &&
      context.evidence &&
      journalCapabilities(context.evidence.receipt.header ?? {})!.cursorSampling.holds &&
      available(fromTime(range.startUs)).length
    ) {
      const captureStart = subtract(
        fromTime(range.startUs),
        fromTime(context.sourceToAssetOffsetUs),
      );
      if (compare(captureStart, fromTime(0)) >= 0) {
        const held = this.records.latestCursor(context.evidence, floor(captureStart));
        if (
          held &&
          compare(
            fromTime(captureToAsset(held.sourceUs, context.sourceToAssetOffsetUs)),
            fromTime(range.startUs),
          ) < 0
        ) {
          const { sequence, ...observation } = held;
          rows.unshift({
            kind: "cursor",
            sourceAtUs: captureToAsset(held.sourceUs, context.sourceToAssetOffsetUs),
            captureAtUs: held.sourceUs,
            sourceSequence: sequence,
            observation,
          });
        }
      }
    }
    const ready = context.coverage.some((c) => c.state === "ready");
    const result = {
      ...selection,
      ...(input.cursor === undefined
        ? {
            available: sourceAvailability(selected.track.available, [range]),
          }
        : {}),
      state: ready ? "ready" : "unavailable",
      context,
      sourceRange: range,
      issues: admitted.issues,
      page: ready
        ? {
            rows,
            nextCursor: more
              ? {
                  query,
                  reference,
                  position: Object.fromEntries(
                    Object.entries(position).map(([kind, { after, done }]) => [
                      kind,
                      { after, done },
                    ]),
                  ),
                }
              : null,
          }
        : null,
    };
    boundSourceEvidenceResponse(result);
    return result;
  }
}
