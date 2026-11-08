import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSnapshot, skillCaseFiles } from "./runtime/skills.mjs";

const operationLiteral = /operation:\s*z\.literal\("([^"]+)"\)/g;

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("skill fixtures expose complete upstream and preserve customized installed inputs", async () => {
  const skill = { "SKILL.md": "skill", "references/install.md": "guide" };
  const files = skillCaseFiles(skill, "skill-diff");
  assert.equal(files["work/upstream/skills/yap/references/install.md"], "guide");
  assert.match(files["work/.agents/skills/yap/SKILL.md"], /LOCAL CUSTOMIZATION/);
  assert.ok(files["work/.agents/skills/yap/local-notes.md"]);
  assert.ok(files["work/.agents/skills/yap/references/removed.md"]);
  assert.ok(files["work/upstream/skills/yap/references/added.md"]);
  assert.equal(
    skillCaseFiles(skill, "skill-install")["work/.agents/skills/yap/SKILL.md"],
    undefined,
  );
  assert.ok(!Object.keys(files).some((path) => path.endsWith("cases.json")));
});

test("project receipts inspect actual bytes and links without following discovery symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-receipts-"));
  try {
    await mkdir(join(root, ".agents/skills/yap"), { recursive: true });
    await mkdir(join(root, ".claude/skills"), { recursive: true });
    await writeFile(join(root, ".agents/skills/yap/SKILL.md"), "custom");
    await writeFile(join(root, ".claude/settings.json"), "unrelated");
    await symlink("../../.agents/skills/yap", join(root, ".claude/skills/yap"));
    const before = await projectSnapshot(root);
    assert.equal(before[".agents/skills/yap/SKILL.md"].text, "custom");
    assert.equal(before[".claude/skills/yap"].target, "../../.agents/skills/yap");
    assert.ok(!before[".claude/skills/yap/SKILL.md"]);
    await writeFile(join(root, ".agents/skills/yap/SKILL.md"), "changed");
    const after = await projectSnapshot(root);
    assert.notEqual(
      before[".agents/skills/yap/SKILL.md"].sha256,
      after[".agents/skills/yap/SKILL.md"].sha256,
    );
    assert.deepEqual(before[".claude/settings.json"], after[".claude/settings.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capability provenance trial presents an older installed skill separately from complete upstream", () => {
  const upstream = {
    "SKILL.md": "current instructions",
    "references/capability-discovery.md": "current discovery",
    "references/helper-examples.md": "current examples",
    "scripts/review-bundle.mjs": "helper",
  };
  const files = skillCaseFiles(upstream, "skill-provenance");
  assert.notEqual(files["work/.agents/skills/yap/SKILL.md"], upstream["SKILL.md"]);
  assert.equal(files["work/.agents/skills/yap/references/capability-discovery.md"], undefined);
  assert.equal(files["work/.agents/skills/yap/references/helper-examples.md"], undefined);
  assert.equal(
    files["work/upstream/skills/yap/references/helper-examples.md"],
    upstream["references/helper-examples.md"],
  );
  assert.equal(
    files["work/.agents/skills/yap/scripts/review-bundle.mjs"],
    upstream["scripts/review-bundle.mjs"],
  );
});

test("the consumer capability catalog covers every public operation", async () => {
  const source = await readFile(
    new URL("../packages/protocol/src/operations.ts", import.meta.url),
    "utf8",
  );
  const catalog = await readFile(
    new URL("../skills/yap/references/capability-catalog.md", import.meta.url),
    "utf8",
  );
  const operationNames = [...source.matchAll(operationLiteral)].map((match) => match[1]);
  assert.ok(operationNames.length > 0);
  for (const operation of operationNames)
    assert.match(catalog, new RegExp("`" + escaped(operation) + "`"), operation);
});

test("skills contain no removed operation names or legacy fields", async () => {
  const root = new URL("../skills/", import.meta.url);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const removed = ["recording.latest", "UNKNOWN_MODEL", "afterSequence"];
  const bareInspect =
    /`inspect`|(?:yap|operation(?:Name|Names)?|call|invoke|run)\s+inspect\b|["'](?:operation|name)["']\s*:\s*["']inspect["']/;
  for (const entry of files) {
    const path = new URL(entry.parentPath ? `${entry.parentPath}/${entry.name}` : entry.name, root);
    const text = await readFile(path, "utf8");
    for (const name of removed) assert.equal(text.includes(name), false, `${path}: ${name}`);
    assert.equal(bareInspect.test(text), false, `${path}: bare inspect operation alias`);
  }
});
