import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildIndex, parsePackage, validateTree } from "./preset-format.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const preset = (
  body = "## Any footage\nAdapt.\n\n## Shoot\nAsk for footage.\n\n## Edit\nCut it.",
) =>
  new Map([
    [
      "PRESET.md",
      bytes(
        `---\nid: sample-style\nversion: 1\nname: Sample\ndescription: A sample.\nreferences:\n  - https://example.com/source\n---\n${body}\n`,
      ),
    ],
    ["targets.json", bytes("{}")],
  ]);

describe("preset format", () => {
  test("parses a clean preset package", () => {
    const result = parsePackage(preset(), { origin: "repo" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest).toMatchObject({ id: "sample-style", kind: "preset", version: 1 });
      expect(result.manifest.files.map((file) => file.path)).toEqual(["PRESET.md", "targets.json"]);
    }
  });

  test.each([
    [
      "missing Any footage",
      "## Shoot\nAsk for footage.\n\n## Edit\nCut it.",
      "missing-any-footage",
    ],
    ["missing Shoot", "## Any footage\nAdapt.\n\n## Edit\nCut it.", "missing-shoot"],
    ["missing Edit", "## Any footage\nAdapt.\n\n## Shoot\nAsk for footage.", "missing-edit"],
    ["bad id", "## Any footage\n\n## Shoot\nAsk.\n\n## Edit\nCut.", "bad-id", "Bad ID"],
  ])("reports %s", (_name, body, code, id = "sample-style") => {
    const files = preset(body);
    if (id !== "sample-style")
      files.set("PRESET.md", bytes(`---\nid: ${id}\nversion: 1\n---\n${body}`));
    const result = parsePackage(files, { origin: "repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((item) => item.code === code)).toBe(true);
  });

  test("reports file too large and Git LFS pointers", () => {
    const files = preset();
    files.set("large.bin", new Uint8Array(100 * 1024 * 1024));
    files.set(
      "pointer.bin",
      bytes(
        "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 10\n",
      ),
    );
    const result = parsePackage(files, { origin: "repo" });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((item) => item.code)).toEqual(
        expect.arrayContaining(["file-too-large", "git-lfs"]),
      );
  });

  test("enforces reference origin rules", () => {
    const files = preset();
    files.set(
      "PRESET.md",
      bytes(
        "---\nid: sample-style\nversion: 1\nreferences:\n  - file:///tmp/nope\n---\n## Any footage\n\n## Shoot\n\n## Edit\n",
      ),
    );
    const result = parsePackage(files, { origin: "repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((item) => item.code === "reference")).toBe(true);
  });

  test("local references may name an existing absolute path only", () => {
    const files = preset();
    files.set(
      "PRESET.md",
      bytes(
        `---\nid: sample-style\nversion: 1\nreferences:\n  - ${resolve("package.json")}\n---\n## Any footage\n\n## Shoot\n## Edit\n`,
      ),
    );
    expect(parsePackage(files, { origin: "local" }).ok).toBe(true);
    files.set(
      "PRESET.md",
      bytes(
        "---\nid: sample-style\nversion: 1\nreferences:\n  - /definitely/missing\n---\n## Any footage\n\n## Shoot\n## Edit\n",
      ),
    );
    const result = parsePackage(files, { origin: "local" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((item) => item.code === "reference")).toBe(true);
  });

  test("requires a preset id to match its folder", () => {
    const files = new Map(
      [...preset()].map(([path, data]) => [
        `styles/PRESET.md` === path ? path : `styles/${path}`,
        data,
      ]),
    );
    files.set(
      "styles/PRESET.md",
      bytes("---\nid: other\nversion: 1\n---\n## Any footage\n\n## Shoot\n## Edit\n"),
    );
    const result = parsePackage(files, { origin: "repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((item) => item.code === "id-folder")).toBe(true);
  });

  test("reports broken links, symlinks, and source folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "preset-format-"));
    await mkdir(join(root, "sample-style", "source"), { recursive: true });
    await writeFile(
      join(root, "sample-style", "PRESET.md"),
      "---\nid: sample-style\nversion: 1\n---\n[missing](nope.md)\n## Any footage\n\n## Shoot\n## Edit\n",
    );
    await symlink("PRESET.md", join(root, "sample-style", "link.md"));
    const issues = await validateTree(root);
    expect(issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["broken-link", "symlink", "source-folder"]),
    );
  });

  test("changing one byte changes exactly one package index entry", () => {
    const first = parsePackage(preset(), { origin: "repo" });
    const changed = preset();
    changed.set("targets.json", bytes('{"changed":true}'));
    const second = parsePackage(changed, { origin: "repo" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      const other = parsePackage(
        new Map([
          [
            "PRESET.md",
            bytes("---\nid: other\nversion: 1\n---\n## Any footage\n\n## Shoot\n## Edit\n"),
          ],
        ]),
        { origin: "repo" },
      );
      expect(other.ok).toBe(true);
      if (other.ok) {
        const before = buildIndex([first.manifest, other.manifest]);
        const after = buildIndex([second.manifest, other.manifest]);
        expect(before.packages.find((p) => p.id === "other")).toEqual(
          after.packages.find((p) => p.id === "other"),
        );
        expect(before.packages.find((p) => p.id === "sample-style")).not.toEqual(
          after.packages.find((p) => p.id === "sample-style"),
        );
      }
    }
  });

  test("sorts index files by path", () => {
    const result = parsePackage(new Map([...preset()].reverse()), { origin: "repo" });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.manifest.files.map((file) => file.path)).toEqual(["PRESET.md", "targets.json"]);
  });
});
