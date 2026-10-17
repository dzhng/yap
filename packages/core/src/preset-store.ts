import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parsePackage, type PresetFile, type PresetManifest } from "./preset-format.js";
import type { InstalledPackage, PresetReceipt } from "./preset-install.js";

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
  files: PresetFile[];
  source: PresetSource;
};

export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

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
    const parsed = parsePackage(new Map([["PRESET.md", new Uint8Array(text)]]), { origin: "local" });
    if (parsed.ok) return parsed.manifest;
  } catch {}
  return {};
}

function parseLocalIds(raw: unknown): Set<string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("local.json must be an object with an ids array");
  const value = (raw as { ids?: unknown }).ids;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string") || Object.keys(raw).some((key) => key !== "ids"))
    throw new Error("local.json must contain only ids: string[]");
  return new Set(value);
}

export function readLocalIds(root: string): Set<string> {
  try { return parseLocalIds(JSON.parse(readFileSync(join(root, "local.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function writeLocalIds(root: string, ids: Iterable<string>): Promise<void> {
  await writeJsonAtomic(join(root, "local.json"), { ids: [...new Set(ids)].sort() });
}

export class PresetStore {
  constructor(public readonly root: string) {}

  list(): PresetSummary[] {
    const receipt = this.readReceipt();
    const locals = readLocalIds(this.root);
    const ids = new Set<string>([
      ...Object.entries(receipt.packages).filter(([, pkg]) => pkg.kind === "preset").map(([id]) => id),
      ...locals,
    ]);
    return [...ids].sort().flatMap((id) => {
      const local = locals.has(id);
      const installed = receipt.packages[id];
      const folder = join(this.root, id);
      const entry = join(folder, "PRESET.md");
      if (!existsSync(entry)) return [];
      const info = metadata(entry);
      return [{
        id,
        kind: "preset" as const,
        name: info.name ?? id,
        description: info.description ?? "",
        version: info.version ?? installed?.version ?? 0,
        source: local ? "local" as const : installed?.source ?? "downloaded" as const,
        references: info.references ?? [],
        ...(receipt.conflicts?.[id] ? { conflict: true } : {}),
      }];
    });
  }

  get(id: string): PresetDetails | undefined {
    const receipt = this.readReceipt();
    const locals = readLocalIds(this.root);
    const installed = receipt.packages[id];
    if (installed && installed.kind !== "preset" && !locals.has(id)) return undefined;
    const path = join(this.root, id);
    const textPath = join(path, "PRESET.md");
    if (!existsSync(textPath)) return undefined;
    const files = installed?.files ?? this.discoverFiles(path);
    return {
      id,
      text: readFileSync(textPath, "utf8"),
      path,
      kitPath: join(this.root, "kit"),
      guidePath: join(this.root, "authoring", "AUTHORING.md"),
      files,
      source: locals.has(id) ? "local" : installed?.source ?? "downloaded",
    };
  }

  readLocal(): string[] { return [...readLocalIds(this.root)].sort(); }
  async addLocal(id: string): Promise<void> {
    const ids = parseLocalIds(await readJsonOr(join(this.root, "local.json"), { ids: [] }));
    ids.add(id);
    await writeLocalIds(this.root, ids);
  }
  async removeLocal(id: string): Promise<void> {
    const ids = parseLocalIds(await readJsonOr(join(this.root, "local.json"), { ids: [] }));
    ids.delete(id);
    await writeLocalIds(this.root, ids);
  }

  private readReceipt(): PresetReceipt {
    try {
      const receipt = JSON.parse(readFileSync(join(this.root, "receipt.json"), "utf8")) as PresetReceipt;
      return { packages: receipt.packages ?? {}, conflicts: receipt.conflicts ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { packages: {}, conflicts: {} };
      throw error;
    }
  }

  private discoverFiles(path: string): PresetFile[] {
    const files: PresetFile[] = [];
    const walk = (dir: string, prefix = "") => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, rel);
        else if (entry.isFile()) {
          const data = readFileSync(full);
          files.push({ path: rel, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
        }
      }
    };
    walk(path);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}

