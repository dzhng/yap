import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isPackageId,
  parsePackage,
  type PresetFile,
  type PresetManifest,
} from "./preset-format.js";
import { readReceipt, type PresetReceipt } from "./preset-install.js";

export type PresetSource = "bundled" | "downloaded" | "local";
export type PresetSummary = {
  id: string;
  kind: "preset";
  name: string;
  description: string;
  version: number;
  source: PresetSource;
  references: string[];
  conflict?: boolean;
};
export type PresetDetails = {
  id: string;
  text: string;
  path: string;
  kitPath: string;
  guidePath: string;
  /** Installed presets list their pinned files; a local preset's files carry no sha256. */
  files: ListedFile[];
  source: PresetSource;
};
export type ListedFile = Omit<PresetFile, "sha256"> & { sha256?: string };

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.datasync();
    await handle.close();
    await rename(temp, path);
  } finally {
    await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}

function metadata(path: string): Partial<PresetManifest> {
  try {
    const text = readFileSync(path);
    const parsed = parsePackage(new Map([["PRESET.md", new Uint8Array(text)]]), {
      origin: "local",
    });
    if (parsed.ok) return parsed.manifest;
  } catch {}
  return {};
}

export function readLocalIds(root: string): Set<string> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, "local.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("local.json must be an object with an ids array");
  const value = (raw as { ids?: unknown }).ids;
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string") ||
    Object.keys(raw).some((key) => key !== "ids")
  )
    throw new Error("local.json must contain only ids: string[]");
  return new Set(value);
}

/** Every preset id the store serves: installed presets plus local ones. */
function presetIds(receipt: PresetReceipt, locals: Set<string>): string[] {
  return [
    ...new Set([
      ...Object.entries(receipt.packages)
        .filter(([, pkg]) => pkg.kind === "preset")
        .map(([id]) => id),
      ...locals,
    ]),
  ].sort();
}

function sourceOf(id: string, receipt: PresetReceipt, locals: Set<string>): PresetSource {
  return locals.has(id) ? "local" : (receipt.packages[id]?.source ?? "downloaded");
}

/** A local preset's files by size. Nothing is read, and source/ folders (local reference videos) are skipped. */
function listLocalFiles(root: string): ListedFile[] {
  const files: ListedFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "source") walk(full, path);
      } else if (entry.isFile()) files.push({ path, bytes: statSync(full).size });
    }
  };
  walk(root, "");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export class PresetStore {
  constructor(public readonly root: string) {}

  list(): PresetSummary[] {
    const receipt = readReceipt(this.root);
    const locals = readLocalIds(this.root);
    return presetIds(receipt, locals).flatMap((id) => {
      const entry = join(this.root, id, "PRESET.md");
      if (!existsSync(entry)) return [];
      const info = metadata(entry);
      return [
        {
          id,
          kind: "preset" as const,
          name: info.name ?? id,
          description: info.description ?? "",
          version: info.version ?? receipt.packages[id]?.version ?? 0,
          source: sourceOf(id, receipt, locals),
          references: info.references ?? [],
          ...(receipt.conflicts[id] ? { conflict: true } : {}),
        },
      ];
    });
  }

  get(id: string): PresetDetails | undefined {
    const receipt = readReceipt(this.root);
    const locals = readLocalIds(this.root);
    const installed = receipt.packages[id];
    // Only an installed or local preset id is served, so a crafted id can't reach outside the root.
    if (!isPackageId(id) || (installed?.kind !== "preset" && !locals.has(id))) return undefined;
    const path = join(this.root, id);
    const textPath = join(path, "PRESET.md");
    if (!existsSync(textPath)) return undefined;
    return {
      id,
      text: readFileSync(textPath, "utf8"),
      path,
      kitPath: join(this.root, "kit"),
      guidePath: join(this.root, "authoring", "AUTHORING.md"),
      files: installed?.files ?? listLocalFiles(path),
      source: sourceOf(id, receipt, locals),
    };
  }

  readLocal(): string[] {
    return [...readLocalIds(this.root)].sort();
  }
  installedIds(): string[] {
    return presetIds(readReceipt(this.root), readLocalIds(this.root));
  }
  async addLocal(id: string): Promise<void> {
    await this.writeLocal((ids) => ids.add(id));
  }
  async removeLocal(id: string): Promise<void> {
    await this.writeLocal((ids) => ids.delete(id));
  }

  private async writeLocal(change: (ids: Set<string>) => void): Promise<void> {
    const ids = readLocalIds(this.root);
    change(ids);
    await writeJsonAtomic(join(this.root, "local.json"), { ids: [...ids].sort() });
  }
}
