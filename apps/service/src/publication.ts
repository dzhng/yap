import { join } from "node:path";
import { derivedBound, MAXIMUM_TAKE_US } from "@yap/protocol";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { CatalogError } from "@yap/core/catalog";
import type { DirectoryIdentity } from "@yap/core/cache";
import { O_EXLOCK, O_NOFOLLOW_ANY } from "@yap/core/open-flags";
import { isPrivateDirectory } from "./managed-files.js";
import { nativeConfirmed, nativeResult, type MediaWorker } from "./worker.js";

type PublicationState =
  | "unprepared"
  | "missing"
  | "prepared"
  | "committed"
  | "replaced"
  | "modified"
  | "conflicted";

export type PublicationFile = { file: DirectoryIdentity; bytes: number; sha256: string };
export type PublicationReceipt = PublicationFile & {
  stage: DirectoryIdentity;
  destination: DirectoryIdentity;
  leaf: string;
  replacement: PublicationFile | null;
};
type StagingPresence = "present" | "absent" | "unreachable";
type PublicationObservation = {
  state: PublicationState;
  receipt: PublicationReceipt | null;
};

const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;

/** A single external publication lifetime. Closing releases descriptors, never evidence.
 * The caller retains this private directory until reconciliation/acknowledgement and
 * persists acknowledged external truth separately from a disposable job result. */
export class Publication {
  private pending: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private constructor(
    private readonly stage: FileHandle,
    private readonly destination: FileHandle,
    private readonly identities: Record<string, unknown>,
    private readonly worker: MediaWorker,
    private readonly timeoutMs: number | undefined,
    private readonly onClosed: (() => void) | undefined,
  ) {}

  /** Live private file lengths, including partial preparation; never opens the destination.
   * Observation borrows no exclusive lock, so it can run alongside a writer. */
  static async usage(
    path: string,
    expected: DirectoryIdentity,
    worker: MediaWorker,
    signal?: AbortSignal,
    committed = false,
  ): Promise<number> {
    if (!(await lstat(path)).isDirectory())
      throw new CatalogError("INVALID_STORAGE", "Publication staging must be a directory");
    const stage = await open(await realpath(path), directoryFlags);
    try {
      const value = Publication.data(
        await worker(
          "publication.usage",
          { stage: expected, committed },
          {
            descriptors: [stage.fd],
            ...(signal ? { signal } : {}),
          },
        ),
      );
      if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
        throw new CatalogError("INVALID_NATIVE_RESPONSE", "Publication storage was not measured");
      return value.bytes;
    } finally {
      await stage.close();
    }
  }

  /** Identify a regular leaf under cooperative destination ownership before admitting replacement. */
  static async inspect(
    directory: string,
    destination: DirectoryIdentity,
    leaf: string,
    worker: MediaWorker,
    signal?: AbortSignal,
  ): Promise<PublicationFile | null> {
    const parent = await open(await realpath(directory), directoryFlags);
    try {
      const bytes = await lstat(join(directory, leaf)).then(
        (info) => info.size,
        (error) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        },
      );
      const value = this.data(
        await worker(
          "publication.inspect",
          { destination, leaf },
          {
            descriptors: [parent.fd],
            timeoutMs: () => publicationDeadlineMs(bytes),
            ...(signal ? { signal } : {}),
          },
        ),
      );
      if (value.file === null) return null;
      const file = value.file as PublicationFile;
      if (
        !file ||
        !file.file ||
        typeof file.file.dev !== "string" ||
        typeof file.file.ino !== "string" ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        typeof file.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(file.sha256)
      )
        throw new CatalogError(
          "INVALID_NATIVE_RESPONSE",
          "Publication destination was not identified",
        );
      return file;
    } finally {
      await parent.close();
    }
  }

  static async open(
    stagePath: string,
    destinationPath: string,
    worker: MediaWorker,
    options: {
      timeoutMs?: number;
      expected?: { stage: DirectoryIdentity; destination: DirectoryIdentity };
      /** Runs once after an opened publication releases its descriptors and their locks. */
      onClosed?: () => void;
    } = {},
  ) {
    const stageBefore = await lstat(stagePath, { bigint: true });
    if (!isPrivateDirectory(stageBefore))
      throw new CatalogError(
        "INVALID_STORAGE",
        "Publication staging must be an owned private directory",
      );
    // The staging lock belongs to this open file description, so inherited worker FDs share it.
    const stage = await open(await realpath(stagePath), directoryFlags | O_EXLOCK).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
          throw new CatalogError(
            "PUBLICATION_BUSY",
            "A publisher still owns this staging directory",
            {},
          );
        throw error;
      },
    );
    let destination: FileHandle | undefined;
    try {
      const actualStage = await stage.stat({ bigint: true });
      if (actualStage.dev !== stageBefore.dev || actualStage.ino !== stageBefore.ino)
        throw new CatalogError("INVALID_STORAGE", "Publication staging changed while opening");
      const before = await lstat(destinationPath, { bigint: true });
      if (!before.isDirectory())
        throw new CatalogError("INVALID_STORAGE", "Publication destination must be a directory");
      if (before.dev === actualStage.dev && before.ino === actualStage.ino)
        throw new CatalogError(
          "INVALID_STORAGE",
          "Publication destination cannot be its staging directory",
        );
      destination = await open(await realpath(destinationPath), directoryFlags | O_EXLOCK).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")
            throw new CatalogError(
              "PUBLICATION_BUSY",
              "Another publisher holds this destination",
              {},
            );
          throw error;
        },
      );
      const actual = await destination.stat({ bigint: true });
      if (actual.dev !== before.dev || actual.ino !== before.ino)
        throw new CatalogError("INVALID_STORAGE", "Publication destination changed while opening");
      const identity = (value: typeof actual) => ({
        dev: value.dev.toString(),
        ino: value.ino.toString(),
      });
      if (
        options.expected &&
        (actualStage.dev.toString() !== options.expected.stage.dev ||
          actualStage.ino.toString() !== options.expected.stage.ino ||
          actual.dev.toString() !== options.expected.destination.dev ||
          actual.ino.toString() !== options.expected.destination.ino)
      )
        throw new CatalogError("PUBLICATION_CHANGED", "Registered publication ownership changed");
      return new Publication(
        stage,
        destination,
        { stage: identity(actualStage), destination: identity(actual) },
        worker,
        options.timeoutMs,
        options.onClosed,
      );
    } catch (error) {
      await destination?.close();
      await stage.close();
      throw error;
    }
  }

  /** The catalog records this random sibling name before allocation. No payload writer
   * may enter until the returned directory identity is committed to that catalog. */
  static async allocate(
    directory: string,
    expected: DirectoryIdentity,
    name: string,
    worker: MediaWorker,
  ): Promise<DirectoryIdentity> {
    const parent = await open(await realpath(directory), directoryFlags);
    try {
      const value = this.data(
        await worker(
          "publication.allocate",
          { destination: expected, name },
          { descriptors: [parent.fd] },
        ),
      );
      const identity = value.identity as DirectoryIdentity;
      if (!identity || typeof identity.dev !== "string" || typeof identity.ino !== "string")
        throw new CatalogError(
          "INVALID_NATIVE_RESPONSE",
          "Publication allocation did not identify staging",
        );
      return identity;
    } finally {
      await parent.close();
    }
  }

  /** A destination path that is gone, or now names another directory, holds nothing this
   * owner may observe or remove beneath the admitted identity: that is `unreachable`.
   * ELOOP counts too, because O_NOFOLLOW_ANY reports a symlink added to the admitted path. */
  static async staging(
    directory: string,
    expected: DirectoryIdentity,
    name: string,
    worker: MediaWorker,
    signal?: AbortSignal,
  ): Promise<StagingPresence> {
    let parent: FileHandle;
    try {
      parent = await open(directory, directoryFlags);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return "unreachable";
      throw error;
    }
    try {
      const actual = await parent.stat({ bigint: true });
      if (actual.dev.toString() !== expected.dev || actual.ino.toString() !== expected.ino)
        return "unreachable";
      const value = this.data(
        await worker(
          "publication.absent",
          { destination: expected, name },
          { descriptors: [parent.fd], ...(signal ? { signal } : {}) },
        ),
      );
      if (typeof value.absent !== "boolean")
        throw new CatalogError("INVALID_NATIVE_RESPONSE", "Staging absence was not confirmed");
      return value.absent ? "absent" : "present";
    } finally {
      await parent.close();
    }
  }

  private static data(result: Awaited<ReturnType<MediaWorker>>): Record<string, unknown> {
    const data = nativeResult(result);
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new CatalogError("INVALID_NATIVE_RESPONSE", "Publication response is missing");
    return data as Record<string, unknown>;
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new CatalogError("INVALID_STATE", "Publication is closed"));
    if (this.pending)
      return Promise.reject(
        new CatalogError("PUBLICATION_BUSY", "Publication operation is still running", {}),
      );
    const pending = action();
    this.pending = pending;
    return pending.finally(() => {
      this.pending = undefined;
    });
  }

  private call(
    operation: string,
    params: Record<string, unknown> = {},
    options: {
      signal?: AbortSignal;
      source?: { readonly fd: number };
    } = {},
  ) {
    return this.worker(
      `publication.${operation}`,
      { ...this.identities, ...params },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.timeoutMs !== undefined ? { timeoutMs: () => this.timeoutMs! } : {}),
        descriptors: [
          this.stage.fd,
          this.destination.fd,
          ...(options.source ? [options.source.fd] : []),
        ],
      },
    );
  }

  /** Source must remain open through this call. A failed prepare keeps partial private
   * evidence for explicit discard; it can never create the external destination. */
  prepare(
    source: { readonly fd: number },
    leaf: string,
    maxBytes: number,
    options: { signal?: AbortSignal; replacement?: PublicationFile | null } = {},
  ) {
    return this.run(async () => {
      const value = Publication.data(
        await this.call(
          "prepare",
          { leaf, maxBytes, replacement: options.replacement ?? null },
          { ...options, source },
        ),
      );
      if (!("receipt" in value))
        throw new CatalogError(
          "INVALID_NATIVE_RESPONSE",
          "Publication preparation was not confirmed",
        );
      return value.receipt;
    });
  }

  private async observe(options: { signal?: AbortSignal } = {}): Promise<PublicationObservation> {
    const value = Publication.data(await this.call("reconcile", {}, options));
    if (
      !("state" in value) ||
      typeof value.state !== "string" ||
      ![
        "unprepared",
        "missing",
        "prepared",
        "committed",
        "replaced",
        "modified",
        "conflicted",
      ].includes(value.state)
    )
      throw new CatalogError("INVALID_NATIVE_RESPONSE", "Publication outcome was not confirmed");
    const receipt = "receipt" in value ? value.receipt : undefined;
    if (value.state === "unprepared" ? receipt !== null : !receipt || typeof receipt !== "object")
      throw new CatalogError("INVALID_NATIVE_RESPONSE", "Publication receipt is missing");
    return {
      state: value.state as PublicationState,
      receipt: receipt as PublicationReceipt | null,
    };
  }

  reconcile(options: { signal?: AbortSignal } = {}) {
    return this.run(() => this.observe(options));
  }

  commit(options: { signal?: AbortSignal } = {}) {
    return this.run(async () => {
      // An abort already observed by this owner never enters the commit worker.
      if (options.signal?.aborted) throw new CatalogError("CANCELED", "Publication was canceled");
      let failure: unknown;
      try {
        Publication.data(await this.call("commit", {}, options));
      } catch (error) {
        failure = error;
      }
      // mediaWorker has reaped the child. Even a canceled/timeout result may have linked.
      const observed = await this.observe();
      if (
        (observed.state === "missing" ||
          observed.state === "prepared" ||
          observed.state === "unprepared") &&
        failure !== undefined
      )
        throw failure;
      return observed;
    });
  }

  /** Call only after the caller durably records the observed external commit. */
  acknowledge() {
    return this.remove("acknowledge");
  }
  /** Explicitly abandons private evidence; never removes the external destination. */
  discard() {
    return this.remove("discard");
  }
  private remove(operation: "acknowledge" | "discard") {
    return this.run(async () =>
      nativeConfirmed(
        await this.call(operation),
        "removed",
        "Publication cleanup was not confirmed",
      ),
    );
  }
  retire(name: string) {
    return this.run(async () =>
      nativeConfirmed(
        await this.call("retire", { name }),
        "removed",
        "Publication staging retirement was not confirmed",
      ),
    );
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.pending?.catch(() => {});
      await Promise.all([this.stage.close(), this.destination.close()]).finally(this.onClosed);
    })());
  }
}

/** Three payload passes and two displaced-destination passes at inferred 4 MiB/s, 2× margin.
 * Express actual bytes as bytes per required take second; this is work, not a file ceiling. */
export function publicationDeadlineMs(bytes: number, replacementBytes = 0): number {
  if (![bytes, replacementBytes].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new CatalogError("INVALID_STORAGE", "Publication byte count is invalid");
  const bytesPerSecond = (bytes * 3 + replacementBytes * 2) / (MAXIMUM_TAKE_US / 1_000_000);
  return Math.max(1, derivedBound((bytesPerSecond / 4_194_304) * 1000, MAXIMUM_TAKE_US, 2));
}

/** Six stop-time journal passes at the slice-00 measured cost per byte, with 2× margin.
 * Scale by actual bytes; pauses, extra roles and callbacks can grow the journal independently. */
export function journalWorkDeadlineMs(bytes: number): number {
  const rate = bytes / (MAXIMUM_TAKE_US / 1_000_000);
  return Math.max(
    1,
    derivedBound(((6 * 51.863325166) / 1_392_503_313) * rate * 1000, MAXIMUM_TAKE_US, 2),
  );
}
