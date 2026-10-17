import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetId, scaffold } from "./preset-scaffold.js";
import { parsePackage } from "./preset-format.js";

describe("presetId", () => {
  it("normalizes words, suffixes collisions, caps ids and rejects unusable names", () => {
    expect(presetId("Hello, World!", new Set())).toBe("hello-world");
    expect(presetId("Hello World", new Set(["hello-world", "hello-world-2"]))).toBe("hello-world-3");
    expect(presetId("!!!", new Set())).toBeNull();
    expect(presetId("A".repeat(100), new Set())).toHaveLength(48);
  });
});

describe("scaffold", () => {
  it("fills frontmatter, preserves template sections and refuses existing targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "preset-scaffold-"));
    try {
      const template = join(root, "template"); const target = join(root, "out");
      await mkdir(template); await writeFile(join(template, "PRESET.md"), "---\nid: style-name\nname: Style name\ndescription: desc\nversion: 1\nreferences:\n  - https://example.com/the-first-reference-video\n---\n\n## Shoot\nkeep\n## Edit\nkeep\n");
      await writeFile(join(template, "extra.txt"), "keep");
      await scaffold({ template, target, id: "new-style", name: "New style", references: ["https://example.com/ref"] });
      expect(await readFile(join(target, "PRESET.md"), "utf8")).toContain("id: new-style");
      expect(await readFile(join(target, "PRESET.md"), "utf8")).toContain("name: New style");
      expect(await readFile(join(target, "PRESET.md"), "utf8")).toContain("- https://example.com/ref");
      expect(await readFile(join(target, "PRESET.md"), "utf8")).toContain("## Shoot");
      await expect(scaffold({ template, target, id: "new-style", name: "New style", references: [] })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it("quotes a name the frontmatter would otherwise misread", async () => {
  const root = await mkdtemp(join(tmpdir(), "preset-scaffold-quote-"));
  const template = join(root, "template");
  await mkdir(template, { recursive: true });
  await writeFile(join(template, "PRESET.md"), "---\nid: style-name\nname: x\nversion: 1\nreferences:\n---\n\n## Shoot\n\n## Edit\n");
  await scaffold({ template, target: join(root, "talks"), id: "talks", name: "Talks: the #1 series", references: [] });
  const parsed = parsePackage(new Map([["PRESET.md", await readFile(join(root, "talks", "PRESET.md"))]]), { origin: "local" });
  expect(parsed.ok && parsed.manifest.name).toBe("Talks: the #1 series");
});
