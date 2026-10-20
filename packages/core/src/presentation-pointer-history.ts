import { fromTime, timeValueSchema, type TimeValue } from "@yap/composition";
import { setImmediate } from "node:timers/promises";
import { CatalogError } from "./catalog.js";
import type { EvidenceIdentity, SourceTrailRead } from "./evidence.js";
import type { SourceEvidenceReader } from "./evidence-read.js";
import { PresentationEvidence, type PresentationRecord } from "./presentation-evidence.js";
import { PresentationPointer } from "./presentation-pointer.js";
import { compareVisualRasters } from "./scenes.js";
import { trailPolicy, type PointerResetFloor } from "./trails.js";
import {
  ceilMicroseconds,
  comparePresentationTimes as compare,
  microsecondTime,
  type PresentationTime,
  type PresentationInstant,
} from "./presentation-time.js";

type Input = {
  presentation: PresentationEvidence;
  evidence: SourceTrailRead & Pick<SourceEvidenceReader, "exportRecords">;
  identity: EvidenceIdentity;
};
type Event = { at: PresentationTime } & (
  | { kind: "presentation"; record: PresentationRecord }
  | { kind: "cursor" | "pause" }
  | { kind: "geometry"; epoch: number }
);

/** A render attempt shares this budget across every selected source and backward replay. */
export function pointerHistoryBudget(limits: { maxEvents: number; maxSamples: number }) {
  if (
    !Number.isSafeInteger(limits.maxEvents) ||
    limits.maxEvents < 1 ||
    !Number.isSafeInteger(limits.maxSamples) ||
    limits.maxSamples < 0
  )
    throw new CatalogError(
      "INVALID_RANGE",
      "Pointer history requires bounded event and sample work",
    );
  const { maxEvents, maxSamples } = limits;
  let events = 0,
    samples = 0;
  return Object.freeze({
    event() {
      if (++events > maxEvents)
        throw new CatalogError("LIMIT_EXCEEDED", "Pointer schedule exceeds its input-event budget");
    },
    sample() {
      if (++samples > maxSamples)
        throw new CatalogError(
          "LIMIT_EXCEEDED",
          "Pointer history exceeds its sampled-occurrence budget",
        );
    },
  });
}

/** One exact event/reset owner for legacy schedules and sampled project pointers.
 * Backward requests reopen forward readers; the aggregate attempt budgets never reset. */
export class PresentationPointerHistory {
  private streams: AsyncGenerator<Event>[] = [];
  private heads: IteratorResult<Event>[] = [];
  private pointer: PresentationPointer;
  private current: PresentationRecord | undefined;
  private reset: PointerResetFloor = { atSourceUs: 0, allowAtBoundary: true, reason: "kept_start" };
  private geometryEpoch: number | undefined;
  private last: PresentationInstant | undefined;
  private count = 0;
  private busy = false;
  private closed = false;
  constructor(
    private readonly input: Input,
    private readonly signal: AbortSignal,
    private readonly budget: ReturnType<typeof pointerHistoryBudget>,
  ) {
    this.pointer = this.inspector();
  }
  get events() {
    return this.count;
  }
  private inspector() {
    return new PresentationPointer(
      this.input.presentation,
      this.input.evidence,
      this.input.identity,
      this.signal,
    );
  }
  private async exclusive<T>(run: () => Promise<T>) {
    if (this.closed || this.busy)
      throw new CatalogError("INVALID_STATE", "Pointer history is closed or already reading");
    this.busy = true;
    try {
      this.signal.throwIfAborted();
      return await run();
    } finally {
      this.busy = false;
    }
  }
  private async initialize() {
    if (this.streams.length) return;
    const { presentation, evidence, identity } = this.input;
    const signal = this.signal;
    async function* frames(): AsyncGenerator<Event> {
      for await (const record of presentation.records(signal))
        yield { at: record.start, kind: "presentation", record };
    }
    async function* observations(index: "cursor" | "geometry" | "pauses"): AsyncGenerator<Event> {
      for (const [spanIndex, range] of presentation.spans.entries()) {
        signal.throwIfAborted();
        for (const page of evidence.exportRecords(identity, index, range)) {
          for (const row of page) {
            signal.throwIfAborted();
            const at = microsecondTime(row.sourceUs!);
            yield index === "geometry"
              ? { at, kind: "geometry", epoch: JSON.parse(row.content).epoch }
              : { at, kind: index === "pauses" ? "pause" : "cursor" };
          }
          await setImmediate(undefined, { signal });
        }
        if (spanIndex % 256 === 255) await setImmediate(undefined, { signal });
      }
    }
    this.streams = [
      frames(),
      observations("cursor"),
      observations("pauses"),
      observations("geometry"),
    ];
    for (const stream of this.streams) this.heads.push(await stream.next());
  }
  private first() {
    let best = -1;
    for (let i = 0; i < this.heads.length; i++)
      if (
        !this.heads[i]!.done &&
        (best < 0 || compare(this.heads[i]!.value.at, this.heads[best]!.value.at) < 0)
      )
        best = i;
    return best;
  }
  private async peek() {
    await this.initialize();
    const first = this.first();
    const end = microsecondTime(this.input.presentation.spans.at(-1)!.endUs);
    return first < 0 || compare(this.heads[first]!.value.at, end) >= 0
      ? null
      : this.heads[first]!.value.at;
  }
  private advanceReset(
    at: PresentationTime,
    reason: PointerResetFloor["reason"],
    allowAtBoundary = true,
  ) {
    const atSourceUs = ceilMicroseconds(at);
    const pointerAtSourceUs =
      reason === "scene" || reason === "kept_start"
        ? (this.reset.pointerAtSourceUs ?? 0)
        : Math.max(this.reset.pointerAtSourceUs ?? 0, atSourceUs + (allowAtBoundary ? 0 : 1));
    const next = { atSourceUs, pointerAtSourceUs, reason, allowAtBoundary };
    if (
      next.pointerAtSourceUs > (this.reset.pointerAtSourceUs ?? 0) ||
      next.atSourceUs > this.reset.atSourceUs ||
      (next.atSourceUs === this.reset.atSourceUs && !allowAtBoundary)
    )
      this.reset = next;
  }
  private async inspect<T extends PresentationInstant>(at: T, trailUs: number) {
    const record = this.current!;
    const result = await this.pointer.atEvent(record, at, this.reset, trailUs);
    if (
      result.inspection.kind === "picture" &&
      result.inspection.plan.stalePointerComparison?.boundary
    )
      this.advanceReset(record.start, "scene");
    return { at, record, inspection: result.inspection };
  }
  private async advance(at: PresentationTime) {
    this.last = at;
    let selected = this.first();
    do {
      this.budget.event();
      this.count++;
      this.signal.throwIfAborted();
      const event = this.heads[selected]!.value;
      if (event.kind === "presentation") {
        const next = event.record;
        if (!this.current || this.current.spanIndex !== next.spanIndex) {
          this.advanceReset(next.start, "kept_start");
          this.geometryEpoch = this.input.evidence.timedGeometryAt(
            this.input.identity,
            this.input.presentation.spans[next.spanIndex]!.startUs,
          )?.epoch;
        } else if (this.current.empty || next.empty)
          this.advanceReset(next.start, "empty_presentation");
        else if (compareVisualRasters(this.current, next).boundary)
          this.advanceReset(next.start, "scene");
        this.current = next;
      } else if (event.kind === "pause") this.advanceReset(event.at, "pause", false);
      else if (event.kind === "geometry") {
        if (this.geometryEpoch !== undefined && this.geometryEpoch !== event.epoch)
          this.advanceReset(event.at, "geometry");
        this.geometryEpoch = event.epoch;
      }
      this.heads[selected] = await this.streams[selected]!.next();
      selected = this.first();
    } while (selected >= 0 && compare(this.heads[selected]!.value.at, at) === 0);
    return !this.current || compare(at, this.current.end) >= 0 ? null : this.inspect(at, 0);
  }
  next() {
    return this.exclusive(async () => {
      for (;;) {
        const at = await this.peek();
        if (!at) return null;
        const state = await this.advance(at);
        if (state) return state;
      }
    });
  }
  sample(spanIndex: number, sourceUs: TimeValue, trailUs: number) {
    return this.exclusive(async () => {
      const span = this.input.presentation.spans[spanIndex];
      const parsed = timeValueSchema.safeParse(sourceUs);
      const time = parsed.success ? fromTime(parsed.data) : null;
      const at: PresentationInstant | null = time
        ? { value: String(time.numerator), timescale: time.denominator * 1000000n }
        : null;
      if (
        !Number.isSafeInteger(spanIndex) ||
        !at ||
        !span ||
        compare(at, microsecondTime(span.startUs)) < 0 ||
        compare(at, microsecondTime(span.endUs)) >= 0 ||
        !Number.isSafeInteger(trailUs) ||
        trailUs < 0 ||
        trailUs > trailPolicy.maximumUs
      )
        throw new CatalogError(
          "INVALID_RANGE",
          "Pointer sample requires a retained source instant and bounded explicit trail",
        );
      this.budget.sample();
      if (this.last && compare(at, this.last) < 0) await this.restart();
      for (;;) {
        const next = await this.peek();
        if (!next || compare(next, at) > 0) break;
        await this.advance(next);
      }
      if (
        !this.current ||
        this.current.spanIndex !== spanIndex ||
        compare(at, this.current.start) < 0 ||
        compare(at, this.current.end) >= 0
      )
        throw new CatalogError(
          "INVALID_EVIDENCE",
          "No exact presentation supports the pointer request",
        );
      this.last = at;
      return this.inspect(at, trailUs);
    });
  }
  private async release() {
    for (const stream of this.streams) await stream.return(undefined);
    this.streams = [];
    this.heads = [];
  }
  private async restart() {
    await this.release();
    this.current = undefined;
    this.reset = { atSourceUs: 0, allowAtBoundary: true, reason: "kept_start" };
    this.geometryEpoch = undefined;
    this.pointer = this.inspector();
  }
  async close() {
    if (this.closed) return;
    if (this.busy) throw new CatalogError("INVALID_STATE", "Pointer history is already reading");
    this.closed = true;
    await this.release();
  }
}
