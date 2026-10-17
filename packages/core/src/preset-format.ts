import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, relative, resolve, dirname } from "node:path";

export type PresetOrigin = "repo" | "local";
export type PresetKind = "preset" | "kit" | "authoring";
export type PresetIssue = { code: string; path?: string; message: string };
export type PresetFile = { path: string; bytes: number; sha256: string };
export type PresetManifest = {
  id: string;
  kind: PresetKind;
  name?: string;
  description?: string;
  version: number;
  references?: string[];
  files: PresetFile[];
};
export type PresetIndex = { format: 1; packages: PresetManifest[] };

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ID = /^[a-z0-9-]+$/;
/** The one id rule for every package: preset, kit and authoring. */
export const isPackageId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const ENTRY = new Map<string, PresetKind>([
  ["PRESET.md", "preset"],
  ["KIT.md", "kit"],
  ["AUTHORING.md", "authoring"],
]);

/** The folder a package installs to: a preset under its id, kit and authoring under their kind. */
/** Why an index can't be read by this app, or null when its format is the one it knows. */
export function unsupportedIndex(index: { format?: unknown }): string | null {
  return index.format === 1 ? null : `unsupported preset index format: ${String(index.format)}`;
}

export function folderFor(pkg: Pick<PresetManifest, "id" | "kind">): string {
  return pkg.kind === "preset" ? pkg.id : pkg.kind;
}

/** A reference is an https URL; a local preset may also name an absolute path to an existing file. */
export function isValidReference(reference: string, origin: PresetOrigin): boolean {
  if (reference.startsWith("https://")) return true;
  if (origin !== "local" || resolve(reference) !== reference) return false;
  try {
    return statSync(reference).isFile();
  } catch {
    return false;
  }
}

function issue(code: string, message: string, path?: string): PresetIssue {
  return { code, ...(path ? { path } : {}), message };
}

function stripComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if ((c === "'" || c === '"') && (!quote || quote === c)) quote = quote ? undefined : c;
    if (c === "#" && !quote && (i === 0 || /\s/.test(value[i - 1]!)))
      return value.slice(0, i).trim();
  }
  return value.trim();
}

function scalar(value: string): string | number | boolean {
  const raw = stripComment(value);
  // The scaffold writes JSON-quoted names; undo its escapes.
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length > 1 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function parseFrontmatter(text: string): {
  values?: Record<string, unknown>;
  body: string;
  error?: string;
} {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0] !== "---") return { body: text, error: "missing frontmatter" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { body: text, error: "unterminated frontmatter" };
  const values: Record<string, unknown> = {};
  let listKey: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const list = line.match(/^\s+-\s+(.+)$/);
    if (list) {
      if (!listKey)
        return { body: lines.slice(end + 1).join("\n"), error: "list item without a key" };
      (values[listKey] as unknown[]).push(scalar(list[1]!));
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match)
      return { body: lines.slice(end + 1).join("\n"), error: `invalid frontmatter line: ${line}` };
    const key = match[1]!;
    const value = match[2] ?? "";
    if (value === "") {
      values[key] = [];
      listKey = key;
    } else {
      values[key] = scalar(value);
      listKey = undefined;
    }
  }
  return { values, body: lines.slice(end + 1).join("\n") };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function packageRootAndEntry(
  path: string,
): { root: string; entry: string; kind: PresetKind } | undefined {
  const normalized = normalizePath(path);
  for (const [entry, kind] of ENTRY) {
    if (normalized === entry) return { root: "", entry, kind };
    if (normalized.endsWith(`/${entry}`))
      return { root: normalized.slice(0, -(entry.length + 1)), entry, kind };
  }
  return undefined;
}

function packageFiles(files: Map<string, Uint8Array>, root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const prefix = root ? `${root}/` : "";
  for (const [raw, value] of files) {
    const path = normalizePath(raw);
    if (path === root || path.startsWith(prefix))
      out.set(prefix ? path.slice(prefix.length) : path, value);
  }
  return out;
}

export function parsePackage(
  files: Map<string, Uint8Array>,
  policy: { origin: PresetOrigin },
): { ok: true; manifest: PresetManifest } | { ok: false; issues: PresetIssue[] } {
  // The shallowest entry is the package's; a deeper one (the authoring template's PRESET.md) is content.
  const entry = [...files.keys()]
    .map(packageRootAndEntry)
    .filter((found) => found !== undefined)
    .sort(
      (a, b) =>
        a.root.split("/").length - b.root.split("/").length || a.root.length - b.root.length,
    )[0];
  if (!entry)
    return {
      ok: false,
      issues: [issue("missing-entry", "package has no recognized entry document")],
    };
  const scoped = packageFiles(files, entry.root);
  const source = scoped.get(entry.entry);
  if (!source)
    return { ok: false, issues: [issue("missing-entry", `missing ${entry.entry}`, entry.entry)] };
  const text = new TextDecoder().decode(source);
  const parsed = parseFrontmatter(text);
  const issues: PresetIssue[] = [];
  if (parsed.error || !parsed.values)
    issues.push(issue("frontmatter", parsed.error ?? "invalid frontmatter", entry.entry));
  const values = parsed.values ?? {};
  const id = typeof values.id === "string" ? values.id : "";
  const version = typeof values.version === "number" ? values.version : NaN;
  if (!id) issues.push(issue("missing-id", "frontmatter id is required", entry.entry));
  if (!Number.isInteger(version) || version < 1)
    issues.push(
      issue("bad-version", "frontmatter version must be a positive integer", entry.entry),
    );
  const expectedFolder =
    entry.kind === "preset" ? (entry.root.split("/").at(-1) ?? "") : entry.kind;
  if (!ID.test(id))
    issues.push(issue("bad-id", `id must match [a-z0-9-]+: ${id || "<missing>"}`, entry.entry));
  if (expectedFolder && id !== expectedFolder)
    issues.push(
      issue("id-folder", `id ${id} does not match folder ${expectedFolder}`, entry.entry),
    );
  const references = values.references;
  if (
    references !== undefined &&
    (!Array.isArray(references) || references.some((v) => typeof v !== "string"))
  ) {
    issues.push(issue("references", "references must be a list of strings", entry.entry));
  } else {
    for (const ref of (references as string[] | undefined) ?? []) {
      if (!isValidReference(ref, policy.origin))
        issues.push(
          issue(
            "reference",
            `reference must be https${policy.origin === "local" ? " or an absolute path to an existing file" : ""}: ${ref}`,
            entry.entry,
          ),
        );
    }
  }
  if (entry.kind === "preset") {
    if (!/^##\s+Any footage\s*$/m.test(parsed.body))
      issues.push(issue("missing-any-footage", "preset is missing ## Any footage", entry.entry));
    if (!/^##\s+Shoot\s*$/m.test(parsed.body))
      issues.push(issue("missing-shoot", "preset is missing ## Shoot", entry.entry));
    if (!/^##\s+Edit\s*$/m.test(parsed.body))
      issues.push(issue("missing-edit", "preset is missing ## Edit", entry.entry));
  }
  for (const [path, bytes] of scoped) {
    if (bytes.byteLength >= MAX_FILE_BYTES)
      issues.push(
        issue("file-too-large", `file is ${bytes.byteLength} bytes; limit is 100 MiB`, path),
      );
    if (isLfsPointer(bytes))
      issues.push(issue("git-lfs", "Git LFS pointer files are not allowed", path));
  }
  if (issues.length) return { ok: false, issues };
  const manifest: PresetManifest = {
    id,
    kind: entry.kind,
    ...(typeof values.name === "string" ? { name: values.name } : {}),
    ...(typeof values.description === "string" ? { description: values.description } : {}),
    version,
    ...(Array.isArray(references) && references.length
      ? { references: references as string[] }
      : {}),
    files: [...scoped]
      .map(([path, data]) => ({
        path,
        bytes: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  return { ok: true, manifest };
}

function isLfsPointer(data: Uint8Array): boolean {
  const text = new TextDecoder().decode(data.subarray(0, 1024));
  return (
    text.startsWith("version https://git-lfs.github.com/spec/v1\n") &&
    /\noid sha256:[0-9a-f]{64}\n/.test(text)
  );
}

export function buildIndex(manifests: PresetManifest[]): PresetIndex {
  return {
    format: 1,
    packages: [...manifests]
      .map((manifest) => ({
        id: manifest.id,
        kind: manifest.kind,
        ...(manifest.name !== undefined ? { name: manifest.name } : {}),
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        version: manifest.version,
        files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function markdownLinks(text: string): string[] {
  return [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)].map((m) => m[1]!);
}

/**
 * Check a presets tree and return the manifest of every valid top-level package. A `source/`
 * folder holds local, git-ignored reference videos: the walk never enters one.
 */
export function validateTree(
  root: string,
  policy: { origin: PresetOrigin } = { origin: "repo" },
): { issues: PresetIssue[]; manifests: PresetManifest[] } {
  const issues: PresetIssue[] = [];
  const manifests: PresetManifest[] = [];
  const files = new Map<string, Uint8Array>();
  const symlinks: string[] = [];
  function walk(dir: string): void {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, item.name);
      const path = normalizePath(relative(root, absolute));
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) symlinks.push(path);
      else if (stat.isDirectory()) {
        if (item.name !== "source") walk(absolute);
      } else if (stat.isFile()) files.set(path, new Uint8Array(readFileSync(absolute)));
    }
  }
  walk(root);
  for (const [path, data] of files) {
    if (data.byteLength >= MAX_FILE_BYTES)
      issues.push(
        issue("file-too-large", `file is ${data.byteLength} bytes; limit is 100 MiB`, path),
      );
    if (isLfsPointer(data))
      issues.push(issue("git-lfs", "Git LFS pointer files are not allowed", path));
  }
  for (const path of symlinks) issues.push(issue("symlink", "symlinks are not allowed", path));
  // Every top-level folder is a package; parsePackage sees its folder so it checks id against it.
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory() || item.name === "source") continue;
    const prefix = `${item.name}/`;
    const parsed = parsePackage(
      new Map([...files].filter(([path]) => path.startsWith(prefix))),
      policy,
    );
    // Installs fetch each package from folderFor(manifest), so it must be this folder.
    if (parsed.ok && folderFor(parsed.manifest) !== item.name)
      issues.push(
        issue(
          "id-folder",
          `${parsed.manifest.kind} ${parsed.manifest.id} belongs in ${folderFor(parsed.manifest)}/, not ${item.name}/`,
          item.name,
        ),
      );
    else if (parsed.ok) manifests.push(parsed.manifest);
    else
      for (const found of parsed.issues)
        issues.push(
          issue(found.code, found.message, found.path ? `${item.name}/${found.path}` : item.name),
        );
  }
  const indexed = new Set<string>(files.keys());
  for (const [path, data] of files) {
    if (!path.endsWith(".md")) continue;
    const text = new TextDecoder().decode(data);
    for (const target of markdownLinks(text)) {
      if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue;
      const clean = target.split("#", 1)[0]!.split("?", 1)[0]!;
      if (!clean) continue;
      const resolved = normalizePath(normalize(join(dirname(path), clean)));
      if (resolved.startsWith("../") || !indexed.has(resolved)) {
        if (path.startsWith("authoring/template/")) continue;
        issues.push(
          issue(
            "broken-link",
            `relative Markdown link does not resolve to a file: ${target}`,
            path,
          ),
        );
      }
    }
  }
  const unique = [
    ...new Map(
      issues.map((item) => [`${item.code}:${item.path ?? ""}:${item.message}`, item]),
    ).values(),
  ];
  return {
    issues: unique.sort((a, b) =>
      `${a.path ?? ""}:${a.code}`.localeCompare(`${b.path ?? ""}:${b.code}`),
    ),
    manifests,
  };
}
