import { basename } from "node:path";
import { CatalogError, type Catalog } from "./catalog.js";
import { DeletionPlans } from "./deletion-plans.js";
import { pageCursor } from "./page-cursor.js";

type RecordingMedia = {
  kind: "recording";
  id: string;
  title: string;
  durationUs: number;
  sizeBytes: number;
  createdAt: string;
};
type ImportedMedia = {
  kind: "asset";
  id: string;
  title: string;
  durationUs: number;
  sizeBytes: number;
  createdAt: string;
};
export type MediaRow = RecordingMedia | ImportedMedia;
export type MediaCursor = string;
export type MediaSizeSubject = { kind: "recording" | "asset"; id: string };

type Position = { createdAt: string; tieBreak: string };

function timeUs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return null;
  const rational = value as { numerator?: unknown; denominator?: unknown };
  if (
    typeof rational.numerator === "number" &&
    typeof rational.denominator === "number" &&
    Number.isFinite(rational.numerator) &&
    Number.isFinite(rational.denominator) &&
    rational.denominator !== 0
  )
    return rational.numerator / rational.denominator;
  return null;
}

function durationUs(metadata: { streams?: unknown }): number {
  if (!Array.isArray(metadata.streams)) return 0;
  let duration = 0;
  for (const stream of metadata.streams) {
    if (!stream || typeof stream !== "object") continue;
    const item = stream as { startUs?: unknown; endUs?: unknown };
    const start = timeUs(item.startUs) ?? 0;
    const end = timeUs(item.endUs);
    if (end !== null && end >= start) duration = Math.max(duration, end - start);
  }
  return Math.round(duration);
}

/** Read-only merged discovery of retained recordings and imported originals. */
export class MediaListing {
  constructor(
    private readonly catalog: Catalog,
    private readonly plans: DeletionPlans,
    private readonly sizeOf: (subject: MediaSizeSubject) => number,
    private readonly recordingListable: (recordingId: string) => boolean,
  ) {}

  list(input: { cursor?: MediaCursor; limit?: number } = {}): {
    media: MediaRow[];
    nextCursor: MediaCursor | null;
  } {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new CatalogError("INVALID_PARAMS", "Media page size must be 1–1000");
    const position = input.cursor
      ? (pageCursor.decode("media.list", input.cursor, {}) as Partial<Position>)
      : undefined;
    if (
      position !== undefined &&
      (!position || typeof position.createdAt !== "string" || typeof position.tieBreak !== "string")
    )
      throw new CatalogError("INVALID_PARAMS", "Invalid media page cursor");

    const rows: MediaRow[] = [];
    const recordings = this.catalog.catalog
      .prepare(
        `SELECT recordingId,createdAt,sourceDurationUs
         FROM recordings
         WHERE state!='canceled'`,
      )
      .all() as Array<{
      recordingId: string;
      createdAt: string;
      sourceDurationUs: number | null;
    }>;
    for (const recording of recordings) {
      if (
        !this.recordingListable(recording.recordingId) ||
        this.plans.isTombstoned("recording", recording.recordingId)
      )
        continue;
      rows.push({
        kind: "recording",
        id: recording.recordingId,
        title: recording.createdAt,
        durationUs: recording.sourceDurationUs ?? 0,
        sizeBytes: 0,
        createdAt: recording.createdAt,
      });
    }

    const assets = this.catalog.catalog
      .prepare(
        `SELECT id,metadata FROM assets
         WHERE EXISTS (SELECT 1 FROM asset_origins WHERE assetId=assets.id AND json_extract(provenance,'$.kind')='import')`,
      )
      .all() as Array<{ id: string; metadata: string }>;
    for (const row of assets) {
      if (this.plans.isTombstoned("asset", row.id)) continue;
      const metadata = JSON.parse(row.metadata) as {
        createdAt: string;
        fileName?: string;
        streams?: unknown;
      };
      const origin = this.catalog.catalog
        .prepare(
          `SELECT provenance FROM asset_origins
           WHERE assetId=? AND json_extract(provenance,'$.kind')='import'
           ORDER BY rowid LIMIT 1`,
        )
        .get(row.id) as { provenance: string } | undefined;
      const provenance = origin ? (JSON.parse(origin.provenance) as { source?: unknown }) : {};
      const source =
        typeof provenance.source === "string" ? provenance.source : (metadata.fileName ?? row.id);
      rows.push({
        kind: "asset",
        id: row.id,
        title: basename(source),
        durationUs: durationUs(metadata),
        sizeBytes: 0,
        createdAt: metadata.createdAt,
      });
    }

    rows.sort((left, right) => {
      const created = right.createdAt.localeCompare(left.createdAt);
      if (created !== 0) return created;
      return this.tieBreak(left).localeCompare(this.tieBreak(right));
    });
    const decodedPosition = position as Position | undefined;
    const start = decodedPosition
      ? rows.findIndex(
          (row) =>
            row.createdAt < decodedPosition.createdAt ||
            (row.createdAt === decodedPosition.createdAt &&
              this.tieBreak(row) > decodedPosition.tieBreak),
        )
      : 0;
    const offset = start < 0 ? rows.length : start;
    const page = rows.slice(offset, offset + limit);
    const last = page.at(-1);
    return {
      media: page.map((row) => ({
        ...row,
        sizeBytes: this.sizeOf(row),
      })),
      nextCursor:
        offset + page.length < rows.length && last
          ? pageCursor.encode(
              "media.list",
              { createdAt: last.createdAt, tieBreak: this.tieBreak(last) },
              {},
            )
          : null,
    };
  }

  private tieBreak(row: MediaRow): string {
    return `${row.kind}:${row.id}`;
  }
}
