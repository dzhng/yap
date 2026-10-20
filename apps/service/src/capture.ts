import type { CaptureSources } from "./capture-sources.js";
import { randomUUID } from "node:crypto";
import {
  readRecoveryReceipt,
  readCaptureSourceOutcome,
  type CapturePublication,
  type CaptureSourceOutcome,
} from "@yap/core/capture-publication";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  isSettled,
  type LifecycleEvent,
  type Recording,
  type CaptureStore,
  type FinalizationError,
} from "@yap/core/capture-store";
import { CatalogError } from "@yap/core/catalog";
import {
  MAXIMUM_TAKE_US,
  captureDeviceSchema,
  captureReportSchema,
  captureSourcesSchema,
  nativeStartSchema,
  operationWaitMs,
  refusalRetryable,
  type CaptureReport,
  type CaptureSelection,
  type OperationResult,
} from "@yap/protocol";
import type { ControlChannel } from "./control.js";
import { renderWindowDeadlineMs, type MediaWorker } from "./worker.js";
import { publicationDeadlineMs, journalWorkDeadlineMs } from "./publication.js";

/**
 * The only outcomes this service states on its own behalf: a take it discarded, and a take whose
 * capture it proved ended. Every other transition arrives from the native session that made it.
 */
type AuthoredOutcome = (
  | { state: "canceled" }
  | { state: "finalizing"; finalizationError: FinalizationError | null }
  | {
      state: "interrupted";
      reason: string;
      message?: string | null;
      sourceDurationUs: number | null;
    }
) & { publication?: CapturePublication };

export function recordingDirectory(home: string, recordingId: string): string {
  return join(home, "recordings", recordingId);
}
export function sourceDirectory(
  home: string,
  recordingId: string,
  kind: "primary" | "camera" = "primary",
): string {
  return join(recordingDirectory(home, recordingId), kind === "primary" ? "source" : "camera");
}

/**
 * Capture control as this service owns it: it allocates a take's identity and directory, asks
 * the app's native capture session to act, and persists what that session reports. Device state,
 * permissions and media belong to native; nothing here re-derives a transition, a duration or a
 * device state machine of its own.
 */
/** A recorded failure waits for an explicit retry; a shutdown that cut recovery short does not. */
function failedFinalization(recording: Recording): boolean {
  return (
    recording.finalizationError !== null && recording.finalizationError.code !== "RECOVERY_CANCELED"
  );
}

export class CaptureService {
  onUpdateProgress: (() => void) | undefined;
  get updateBlocked(): boolean {
    return !!this.recovery || this.store.updateBlocked;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  private readonly lifetime = new AbortController();
  private recovery:
    | { recordingId: string; controller: AbortController; work: Promise<void> }
    | undefined;

  constructor(
    private readonly store: CaptureStore,
    private readonly home: string,
    /** The native capture session, reached over the app's private control channel. */
    private readonly native: ControlChannel["call"],
    private readonly worker: MediaWorker,
    private readonly log: (message: string) => void = () => {},
    private readonly changed: (recording: Recording) => void = () => {},
    private readonly sourceLifetime?: CaptureSources,
  ) {}

  /**
   * One control order for everything that touches the capture device. Native refuses a second
   * concurrent take by itself; this queue is what makes which request meets that refusal
   * deterministic instead of a race between two half-finished starts.
   */
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => {
      if (this.stopping) throw new CatalogError("OWNER_CLOSED", "Capture service is closing");
      return run();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.lifetime.abort();
    await this.queue;
    await this.recovery?.work;
  }

  // Reading what the device can see, and what it is doing, changes nothing and so does not
  // join the control order below.
  async sources(): Promise<unknown> {
    return captureSourcesSchema.parse(await this.ask("capture.sources", {}));
  }

  async status() {
    const device = captureDeviceSchema.parse(await this.ask("capture.status", {}));
    const recovering =
      this.recovery && !this.store.isDeleting(this.recovery.recordingId)
        ? this.store.get(this.recovery.recordingId)
        : null;
    return {
      device,
      // A take awaiting deletion is no longer discoverable, though native may still be ending it.
      recording:
        device.recordingId === null
          ? (recovering ?? this.store.pendingFinalization())
          : this.store.isDeleting(device.recordingId)
            ? null
            : this.store.get(device.recordingId),
    };
  }

  /**
   * Allocates identity and directory first, against a durable receipt for the request that asked
   * for them: a repeated request ID answers with the same take and never starts capture twice,
   * and the same ID asking for a different take is refused rather than quietly reinterpreted.
   */
  start(selection: CaptureSelection & { requestId: string }): Promise<Recording> {
    return this.serialize(async () => {
      const { recording, replay } = this.store.allocate({
        requestId: selection.requestId,
        arguments: allocationArguments("capture.start", selection),
        ...(selection.cameraDeviceId === undefined
          ? {}
          : { cameraDeviceId: selection.cameraDeviceId }),
      });
      if (replay) return this.resolve(recording);
      try {
        this.requireRecoveryQuiet();
      } catch (error) {
        throw this.refused(recording, error);
      }
      return this.begin(recording, selection);
    });
  }

  /** A new identity every time, and the same new identity for a replayed request. */
  restart(
    selection: CaptureSelection & { recordingId: string; requestId: string },
  ): Promise<Recording> {
    return this.serialize(async () => {
      this.store.get(selection.recordingId);
      const { recording, replay } = this.store.allocate({
        requestId: selection.requestId,
        arguments: allocationArguments("capture.restart", selection),
        ...(selection.cameraDeviceId === undefined
          ? {}
          : { cameraDeviceId: selection.cameraDeviceId }),
      });
      if (replay) return this.resolve(recording);
      try {
        this.requireRecoveryQuiet();
        const discarded = await this.discard(selection.recordingId);
        if (discarded.state !== "canceled")
          throw new CatalogError(
            "CAPTURE_RECOVERY_PENDING",
            "The previous take is still finalizing; inspect it before restarting",
            { recordingId: discarded.id },
          );
      } catch (error) {
        // The take this restart named could not be discarded, so its replacement never reached
        // the device: it is settled with that refusal instead of left as an unresolvable receipt.
        throw this.refused(recording, error);
      }
      return this.begin(recording, selection);
    });
  }

  /**
   * Resolves a replay or stop of an unproved start onto the take it already named. That take
   * is ended and settled here rather than started a second time: native's refusal of
   * that second start would be about the take already running, and says nothing about whether
   * the first one captured media.
   */
  private async resolve(recording: Recording): Promise<Recording> {
    if (recording.state !== "preparing") return recording;
    const settled = await this.abandon(recording);
    if (!isSettled(settled.state) && settled.state !== "finalizing")
      throw new CatalogError(
        "UNRESOLVED_START",
        "This take's start is still unproved; retry the same request",
        { recordingId: settled.id, state: settled.state },
      );
    return settled;
  }

  pause(recordingId: string): Promise<Recording> {
    return this.serialize(() => this.transition(recordingId, "capture.pause"));
  }

  resume(recordingId: string): Promise<Recording> {
    return this.serialize(() => this.transition(recordingId, "capture.resume"));
  }

  /**
   * Turns a live take's reserved companion camera on or off. This is not a lifecycle transition:
   * nothing is stored, and native answers with its device state, which carries the camera's.
   */
  setCamera(recordingId: string, on: boolean) {
    return this.serialize(async () => {
      const recording = this.store.get(recordingId);
      if (recording.state !== "recording" && recording.state !== "paused")
        throw new CatalogError(
          "INVALID_STATE",
          `A ${recording.state} take cannot turn its camera ${on ? "on" : "off"}`,
          { state: recording.state },
        );
      if (recording.camera === null)
        throw new CatalogError("CAMERA_NOT_RESERVED", "This take reserved no companion camera", {
          recordingId,
        });
      // Turning on opens the camera cold, so native gets the operation's whole public budget.
      const answer = await this.native(
        "capture.setCamera",
        { recordingId, on },
        { timeoutMs: operationWaitMs("capture.setCamera") },
      );
      if (!answer.ok) throw fromNative(answer);
      const device = captureDeviceSchema.parse(answer.data);
      return { device, recording: this.store.get(recordingId) };
    });
  }

  stop(recordingId: string): Promise<Recording> {
    return this.serialize(async () => {
      const recording = this.store.get(recordingId);
      if (isSettled(recording.state)) return recording;
      if (this.recovery?.recordingId === recordingId) return recording;
      if (recording.state === "preparing") return this.abandon(recording);
      const answer = await this.native("capture.stop", { recordingId });
      if (answer.ok) return this.apply(recording, answer.data);
      if (answer.error.code !== "INVALID_STATE") throw fromNative(answer);
      // Native is not holding this take, so its own durable media is the only truth left.
      return this.reconcile(recording, { retryFailure: true });
    });
  }

  cancel(recordingId: string): Promise<Recording> {
    return this.serialize(() => this.discard(recordingId));
  }

  /** Joins the capture order; success proves this take can no longer write, but removes nothing. */
  quiesce(recordingId: string): Promise<void> {
    return this.serialize(async () => {
      const recording = this.store.deleting(recordingId);
      if (!recording)
        throw new CatalogError("INVALID_STATE", "Recording deletion has not been requested");
      if (isSettled(recording.state)) return;
      if (this.recovery?.recordingId === recordingId) {
        this.recovery.controller.abort();
        await this.recovery.work;
      }
      await this.endNativeCapture(recording);
      // A cancel response carries its pre-discard finalizing event. Check the device after that
      // ordered call, including when native refused because it no longer owns this take.
      const device = captureDeviceSchema.parse(await this.ask("capture.status", {}));
      if (!nativeReleaseProven(device, recordingId))
        throw new CatalogError(
          "CAPTURE_NOT_QUIET",
          "Native capture has not proved this take stopped",
          { recordingId },
        );
      this.observed(this.store.settleDeletingCapture(recordingId));
    });
  }

  /** Applies one transition native reported on its own, without this service asking for it. */
  report(report: CaptureReport): Recording {
    return this.observed(this.store.ingestLifecycle(report.recordingId, lifecycleEvent(report)));
  }

  /** Reconcile takes in order while releasing control between owned recovery attempts. */
  async reconcileStranded(): Promise<void> {
    if (this.stopping) throw new CatalogError("OWNER_CLOSED", "Capture service is closing");
    for (const recording of this.store.unsettled()) {
      if (this.stopping) break;
      if (this.store.isDeleting(recording.id) || failedFinalization(recording)) continue;
      try {
        const started = await this.serialize(async () => {
          await this.reconcile(recording);
          return { work: this.recovery?.work };
        });
        await started.work;
      } catch (error) {
        this.log(`reconcile failed for ${recording.id}: ${(error as Error).message}`);
      }
    }
  }

  private async begin(recording: Recording, selection: CaptureSelection): Promise<Recording> {
    try {
      const kinds =
        recording.camera === null ? (["primary"] as const) : (["primary", "camera"] as const);
      for (const kind of kinds) {
        await mkdir(sourceDirectory(this.home, recording.id, kind), {
          recursive: true,
          mode: 0o700,
        });
      }
    } catch (error) {
      throw this.refused(recording, error);
    }
    this.store.get(recording.id);
    const answer = await this.native(
      "capture.start",
      nativeStartSchema.parse({
        ...selection,
        recordingId: recording.id,
        sourceId: recording.sourceId,
        ...(recording.camera === null
          ? {}
          : {
              cameraSourceId: recording.camera.sourceId,
              cameraDeviceId: recording.camera.deviceId,
              cameraDirectory: sourceDirectory(this.home, recording.id, "camera"),
            }),
        outputDirectory: sourceDirectory(this.home, recording.id),
      }),
    );
    if (answer.ok) return this.apply(recording, answer.data);
    if (!unanswered(answer.error.code)) throw this.refused(recording, fromNative(answer));
    const failed = await this.abandon(recording);
    throw new CatalogError(answer.error.code, answer.error.message, {
      recordingId: failed.id,
      state: failed.state,
    });
  }

  /**
   * Settles a take that never reached the device, and states why. A start native refused, or one
   * whose preparation refused before native was asked, keeps its identity and that reason rather
   * than disappearing or waiting forever in preparing where nothing could ever resolve it.
   */
  private refused(recording: Recording, error: unknown): CatalogError {
    const refusal = error instanceof CatalogError ? error : null;
    // An owner's own code when there is one; anything else is a failure this service cannot name.
    const code = refusal?.code ?? "INTERNAL_ERROR";
    const failed = this.author(recording, {
      state: "interrupted",
      reason: code,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
      sourceDurationUs: null,
    });
    return new CatalogError(code, (error as Error).message, {
      recordingId: failed.id,
      state: failed.state,
    });
  }

  /**
   * Ends a take whose start was never answered. A deadline or a closed channel says nothing about
   * the device, so the take is ended on it and settled from the media that ending left behind.
   * A take whose end cannot be proved stays unsettled, still reachable by a later stop, by the
   * session's own reports and by the next startup's recovery.
   */
  private async abandon(recording: Recording): Promise<Recording> {
    const stopped = await this.native("capture.stop", { recordingId: recording.id });
    if (stopped.ok) {
      const report = this.readReport(recording, stopped.data);
      // A finalizing acknowledgment still owns live media; only its later terminal report
      // or a proved absent device can authorize recovery.
      if (!isSettled(report.state)) return this.report(report);
    }
    // Either native ended this take now, or it is not holding it; both leave the media in
    // charge of the outcome.
    if (stopped.ok || stopped.error.code === "INVALID_STATE") {
      try {
        return await this.reconcile(recording);
      } catch (error) {
        this.log(`recovery failed for ${recording.id}: ${(error as Error).message}`);
      }
    }
    const current = this.store.get(recording.id);
    if (!isSettled(current.state))
      this.log(`unsettled start for ${recording.id}: capture may still be running`);
    return current;
  }

  /**
   * Pause and resume are transitions of a live capture, so a take that has already ended refuses
   * them rather than answering with its stored outcome. Stopping a finished take stays idempotent;
   * pausing a paused take and resuming a recording one stay idempotent through native's own
   * validation, which is the only thing that knows what the device is doing.
   */
  private async transition(
    recordingId: string,
    operation: "capture.pause" | "capture.resume",
  ): Promise<Recording> {
    const recording = this.store.get(recordingId);
    if (isSettled(recording.state))
      throw new CatalogError(
        "INVALID_STATE",
        `A ${recording.state} take cannot ${operation === "capture.pause" ? "pause" : "resume"}`,
        { state: recording.state },
      );
    const answer = await this.native(operation, { recordingId });
    if (!answer.ok) throw fromNative(answer);
    return this.apply(recording, answer.data);
  }

  private async discard(recordingId: string): Promise<Recording> {
    const recording = this.store.get(recordingId);
    if (isSettled(recording.state) && recording.state !== "canceled")
      throw new CatalogError(
        "INVALID_STATE",
        "A finished take is removed through the library, not canceled",
        { state: recording.state },
      );
    if (this.recovery?.recordingId === recordingId) {
      const attempt = this.recovery;
      attempt.controller.abort();
      await attempt.work;
      const current = this.store.get(recordingId);
      if (isSettled(current.state))
        throw new CatalogError(
          "INVALID_STATE",
          "A finished take is removed through the library, not canceled",
          { state: current.state },
        );
      return current;
    }
    const discard = async () => {
      let current = recording;
      if (current.state !== "canceled") {
        const report = await this.endNativeCapture(current);
        if (report) current = this.report(report);
        else return this.reconcile(current, { discardIfEmpty: true });
        // A joined finalization can win; the terminal rule preserves that take for explicit deletion.
        current = this.author(current, { state: "canceled" });
      }
      return current;
    };
    if (this.sourceLifetime) {
      try {
        return await this.sourceLifetime.discard(recordingId, this.lifetime.signal, discard);
      } finally {
        // Completion may win while admission is fenced; release that fence before notifying consumers.
        if (this.store.isAvailable(recordingId)) this.observed(this.store.get(recordingId));
      }
    }
    const current = await discard();
    if (current.state === "canceled")
      await rm(recordingDirectory(this.home, recordingId), { recursive: true, force: true });
    return current;
  }

  private async endNativeCapture(recording: Recording): Promise<CaptureReport | null> {
    const answer = await this.native("capture.cancel", { recordingId: recording.id });
    if (answer.ok) return this.readReport(recording, answer.data);
    if (answer.error.code === "INVALID_STATE") return null;
    throw fromNative(answer);
  }

  private requireRecoveryQuiet(): void {
    if (this.recovery)
      throw new CatalogError(
        "CAPTURE_RECOVERY_PENDING",
        "A take is still finalizing; inspect its status before starting another",
        { recordingId: this.recovery.recordingId },
      );
  }

  private async reconcile(
    recording: Recording,
    { discardIfEmpty = false, retryFailure = false } = {},
  ): Promise<Recording> {
    if (this.recovery?.recordingId === recording.id) return this.store.get(recording.id);
    this.requireRecoveryQuiet();
    // The app can outlive its service. Never fence its native sequence merely because this service restarted.
    const device = captureDeviceSchema.parse(await this.ask("capture.status", {}));
    if (!nativeRecoveryQuiet(device))
      throw new CatalogError(
        "CAPTURE_NOT_QUIET",
        "Native capture has not proved recovery can begin",
        { recordingId: recording.id, deviceRecordingId: device.recordingId },
      );
    const current = this.store.get(recording.id);
    if (isSettled(current.state) || (failedFinalization(current) && !retryFailure)) return current;
    const finalizing = this.author(current, {
      state: "finalizing",
      finalizationError: null,
      publication: current.publication ?? {
        generation: `recovery:${randomUUID()}`,
        sourceId: current.sourceId,
        inputsClosed: false,
        primary: null,
        camera: null,
      },
    });
    const controller = new AbortController();
    const attempt = { recordingId: current.id, controller, work: Promise.resolve() };
    this.recovery = attempt;
    attempt.work = Promise.resolve()
      .then(async () => {
        const recovered = await this.readRecoveredSources(
          current,
          AbortSignal.any([controller.signal, this.lifetime.signal]),
        );
        if (this.store.isDeleting(current.id)) return;
        const selected = this.store.get(current.id);
        if (isSettled(selected.state)) return;
        if (
          discardIfEmpty &&
          !recovered.captured &&
          recovered.durationUs === 0 &&
          selected.publication?.camera?.state !== "published"
        ) {
          const entries = await readdir(sourceDirectory(this.home, current.id)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            },
          );
          if (entries.length > 0)
            throw new CatalogError(
              "CAPTURE_RECOVERY_UNRESOLVED",
              "Source bytes remain but recovery could not prove their outcome",
              { recordingId: current.id },
            );
          const canceled = this.author(selected, { state: "canceled" });
          if (this.sourceLifetime)
            await this.sourceLifetime.discard(
              current.id,
              this.lifetime.signal,
              async () => canceled,
            );
          else
            await rm(recordingDirectory(this.home, current.id), {
              recursive: true,
              force: true,
            });
        } else {
          this.settleRecovered(selected, recovered);
        }
      })
      .catch((error: unknown) => {
        if (this.store.isDeleting(current.id)) return;
        const selected = this.store.get(current.id);
        if (isSettled(selected.state)) return;
        let code =
          controller.signal.aborted || this.lifetime.signal.aborted
            ? "RECOVERY_CANCELED"
            : error instanceof CatalogError
              ? error.code
              : "RECOVERY_FAILED";
        if (code.length > 128) code = "RECOVERY_FAILED";
        const finalizationError = {
          code,
          message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
          retryable: refusalRetryable(code),
        };
        this.author(selected, { state: "finalizing", finalizationError });
        this.log(
          `recovery failed for ${selected.id}: ${finalizationError.code}: ${finalizationError.message}`,
        );
      })
      .finally(() => {
        if (this.recovery === attempt) {
          this.recovery = undefined;
          this.onUpdateProgress?.();
        }
      });
    return finalizing;
  }

  private async readRecoveredSources(
    recording: Recording,
    signal: AbortSignal = this.lifetime.signal,
  ): Promise<ReturnType<typeof readRecoveryReceipt>> {
    const outcomes = new Map<
      "primary" | "camera",
      { inputsClosed: boolean; outcome: CaptureSourceOutcome | null }
    >();
    const publish = () => {
      if (this.store.isDeleting(recording.id)) return;
      const current = this.store.get(recording.id);
      if (isSettled(current.state)) return;
      const previous = current.publication!;
      const inputsClosed =
        previous.inputsClosed || [...outcomes.values()].some((value) => value.inputsClosed);
      if (!inputsClosed) return;
      this.author(current, {
        state: "finalizing",
        finalizationError: null,
        publication: {
          ...previous,
          inputsClosed,
          primary: outcomes.has("primary") ? outcomes.get("primary")!.outcome : previous.primary,
          camera: outcomes.has("camera") ? outcomes.get("camera")!.outcome : previous.camera,
        },
      });
    };
    const kinds =
      recording.camera === null ? (["primary"] as const) : (["primary", "camera"] as const);
    const results = await Promise.allSettled(
      kinds.map(async (kind) => {
        try {
          const timeoutMs = await this.recoveryDeadline(recording, kind);
          const sourceAuthority =
            kind === "primary"
              ? { kind, sourceId: recording.sourceId }
              : {
                  kind,
                  sourceId: recording.camera!.sourceId,
                  binding: { recordingId: recording.id, ...recording.camera! },
                };
          const recovered = await this.worker(
            "media.recover",
            {
              directory: sourceDirectory(this.home, recording.id, kind),
              sourceAuthority,
            },
            { signal, timeoutMs },
          );
          if (!recovered.ok) throw fromNative(recovered);
          const result = readRecoveryReceipt(recovered.data);
          const outcome = readCaptureSourceOutcome(result.sourcePublication);
          outcomes.set(kind, { inputsClosed: result.inputsClosed, outcome });
          publish();
          if (result.cleanupFailure)
            this.log(
              `cleanup pending for ${recording.id}/${kind}: ${result.cleanupFailure.code}: ${result.cleanupFailure.message}`,
            );
          return result;
        } catch (error) {
          // An outer media refusal does not establish invalid provenance. Keep it retry-visible;
          // a sibling's exclusive closure proof can still admit that independently verified source.
          // Recovery refuses with a classified code and names the specific cause in details.
          const cause = error instanceof CatalogError ? error.details.cause : undefined;
          const code =
            typeof cause === "string" && cause.length <= 128
              ? cause
              : error instanceof CatalogError && error.code.length <= 128
                ? error.code
                : "RECOVERY_FAILED";
          outcomes.set(kind, {
            inputsClosed: false,
            outcome: {
              state: "pending",
              error: {
                code,
                message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
                retryable: refusalRetryable(code),
              },
            },
          });
          publish();
          throw error;
        }
      }),
    );
    const refused = results.find((value) => value.status === "rejected");
    if (refused?.status === "rejected") throw refused.reason;
    for (const [kind, value] of outcomes) {
      if (!value.inputsClosed || value.outcome === null)
        throw new CatalogError(
          "INVALID_RESPONSE",
          `Recovery did not establish ${kind} source authority`,
        );
      if (value.outcome.state === "pending")
        throw new CatalogError(value.outcome.error.code, value.outcome.error.message, { kind });
    }
    return (results[0] as PromiseFulfilledResult<ReturnType<typeof readRecoveryReceipt>>).value;
  }

  private async recoveryDeadline(
    recording: Recording,
    kind: "primary" | "camera",
  ): Promise<number> {
    const directory = sourceDirectory(this.home, recording.id, kind);
    const names = [
      "capture.journal.jsonl",
      "video.mov",
      "source.publication.json",
      "source.journal.jsonl",
      "camera.publication.json",
      "camera.mapping.jsonl",
      "camera.raw.mov",
      "camera.closed.json",
      ...["narration", "system"].flatMap((role) => [
        `${role}.packed.mov`,
        `${role}.mov`,
        `${role}.publication.json`,
        `.capture-publication-${role}/intent.json`,
        `.capture-publication-${role}/candidate.mov`,
        `.capture-publication-${role}/prepared.json`,
      ]),
    ];
    const members = await Promise.all(
      names.map(async (name) => {
        const info = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        return { name, bytes: info?.isFile() ? info.size : 0, exists: info !== null };
      }),
    );
    const canonicalWork = members.some(
      (member) =>
        member.exists &&
        (member.name === "camera.raw.mov" ||
          member.name === "camera.closed.json" ||
          member.name.includes(".packed.") ||
          member.name.includes(".publication.") ||
          member.name.startsWith(".capture-publication-")),
    );
    const journalBytes =
      members.find((member) => member.name === "capture.journal.jsonl")?.bytes ?? 0;
    // Closed sources carry their actual duration. An unclosed crash prefix can be any length
    // up to the take requirement; reserve that duration until recovery proves its endpoint.
    const durationUs = recording.sourceDurationUs ?? MAXIMUM_TAKE_US;
    const roles = new Set(
      members.flatMap((member) => {
        const role = /^(?:\.capture-publication-)?(narration|system)(?:\.|\/)/.exec(
          member.name,
        )?.[1];
        return member.exists && role ? [role] : [];
      }),
    ).size;
    const traversals = canonicalWork ? roles * 4 + (kind === "camera" ? 3 : 1) : 1;
    return (
      journalWorkDeadlineMs(journalBytes) +
      publicationDeadlineMs(members.reduce((bytes, member) => bytes + member.bytes, 0)) +
      traversals * renderWindowDeadlineMs({ startUs: 0, endUs: durationUs })
    );
  }

  private settleRecovered(
    recording: Recording,
    {
      durationUs,
      captured,
      failureCode,
      failureMessage,
      cleanupFailure,
    }: ReturnType<typeof readRecoveryReceipt>,
  ): Recording {
    return this.author(recording, {
      state: "interrupted",
      reason:
        failureCode ??
        (durationUs > 0
          ? (cleanupFailure?.code ?? "CAPTURE_INTERRUPTED")
          : captured
            ? "NO_RECOVERABLE_VIDEO"
            : "NO_SOURCE_MEDIA"),
      message:
        (failureCode != null ? failureMessage : durationUs > 0 ? cleanupFailure?.message : null) ??
        null,
      sourceDurationUs: durationUs > 0 ? durationUs : null,
    });
  }

  private apply(recording: Recording, data: unknown): Recording {
    return this.report(this.readReport(recording, data));
  }

  private readReport(recording: Recording, data: unknown): CaptureReport {
    const report = captureReportSchema.parse(data);
    if (report.recordingId !== recording.id || report.sourceId !== recording.sourceId)
      throw new CatalogError("INVALID_STATE", "Native reported another take", {
        recordingId: recording.id,
        reportedRecordingId: report.recordingId,
      });
    return report;
  }

  /** Service outcomes continue the last observed sequence; terminal state owns finality. */
  private author(recording: Recording, outcome: AuthoredOutcome): Recording {
    return this.observed(
      this.store.ingestLifecycle(recording.id, {
        ...outcome,
        sourceId: recording.sourceId,
        sequence: recording.lifecycleSequence + 1,
      }),
    );
  }

  private observed(recording: Recording): Recording {
    // Background admission must not turn a successful native transition into a failed capture.
    try {
      this.changed(recording);
    } catch (error) {
      this.log(`processing admission failed for ${recording.id}: ${(error as Error).message}`);
    }
    return recording;
  }

  private async ask(operation: string, params: Record<string, unknown>): Promise<unknown> {
    const answer = await this.native(operation, params);
    if (!answer.ok) throw fromNative(answer);
    return answer.data;
  }
}

/**
 * What a request asked for, in one canonical order, so that a replayed request ID is recognized as
 * the same take and the same ID asking for a different one is refused. Field order is stated here
 * rather than taken from a parsed object's key order.
 */
function allocationArguments(
  operation: string,
  selection: CaptureSelection & { recordingId?: string },
): string {
  const source = selection.source;
  return JSON.stringify([
    operation,
    selection.recordingId ?? null,
    source.kind,
    source.kind === "region" ? source.displayId : source.id,
    source.kind === "region" ? [source.x, source.y, source.width, source.height] : null,
    selection.microphone,
    selection.systemAudio,
    selection.microphoneDeviceId ?? null,
    selection.cameraDeviceId ?? null,
    // Absent means "on", so only a different start state is a different take.
    selection.cameraDeviceId === undefined ? null : (selection.cameraAtStart ?? "on"),
  ]);
}

/**
 * The codes the control channel states on its own when it cannot say whether native ran the call.
 * Every other code is native's own answer, and so is proof of what it did.
 */
function unanswered(code: string): boolean {
  return code === "TIMEOUT" || code === "SERVICE_STOPPED" || code === "CONTROL_RESPONSE_INVALID";
}

function fromNative(result: OperationResult & { ok: false }): CatalogError {
  return new CatalogError(result.error.code, result.error.message, result.error.details);
}

/** Recovery may begin only when native proves that no capture or source is still active. */
function nativeRecoveryQuiet(device: ReturnType<typeof captureDeviceSchema.parse>): boolean {
  return device.state === "idle" && device.recordingId === null && device.sourceId === null;
}

/** Deletion may settle when this take is gone, or when another live take owns the device. */
function nativeReleaseProven(
  device: ReturnType<typeof captureDeviceSchema.parse>,
  recordingId: string,
): boolean {
  return (
    nativeRecoveryQuiet(device) ||
    (device.recordingId !== null &&
      device.recordingId !== recordingId &&
      (device.state === "recording" || device.state === "paused"))
  );
}

function lifecycleEvent(report: CaptureReport): LifecycleEvent {
  const identity = {
    sourceId: report.sourceId,
    sequence: report.sequence,
    ...(report.publication === undefined ? {} : { publication: report.publication }),
  };
  if (report.state === "complete") {
    if (typeof report.sourceDurationUs !== "number")
      throw new CatalogError("INVALID_STATE", "A finalized take must report its source duration");
    return {
      ...identity,
      state: "complete",
      sourceDurationUs: report.sourceDurationUs,
      ...(report.reason == null ? {} : { reason: report.reason }),
    };
  }
  if (report.state === "interrupted")
    return {
      ...identity,
      state: "interrupted",
      reason: report.reason ?? "CAPTURE_INTERRUPTED",
      message: report.message ?? null,
      sourceDurationUs: report.sourceDurationUs ?? null,
    };
  if (report.state === "finalizing")
    return {
      ...identity,
      state: "finalizing",
      ...(report.finalizationError === undefined
        ? {}
        : {
            finalizationError:
              report.finalizationError === null
                ? null
                : {
                    ...report.finalizationError,
                    retryable: refusalRetryable(report.finalizationError.code),
                  },
          }),
    };
  return { ...identity, state: report.state };
}
