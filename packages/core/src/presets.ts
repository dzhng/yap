import {
  directorySource,
  emptyInstallReport,
  installPackages,
  newerThanInstalled,
} from "./preset-install.js";
import { presetId, scaffold } from "./preset-scaffold.js";
import { presetReceiptsFrom0161 } from "./record-identity-migration.js";

type Receipt = { input: string; result: unknown };
const receiptFileVersion = 2;
import { join } from "node:path";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import {
  GET_INSTRUCTIONS_TEMPLATE,
  LIST_INSTRUCTIONS_TEMPLATE,
  render,
} from "./preset-instructions.js";
import { PresetStore, type PresetDetails, type PresetSummary } from "./preset-store.js";
import type { PresetRefresh, RefreshState } from "./preset-refresh.js";
import type { InstallReport } from "./preset-install.js";
import { isValidReference } from "./preset-format.js";
import { CatalogError } from "./catalog.js";
import { pageCursor } from "./page-cursor.js";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type Trash = (path: string) => Promise<void>;
const productionTrash: Trash = (path) =>
  new Promise((resolve, reject) => {
    execFile("/usr/bin/trash", [path], (error) => (error ? reject(error) : resolve()));
  });

export type PresetsOptions = {
  root: string;
  bundled?: string;
  refresh?: PresetRefresh;
  trash?: Trash;
};
export type PresetListResult = {
  presets: PresetSummary[];
  refresh: RefreshState;
  instructions: string[];
};
export type PresetResult = PresetDetails & { instructions: string[] };
export type PresetUpdateResult = {
  report: InstallReport;
  refresh: RefreshState;
  instructions: string[];
};

export class Presets {
  private readonly requests = new Map<string, { input: string; result: unknown }>();
  private readonly requestReceipts = new Map<string, { input: string; result: unknown }>();
  private readonly requestReceiptPath: string;
  constructor(
    private readonly store: PresetStore,
    /** Why the bundled install failed, if it did; presets never stop the service starting. */
    private readonly installError: string | null = null,
    private readonly refresh?: PresetRefresh,
    private readonly trash: Trash = productionTrash,
  ) {
    this.requestReceiptPath = join(this.store.root, ".request-receipts.json");
    if (existsSync(this.requestReceiptPath)) {
      try {
        const stored = JSON.parse(readFileSync(this.requestReceiptPath, "utf8")) as
          | { version: typeof receiptFileVersion; receipts: Record<string, Receipt> }
          | Record<string, Receipt>;
        // 0.1.61 wrote the receipts unversioned; they are converted once and rewritten.
        const current = stored.version === receiptFileVersion;
        const receipts = current
          ? (stored.receipts as Record<string, Receipt>)
          : presetReceiptsFrom0161(stored as Record<string, Receipt>);
        for (const [id, receipt] of Object.entries(receipts)) this.requestReceipts.set(id, receipt);
        if (!current) this.writeRequestReceipts();
      } catch {
        // A damaged receipt file cannot authorize a replay; the preset files remain the source.
      }
    }
  }
  private saveRequestReceipt(requestId: string, receipt: { input: string; result: unknown }): void {
    this.requestReceipts.set(requestId, receipt);
    this.writeRequestReceipts();
  }
  private writeRequestReceipts(): void {
    const temporary = `${this.requestReceiptPath}.tmp`;
    const file = {
      version: receiptFileVersion,
      receipts: Object.fromEntries(this.requestReceipts),
    };
    writeFileSync(temporary, JSON.stringify(file), {
      mode: 0o600,
    });
    renameSync(temporary, this.requestReceiptPath);
  }
  private priorRequest(requestId: string | undefined, input: string) {
    if (!requestId) return undefined;
    const prior = this.requests.get(requestId) ?? this.requestReceipts.get(requestId);
    if (!prior) return undefined;
    if (prior.input !== input)
      throw new CatalogError(
        "REQUEST_CONFLICT",
        "Request identity names different preset parameters",
      );
    return prior.result;
  }

  list(): PresetListResult {
    return {
      presets: this.store.list(),
      refresh: this.refresh
        ? (() => {
            const state = this.refresh.state();
            return state.checkedAt ? state : { ...state, error: state.error ?? this.installError };
          })()
        : { checkedAt: null, commit: null, error: this.installError, available: [], bytesDone: 0 },
      instructions: render(LIST_INSTRUCTIONS_TEMPLATE, {}),
    };
  }

  page(input: { cursor?: string; limit?: number } = {}) {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new CatalogError("INVALID_PARAMS", "Preset page limit must be 1–1000");
    const position =
      input.cursor === undefined
        ? 0
        : (pageCursor.decode("preset.list", input.cursor, {}) as { index?: unknown }).index;
    if (!Number.isSafeInteger(position) || (position as number) < 0)
      throw new CatalogError("INVALID_PARAMS", "Invalid preset page cursor");
    const listed = this.list();
    const presets = listed.presets.slice(position as number, (position as number) + limit + 1);
    return {
      ...listed,
      presets: presets.slice(0, limit),
      nextCursor:
        presets.length > limit
          ? pageCursor.encode("preset.list", { index: (position as number) + limit }, {})
          : null,
    };
  }

  async update(id?: string, requestId?: string): Promise<PresetUpdateResult> {
    const input = JSON.stringify({ operation: "preset.update", presetId: id ?? null });
    const prior = this.priorRequest(requestId, input);
    if (prior)
      return (
        prior instanceof Promise ? prior : Promise.resolve(prior)
      ) as Promise<PresetUpdateResult>;
    const run = async (): Promise<PresetUpdateResult> => {
      // Nothing was changed: report why as an outcome, like a failed file.
      const unchanged = (reason: string, instruction: string): PresetUpdateResult => ({
        report: { ...emptyInstallReport(), failed: [{ id: id ?? "presets", reason }] },
        refresh: this.list().refresh,
        instructions: [instruction],
      });
      if (!this.refresh)
        return unchanged(
          "refresh is disabled",
          "Preset refresh is turned off in this service, so nothing was downloaded; the installed presets are unchanged.",
        );
      let report: InstallReport;
      try {
        report = await this.refresh.run(id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return unchanged(
          reason,
          `The preset source could not be reached (${reason}); the installed presets are unchanged and still usable.`,
        );
      }
      // Only presets can be read with preset.get; kit and authoring updates are shared files.
      const updated = report.installed.filter(
        (value) => this.store.get(value)?.source === "downloaded",
      );
      const instructions: string[] = [];
      if (updated.length)
        instructions.push(
          `Presets updated: ${updated.join(", ")}. Call preset.get on each before editing with it.`,
        );
      if (report.removed.length)
        instructions.push(`No longer offered and removed: ${report.removed.join(", ")}.`);
      if (!instructions.length) instructions.push("No presets changed.");
      return { report, refresh: this.list().refresh, instructions };
    };
    const result = run();
    if (requestId) {
      this.requests.set(requestId, { input, result });
      void result.then(
        (value) => this.saveRequestReceipt(requestId, { input, result: value }),
        () => {},
      );
    }
    return result;
  }

  async create(input: {
    name: string;
    references?: string[] | undefined;
    requestId?: string;
  }): Promise<{
    id: string;
    path: string;
    guidePath: string;
    kitPath: string;
    instructions: string[];
  }> {
    const requestId = input.requestId;
    const requestInput = JSON.stringify({
      operation: "preset.create",
      name: input.name,
      references: input.references ?? [],
    });
    const prior = this.priorRequest(requestId, requestInput);
    if (prior)
      return (prior instanceof Promise ? prior : Promise.resolve(prior)) as Promise<
        Awaited<ReturnType<Presets["create"]>>
      >;
    const run = async () => {
      const references = input.references ?? [];
      for (const reference of references)
        if (!isValidReference(reference, "local"))
          throw new CatalogError(
            "PRESET_REFERENCE_INVALID",
            `A reference must be an https URL or an absolute path to an existing file: ${reference}`,
            { reference },
          );
      // Reserve every official id, including ones a refresh in flight is about to install.
      await this.refresh?.settled();
      const taken = this.refresh?.remoteIds() ?? new Set<string>();
      for (const id of this.store.installedIds()) taken.add(id);
      const id = presetId(input.name, taken);
      if (!id)
        throw new CatalogError(
          "PRESET_NAME_UNUSABLE",
          `Preset name has no usable characters: ${input.name}`,
          { name: input.name },
        );
      const path = join(this.store.root, id);
      await scaffold({
        template: join(this.store.root, "authoring", "template"),
        target: path,
        id,
        name: input.name,
        references,
      });
      try {
        await this.store.addLocal(id);
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      const guidePath = join(this.store.root, "authoring", "AUTHORING.md");
      const kitPath = join(this.store.root, "kit");
      return {
        id,
        path,
        guidePath,
        kitPath,
        instructions: render(
          await readFile(join(this.store.root, "authoring", "instructions.md"), "utf8"),
          { id, path, guidePath, kitPath },
        ),
      };
    };
    const result = run();
    if (requestId) {
      this.requests.set(requestId, { input: requestInput, result });
      void result.then(
        (value) => this.saveRequestReceipt(requestId, { input: requestInput, result: value }),
        () => {},
      );
    }
    return result;
  }

  async delete(
    id: string,
    requestId?: string,
  ): Promise<{ id: string; trashed: true; trashedPaths: string[]; instructions: string[] }> {
    const input = JSON.stringify({ operation: "preset.delete", presetId: id });
    const prior = this.priorRequest(requestId, input);
    if (prior)
      return (prior instanceof Promise ? prior : Promise.resolve(prior)) as Promise<
        Awaited<ReturnType<Presets["delete"]>>
      >;
    const run = async (): Promise<{
      id: string;
      trashed: true;
      trashedPaths: string[];
      instructions: string[];
    }> => {
      if (!this.store.readLocal().includes(id))
        throw new CatalogError("PRESET_NOT_LOCAL", `Preset is not local: ${id}`, { id });
      const path = join(this.store.root, id);
      await this.trash(path);
      await this.store.removeLocal(id);
      return {
        id,
        trashed: true,
        trashedPaths: [path],
        instructions: [`Preset ${id} is in the Trash. It can be restored from Finder.`],
      };
    };
    const result = run();
    if (requestId) {
      this.requests.set(requestId, { input, result });
      void result.then(
        (value) => this.saveRequestReceipt(requestId, { input, result: value }),
        () => {},
      );
    }
    return result;
  }

  get(id: string): PresetResult {
    const details = this.store.get(id);
    if (!details) throw new CatalogError("PRESET_NOT_FOUND", `Preset not found: ${id}`, { id });
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
      const report = await installPackages(
        directorySource(options.bundled),
        options.root,
        newerThanInstalled,
      );
      if (report.failed.length)
        installError = report.failed.map((f) => `${f.id}: ${f.reason}`).join("; ");
    } catch (error) {
      installError = `bundled presets unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return new Presets(new PresetStore(options.root), installError, options.refresh, options.trash);
}
