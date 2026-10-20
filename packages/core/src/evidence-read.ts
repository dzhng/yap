import { EVIDENCE_BATCH_BYTES, type PageBound, type PageQuery } from "./ordered-pages.js";
import { CatalogError } from "./catalog.js";
import type { EvidenceIdentity, RecordRow, RawCursorSample, SourceGeometry } from "./evidence.js";
import type { TimeRange } from "./presentation-time.js";

export const evidenceIndexes = [
  "cursor",
  "cursorSequence",
  "geometry",
  "unplaced",
  "pauses",
  "marks",
  "narration",
  "system",
] as const;
export type EvidenceIndex = (typeof evidenceIndexes)[number];
export type RecordQuery = Omit<PageQuery, "index"> & { index: EvidenceIndex };
const max = Number.MAX_SAFE_INTEGER;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
const content = <T>(row: RecordRow): T => ({ ...JSON.parse(row.content), sequence: row.sequence });
export function recordKey(index: EvidenceIndex, row: RecordRow): number[] {
  if (index === "cursorSequence" || index === "unplaced") return [row.sequence];
  return [row.sourceUs!, row.sequence];
}

/** One query semantics owner; storage adapters only provide bounded ordered records. */
export abstract class SourceEvidenceReader {
  abstract cursorSampling(identity: EvidenceIdentity): { intervalUs: number; holds: boolean };
  protected abstract requireComplete(identity: EvidenceIdentity): void;
  protected abstract records(identity: EvidenceIdentity, query: RecordQuery): RecordRow[];

  /** Export normalized records through the same orders used by inspection. */
  *exportRecords(
    identity: EvidenceIdentity,
    index: EvidenceIndex,
    range?: TimeRange,
  ): Generator<RecordRow[]> {
    this.requireComplete(identity);
    if (range) {
      this.timingRange(range);
      if (!["cursor", "geometry", "pauses", "marks"].includes(index))
        invalid("Source ranges require cursor, geometry, pause or mark records");
    }
    let lower: PageBound | undefined = range
      ? { key: [range.startUs, 0], inclusive: true }
      : undefined;
    const upper: PageBound | undefined = range
      ? { key: [range.endUs, 0], inclusive: false }
      : undefined;
    for (;;) {
      const rows = this.records(identity, {
        index,
        ...(lower ? { lower } : {}),
        ...(upper ? { upper } : {}),
        limit: 256,
        maxBytes: EVIDENCE_BATCH_BYTES,
      });
      if (!rows.length) return;
      yield rows;
      lower = { key: recordKey(index, rows.at(-1)!), inclusive: false };
    }
  }
  /** Ordered point markers for bounded timeline projection; null-time geometry stays separate. */
  eventRecords(
    identity: EvidenceIdentity,
    index: "pauses" | "geometry" | "marks",
    after: readonly [number, number] | null,
    limit: number,
  ): RecordRow[] {
    if (
      !integer(limit) ||
      limit < 1 ||
      limit > 256 ||
      (after !== null && (after.length !== 2 || after.some((value) => !integer(value))))
    )
      invalid("Invalid timeline source record page");
    this.requireComplete(identity);
    return this.records(identity, {
      index,
      limit,
      ...(after ? { lower: { key: after, inclusive: false } } : {}),
    });
  }
  /** Source-window point seeks share the persisted timestamp/sequence indexes. */
  pointRecords(
    identity: EvidenceIdentity,
    index: "cursor" | "pauses" | "geometry",
    range: TimeRange,
    after: readonly [number, number] | null,
    limit: number,
  ): RecordRow[] {
    this.timingRange(range);
    if (
      !integer(limit) ||
      limit < 1 ||
      limit > 256 ||
      (after && (after.length !== 2 || after.some((value) => !integer(value))))
    )
      invalid("Invalid source point page");
    this.requireComplete(identity);
    const resume = after && after[0] >= range.startUs;
    return this.records(identity, {
      index,
      limit,
      lower: { key: resume ? after : [range.startUs, 0], inclusive: !resume },
      upper: { key: [range.endUs, 0], inclusive: false },
    });
  }
  private timingRange(range: TimeRange) {
    if (!integer(range.startUs) || !integer(range.endUs) || range.endUs < range.startUs)
      throw new CatalogError("INVALID_RANGE", "Invalid source timing range");
  }
  page(input: EvidenceIdentity & { range: TimeRange; afterSequence?: number; limit?: number }): {
    samples: (RawCursorSample & { sequence: number })[];
    nextSequence: number | null;
  } {
    const { range, afterSequence } = input,
      limit = input.limit ?? 1000;
    if (
      !integer(range.startUs) ||
      !integer(range.endUs) ||
      range.endUs <= range.startUs ||
      !integer(limit) ||
      limit < 1 ||
      limit > 5000 ||
      (afterSequence != null && (!integer(afterSequence) || afterSequence < 1))
    )
      invalid("Invalid cursor page range or limit");
    this.requireComplete(input);
    let afterUs = range.startUs,
      after = 0;
    if (afterSequence != null) {
      const bound = { key: [afterSequence], inclusive: true };
      const anchor = this.records(input, {
        index: "cursorSequence",
        lower: bound,
        upper: bound,
        limit: 1,
      })[0];
      if (!anchor || anchor.sourceUs! < range.startUs || anchor.sourceUs! >= range.endUs)
        invalid("Cursor continuation is outside this range");
      afterUs = anchor.sourceUs!;
      after = afterSequence;
    }
    const rows = this.records(input, {
      index: "cursor",
      lower: { key: [afterUs, after], inclusive: false },
      upper: { key: [range.endUs, 0], inclusive: false },
      limit: limit + 1,
    });
    const more = rows.length > limit;
    if (more) rows.pop();
    return {
      samples: rows.map((row) => content<RawCursorSample & { sequence: number }>(row)),
      nextSequence: more ? rows.at(-1)!.sequence : null,
    };
  }
  /** Outside/unknown observations supersede older visible pointers. */
  latestCursor(
    identity: EvidenceIdentity,
    atSourceUs: number,
  ): (RawCursorSample & { sequence: number }) | null {
    return this.neighbor(identity, "cursor", atSourceUs, false);
  }
  /** A timed predecessor cannot resolve later null-time geometry. */
  timedGeometryAt(identity: EvidenceIdentity, atSourceUs: number): SourceGeometry | null {
    return this.neighbor(identity, "geometry", atSourceUs, false);
  }
  nextTimedGeometry(identity: EvidenceIdentity, atSourceUs: number): SourceGeometry | null {
    return this.neighbor(identity, "geometry", atSourceUs, true);
  }
  private neighbor<T>(
    identity: EvidenceIdentity,
    index: "cursor" | "geometry",
    at: number,
    next: boolean,
  ): T | null {
    this.timingRange({ startUs: at, endUs: at });
    this.requireComplete(identity);
    const bound = { key: [at, max], inclusive: !next };
    const row = this.records(identity, {
      index,
      ...(next ? { lower: bound } : { upper: bound }),
      reverse: !next,
      limit: 1,
    })[0];
    return row ? content<T>(row) : null;
  }
  geometryChanges(identity: EvidenceIdentity, range: TimeRange): SourceGeometry[] {
    return this.boundaries(identity, "geometry", range);
  }
  /** Null-time placements stay in delivery order; never promote them to source zero. */
  unplacedGeometry(
    identity: EvidenceIdentity,
    range: { afterSequence: number; beforeSequence?: number },
  ): SourceGeometry[] {
    const end = range.beforeSequence ?? max;
    if (!integer(range.afterSequence) || !integer(end) || end <= range.afterSequence)
      invalid("Invalid geometry sequence range");
    this.requireComplete(identity);
    const rows = this.allRecords(identity, {
      index: "unplaced",
      lower: { key: [range.afterSequence], inclusive: false },
      upper: { key: [end], inclusive: false },
    });
    return rows.map((row) => content<SourceGeometry>(row));
  }
  /** Both retained boundaries include their markers without adding media duration. */
  pauseBoundaries(
    identity: EvidenceIdentity,
    range: TimeRange,
  ): { atSourceUs: number; elapsedPauseUs: number; sequence: number }[] {
    return this.boundaries(identity, "pauses", range);
  }
  private boundaries<T>(
    identity: EvidenceIdentity,
    index: "pauses" | "geometry",
    range: TimeRange,
  ): T[] {
    this.timingRange(range);
    this.requireComplete(identity);
    const rows = this.allRecords(identity, {
      index,
      lower: { key: [range.startUs, 0], inclusive: true },
      upper: { key: [range.endUs, max], inclusive: true },
    });
    return rows.map((row) => content<T>(row));
  }
  private allRecords(identity: EvidenceIdentity, query: Omit<RecordQuery, "limit">): RecordRow[] {
    const result: RecordRow[] = [];
    let lower = query.lower;
    for (;;) {
      const rows = this.records(identity, { ...query, ...(lower ? { lower } : {}), limit: 256 });
      if (!rows.length) return result;
      result.push(...rows);
      if (rows.length < 256) return result;
      lower = { key: recordKey(query.index, rows.at(-1)!), inclusive: false };
    }
  }
  hasAudio(identity: EvidenceIdentity, role: "narration" | "system"): boolean {
    this.requireComplete(identity);
    return this.records(identity, { index: role, limit: 1 }).length !== 0;
  }
  /** One preceding coalesced interval can overlap the requested half-open range. */
  audio(identity: EvidenceIdentity, role: "narration" | "system", range: TimeRange): TimeRange[] {
    this.timingRange(range);
    this.requireComplete(identity);
    if (range.startUs === range.endUs) return [];
    const bound = { key: [range.startUs, max], inclusive: true };
    const prior = this.records(identity, { index: role, upper: bound, reverse: true, limit: 1 });
    const rows = this.allRecords(identity, {
      index: role,
      lower: { ...bound, inclusive: false },
      upper: { key: [range.endUs, 0], inclusive: false },
    });
    const intervals = [...prior, ...rows]
      .map((row) => {
        const interval = JSON.parse(row.content) as TimeRange;
        return {
          startUs: Math.max(interval.startUs, range.startUs),
          endUs: Math.min(interval.endUs, range.endUs),
        };
      })
      .filter((interval) => interval.startUs < interval.endUs);
    return intervals;
  }
}
