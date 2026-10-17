import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PresetStore } from "./preset-store.js";
import { installPackages, type PackageSource } from "./preset-install.js";
import type { PresetManifest } from "./preset-format.js";
import { createHash } from "node:crypto";

const encoder = new TextEncoder();
const makePackage = (version = 3): [PresetManifest, Uint8Array] => {
  const data = encoder.encode("---\nid: sample-style\nname: Sample style\ndescription: A useful style\nversion: " + version + "\nreferences:\n  - https://example.com/source\n---\n## Shoot\nAsk.\n\n## Edit\nCut.\n");
  return [{ id: "sample-style", kind: "preset", name: "Sample style", description: "A useful style", version, references: ["https://example.com/source"], files: [{ path: "PRESET.md", bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") }] }, data];
};

describe("preset store", () => {
  test("lists and gets an installed preset with shared kit and guide paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "preset-store-"));
    const [pkg, data] = makePackage();
    const source: PackageSource = { index: async () => ({ format: 1, packages: [pkg] }), file: async () => new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }), source: "bundled" };
    await installPackages(source, root);
    const store = new PresetStore(root);
    expect(store.list()).toEqual([{ id: "sample-style", kind: "preset", name: "Sample style", description: "A useful style", version: 3, source: "bundled", references: ["https://example.com/source"] }]);
    const item = store.get("sample-style");
    expect(item).toMatchObject({ id: "sample-style", text: new TextDecoder().decode(data), path: join(root, "sample-style"), kitPath: join(root, "kit"), guidePath: join(root, "authoring", "AUTHORING.md"), source: "bundled" });
    expect(item?.files[0]?.sha256).toBe(pkg.files[0]?.sha256);
  });

  test("local.json add and remove are atomic and local source wins with conflict", async () => {
    const root = await mkdtemp(join(tmpdir(), "preset-store-"));
    const [pkg, data] = makePackage();
    const source: PackageSource = { index: async () => ({ format: 1, packages: [pkg] }), file: async () => new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }), source: "bundled" };
    await mkdir(join(root, "sample-style"));
    await writeFile(join(root, "local.json"), JSON.stringify({ ids: ["sample-style"] }));
    await writeFile(join(root, "sample-style", "PRESET.md"), new TextDecoder().decode(data));
    const report = await installPackages(source, root);
    expect(report.conflicts).toEqual(["sample-style"]);
    const receipt = JSON.parse(await readFile(join(root, "receipt.json"), "utf8"));
    expect(receipt.packages["sample-style"]).toBeUndefined();
    expect(receipt.conflicts["sample-style"]).toEqual({ version: 3 });
    const store = new PresetStore(root);
    expect(store.list()[0]).toMatchObject({ source: "local", conflict: true });
    await store.addLocal("another-style");
    expect(JSON.parse(await readFile(join(root, "local.json"), "utf8")).ids).toEqual(["another-style", "sample-style"]);
    await store.removeLocal("another-style");
    expect(store.readLocal()).toEqual(["sample-style"]);
    expect(store.get("sample-style")?.source).toBe("local");
  });

  test("rejects any local.json shape other than ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "preset-store-"));
    await writeFile(join(root, "local.json"), JSON.stringify(["sample-style"]));
    expect(() => new PresetStore(root).list()).toThrow(/local\.json/);
  });

  test("kit and authoring packages never appear as presets", async () => {
    const root = await mkdtemp(join(tmpdir(), "preset-store-"));
    await writeFile(join(root, "receipt.json"), JSON.stringify({ packages: { kit: { kind: "kit", version: 1, source: "bundled", files: [] }, authoring: { kind: "authoring", version: 1, source: "bundled", files: [] } } }));
    expect(new PresetStore(root).list()).toEqual([]);
    expect(new PresetStore(root).get("kit")).toBeUndefined();
  });
});
