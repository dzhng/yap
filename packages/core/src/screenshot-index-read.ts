import { CatalogError } from "./catalog.js";
import type {
  IndexRecords,
  ScreenshotIndexMetadata,
  ScreenshotIndexEntry,
} from "./screenshot-index.js";
import { RESPONSE_FRAME_BYTES } from "@yap/protocol";
export type IndexCoverage<D extends IndexRecords = IndexRecords> = D["coverage"] & {
  sequence: number;
};
export type EntryQuery = { after: number; through?: number; limit: number };
export type CoverageQuery = EntryQuery & { ordinal?: number };
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
function limitValue(limit = 100): number {
  if (!integer(limit) || limit < 1 || limit > 1000)
    throw new CatalogError("INVALID_PARAMS", "Index page limit must be 1...1000");
  return limit;
}
function invalid(message: string): never {
  throw new CatalogError("INVALID_EVIDENCE", message);
}
/** Entry and coverage continuation semantics shared by live and portable retained indexes. */
export abstract class ScreenshotIndexReader<D extends IndexRecords = IndexRecords> {
  metadata(identity: D["identity"]): ScreenshotIndexMetadata<D> {
    return this.readMetadata(identity);
  }
  protected abstract readMetadata(identity: D["identity"]): ScreenshotIndexMetadata<D>;
  protected abstract entryRows(
    identity: D["identity"],
    query: EntryQuery,
  ): ScreenshotIndexEntry<D>[];
  protected abstract coverageRows(
    identity: D["identity"],
    query: CoverageQuery,
  ): IndexCoverage<D>[];
  readEntry(identity: D["identity"], ordinal: number): ScreenshotIndexEntry<D> {
    if (!integer(ordinal))
      throw new CatalogError("INVALID_PARAMS", "Index ordinal must be a nonnegative integer");
    const row = this.entryRows(identity, { after: ordinal - 1, through: ordinal, limit: 1 })[0];
    if (!row) throw new CatalogError("NOT_FOUND", "Selected index frame does not exist");
    return row;
  }
  page({
    identity,
    afterOrdinal,
    limit,
  }: {
    identity: D["identity"];
    afterOrdinal?: number;
    limit?: number;
  }) {
    const metadata = this.readMetadata(identity),
      take = limitValue(limit);
    if (afterOrdinal !== undefined) this.readEntry(identity, afterOrdinal);
    const entries = this.entryRows(identity, { after: afterOrdinal ?? -1, limit: take + 1 });
    let more = entries.length > take;
    if (more) entries.pop();
    while (
      entries.length > 1 &&
      Buffer.byteLength(JSON.stringify({ metadata, entries })) > RESPONSE_FRAME_BYTES
    ) {
      entries.pop();
      more = true;
    }
    return { metadata, entries, nextOrdinal: more ? entries.at(-1)!.candidate.ordinal : null };
  }
  coveragePage({
    identity,
    afterSequence,
    candidateOrdinal,
    limit,
  }: {
    identity: D["identity"];
    afterSequence?: number;
    candidateOrdinal?: number;
    limit?: number;
  }) {
    this.readMetadata(identity);
    const take = limitValue(limit);
    if (candidateOrdinal !== undefined) this.readEntry(identity, candidateOrdinal);
    if (afterSequence !== undefined) {
      if (!integer(afterSequence)) invalid("Invalid coverage continuation");
      const anchor = this.coverageRows(identity, {
        after: afterSequence - 1,
        through: afterSequence,
        limit: 1,
      })[0];
      if (!anchor || (candidateOrdinal !== undefined && anchor.ordinal !== candidateOrdinal))
        invalid("Coverage continuation is outside this query");
    }
    const coverage = this.coverageRows(identity, {
      after: afterSequence ?? -1,
      ...(candidateOrdinal === undefined ? {} : { ordinal: candidateOrdinal }),
      limit: take + 1,
    });
    const more = coverage.length > take;
    if (more) coverage.pop();
    return { coverage, nextSequence: more ? coverage.at(-1)!.sequence : null };
  }
}
