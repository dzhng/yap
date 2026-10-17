import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./presets-index.mjs", import.meta.url));

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "presets-index-"));
  await mkdir(join(root, "kit"));
  await writeFile(join(root, "kit", "KIT.md"), "---\nid: kit\nversion: 1\nname: Kit\n---\nKit.\n");
  await mkdir(join(root, "demo", "examples", "one"), { recursive: true });
  await writeFile(
    join(root, "demo", "PRESET.md"),
    "---\nid: demo\nversion: 1\nname: Demo\nreferences:\n  - https://example.com\n---\n## Any footage\n\n## Shoot\n\n## Edit\n",
  );
  await writeFile(
    join(root, "demo", "targets.json"),
    JSON.stringify({ durationSeconds: { range: [1, 2] } }),
  );
  await writeFile(
    join(root, "demo", "examples", "one", "profile.json"),
    JSON.stringify({ durationSeconds: 1.5 }),
  );
  return root;
}

async function invoke(root, check = true, baseIndex) {
  try {
    const result = await run(process.execPath, [script, ...(check ? ["--check"] : [])], {
      env: {
        ...process.env,
        PRESETS_ROOT: root,
        ...(baseIndex ? { PRESETS_BASE_INDEX: baseIndex } : {}),
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("--check rejects a stale index", async () => {
  const root = await tree();
  assert.equal((await invoke(root, false)).code, 0);
  await writeFile(join(root, "index.json"), "{}\n");
  assert.notEqual((await invoke(root)).code, 0);
});

test("--check rejects a changed file without a version bump", async () => {
  const root = await tree();
  assert.equal((await invoke(root, false)).code, 0);
  const base = join(root, "base-index.json");
  await copyFile(join(root, "index.json"), base);
  await writeFile(join(root, "demo", "targets.json"), '{"changed":true}\n');
  assert.equal((await invoke(root, false)).code, 0);
  assert.notEqual((await invoke(root, true, base)).code, 0);
});

test("--check rejects an example outside targets", async () => {
  const root = await tree();
  assert.equal((await invoke(root, false)).code, 0);
  await writeFile(
    join(root, "demo", "examples", "one", "profile.json"),
    JSON.stringify({ durationSeconds: 9 }),
  );
  assert.notEqual((await invoke(root)).code, 0);
});

test("--check accepts a clean tree", async () => {
  const root = await tree();
  assert.equal((await invoke(root, false)).code, 0);
  assert.equal((await invoke(root)).code, 0);
});
