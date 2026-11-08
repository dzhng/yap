import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { seedSource, populateLibrary, observeLibrary } from "./library.mjs";
import { startPublicService } from "../../apps/macos/tests/fixtures/public-service.mjs";

test("installed fixture retains actual source bytes and public facts after service restart", async () => {
  const root = await mkdtemp("/tmp/yap-installed-library-");
  const home = join(root, "home");
  const media = new URL(
    "../../specs/done/recording-for-ai/assets/agent-mcp-journey/source.mov",
    import.meta.url,
  ).pathname;
  let service;
  try {
    const source = await seedSource(home, media);
    const native = process.env.YAP_NATIVE;
    assert.ok(native, "Set YAP_NATIVE to an already-built native worker");
    service = await startPublicService(home, native);
    const manifest = await populateLibrary(home, source, service.call);
    const before = await observeLibrary(home, manifest, service.call);
    await writeFile(join(root, "before.json"), JSON.stringify(before));
    assert.equal(before.recording.state, "interrupted");
    assert.equal(before.project.currentRevisionId, manifest.revisionId);
    assert.equal(before.job.state, "ready");
    assert.equal(before.export.state, "ready");
    assert.equal(before.originalSha256, source.sha256);
    assert.deepEqual(await readFile(media), await readFile(manifest.originalPath));
    await service.close();
    service = await startPublicService(home, native);
    const after = await observeLibrary(home, manifest, service.call);
    await writeFile(join(root, "after.json"), JSON.stringify(after));
    assert.deepEqual(after, before);
  } catch (error) {
    for (const name of ["before", "after"]) {
      try {
        await copyFile(join(root, name + ".json"), root + `-${name}-unverified.json`);
      } catch (copyError) {
        if (copyError.code !== "ENOENT") throw copyError;
      }
    }
    throw error;
  } finally {
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
});
