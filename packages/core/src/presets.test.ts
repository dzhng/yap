import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPresets } from "./presets.js";

const bundled = resolve(import.meta.dirname, "../../../presets");

describe("presets facade", () => {
  it("installs bundled presets and returns path-aware instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "presets-facade-"));
    try {
      const presets = await createPresets({ root, bundled });
      const listed = presets.list();
      expect(listed.presets.map(({ id }) => id)).toEqual([
        "on-location-conversation",
        "studio-podcast",
        "tactile-launch-film",
      ]);
      expect(listed.presets.every(({ source }) => source === "bundled")).toBe(true);
      expect(listed.instructions.length).toBeGreaterThan(0);

      const details = presets.get("tactile-launch-film");
      expect(details.source).toBe("bundled");
      expect(details.text).toContain("## Shoot");
      await expect(stat(details.path)).resolves.toBeTruthy();
      await expect(stat(details.kitPath)).resolves.toBeTruthy();
      await expect(stat(details.guidePath)).resolves.toBeTruthy();
      expect(details.instructions.join(" ")).toContain(details.path);
      expect(details.instructions.join(" ")).toContain(details.kitPath);
      for (const [, target] of details.text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^(?:[a-z]+:|#|\/)/i.test(target!)) continue;
        await expect(stat(resolve(details.path, target!.split("#", 1)[0]!))).resolves.toBeTruthy();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reinstall a bundled tie on a second construction", async () => {
    const root = await mkdtemp(join(tmpdir(), "presets-facade-"));
    try {
      await createPresets({ root, bundled });
      const receipt = join(root, "receipt.json");
      const before = await readFile(receipt);
      await createPresets({ root, bundled });
      expect(await readFile(receipt)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates and deletes local presets with rendered authoring instructions", async () => {
    const root = await mkdtemp(join(tmpdir(), "presets-create-"));
    try {
      const presets = await createPresets({ root, bundled });
      const reference = join(root, "reference.mp4");
      await writeFile(reference, "reference");
      const created = await presets.create({ name: "Vertical Explainer", references: [reference] });
      expect(created.id).toBe("vertical-explainer");
      expect(created.instructions.join(" ")).toContain(created.path);
      expect(created.instructions.join(" ")).toContain(created.kitPath);
      expect(created.instructions.join(" ")).toContain(created.guidePath);
      expect(presets.list().presets.find((item) => item.id === created.id)?.source).toBe("local");
      expect(presets.get(created.id).text).toContain(reference);
      const moved: string[] = [];
      const deleted = await (async () => {
        const local = await createPresets({ root, bundled, trash: async (path) => { moved.push(path); } });
        return local.delete(created.id);
      })();
      expect(deleted.trashedPaths).toEqual([created.path]);
      expect(moved).toEqual([created.path]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it("a broken bundled directory never stops the facade; the error is reported by list", async () => {
  const root = await mkdtemp(join(tmpdir(), "presets-broken-"));
  const bundled = await mkdtemp(join(tmpdir(), "presets-bundled-empty-"));
  const presets = await createPresets({ root, bundled });
  const listed = presets.list();
  expect(listed.presets).toEqual([]);
  expect(listed.refresh.error).toMatch(/bundled presets unavailable/);
});

it("after a kit-only update, instructions never send the agent to preset.get the kit", async () => {
  const root = await mkdtemp(join(tmpdir(), "presets-update-kit-"));
  const fakeRefresh = {
    run: async () => ({ installed: ["kit", "authoring"], skipped: [], failed: [], removed: [], conflicts: [] }),
    state: () => ({ checkedAt: "2026-10-17T00:00:00.000Z", commit: "c".repeat(40), error: null, available: [], bytesDone: 0 }),
    settled: async () => {},
    remoteIds: () => new Set<string>(),
  };
  const presets = await createPresets({ root, refresh: fakeRefresh as never });
  const result = await presets.update();
  expect(result.instructions).toEqual(["No presets changed."]);
  await rm(root, { recursive: true, force: true });
});
