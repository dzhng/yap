import { admitMicrosecondRange, round, fromTime, type Issue } from "@yap/composition";
import { z } from "zod";
import { CatalogError } from "./catalog.js";
import { comparePageKeys, type PageBound } from "./ordered-pages.js";
import type { TimeRange } from "./presentation-time.js";
import type {
  TranscriptMetadata,
  GapReason,
  TranscriptGapRecord,
  TranscriptRecords,
  TranscriptWordRecord,
} from "./transcript.js";
import { foldWord, type WordKind } from "./word-kind.js";

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Literal search examines at most this many start words per call, then returns a continuation. */
const searchBudget = 10_000;
const batch = 256;

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new CatalogError("INVALID_PARAMS", `Limit must be 1 to ${maximum}`);
  return result;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CatalogError("INVALID_PARAMS", "Invalid transcript continuation");
  return parsed.data;
}
const wordId = (ordinal: number) => `w${ordinal}`;
type SourceRecord = TranscriptWordRecord | TranscriptGapRecord;
type AfterRecord = { sourceUs: number; ordinal: number | null } | null;

/** Bounded ordered traversal shared by source and project evidence readers. */
class TranscriptTraversal {
  constructor(
    private readonly records: TranscriptRecords,
    private readonly identity: TranscriptMetadata,
  ) {}

  page(spans: readonly TimeRange[] | null, count: number, after: AfterRecord) {
    const records: SourceRecord[] = [];
    let more = false;
    spans: for (const span of spans ?? [null]) {
      // A later row starts after the last one, so it cannot fall in a span that ended by then.
      if (span && after && span.endUs <= after.sourceUs) continue;
      const words = this.spanWords(span, after, Math.min(batch, count + 1));
      const gaps = this.spanGaps(span, after, Math.min(batch, count + 1));
      let word = words.next();
      let gap = gaps.next();
      while (!word.done || !gap.done) {
        if (records.length === count) {
          more = true;
          break spans;
        }
        const takeGap = word.done || (!gap.done && gap.value.startUs < word.value.startUs);
        const row = takeGap ? gap.value! : word.value!;
        records.push(row);
        after = { sourceUs: row.startUs, ordinal: "ordinal" in row ? row.ordinal : null };
        if (takeGap) gap = gaps.next();
        else word = words.next();
      }
    }
    return { records, more, after };
  }

  /** The longest retained estimate bounds lookback; SQL filters all overlapping observations. */
  private *spanWords(
    span: TimeRange | null,
    after: { sourceUs: number; ordinal: number | null } | null,
    fetch: number,
  ) {
    const window: PageBound = {
      key: [span ? Math.max(0, span.startUs - this.identity.maxWordUs) : 0, 0],
      inclusive: true,
    };
    const resume: PageBound | null = after
      ? after.ordinal === null
        ? { key: [after.sourceUs + 1, 0], inclusive: true }
        : { key: [after.sourceUs, after.ordinal], inclusive: false }
      : null;
    let lower = resume && comparePageKeys(resume.key, window.key) >= 0 ? resume : window;
    for (;;) {
      const words = this.records.wordRecords(this.identity, {
        lower,
        ...(span ? { upper: { key: [span.endUs, 0], inclusive: false }, intersects: span } : {}),
        limit: fetch,
      });
      yield* words;
      if (words.length < fetch) return;
      const last = words.at(-1)!;
      lower = { key: [last.startUs, last.ordinal], inclusive: false };
    }
  }

  /** Gaps are disjoint, so only the one starting at or before the span can already cover it. */
  private *spanGaps(span: TimeRange | null, after: AfterRecord, fetch: number) {
    const prior = span
      ? this.records.gapRecords(this.identity, {
          upper: { key: [span.startUs], inclusive: true },
          reverse: true,
          limit: 1,
        })[0]
      : undefined;
    if (
      span &&
      prior &&
      prior.endUs > span.startUs &&
      (!after ||
        prior.startUs > after.sourceUs ||
        (prior.startUs === after.sourceUs && after.ordinal !== null))
    )
      yield prior;
    let lower: PageBound = {
      key: [Math.max(span?.startUs ?? 0, after?.sourceUs ?? 0)],
      inclusive:
        (!span && !after) ||
        !!(after && after.ordinal !== null && after.sourceUs > (span?.startUs ?? -1)),
    };
    for (;;) {
      const gaps = this.records.gapRecords(this.identity, {
        lower,
        ...(span ? { upper: { key: [span.endUs], inclusive: false } } : {}),
        limit: fetch,
      });
      yield* gaps;
      if (gaps.length < fetch) return;
      lower = { key: [gaps.at(-1)!.startUs], inclusive: false };
    }
  }

  search<T>(
    terms: string[],
    count: number,
    after: { startUs: number; ordinal: number } | null,
    project: (phrase: TranscriptWordRecord[]) => T | null,
  ) {
    let lower: PageBound | undefined = after
      ? { key: [after.startUs, after.ordinal], inclusive: false }
      : undefined;
    const entries: T[] = [];
    let examined = 0;
    let last: TranscriptWordRecord | null = null;
    for (;;) {
      // Fetch enough lookahead that a phrase starting in this batch is complete.
      const words = this.records.wordRecords(this.identity, {
        ...(lower ? { lower } : {}),
        limit: batch + terms.length - 1,
      });
      const starts = words.length < batch + terms.length - 1 ? words.length : batch;
      for (let index = 0; index < starts; index++) {
        if (entries.length === count || examined === searchBudget) return { entries, last };
        examined++;
        last = words[index]!;
        const phrase = words.slice(index, index + terms.length);
        if (
          phrase.length !== terms.length ||
          phrase.some((word, offset) => foldWord(word.text) !== terms[offset])
        )
          continue;
        const entry = project(phrase);
        if (entry) entries.push(entry);
      }
      if (starts < batch) return { entries, last: null };
      lower = { key: [last!.startUs, last!.ordinal], inclusive: false };
    }
  }
}

const sourceReference = {
  assetId: z.string().min(1),
  streamId: z.string().min(1),
  acquisitionId: z.string().min(1).nullable(),
  generation: z.string().min(1),
  supportDigest: z.string().min(1),
  afterSourceUs: time,
  afterOrdinal: time.nullable(),
};
const sourcePageCursor = z.strictObject({
  ...sourceReference,
  range: z.strictObject({ startUs: time, endUs: time }).nullable(),
});
const sourceSearchCursor = z.strictObject({
  ...sourceReference,
  text: z.string(),
  afterOrdinal: time,
});
export type SourceTranscriptPageCursor = z.infer<typeof sourcePageCursor>;
export type SourceTranscriptSearchCursor = z.infer<typeof sourceSearchCursor>;
export type SourceTranscriptRow = {
  sourceRange: TimeRange;
  partial: boolean;
} & (
  | {
      type: "word";
      wordId: string;
      ordinal: number;
      text: string;
      kind: WordKind;
      instant?: true;
      confidence: number | null;
      segment: number;
      /** What the publication reported about this word; absent when nothing. */
      issues?: Issue[];
    }
  | { type: "gap"; reason: GapReason }
);
export type SourceTranscriptSearchEntry = { wordIds: string[]; sourceRange: TimeRange };

/** Reads immutable source-clock evidence without inventing an editing revision. */
export class SourceTranscriptRead {
  private readonly reference;
  private readonly traversal: TranscriptTraversal;

  constructor(
    records: TranscriptRecords,
    private readonly metadata: TranscriptMetadata,
  ) {
    if (metadata.owner.kind !== "asset" || metadata.source.kind !== "asset")
      throw new CatalogError("INVALID_EVIDENCE", "Source transcript requires an asset source");
    this.reference = {
      assetId: metadata.owner.id,
      streamId: metadata.source.streamId,
      acquisitionId: metadata.source.acquisitionId ?? null,
      generation: metadata.generation,
      supportDigest: metadata.source.supportDigest,
    };
    this.traversal = new TranscriptTraversal(records, metadata);
  }

  /** The selected source is the caller's filter; its generation and support are the pin. */
  private continuation<T extends typeof this.reference>(cursor: T | undefined): T | undefined {
    const differs = (keys: (keyof typeof this.reference)[]) =>
      cursor !== undefined && keys.some((key) => cursor[key] !== this.reference[key]);
    if (differs(["assetId", "streamId", "acquisitionId"]))
      throw new CatalogError(
        "INVALID_PARAMS",
        "Transcript continuation belongs to another source",
        this.reference,
      );
    if (differs(["generation", "supportDigest"]))
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Transcript continuation belongs to another generation",
        this.reference,
      );
    return cursor;
  }

  /** Unfiltered enumeration returns every observation. Explicit ranges select half-open support;
   * sourceRange remains original and partial reports window clipping. */
  page(input: { range?: TimeRange | undefined; cursor?: unknown; limit?: number | undefined }) {
    const count = limit(input.limit, 250, 1000);
    const cursor = this.continuation(
      input.cursor === undefined ? undefined : parse(sourcePageCursor, input.cursor),
    );
    const range = input.range ?? cursor?.range ?? null;
    if (
      cursor &&
      (cursor.range?.startUs !== range?.startUs || cursor.range?.endUs !== range?.endUs)
    )
      throw new CatalogError("INVALID_PARAMS", "Transcript continuation used another range");
    const whole = { startUs: 0, endUs: round(fromTime(this.metadata.source.durationUs)) };
    // The cursor keeps the requested range, so every page reports the same clamp.
    const admitted = range ? admitMicrosecondRange(range, whole) : null;
    const span = admitted?.range ?? whole;
    const { records, more, after } = this.traversal.page(
      admitted ? [span] : null,
      count,
      cursor ? { sourceUs: cursor.afterSourceUs, ordinal: cursor.afterOrdinal } : null,
    );
    const rows: SourceTranscriptRow[] = records.map((row) => {
      const common = {
        sourceRange: { startUs: row.startUs, endUs: row.endUs },
        partial: row.startUs < span.startUs || row.endUs > span.endUs,
      };
      return "ordinal" in row
        ? {
            type: "word",
            wordId: wordId(row.ordinal),
            ordinal: row.ordinal,
            text: row.text,
            kind: row.kind,
            confidence: row.confidence,
            segment: row.segment,
            ...(row.instant ? { instant: true as const } : {}),
            ...(row.issues ? { issues: row.issues } : {}),
            ...common,
          }
        : { type: "gap", reason: row.reason, ...common };
    });
    return {
      rows,
      issues: admitted?.issues ?? [],
      nextCursor:
        more && after
          ? ({
              ...this.reference,
              range,
              afterSourceUs: after.sourceUs,
              afterOrdinal: after.ordinal,
            } satisfies SourceTranscriptPageCursor)
          : null,
    };
  }

  search(input: { text: string; cursor?: unknown; limit?: number | undefined }) {
    const count = limit(input.limit, 100, 1000);
    const terms = transcriptSearchTerms(input.text);
    const cursor = this.continuation(
      input.cursor === undefined ? undefined : parse(sourceSearchCursor, input.cursor),
    );
    if (cursor && cursor.text !== input.text)
      throw new CatalogError("INVALID_PARAMS", "Transcript continuation searched other text");
    const { entries, last } = this.traversal.search(
      terms,
      count,
      cursor ? { startUs: cursor.afterSourceUs, ordinal: cursor.afterOrdinal } : null,
      (phrase): SourceTranscriptSearchEntry | null => {
        if (phrase.some((word) => word.segment !== phrase[0]!.segment)) return null;
        return {
          wordIds: phrase.map((word) => wordId(word.ordinal)),
          sourceRange: {
            startUs: phrase[0]!.startUs,
            endUs: Math.max(...phrase.map((word) => word.endUs)),
          },
        };
      },
    );
    return {
      entries,
      nextCursor: last
        ? ({
            ...this.reference,
            text: input.text,
            afterSourceUs: last.startUs,
            afterOrdinal: last.ordinal,
          } satisfies SourceTranscriptSearchCursor)
        : null,
    };
  }
}

export function transcriptSearchTerms(text: string) {
  if (typeof text !== "string" || text.length < 1 || text.length > 200)
    throw new CatalogError("INVALID_PARAMS", "Search text must be 1 to 200 characters");
  const terms = text.split(/\s+/).map(foldWord).filter(Boolean);
  if (!terms.length) throw new CatalogError("INVALID_PARAMS", "Search text contains no words");
  return terms;
}
