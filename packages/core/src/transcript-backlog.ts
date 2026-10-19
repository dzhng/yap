import { CatalogError, type Catalog } from "./catalog.js";

export type TranscriptBacklogSelection = Readonly<{
  assetId: string;
  streamId: string;
  acquisitionId?: string;
}>;

export type TranscriptBacklogState = "none" | "pending" | "submitted";

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
};

type BacklogRow = TranscriptBacklogSelection & {
  state: Exclude<TranscriptBacklogState, "none">;
};

function key(selection: TranscriptBacklogSelection): [string, string, string] {
  return [selection.assetId, selection.streamId, selection.acquisitionId ?? ""];
}

/** Durable automatic transcription intent; job identity and execution remain transcript-owned. */
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
        state TEXT NOT NULL CHECK(state IN ('pending','submitted')),
        PRIMARY KEY(assetId, streamId, acquisitionId)
      ) STRICT;
    `);
  }

  enqueue(selection: TranscriptBacklogSelection): void {
    this.catalog.catalog
      .prepare(
        "INSERT OR IGNORE INTO transcript_backlog(assetId,streamId,acquisitionId,state) VALUES(?,?,?,'pending')",
      )
      .run(...key(selection));
  }

  state(selection: TranscriptBacklogSelection): TranscriptBacklogState {
    const row = this.catalog.catalog
      .prepare(
        "SELECT state FROM transcript_backlog WHERE assetId=? AND streamId=? AND acquisitionId=?",
      )
      .get(...key(selection)) as { state: Exclude<TranscriptBacklogState, "none"> } | undefined;
    return row?.state ?? "none";
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
      .prepare("SELECT assetId,streamId,acquisitionId,state FROM transcript_backlog ORDER BY rowid")
      .all() as BacklogRow[];
    for (const row of rows) {
      const selection = {
        assetId: row.assetId,
        streamId: row.streamId,
        ...(row.acquisitionId ? { acquisitionId: row.acquisitionId } : {}),
      };
      let status: TranscriptStatus;
      try {
        status = this.driver.status(selection);
      } catch (error) {
        if (
          error instanceof CatalogError &&
          ["NOT_FOUND", "ASSET_DELETED", "ACQUISITION_NOT_FOUND"].includes(error.code)
        ) {
          this.catalog.catalog
            .prepare(
              "DELETE FROM transcript_backlog WHERE assetId=? AND streamId=? AND acquisitionId=?",
            )
            .run(...key(selection));
          continue;
        }
        throw error;
      }
      if (status.state === "ready" || (status.state === "unavailable" && !status.retryable)) {
        this.catalog.catalog
          .prepare(
            "DELETE FROM transcript_backlog WHERE assetId=? AND streamId=? AND acquisitionId=?",
          )
          .run(...key(selection));
        continue;
      }
      if (status.state === "failed" || status.state === "canceled") {
        if (!status.retryable) continue;
        this.driver.retry(selection);
      } else if (status.state === "not_requested") {
        this.driver.submit(selection, "background");
      } else {
        continue;
      }
      this.catalog.catalog
        .prepare(
          "UPDATE transcript_backlog SET state='submitted' WHERE assetId=? AND streamId=? AND acquisitionId=?",
        )
        .run(...key(selection));
    }
  }
}
