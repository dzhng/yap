import { expect, test } from "vitest";
import {
  writeFileSync,
  unlinkSync,
  symlinkSync,
  linkSync,
  existsSync,
  readFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { DerivedCache } from "./cache.js";
import { Catalog } from "./catalog.js";
import { fixture, add, cover, png } from "./retained-source-index.fixture.js";
test("complete selected images and explicit coverage survive a catalog restart", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const first = add(f);
  expect(() => f.index.page({ identity: f.identity })).toThrow("complete");
  f.index.appendCoverage(f.identity, {
    state: "available",
    ordinal: 0,
    source: { startUs: 0, endUs: 5_000_000 },
    equality: "sampled",
  });
  f.index.appendCoverage(f.identity, {
    state: "available",
    ordinal: 0,
    source: { startUs: 5_000_000, endUs: 10_000_000 },
    equality: "sampled",
  });
  const metadata = await f.index.finish(f.identity);
  f.catalog.close();
  const reopened = new Catalog(f.path);
  const index = f.reopenedIndex(reopened);
  expect(index.page({ identity: f.identity })).toEqual({
    metadata,
    entries: [{ candidate: first.candidate, frame: first.frame, coverageCount: 1 }],
    nextOrdinal: null,
  });
  expect(index.coveragePage({ identity: f.identity }).coverage).toEqual([
    {
      sequence: 0,
      state: "available",
      ordinal: 0,
      source: { startUs: 0, endUs: 10_000_000 },
      equality: "sampled",
    },
  ]);
  const lease = index.openRead(f.identity, 0);
  const buffer = Buffer.alloc(lease.bytes);
  expect(lease.read(buffer, 0)).toBe(png.length);
  expect(buffer).toEqual(png);
  lease.release();
});
test("retained images remain readable and removable after a device number changes", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const image = add(f);
  cover(f);
  await f.index.finish(f.identity);
  // Model a remount: the saved device differs, while paths, inodes and bytes survive.
  f.catalog.catalog.exec(`
    UPDATE screenshot_index_generations SET device=device+1;
    UPDATE screenshot_index_entries SET device=device+1;
  `);
  f.catalog.close();
  const reopened = new Catalog(f.path);
  const index = f.reopenedIndex(reopened);
  const lease = index.openRead(f.identity, 0);
  try {
    const bytes = Buffer.alloc(lease.bytes);
    expect(lease.read(bytes, 0)).toBe(png.length);
    expect(bytes).toEqual(png);
  } finally {
    lease.release();
  }
  await index.remove(f.identity);
  expect(existsSync(image.frame.file)).toBe(false);
});
test("pages and filtered coverage remain bounded and reject unrelated anchors", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  add(f);
  add(f, 1, 1_000_000);
  cover(f, 0, 0, 2_000_000);
  cover(f, 1, 2_000_000, 3_000_000);
  cover(f, 0, 3_000_000, 6_000_000);
  cover(f, 0, 6_000_000, 10_000_000, "unproven");
  await f.index.finish(f.identity);
  const first = f.index.page({ identity: f.identity, limit: 1 });
  expect(first.entries[0]?.coverageCount).toBe(3);
  expect(first.nextOrdinal).toBe(0);
  const second = f.index.page({ identity: f.identity, afterOrdinal: 0, limit: 1 });
  expect(second.entries[0]?.candidate.ordinal).toBe(1);
  expect(second.nextOrdinal).toBeNull();
  const coverage = f.index.coveragePage({ identity: f.identity, candidateOrdinal: 0, limit: 1 });
  expect(coverage.coverage[0]?.source).toEqual({ startUs: 0, endUs: 2_000_000 });
  expect(coverage.nextSequence).toBe(0);
  const next = f.index.coveragePage({
    identity: f.identity,
    candidateOrdinal: 0,
    afterSequence: 0,
  });
  expect(
    next.coverage.map((c) => [
      c.sequence,
      c.source,
      c.state === "available" ? c.equality : c.state,
    ]),
  ).toEqual([
    [2, { startUs: 3_000_000, endUs: 6_000_000 }, "sampled"],
    [3, { startUs: 6_000_000, endUs: 10_000_000 }, "unproven"],
  ]);
  expect(() => f.index.page({ identity: f.identity, afterOrdinal: 50 })).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(() => f.index.page({ identity: f.identity, limit: 201 })).not.toThrow();
  expect(() =>
    f.index.coveragePage({ identity: f.identity, candidateOrdinal: 0, afterSequence: 1 }),
  ).toThrow("outside");
  expect(() => f.index.page({ identity: { ...f.identity, streamId: "other" } })).toThrow(
    "identity",
  );
  expect(() => f.index.openRead({ ...f.identity, streamId: "other" }, 0)).toThrow("identity");
});
test("incomplete coverage and missing retained files cannot become complete", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const image = add(f);
  cover(f, 0, 0, 4_000_000);
  await expect(f.index.finish(f.identity)).rejects.toThrow("incomplete");
  expect(() => cover(f, 0, 5_000_000, 10_000_000)).toThrow("contiguously");
  cover(f, 0, 4_000_000, 10_000_000);
  unlinkSync(image.frame.file);
  await expect(f.index.finish(f.identity)).rejects.toThrow();
  expect(() => f.index.page({ identity: f.identity })).toThrow("complete");
  await f.index.remove(f.identity);
});
test("removing a generation that begin refused succeeds without replacing the refusal", async () => {
  const f = await fixture();
  const refused = {
    ...f.identity,
    scenes: { ...f.identity.scenes, source: { ...f.identity.scenes.source, supportDigest: "x" } },
  };
  expect(() => f.index.begin(refused)).toThrow("does not match published scenes");
  await expect(f.index.remove(refused)).resolves.toBeUndefined();
  await expect(f.index.remove(refused)).resolves.toBeUndefined();
});
test("canceling final validation hides partial evidence and prevents late appends", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  add(f);
  cover(f);
  const controller = new AbortController();
  const finishing = f.index.finish(f.identity, controller.signal);
  expect(() => f.index.outputPath(f.identity, 1)).toThrow("writable");
  controller.abort();
  await expect(finishing).rejects.toThrow();
  expect(() => f.index.page({ identity: f.identity })).toThrow("complete");
  await f.index.reclaim({ kind: "asset", assetId: f.identity.assetId }, () => false);
  expect(() => f.index.outputPath(f.identity, 0)).toThrow("identity");
});
test("an acquired read survives deletion while new reads fail", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const image = add(f);
  cover(f);
  await f.index.finish(f.identity);
  const read = f.index.openRead(f.identity, 0);
  await f.index.remove(f.identity);
  expect(existsSync(image.frame.file)).toBe(false);
  expect(() => f.index.openRead(f.identity, 0)).toThrow("identity");
  const bytes = Buffer.alloc(read.bytes + 10, 5);
  expect(read.read(bytes, 0)).toBe(png.length);
  expect(bytes.subarray(0, png.length)).toEqual(png);
  expect(bytes.subarray(png.length)).toEqual(Buffer.alloc(10, 5));
  expect(() => read.read(bytes, -1)).toThrow("position");
  read.release();
  read.release();
  expect(() => read.read(bytes, 0)).toThrow("released");
});
test("retained evidence survives derived cache eviction and owner-directed reclamation", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const image = add(f);
  cover(f);
  await f.index.finish(f.identity);
  const cache = new DerivedCache(
    f.catalog,
    f.home,
    (owner) => {
      if (owner.kind !== "asset") throw new Error("asset only");
      f.assets.get(owner.assetId);
    },
    png.length,
  );
  await cache.reconcile();
  const reserved = cache.reserve({ kind: "asset", assetId: f.identity.assetId });
  writeFileSync(reserved.path, png);
  await cache.publish(reserved.id);
  const later = cache.reserve({ kind: "asset", assetId: f.identity.assetId });
  writeFileSync(later.path, png);
  await cache.publish(later.id);
  expect(cache.acquire(reserved.id)).toBeNull();
  expect(existsSync(image.frame.file)).toBe(true);
  const read = f.index.openRead(f.identity, 0);
  read.release();
  const partial = { ...f.identity, generation: "partial" };
  f.index.begin(partial);
  const stray = f.index.outputPath(partial, 0);
  writeFileSync(stray, png);
  await f.index.reclaim(
    { kind: "asset", assetId: f.identity.assetId },
    (id) => id.generation === f.identity.generation,
  );
  expect(existsSync(stray)).toBe(false);
  expect(f.index.page({ identity: f.identity }).entries[0]?.frame.sizeBytes).toBe(png.length);
});
test.for([false, true])(
  "replaced, symlinked and hard-linked images are refused (remounted: %s)",
  async (remounted) => {
    const f = await fixture();
    f.index.begin(f.identity);
    const image = add(f);
    cover(f);
    await f.index.finish(f.identity);
    if (remounted) {
      f.catalog.catalog.exec(`
      UPDATE screenshot_index_generations SET device=device+1;
      UPDATE screenshot_index_entries SET device=device+1;
    `);
    }
    const outside = join(f.home, "outside.png");
    writeFileSync(outside, png);
    unlinkSync(image.frame.file);
    symlinkSync(outside, image.frame.file);
    expect(() => f.index.openRead(f.identity, 0)).toThrow();
    unlinkSync(image.frame.file);
    linkSync(outside, image.frame.file);
    expect(() => f.index.openRead(f.identity, 0)).toThrow("PNG");
    unlinkSync(image.frame.file);
    writeFileSync(image.frame.file, png);
    expect(() => f.index.openRead(f.identity, 0)).toThrow("changed");
    await f.index.remove(f.identity);
    expect(existsSync(outside)).toBe(true);
  },
);
test("a replaced generation directory is refused even after a device number changes", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const image = add(f);
  cover(f);
  await f.index.finish(f.identity);
  f.catalog.catalog.exec(`
    UPDATE screenshot_index_generations SET device=device+1;
    UPDATE screenshot_index_entries SET device=device+1;
  `);
  const directory = join(image.frame.file, "..");
  renameSync(directory, directory + "-original");
  mkdirSync(directory);
  writeFileSync(image.frame.file, png);
  expect(() => f.index.openRead(f.identity, 0)).toThrow("directory changed");
  await expect(f.index.remove(f.identity)).rejects.toThrow("directory changed");
  expect(readFileSync(image.frame.file)).toEqual(png);
});
test("a substituted FIFO is rejected without blocking file validation", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const image = add(f);
  cover(f);
  await f.index.finish(f.identity);
  unlinkSync(image.frame.file);
  execFileSync("mkfifo", [image.frame.file]);
  const sourceDirectory = new URL("./", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `
 import { registerHooks } from 'node:module';
 const sourceDirectory=${JSON.stringify(sourceDirectory)};
 // This Node subprocess must exercise the current source, including its .js TS imports.
 registerHooks({resolve(specifier,context,next){
   if(context.parentURL?.startsWith(sourceDirectory) && specifier.startsWith('.') && specifier.endsWith('.js'))
     specifier=new URL(specifier.slice(0,-3)+'.ts',context.parentURL).href;
   return next(specifier,context);
 }});
 const { Catalog } = await import(${JSON.stringify(new URL("./catalog.ts", import.meta.url).href)});
 const { ScreenshotIndexStore } = await import(${JSON.stringify(new URL("./screenshot-index.ts", import.meta.url).href)});
 const catalog=new Catalog(${JSON.stringify(f.path)});
 try {
   const { AssetStore } = await import(${JSON.stringify(new URL("./assets.ts", import.meta.url).href)});
   const { AcquisitionStore } = await import(${JSON.stringify(new URL("./acquisitions.ts", import.meta.url).href)});
   const { selectSource } = await import(${JSON.stringify(new URL("./source-selection.ts", import.meta.url).href)});
   const { SceneEvidenceStore, assetSceneOwner } = await import(${JSON.stringify(new URL("./scene-evidence.ts", import.meta.url).href)});
   const { sourceIndexDomain } = await import(${JSON.stringify(new URL("./source-index.ts", import.meta.url).href)});
   const assets=new AssetStore(catalog,${JSON.stringify(f.home)}),acquisitions=new AcquisitionStore(catalog);
   new ScreenshotIndexStore(catalog,${JSON.stringify(f.home)},sourceIndexDomain(
     s=>selectSource(assets,acquisitions,s),new SceneEvidenceStore(catalog,assetSceneOwner(assets,acquisitions)),null)).openRead(${JSON.stringify(f.identity)},0);
   process.exitCode=1;
 } catch(error) {
   process.stdout.write(JSON.stringify({code:error.code,message:error.message}));
 } finally {catalog.close();}
 `,
    ],
    // Opening a FIFO for reading blocks until a writer appears, which never happens here, so a
    // blocking read never returns. The bound only has to beat that, not a loaded machine's
    // startup of a TypeScript-transforming Node child.
    { timeout: 20_000, encoding: "utf8" },
  );
  expect(child.stderr).toBe("");
  expect(child.error).toBeUndefined();
  expect({ status: child.status, signal: child.signal }).toEqual({ status: 0, signal: null });
  expect(JSON.parse(child.stdout)).toEqual({
    code: "INVALID_EVIDENCE",
    message: "Invalid retained PNG file or byte receipt",
  });
}, 30_000);
test("one damaged generation does not starve unrelated reclamation", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  const image = add(f);
  cover(f);
  await f.index.finish(f.identity);
  const next = { ...f.identity, generation: "next-partial" };
  f.index.begin(next);
  const nextPath = f.index.outputPath(next, 0);
  writeFileSync(nextPath, png);
  writeFileSync(join(image.frame.file, "..", "unexpected.txt"), "foreign file");
  const error = await f.index
    .reclaim({ kind: "asset", assetId: f.identity.assetId }, () => false)
    .catch((error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(existsSync(nextPath)).toBe(false);
  expect(() => f.index.page({ identity: f.identity })).toThrow("complete");
});
test("candidate and coverage pages cap work independently at 100 by default and 1000 maximum", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  for (let i = 0; i < 205; i++) add(f, i, i * 1000);
  for (let i = 0; i < 205; i++)
    cover(f, i % 2, Math.floor((i * 10_000_000) / 205), Math.floor(((i + 1) * 10_000_000) / 205));
  await f.index.finish(f.identity);
  expect(f.index.page({ identity: f.identity }).entries.map((e) => e.candidate.ordinal)).toEqual(
    Array.from({ length: 100 }, (_, i) => i),
  );
  const first = f.index.page({ identity: f.identity, limit: 200 });
  expect(first.nextOrdinal).toBe(199);
  expect(
    f.index
      .page({ identity: f.identity, afterOrdinal: first.nextOrdinal! })
      .entries.map((e) => e.candidate.ordinal),
  ).toEqual([200, 201, 202, 203, 204]);
  expect(f.index.coveragePage({ identity: f.identity }).nextSequence).toBe(99);
  const coverage = f.index.coveragePage({ identity: f.identity, limit: 200 });
  expect(coverage.nextSequence).toBe(199);
  expect(
    f.index
      .coveragePage({ identity: f.identity, afterSequence: 199 })
      .coverage.map((c) => c.sequence),
  ).toEqual([200, 201, 202, 203, 204]);
});
test("a rendered receipt cannot silently change pinned source support", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  expect(() =>
    add(f, 0, 0, (frame) => {
      frame.supportDigest = "different-source-support";
    }),
  ).toThrow("receipt");
});
test("compact finish metadata is a usable pinned identity for pages and reads", async () => {
  const f = await fixture();
  f.index.begin(f.identity);
  add(f);
  cover(f);
  const metadata = await f.index.finish(f.identity);
  expect(f.index.page({ identity: metadata }).entries[0]?.candidate.ordinal).toBe(0);
  const read = f.index.openRead(metadata, 0);
  expect(read.bytes).toBe(png.length);
  read.release();
  expect(() => f.index.page({ identity: { ...metadata, implementationId: "different" } })).toThrow(
    "identity",
  );
});
