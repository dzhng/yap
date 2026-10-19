import { CatalogError, type Catalog } from "./catalog.js";

export type TranscriptBacklogSelection = Readonly<{
  assetId: string;
  streamId: string;
  acquisitionId?: string;
}>;

type TranscriptStatus = {
  state:
    | "not_requested"
    | "queued"
    | "processing"
    | "ready"
    | "failed"
    | "unavailable"
    | "canceled";
  retryable: boolean;
};

export type TranscriptBacklogDriver = {
  readiness(): boolean;
  status(selection: TranscriptBacklogSelection): TranscriptStatus;
  submit(selection: TranscriptBacklogSelection, priority: "background"): void;
  retry(selection: TranscriptBacklogSelection): void;
  /** Where a failure nobody awaits goes; a drain never rejects on one row's behalf. */
  report(error: unknown): void;
};

type BacklogRow = { assetId: string; streamId: string; acquisitionId: string; retries: number };

// An automatic retry is for a transient failure (an update interrupted the job). One that keeps
// failing is left for the caller to retry explicitly rather than rerun after every job.
const automaticRetries = 3;
// Selections a source no longer has: the row can never be satisfied.
const gone = new Set(["NOT_FOUND", "ASSET_DELETED", "ACQUISITION_NOT_FOUND"]);

function key(selection: TranscriptBacklogSelection): [string, string, string] {
  return [selection.assetId, selection.streamId, selection.acquisitionId ?? ""];
}

/**
 * Durable automatic transcription intent; job identity and execution remain transcript-owned. A
 * row exists while the backlog still owes a source a transcript, and leaves once the transcript
 * is ready or can no longer be delivered automatically.
 */
export class TranscriptBacklog {
  private draining: Promise<void> | undefined;

  constructor(
    private readonly catalog: Catalog,
    private readonly driver: TranscriptBacklogDriver,
  ) {
    catalog.catalog.exec(`
      CREATE TABLE IF NOT EXISTS transcript_backlog (
        assetId TEXT NOT NULL,
        streamId TEXT NOT NULL,
        acquisitionId TEXT NOT NULL DEFAULT '',
        retries INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(assetId, streamId, acquisitionId)
      ) STRICT;
    `);
  }

  enqueue(selection: TranscriptBacklogSelection): void {
    this.catalog.catalog
      .prepare(
        "INSERT OR IGNORE INTO transcript_backlog(assetId,streamId,acquisitionId) VALUES(?,?,?)",
      )
      .run(...key(selection));
  }

  /** Whether the backlog still owes this source a transcript. */
  pending(selection: TranscriptBacklogSelection): boolean {
    return Boolean(
      this.catalog.catalog
        .prepare(
          "SELECT 1 FROM transcript_backlog WHERE assetId=? AND streamId=? AND acquisitionId=?",
        )
        .get(...key(selection)),
    );
  }

  /** Drain soon, from any event that may have made progress possible; never rejects. */
  wake(): void {
    queueMicrotask(() => {
      this.drain().catch((error) => this.driver.report(error));
    });
  }

  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainRows().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drainRows(): Promise<void> {
    if (!this.driver.readiness()) return;
    const rows = this.catalog.catalog
      .prepare(
        "SELECT assetId,streamId,acquisitionId,retries FROM transcript_backlog ORDER BY rowid",
      )
      .all() as BacklogRow[];
    for (const row of rows) {
      const selection = {
        assetId: row.assetId,
        streamId: row.streamId,
        ...(row.acquisitionId ? { acquisitionId: row.acquisitionId } : {}),
      };
      try {
        this.drainRow(selection, row.retries);
      } catch (error) {
        if (!(error instanceof CatalogError)) {
          this.driver.report(error);
          continue;
        }
        if (gone.has(error.code)) this.remove(selection);
        // A full job queue refuses every later row too; its next free slot wakes the backlog.
        else if (error.code === "CAPACITY_EXCEEDED") return;
        else this.driver.report(error);
      }
    }
  }

  private drainRow(selection: TranscriptBacklogSelection, retries: number): void {
    const status = this.driver.status(selection);
    switch (status.state) {
      case "not_requested":
        return this.driver.submit(selection, "background");
      case "failed":
      case "canceled":
        if (!status.retryable || retries >= automaticRetries) return this.remove(selection);
        this.driver.retry(selection);
        this.catalog.catalog
          .prepare(
            "UPDATE transcript_backlog SET retries=retries+1 WHERE assetId=? AND streamId=? AND acquisitionId=?",
          )
          .run(...key(selection));
        return;
      case "ready":
        return this.remove(selection);
      case "unavailable":
        // A retryable unavailable source (the model is not prepared) waits for a later wake.
        if (!status.retryable) this.remove(selection);
        return;
      case "queued":
      case "processing":
        return;
    }
  }

  private remove(selection: TranscriptBacklogSelection): void {
    this.catalog.catalog
      .prepare("DELETE FROM transcript_backlog WHERE assetId=? AND streamId=? AND acquisitionId=?")
      .run(...key(selection));
  }
}
