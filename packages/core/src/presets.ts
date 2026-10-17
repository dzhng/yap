import { directorySource, installPackages, newerThanInstalled } from "./preset-install.js";
import { GET_INSTRUCTIONS_TEMPLATE, LIST_INSTRUCTIONS_TEMPLATE, render } from "./preset-instructions.js";
import { PresetStore, type PresetDetails, type PresetSummary } from "./preset-store.js";

export type PresetsOptions = { root: string; bundled?: string };
export type PresetListResult = {
  presets: PresetSummary[];
  refresh: { checkedAt: null; commit: null; error: string | null; available: [] };
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
  ) {}

  list(): PresetListResult {
    return {
      presets: this.store.list(),
      refresh: { checkedAt: null, commit: null, error: this.installError, available: [] },
      instructions: render(LIST_INSTRUCTIONS_TEMPLATE, {}),
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
  return new Presets(new PresetStore(options.root), installError);
}
