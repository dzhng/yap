#!/usr/bin/env node
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildIndex, parsePackage, validateTree } from "../packages/core/src/preset-format.ts";
import { checkProfile } from "../presets/kit/check.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(process.env.PRESETS_ROOT ?? join(repo, "presets"));
const indexPath = join(root, "index.json");
const checking = process.argv.includes("--check");

async function collect(dir, prefix = "", out = new Map()) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === "index.json" || item.name === "source") continue;
    const absolute = join(dir, item.name);
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    const stat = await lstat(absolute);
    if (stat.isDirectory()) await collect(absolute, path, out);
    else if (stat.isFile()) out.set(path, new Uint8Array(await readFile(absolute)));
  }
  return out;
}

async function packageManifests() {
  const entries = await readdir(root, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "source") continue;
    const files = await collect(join(root, entry.name));
    const parsed = parsePackage(files, { origin: "repo" });
    if (parsed.ok) {
      if (parsed.manifest.id !== entry.name) manifests.push({ __issues: [{ message: `id ${parsed.manifest.id} does not match folder ${entry.name}` }] });
      else manifests.push(parsed.manifest);
    }
    else manifests.push({ __issues: parsed.issues });
  }
  return manifests;
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function packageChanged(current, previous) {
  if (!previous) return false;
  if (current.files.length !== previous.files.length) return true;
  return current.files.some((file) => {
    const old = previous.files.find((item) => item.path === file.path);
    return !old || old.bytes !== file.bytes || old.sha256 !== file.sha256;
  });
}

function baseIndex() {
  if (process.env.PRESETS_BASE_INDEX) {
    try { return JSON.parse(readFileSync(process.env.PRESETS_BASE_INDEX, "utf8")); } catch { return undefined; }
  }
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return JSON.parse(execFileSync("git", ["show", `${base}:presets/index.json`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return undefined;
  }
}

async function exampleIssues(manifest) {
  if (manifest.kind !== "preset") return [];
  const targetPath = join(root, manifest.id, "targets.json");
  let targets;
  try {
    targets = JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    return [];
  }
  const issues = [];
  const examples = join(root, manifest.id, "examples");
  let dirs;
  try { dirs = await readdir(examples, { withFileTypes: true }); } catch { return issues; }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const profilePath = join(examples, dir.name, "profile.json");
    try {
      const rows = checkProfile(JSON.parse(await readFile(profilePath, "utf8")), targets);
      for (const row of rows) if (!row.ok) issues.push(`${manifest.id}/examples/${dir.name}/profile.json: ${row.path} is outside targets`);
    } catch {
      // An example without a profile is not an example check failure.
    }
  }
  return issues;
}

const manifests = await packageManifests();
const issues = [];
for (const manifest of manifests) {
  if (manifest.__issues) issues.push(...manifest.__issues.map((item) => `${item.path ?? ""}: ${item.message}`));
  else for (const problem of await exampleIssues(manifest)) issues.push(problem);
}
issues.push(...(await validateTree(root)).map((item) => `${item.path ?? ""}: ${item.message}`));
const validManifests = manifests.filter((manifest) => !manifest.__issues);
const generated = buildIndex(validManifests);

if (checking) {
  try {
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    if (canonical(current) !== canonical(generated)) issues.push("index.json is stale");
  } catch {
    issues.push("index.json is missing or invalid");
  }
  const previous = baseIndex();
  if (previous?.packages) {
    for (const manifest of validManifests) {
      const old = previous.packages.find((item) => item.id === manifest.id && item.kind === manifest.kind);
      if (packageChanged(manifest, old) && old && manifest.version <= old.version) issues.push(`${manifest.id}: files changed without a version bump`);
    }
  }
} else {
  await writeFile(indexPath, canonical(generated));
}

for (const manifest of validManifests) console.log(`${manifest.kind} ${manifest.id} ${manifest.version} ${manifest.files.length}`);
if (issues.length) {
  for (const item of issues) console.error(`preset: ${item}`);
  process.exitCode = 1;
}
