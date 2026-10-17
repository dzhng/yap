import { directorySource, installPackages, newerThanInstalled } from "./preset-install.js";
import { GET_INSTRUCTIONS_TEMPLATE, LIST_INSTRUCTIONS_TEMPLATE, render } from "./preset-instructions.js";
import { PresetStore, type PresetDetails, type PresetSummary } from "./preset-store.js";
import type { PresetRefresh, RefreshState } from "./preset-refresh.js";
import type { InstallReport } from "./preset-install.js";

export type PresetsOptions = { root: string; bundled?: string; refresh?: PresetRefresh };
export type PresetListResult = {
  presets: PresetSummary[];
  refresh: RefreshState;
  instructions: string[];
};
export type PresetResult = PresetDetails & { instructions: string[] };

export class PresetNotFoundError extends Error {
  readonly code = "PRESET_NOT_FOUND";
  readonly details = {};
  readonly retryable = false;

  constructor(readonly id: string) {
    super(`Preset not found: ${id}`);
    this.name = "PresetNotFoundError";
  }
}

export class Presets {
  constructor(
    private readonly store: PresetStore,
    /** Why the bundled install failed, if it did; presets never stop the service starting. */
    private readonly installError: string | null = null,
    private readonly refresh?: PresetRefresh,
  ) {}

  list(): PresetListResult {
    return {
      presets: this.store.list(),
      refresh: this.refresh ? (() => {
        const state = this.refresh.state();
        return state.checkedAt ? state : { ...state, error: state.error ?? this.installError };
      })() : { checkedAt: null, commit: null, error: this.installError, available: [], bytesDone: 0 },
      instructions: render(LIST_INSTRUCTIONS_TEMPLATE, {}),
    };
  }

  async update(id?: string): Promise<{ report: InstallReport; refresh: RefreshState; instructions: string[] }> {
    if (!this.refresh) {
      return { report: { installed: [], skipped: [], failed: [{ id: id ?? "presets", reason: "refresh is disabled" }], removed: [], conflicts: [] }, refresh: this.list().refresh, instructions: ["Preset refresh is turned off in this service, so nothing was downloaded; the installed presets are unchanged."] };
    }
    const report = await this.refresh.run(id);
    const changed = [...new Set([...report.installed, ...report.removed].filter((value) => this.store.get(value)?.source !== "local"))];
    return {
      report,
      refresh: this.list().refresh,
      instructions: changed.length ? [`Presets changed: ${changed.join(", ")}. Call preset.get on each changed preset before editing.`] : ["No presets changed."],
    };
  }

  get(id: string): PresetResult {
    const details = this.store.get(id);
    if (!details) throw new PresetNotFoundError(id);
    return {
      ...details,
      instructions: render(GET_INSTRUCTIONS_TEMPLATE, {
        path: details.path,
        kitPath: details.kitPath,
      }),
    };
  }
}

export async function createPresets(options: PresetsOptions): Promise<Presets> {
  let installError: string | null = null;
  if (options.bundled) {
    try {
      const report = await installPackages(directorySource(options.bundled), options.root, newerThanInstalled);
      if (report.failed.length) installError = report.failed.map((f) => `${f.id}: ${f.reason}`).join("; ");
    } catch (error) {
      installError = `bundled presets unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return new Presets(new PresetStore(options.root), installError, options.refresh);
}
