import { Catalog, CatalogError } from "./catalog.js";
import { pageCursor } from "./page-cursor.js";
import {
  readCapturePublication,
  type CapturePublication,
  type CapturePublishedSource,
  type CapturePublicationState,
} from "./capture-publication.js";
export type RecordingState =
  | "preparing"
  | "recording"
  | "paused"
  | "finalizing"
  | "complete"
  | "interrupted"
  | "canceled";
export type FinalizationError = Readonly<{ code: string; message: string; retryable: boolean }>;
export type Recording = Readonly<{
  recordingId: string;
  sourceId: string;
  camera: Readonly<{ sourceId: string; deviceId: string }> | null;
  publication: CapturePublication | null;
  creationSequence: number;
  createdAt: string;
  state: RecordingState;
  lifecycleSequence: number;
  interruptionReason: string | null;
  interruptionMessage: string | null;
  finalizationError: FinalizationError | null;
  sourceDurationUs: number | null;
}>;
/** A capture session reports its device transitions here; core never derives them itself. */
export type LifecycleEvent = Readonly<{
  sourceId: string;
  sequence: number;
  publication?: unknown;
}> &
  Readonly<
    | { state: "recording" | "paused" | "canceled" }
    | { state: "finalizing"; finalizationError?: FinalizationError | null }
    | { state: "complete"; sourceDurationUs: number }
    | {
        state: "interrupted";
        reason: string;
        message?: string | null;
        sourceDurationUs: number | null;
      }
  >;
const nextStates: Readonly<Record<RecordingState, readonly RecordingState[]>> = {
  preparing: ["recording", "finalizing", "interrupted", "canceled"],
  recording: ["recording", "paused", "finalizing", "interrupted", "canceled"],
  paused: ["paused", "recording", "finalizing", "interrupted", "canceled"],
  finalizing: ["finalizing", "complete", "interrupted", "canceled"],
  complete: ["complete"],
  interrupted: ["interrupted"],
  canceled: ["canceled"],
};
const recordingColumns =
  "recordingId,sourceId,cameraSourceId,cameraDeviceId,publication,creationSequence,createdAt,state,lifecycleSequence,interruptionReason,interruptionMessage,finalizationError,sourceDurationUs";
type RecordingRow = Omit<Recording, "finalizationError" | "camera" | "publication"> & {
  finalizationError: string | null;
  publication: string | null;
  cameraSourceId: string | null;
  cameraDeviceId: string | null;
};
function readRecording(row: RecordingRow): Recording {
  const { cameraSourceId, cameraDeviceId, ...recording } = row;
  return {
    ...recording,
    camera:
      cameraSourceId === null ? null : { sourceId: cameraSourceId, deviceId: cameraDeviceId! },
    publication:
      row.publication === null
        ? null
        : (JSON.parse(row.publication) as CapturePublicationState).observation,
    finalizationError:
      row.finalizationError === null
        ? null
        : (JSON.parse(row.finalizationError) as FinalizationError),
  };
}
/** A settled take can no longer leave its state, so a missing source is final rather than pending. */
export function isSettled(state: RecordingState): boolean {
  return nextStates[state].every((next) => next === state);
}
const unsettledStates = (Object.keys(nextStates) as RecordingState[]).filter(
  (state) => !isSettled(state),
);
export type RecordingCursor = string;
/** What a caller asks a take to be allocated for, canonically, so a replay can be recognized. */
export type AllocationRequest = Readonly<{
  requestId: string;
  arguments: string;
  cameraDeviceId?: string;
}>;
/** A take's identity, and whether this request had already been given it. */
export type Allocation = Readonly<{ recording: Recording; replay: boolean }>;
/** Durable take facts on the one catalog connection; editorial state belongs to its consumer. */
export class CaptureStore extends Catalog {
  constructor(
    path: string,
    protected readonly providers: { now: () => string; newId: () => string },
    busyTimeoutMs = 1000,
  ) {
    super(path, busyTimeoutMs);
    this.catalog.exec(`
   CREATE TABLE IF NOT EXISTS recordings (
    creationSequence INTEGER PRIMARY KEY AUTOINCREMENT,recordingId TEXT UNIQUE NOT NULL,sourceId TEXT UNIQUE NOT NULL,
    cameraSourceId TEXT UNIQUE,cameraDeviceId TEXT,publication TEXT,
    allocationRequestId TEXT UNIQUE,allocationArguments TEXT,createdAt TEXT NOT NULL,state TEXT NOT NULL,lifecycleSequence INTEGER NOT NULL,
    interruptionReason TEXT,interruptionMessage TEXT,finalizationError TEXT,sourceDurationUs INTEGER,
    CHECK ((cameraSourceId IS NULL)=(cameraDeviceId IS NULL))
   ) STRICT;
   CREATE INDEX IF NOT EXISTS recordings_state_sequence ON recordings(state,creationSequence);
   CREATE TABLE IF NOT EXISTS recording_deletions (
    recordingId TEXT PRIMARY KEY REFERENCES recordings(recordingId)
   ) STRICT;
  `);
  }
  /**
   * Reserves the recording and capture-source identity a native start needs, before it runs, and
   * says whether this is that request's first allocation or a replay of one already stored. The
   * receipt is durable and carries the canonical arguments it was allocated for, so a request ID
   * replayed after a lost answer names the same take across a relaunch, and the same ID reused for
   * a different take is refused instead of being answered with the first one.
   */
  allocate(request?: AllocationRequest): Allocation {
    if (
      request?.cameraDeviceId !== undefined &&
      (request.cameraDeviceId.length === 0 || request.cameraDeviceId.length > 256)
    )
      throw new CatalogError(
        "INVALID_PARAMS",
        "Camera device identity must be bounded and nonempty",
      );
    return this.transaction(() => {
      if (request) {
        const stored = this.catalog
          .prepare(
            `SELECT ${recordingColumns},allocationArguments FROM recordings WHERE allocationRequestId=?`,
          )
          .get(request.requestId) as (RecordingRow & { allocationArguments: string }) | undefined;
        if (stored) {
          const { allocationArguments, ...recording } = stored;
          if (
            allocationArguments !== request.arguments ||
            recording.cameraDeviceId !== (request.cameraDeviceId ?? null)
          )
            throw new CatalogError(
              "REQUEST_CONFLICT",
              "Request ID was already used with different arguments",
            );
          return { recording: this.get(recording.recordingId), replay: true };
        }
      }
      const recordingId = this.providers.newId();
      const sourceId = this.providers.newId();
      const cameraSourceId = request?.cameraDeviceId === undefined ? null : this.providers.newId();
      this.catalog
        .prepare(
          "INSERT INTO recordings(recordingId,sourceId,cameraSourceId,cameraDeviceId,allocationRequestId,allocationArguments,createdAt,state,lifecycleSequence) VALUES (?,?,?,?,?,?,?,'preparing',0)",
        )
        .run(
          recordingId,
          sourceId,
          cameraSourceId,
          request?.cameraDeviceId ?? null,
          request?.requestId ?? null,
          request?.arguments ?? null,
          this.providers.now(),
        );
      return { recording: this.get(recordingId), replay: false };
    });
  }
  get(recordingId: string): Recording {
    const row = this.catalog
      .prepare(
        `SELECT ${recordingColumns} FROM recordings WHERE recordingId=? AND recordingId NOT IN (SELECT recordingId FROM recording_deletions)`,
      )
      .get(recordingId);
    if (!row) throw new CatalogError("NOT_FOUND", "Recording does not exist", { recordingId });
    return readRecording(row as RecordingRow);
  }
  /** Source publication can finish before its sibling; no growing take journal is admission authority. */
  publishedSource(recordingId: string, sourceId: string): CapturePublishedSource {
    const recording = this.get(recordingId);
    if (recording.state === "canceled")
      throw new CatalogError("UNAVAILABLE", "Capture was discarded");
    const kind =
      sourceId === recording.sourceId
        ? "primary"
        : sourceId === recording.camera?.sourceId
          ? "camera"
          : null;
    if (kind === null) throw new CatalogError("NOT_FOUND", "Capture does not own the named source");
    const outcome = recording.publication?.[kind];
    if (outcome == null && isSettled(recording.state))
      throw new CatalogError("UNAVAILABLE", "Capture has no published source", { sourceId });
    if (outcome?.state === "unavailable")
      throw new CatalogError("UNAVAILABLE", outcome.error.message, {
        sourceId,
        cause: outcome.error.code,
      });
    if (!recording.publication?.inputsClosed || outcome?.state !== "published")
      throw new CatalogError("NOT_READY", "Capture source has not published", { sourceId });
    return outcome.source;
  }
  /** Physical inputs, including drain, retain queue priority; publication after closure does not. */
  isCapturing(): boolean {
    return Boolean(
      this.catalog
        .prepare(`SELECT 1 FROM recordings
      WHERE state IN ('preparing','recording','paused','finalizing')
      AND coalesce(json_extract(publication,'$.observation.inputsClosed'),0)=0 LIMIT 1`)
        .get(),
    );
  }
  /** Durable intent fences public access before asynchronous producer shutdown begins. */
  markDeleting(recordingId: string): Recording | null {
    return this.transaction(() => {
      this.catalog
        .prepare(`INSERT OR IGNORE INTO recording_deletions(recordingId)
        SELECT recordingId FROM recordings WHERE recordingId=?`)
        .run(recordingId);
      return this.deleting(recordingId);
    });
  }
  /** Deletion and storage accounting may inspect a marked recording's retained identity. */
  deleting(recordingId: string): Recording | null {
    const row = this.catalog
      .prepare(`SELECT ${recordingColumns} FROM recordings
      WHERE recordingId=? AND recordingId IN (SELECT recordingId FROM recording_deletions)`)
      .get(recordingId) as RecordingRow | undefined;
    return row ? readRecording(row) : null;
  }
  deletionsPage(afterId = "", limit = 50): { recordings: Recording[]; nextAfterId: string | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new CatalogError("INVALID_PARAMS", "Deletion page size must be 1–200");
    const rows = this.catalog
      .prepare(`SELECT ${recordingColumns} FROM recording_deletions JOIN recordings USING(recordingId)
      WHERE recordingId>?
      ORDER BY recordingId LIMIT ?`)
      .all(afterId, limit + 1) as RecordingRow[];
    return {
      recordings: rows.slice(0, limit).map(readRecording),
      nextAfterId: rows.length > limit ? rows[limit - 1]!.recordingId : null,
    };
  }
  /** Finalize only after each resource owner has reclaimed its rows and files. Foreign keys keep
   * an omitted owner from silently losing the recording identity needed to finish cleanup. */
  finishDeletion(recordingId: string): void {
    this.transaction(() => {
      if (!this.deleting(recordingId)) {
        if (this.catalog.prepare("SELECT 1 FROM recordings WHERE recordingId=?").get(recordingId))
          throw new CatalogError("INVALID_STATE", "Recording deletion has not been requested");
        return;
      }
      this.removeRecording(recordingId);
    });
  }
  protected removeRecording(recordingId: string): void {
    for (const table of ["recording_deletions", "recordings"])
      this.catalog.prepare(`DELETE FROM ${table} WHERE recordingId=?`).run(recordingId);
  }
  /** Native closure ends capture priority even if later deletion cleanup fails. */
  settleDeletingCapture(recordingId: string): Recording {
    return this.transaction(() => {
      const recording = this.deleting(recordingId);
      if (!recording)
        throw new CatalogError("INVALID_STATE", "Recording deletion has not been requested");
      if (isSettled(recording.state)) return recording;
      this.catalog
        .prepare(
          "UPDATE recordings SET state='canceled',interruptionReason=NULL,interruptionMessage=NULL,finalizationError=NULL WHERE recordingId=?",
        )
        .run(recordingId);
      return {
        ...recording,
        state: "canceled",
        interruptionReason: null,
        interruptionMessage: null,
        finalizationError: null,
      };
    });
  }
  /** Whether work for this take may still start or publish: it was neither discarded nor marked for deletion. */
  isAvailable(recordingId: string): boolean {
    return Boolean(
      this.catalog
        .prepare(
          "SELECT 1 FROM recordings WHERE recordingId=? AND state!='canceled' AND recordingId NOT IN (SELECT recordingId FROM recording_deletions)",
        )
        .get(recordingId),
    );
  }
  isDeleting(recordingId: string): boolean {
    return Boolean(
      this.catalog
        .prepare("SELECT 1 FROM recording_deletions WHERE recordingId=?")
        .get(recordingId),
    );
  }
  /**
   * Visits every take the catalog still holds, discarded and deleting ones included. A failed visit
   * does not stop the rest; the first failure is rethrown once every take was visited.
   */
  async forEachRecording(
    signal: AbortSignal,
    visit: (recording: Pick<Recording, "recordingId" | "sourceId">) => Promise<void>,
  ): Promise<void> {
    let after = "";
    let failed = false;
    let firstError: unknown;
    for (;;) {
      signal.throwIfAborted();
      const recording = this.catalog
        .prepare(
          "SELECT recordingId,sourceId FROM recordings WHERE recordingId>? ORDER BY recordingId LIMIT 1",
        )
        .get(after) as Pick<Recording, "recordingId" | "sourceId"> | undefined;
      if (!recording) break;
      after = recording.recordingId;
      try {
        await visit(recording);
      } catch (error) {
        signal.throwIfAborted();
        if (!failed) firstError = error;
        failed = true;
      }
    }
    if (failed) throw firstError;
  }
  /** Creation sequences never move: later takes cannot enter an existing traversal. */
  list(
    cursor: RecordingCursor | null = null,
    limit = 100,
  ): { recordings: readonly Recording[]; nextCursor: RecordingCursor | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new CatalogError("INVALID_PARAMS", "Recording page size must be 1–1000");
    const position = cursor === null ? undefined : pageCursor.decode("recording.list", cursor, {});
    const before =
      position === undefined
        ? Number.MAX_SAFE_INTEGER
        : (position as { sequence?: unknown }).sequence;
    if (!Number.isSafeInteger(before) || (before as number) < 1)
      throw new CatalogError("INVALID_PARAMS", "Invalid recording page cursor");
    const rows = this.catalog
      .prepare(
        `SELECT ${recordingColumns} FROM recordings
       WHERE state!='canceled' AND recordingId NOT IN (SELECT recordingId FROM recording_deletions) AND creationSequence < ?
       ORDER BY creationSequence DESC LIMIT ?`,
      )
      .all(before as number, limit + 1) as RecordingRow[];
    const recordings = rows.slice(0, limit).map(readRecording);
    return {
      recordings,
      nextCursor:
        rows.length > limit
          ? pageCursor.encode(
              "recording.list",
              { sequence: recordings[recordings.length - 1]!.creationSequence },
              {},
            )
          : null,
    };
  }
  /**
   * Every take that can still change state, oldest first. A relaunched service reconciles these
   * against their own durable media; nothing else may be left describing a capture that ended.
   */
  /**
   * Whether a take is still changing. One whose recovery failed waits for an explicit retry
   * (`capture.stop`), which can wait for an update, so it does not hold one back. A finalizing
   * take without a failure stores the JSON text `null`.
   */
  get updateBlocked(): boolean {
    return !!this.catalog
      .prepare(
        `SELECT 1 FROM recordings WHERE state IN (${unsettledStates.map(() => "?").join(",")}) AND (finalizationError IS NULL OR finalizationError = 'null') LIMIT 1`,
      )
      .get(...unsettledStates);
  }
  unsettled(): Recording[] {
    return (
      this.catalog
        .prepare(
          `SELECT ${recordingColumns} FROM recordings WHERE state IN (${unsettledStates
            .map(() => "?")
            .join(",")}) ORDER BY creationSequence`,
        )
        .all(...unsettledStates) as RecordingRow[]
    ).map(readRecording);
  }
  latest(): Recording | null {
    const row = this.catalog
      .prepare(
        `SELECT ${recordingColumns} FROM recordings WHERE state!='canceled' AND recordingId NOT IN (SELECT recordingId FROM recording_deletions) ORDER BY creationSequence DESC LIMIT 1`,
      )
      .get() as RecordingRow | undefined;
    return row ? readRecording(row) : null;
  }
  /** A canceled or deleting take is hidden from recording discovery. */
  listable(recordingId: string): boolean {
    return Boolean(
      this.catalog
        .prepare(
          "SELECT 1 FROM recordings WHERE recordingId=? AND state!='canceled' AND recordingId NOT IN (SELECT recordingId FROM recording_deletions)",
        )
        .get(recordingId),
    );
  }
  /** One retained finalization for status when no current recovery or native take owns the view. */
  pendingFinalization(): Recording | null {
    const row = this.catalog
      .prepare(`SELECT ${recordingColumns} FROM recordings
      WHERE state='finalizing' AND recordingId NOT IN (SELECT recordingId FROM recording_deletions)
      ORDER BY creationSequence LIMIT 1`)
      .get() as RecordingRow | undefined;
    return row ? readRecording(row) : null;
  }
  /**
   * Applies one reported capture transition. Re-delivery of an already applied sequence keeps the
   * stored state, and an event from a superseded session or a settled take is refused outright.
   */
  ingestLifecycle(recordingId: string, event: LifecycleEvent): Recording {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
      throw new RangeError("A lifecycle sequence must be a positive safe integer");
    if (event.state === "finalizing" && event.finalizationError != null) {
      const failure = event.finalizationError;
      if (
        typeof failure.code !== "string" ||
        failure.code.length < 1 ||
        failure.code.length > 128 ||
        typeof failure.message !== "string" ||
        failure.message.length > 4096 ||
        typeof failure.retryable !== "boolean"
      )
        throw new CatalogError(
          "INVALID_PARAMS",
          "Finalization failure must be a bounded public error",
        );
    }
    if (
      event.state === "interrupted" &&
      event.message != null &&
      (typeof event.message !== "string" || event.message.length > 4096)
    )
      throw new CatalogError("INVALID_PARAMS", "Interruption message must be bounded text");
    return this.transaction(() => {
      const recording = this.get(recordingId);
      if (event.sourceId !== recording.sourceId)
        throw new CatalogError("INVALID_STATE", "Event belongs to another capture session", {
          sourceId: recording.sourceId,
          reportedSourceId: event.sourceId,
        });
      if (event.sequence <= recording.lifecycleSequence) return recording;
      const stored = this.catalog
        .prepare("SELECT publication FROM recordings WHERE recordingId=?")
        .get(recordingId)!.publication as string | null;
      const previous = stored === null ? null : (JSON.parse(stored) as CapturePublicationState);
      const publication =
        event.publication === undefined
          ? previous
          : readCapturePublication(event.publication, recording, previous);
      if (!nextStates[recording.state].includes(event.state))
        throw new CatalogError(
          "INVALID_STATE",
          `A ${recording.state} recording cannot become ${event.state}`,
          { state: recording.state, reportedState: event.state },
        );
      if (event.state === "complete" || event.state === "interrupted")
        this.attachSource(recording, event.sourceDurationUs);
      this.catalog
        .prepare(
          "UPDATE recordings SET state=?,lifecycleSequence=?,interruptionReason=?,interruptionMessage=?,finalizationError=?,publication=? WHERE recordingId=?",
        )
        .run(
          event.state,
          event.sequence,
          event.state === "interrupted" ? event.reason : null,
          event.state === "interrupted" ? (event.message ?? null) : null,
          event.state === "finalizing"
            ? JSON.stringify(
                event.finalizationError === undefined
                  ? recording.finalizationError
                  : event.finalizationError,
              )
            : null,
          publication === null ? null : JSON.stringify(publication),
          recordingId,
        );
      return this.get(recordingId);
    });
  }
  /**
   * A null duration is a validated report that no video survived, so it and an attached duration
   * refuse each other in both directions rather than one silently replacing the other.
   */
  private attachSource(recording: Recording, sourceDurationUs: number | null): void {
    if (recording.state === "canceled")
      throw new CatalogError("INVALID_STATE", "A canceled take keeps no source", {
        state: recording.state,
      });
    if (recording.sourceDurationUs !== null) {
      if (recording.sourceDurationUs !== sourceDurationUs)
        throw new CatalogError("INVALID_STATE", "Source duration is immutable", {
          sourceDurationUs: recording.sourceDurationUs,
        });
      return;
    }
    if (sourceDurationUs === null) return;
    if (isSettled(recording.state))
      throw new CatalogError("INVALID_STATE", "This take already reported no usable video", {
        state: recording.state,
        interruptionReason: recording.interruptionReason,
      });
    this.storeSource(recording.recordingId, sourceDurationUs);
  }
  /** Runs inside the lifecycle/registration transaction, including an editing specialization. */
  protected storeSource(recordingId: string, sourceDurationUs: number): void {
    if (!Number.isSafeInteger(sourceDurationUs) || sourceDurationUs <= 0)
      throw new CatalogError("INVALID_RANGE", "Source duration must be a positive safe integer");
    this.catalog
      .prepare("UPDATE recordings SET sourceDurationUs=? WHERE recordingId=?")
      .run(sourceDurationUs, recordingId);
  }
  /** Attaches a validated source duration once; null remains an explicit no-video outcome. */
  registerSource(recordingId: string, sourceDurationUs: number): Recording {
    return this.transaction(() => {
      this.attachSource(this.get(recordingId), sourceDurationUs);
      return this.get(recordingId);
    });
  }
}
