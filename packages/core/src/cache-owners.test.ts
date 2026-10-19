import { projectStoreFixture } from "./project-store.fixture.js";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { DerivedCache } from "./cache.js";
import type { JobOwner } from "./jobs.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("asset-owned derivatives evict and reopen without modifying original media", async () => {
  const home = await mkdtemp(join(tmpdir(), "yap-cache-assets-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "catalog.sqlite");
  const catalog = new Catalog(path);
  let active = catalog;
  cleanup.push(async () => active.close());
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const source = join(home, "source.wav");
  await writeFile(source, "original media");
  const asset = await assets.import(source, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "audio",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1000000,
        segments: [{ startUs: 0, endUs: 1000000, empty: false }],
      },
    ],
  }));
  const owner = { kind: "asset" as const, id: asset.id };
  const check = (store: AssetStore) => (candidate: JobOwner) => {
    if (candidate.kind !== "asset") throw new CatalogError("NOT_FOUND", "Expected asset owner");
    store.get(candidate.id);
  };
  const cache = new DerivedCache(catalog, home, check(assets), 6);
  await cache.reconcile();
  const first = cache.reserve(owner);
  await writeFile(first.path, "old!");
  await cache.publish(first.id);
  const second = cache.reserve(owner);
  await writeFile(second.path, "new!");
  await cache.publish(second.id);
  expect(cache.acquire(first.id)).toBeNull();
  catalog.close();
  active = new Catalog(path);
  const reopenedAssets = new AssetStore(active, home);
  const reopened = new DerivedCache(active, home, check(reopenedAssets), 6);
  await reopened.reconcile();
  const retained = reopened.acquire(second.id);
  expect(retained?.bytes).toBe(4);
  retained?.release();
  expect(reopened.ownerForFile(second.path)).toEqual(owner);
  expect(await readFile(second.path, "utf8")).toBe("new!");
  expect(await readFile(reopenedAssets.path(asset.id), "utf8")).toBe("original media");
});

test("project retirement fences derived files and cannot purge another owner kind", async () => {
  const home = await mkdtemp(join(tmpdir(), "yap-cache-owners-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => catalog.close());
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const projects = projectStoreFixture(catalog, assets, home);
  const project = projects.create({
    requestId: "create",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  }).project;
  const owner = { kind: "project" as const, id: project.projectId };
  // Equal IDs must remain distinct even when today's generators use different shapes.
  const other = { kind: "asset" as const, id: project.projectId };
  const assertAvailable = (candidate: JobOwner) => {
    if (candidate.kind === "project") projects.get(candidate.id);
    else if (candidate.kind !== "asset" || candidate.id !== other.id)
      throw new CatalogError("NOT_FOUND", "Missing test owner");
  };
  const cache = new DerivedCache(catalog, home, assertAvailable);
  await cache.reconcile();
  const first = cache.reserve(owner);
  const second = cache.reserve(other);
  await writeFile(first.path, "project");
  await writeFile(second.path, "asset");
  await cache.publish(first.id);
  await cache.publish(second.id);
  expect(cache.ownerForFile(first.path)).toEqual(owner);
  expect(cache.ownerForFile(second.path)).toEqual(other);
  const held = cache.acquire(first.id);
  expect(held).not.toBeNull();
  const pending = cache.reserve(owner);
  await writeFile(pending.path, "unpublished");
  projects.markDeleting(owner.id);
  expect(() => cache.reserve(owner)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(() => cache.acquire(first.id)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  await expect(cache.publish(pending.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(cache.acquire(pending.id)).toBeNull();
  const removeFiles = async ({ ids }: { ids: readonly string[] }) => {
    for (const id of ids) await unlink(join(home, "cache", "derived", `${id}.cache`));
  };
  await expect(cache.purgeOwner(owner, removeFiles)).rejects.toMatchObject({ code: "CACHE_BUSY" });
  held!.release();
  await cache.purgeOwner(owner, removeFiles);
  expect([...cache.usageFiles(owner)]).toEqual([]);
  expect([...cache.usageFiles(other)]).toEqual([second.path]);
  const remaining = cache.acquire(second.id);
  expect(remaining?.bytes).toBe(5);
  remaining?.release();
});
