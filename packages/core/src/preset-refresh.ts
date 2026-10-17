import { join } from "node:path";
import {
  installPackages,
  newerThanInstalled,
  type InstallReport,
  type PackageSource,
  type PackageSelector,
  type PresetReceipt,
} from "./preset-install.js";
import { readJsonOr, readLocalIds } from "./preset-store.js";
import type { PresetIndex } from "./preset-format.js";

export type RefreshState = {
  checkedAt: string | null;
  commit: string | null;
  error: string | null;
  available: Array<{ id: string; version: number }>;
  bytesDone: number;
};
export type RefreshClock = {
  now: () => Date;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
};
export type PresetRefreshOptions = {
  root: string;
  source: () => PackageSource;
  clock?: RefreshClock;
  everyMs?: number;
};

const defaultClock: RefreshClock = {
  now: () => new Date(),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

export class PresetRefresh {
  private readonly clock: RefreshClock;
  private readonly everyMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<InstallReport> | undefined;
  private started = false;
  private lastRemoteIds: string[] = [];
  private closed = false;
  private currentState: RefreshState = {
    checkedAt: null,
    commit: null,
    error: null,
    available: [],
    bytesDone: 0,
  };

  constructor(private readonly options: PresetRefreshOptions) {
    this.clock = options.clock ?? defaultClock;
    this.everyMs = options.everyMs ?? 24 * 60 * 60 * 1000;
  }

  state(): RefreshState {
    return { ...this.currentState, available: [...this.currentState.available] };
  }

  run(id?: string): Promise<InstallReport> {
    if (this.closed) return Promise.reject(new Error("preset refresh is closed"));
    if (this.inFlight) return this.inFlight;
    this.currentState = { ...this.currentState, error: null, bytesDone: 0 };
    const task = this.perform(id);
    this.inFlight = task.finally(() => {
      if (this.inFlight === joined) this.inFlight = undefined;
    });
    const joined = this.inFlight;
    return joined;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.run().catch(() => {});
    this.schedule();
  }

  /** Stop the schedule and wait for a run in flight, so no install is still moving folders. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    await this.settled();
  }

  /** Resolves once no run is in flight; a failed run counts as settled. */
  async settled(): Promise<void> {
    await this.inFlight?.catch(() => {});
  }

  /** Every package id in the last remote index fetched, newer or not. */
  remoteIds(): Set<string> {
    return new Set(this.lastRemoteIds);
  }

  private schedule(): void {
    if (this.closed) return;
    const timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.run()
        .catch(() => {})
        .finally(() => this.schedule());
    }, this.everyMs);
    this.timer = timer;
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
  }

  private async perform(id?: string): Promise<InstallReport> {
    const source = this.options.source();
    try {
      const index = await source.index();
      this.lastRemoteIds = index.packages.map((pkg) => pkg.id);
      // An id-scoped refresh owns that preset plus the shared kit and guide.
      const owned = (remote: { id: string; kind: string }) =>
        !id || remote.id === id || remote.kind === "kit" || remote.kind === "authoring";
      const selected: PackageSelector = (remote, installed) =>
        owned(remote) && newerThanInstalled(remote, installed);
      const state = this.currentState;
      const counted: PackageSource = {
        ...source,
        index: async () => index,
        file: async (pkg, path, expect, signal) => {
          const stream = await source.file(pkg, path, expect, signal);
          const reader = stream.getReader();
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  reader.releaseLock();
                  controller.close();
                  return;
                }
                state.bytesDone += next.value.byteLength;
                controller.enqueue(next.value);
              } catch (error) {
                controller.error(error);
              }
            },
            cancel(reason) {
              void reader.cancel(reason);
            },
          });
        },
      };
      const report = await installPackages(counted, this.options.root, selected, {
        removeMissingDownloaded: true,
        removeSelector: owned,
      });
      this.currentState = {
        checkedAt: this.clock.now().toISOString(),
        commit: source.commit ?? null,
        error: report.failed.length
          ? report.failed.map((failure) => `${failure.id}: ${failure.reason}`).join("; ")
          : null,
        available: await this.available(index),
        bytesDone: this.currentState.bytesDone,
      };
      return report;
    } catch (error) {
      this.currentState = {
        ...this.currentState,
        checkedAt: this.clock.now().toISOString(),
        commit: source.commit ?? null,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  private async available(index: PresetIndex): Promise<Array<{ id: string; version: number }>> {
    const receipt = await readJsonOr<PresetReceipt>(join(this.options.root, "receipt.json"), {
      packages: {},
      conflicts: {},
    });
    const locals = readLocalIds(this.options.root);
    return index.packages
      .filter((pkg) => !locals.has(pkg.id) && newerThanInstalled(pkg, receipt.packages[pkg.id]))
      .map((pkg) => ({ id: pkg.id, version: pkg.version }));
  }
}
