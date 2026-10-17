import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export function presetId(name: string, taken: ReadonlySet<string>): string | null {
  const ascii = name
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .toLowerCase();
  const words = ascii.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return null;
  const base = words.join("-").slice(0, 48).replace(/-+$/g, "");
  if (!base) return null;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, Math.max(1, 48 - suffix.length))}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type ScaffoldOptions = {
  template: string;
  target: string;
  id: string;
  name: string;
  references: readonly string[];
};

/** Quote a value the frontmatter parser would otherwise misread (a colon, a comment mark, quotes). */
function yamlScalar(value: string): string {
  return /[:#"'\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
}

function frontmatter(
  text: string,
  id: string,
  name: string,
  references: readonly string[],
): string {
  const match = text.match(/^(---\n)([\s\S]*?)(\n---\n[\s\S]*)$/);
  if (!match) throw new Error("template PRESET.md has no frontmatter");
  const lines = match[2]!.split("\n");
  const out: string[] = [];
  let replacedReferences = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("id:")) {
      out.push(`id: ${id}`);
      continue;
    }
    if (line.startsWith("name:")) {
      out.push(`name: ${yamlScalar(name)}`);
      continue;
    }
    if (/^references:\s*$/.test(line)) {
      out.push("references:");
      for (const ref of references) out.push(`  - ${ref}`);
      replacedReferences = true;
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1]!)) i++;
      continue;
    }
    out.push(line);
  }
  if (!replacedReferences) {
    const version = out.findIndex((line) => line.startsWith("version:"));
    out.splice(
      version < 0 ? out.length : version + 1,
      0,
      "references:",
      ...references.map((ref) => `  - ${ref}`),
    );
  }
  return `${match[1]}${out.join("\n")}${match[3]}`;
}

export async function scaffold(options: ScaffoldOptions): Promise<void> {
  try {
    await stat(options.target);
    throw new Error(`preset folder already exists: ${options.target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(options.target), { recursive: true });
  const staging = join(dirname(options.target), `.staging-${options.id}-${randomUUID()}`);
  try {
    await cp(options.template, staging, { recursive: true, errorOnExist: true });
    const presetPath = join(staging, "PRESET.md");
    const text = await readFile(presetPath, "utf8");
    await writeFile(presetPath, frontmatter(text, options.id, options.name, options.references));
    try {
      await stat(options.target);
      throw new Error(`preset folder already exists: ${options.target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, options.target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
