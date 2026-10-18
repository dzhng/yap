import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { DerivedCache } from "@yap/core/cache";
import { launchReady, socketPath, temporary, waitFor } from "./harness.mjs";

// Optional companion to lab:index-scale; never regenerates or edits the supplied input.
// YAP_FRAME_CACHE_VIDEO names an existing generated 30-minute video, copied into scratch.
// YAP_FRAME_CACHE_EVIDENCE optionally names a new JSON receipt file.
const cli = new URL("../../cli/dist/main.js", import.meta.url).pathname;
const durationUs = 1_800_000_000;
async function hash(path) {
  const value = createHash("sha256");
  for await (const bytes of createReadStream(path)) value.update(bytes);
  return value.digest("hex");
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

async function fileIdentity(path) {
  const stat = await lstat(path, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

test(
  "30-minute selected source picture hits cache, survives LRU eviction, and leaves source unchanged",
  { timeout: 90_000 },
  async () => {
    const input = process.env.YAP_FRAME_CACHE_VIDEO;
    assert.ok(
      input && isAbsolute(input),
      "Set YAP_FRAME_CACHE_VIDEO to the preserved generated 30-minute video",
    );
    const probe = JSON.parse(
      run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", input]),
    );
    assert.equal(Math.round(Number(probe.format.duration) * 1_000_000), durationUs);
    const originalHash = await hash(input);
    const home = temporary("/tmp/scr-frame-cache-scale-");
    let { instance } = await launchReady(home);
    try {
      const call = async (operation, params = {}) => {
        const result = await callLocal(
          socketPath(home),
          { id: randomUUID(), operation, params },
          { timeoutMs: 20_000 },
        );
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.data;
      };
      const admission = await call("asset.import", { requestId: randomUUID(), path: input });
      const imported = await waitFor(async () => {
        const job = await call("job.get", { jobId: admission.jobId });
        assert.ok(!["failed", "canceled"].includes(job.state), JSON.stringify(job));
        return job.state === "ready" ? job.published.output : false;
      }, 20_000);
      const asset = await call("asset.get", { assetId: imported.assetId });
      assert.equal(asset.id, originalHash);
      const videoStreams = asset.streams.filter(
        (stream) => stream.kind === "video" && stream.decodable,
      );
      assert.equal(videoStreams.length, 1, "The preserved generated fixture has one video stream");
      const params = {
        assetId: asset.id,
        streamId: videoStreams[0].id,
        atUs: 1_200_000_000,
      };
      const ready = () =>
        waitFor(async () => {
          const result = await call("frame.get", params);
          assert.ok(!["failed", "unavailable"].includes(result.state), JSON.stringify(result));
          if (result.state !== "ready") return false;
          await call("artifact.close", { token: result.delivery.token });
          return result;
        }, 20_000);
      const first = await ready(),
        firstFrame = first.published.output;
      const firstIdentity = await fileIdentity(firstFrame.file),
        firstBytes = await readFile(firstFrame.file);
      const output = join(home, "cache-hit.png");
      const repeated = JSON.parse(
        run(process.execPath, [
          cli,
          "frame.get",
          "--socket",
          socketPath(home),
          "--params",
          JSON.stringify(params),
          "--output",
          output,
        ]),
      );
      assert.equal(repeated.ok, true);
      assert.deepEqual(repeated.data.published, first.published);
      assert.deepEqual(await fileIdentity(firstFrame.file), firstIdentity);
      assert.deepEqual(await readFile(output), firstBytes);
      assert.deepEqual(await instance.reap(), []);

      instance = null;
      const library = join(home, "library"),
        catalog = new Catalog(join(library, "catalog.sqlite"));
      const assets = new AssetStore(catalog, library);
      let states, video;
      try {
        video = assets.path(asset.id);
        assert.equal(await hash(video), originalHash);
        states = catalog.catalog
          .prepare(
            "SELECT artifact,state FROM jobs WHERE targetKind='asset' AND targetId=? ORDER BY artifact",
          )
          .all(asset.id)
          .map((row) => ({ ...row }));
        assert.deepEqual(states, [{ artifact: "frame", state: "ready" }]);
        assert.deepEqual(catalog.catalog.prepare("SELECT * FROM recordings").all(), []);
        assert.deepEqual(catalog.catalog.prepare("SELECT * FROM projects").all(), []);
        const cache = new DerivedCache(
          catalog,
          library,
          (owner) => {
            assert.equal(owner.kind, "asset");
            assets.get(owner.assetId);
          },
          1,
        );
        await cache.reconcile();
        const stale = cache.acquire(firstFrame.cacheId);
        stale?.release();
        assert.equal(stale, null);
        assert.equal(existsSync(firstFrame.file), false, "LRU must remove the cached derivative");
      } finally {
        catalog.close();
      }
      assert.equal(await hash(video), originalHash);
      ({ instance } = await launchReady(home));
      const retry = await call("job.retry", params);
      if (retry.delivery) await call("artifact.close", { token: retry.delivery.token });
      const regenerated = await ready();
      assert.equal(regenerated.jobId, first.jobId);
      assert.equal(
        Number(regenerated.published.generation),
        Number(first.published.generation) + 1,
      );
      assert.notEqual(regenerated.published.output.cacheId, firstFrame.cacheId);
      assert.deepEqual(await readFile(regenerated.published.output.file), firstBytes);
      assert.equal(await hash(video), originalHash);
      assert.equal(await hash(input), originalHash);
      assert.deepEqual(await instance.reap(), []);
      instance = null;
      const report = {
        generated: true,
        durationUs,
        requestedSourceUs: params.atUs,
        actualSourceUs: firstFrame.actualSourceUs,
        inputSha256: originalHash,
        sourceUnchanged: true,
        cacheHit: {
          cacheId: firstFrame.cacheId,
          generation: first.published.generation,
          identity: firstIdentity,
          bytes: firstBytes.length,
          sha256: createHash("sha256").update(firstBytes).digest("hex"),
        },
        evicted: true,
        regenerated: {
          cacheId: regenerated.published.output.cacheId,
          generation: regenerated.published.generation,
          bytesEqual: true,
        },
        selectedAssetJobs: states,
        ownedProcessesReaped: true,
        scope:
          "Selected-source cache companion only; no automatic recording/project or source/scene job dependencies, full index rerun, capture devices or user media.",
      };
      console.log(JSON.stringify(report));
      if (process.env.YAP_FRAME_CACHE_EVIDENCE)
        await writeFile(
          process.env.YAP_FRAME_CACHE_EVIDENCE,
          JSON.stringify(report, null, 2) + "\n",
          { flag: "wx" },
        );
    } finally {
      if (instance) assert.deepEqual(await instance.reap(), []);
    }
  },
);
