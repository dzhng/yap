import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { callLocal } from "@yap/client";
import { CaptureStore } from "@yap/core/capture-store";
import { AssetStore } from "@yap/core/assets";
import { DerivedCache } from "@yap/core/cache";
import { launchReady, socketPath, temporary, waitFor } from "./harness.mjs";

function file(path, contents) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents);
  return path;
}

// Seeded crash state: this does not claim a process was killed during a deletion operation.
// Capture deletion does not retire managed asset derivatives.
// Source bytes are generated leftovers, not captured media; no screen or audio access is needed.
test(
  "bundled startup resumes durable deletion and preserves unrelated files across restart",
  { timeout: 60_000 },
  async () => {
    const home = temporary("/tmp/yap-delete-restart-");
    const outside = temporary("/tmp/yap-delete-external-");
    const library = join(home, "library");
    mkdirSync(library, { mode: 0o700 });
    const path = join(library, "catalog.sqlite");
    const store = new CaptureStore(path, {
      now: () => "seeded deletion restart",
      newId: randomUUID,
    });
    const assets = new AssetStore(store, library);
    await assets.recover();
    const original = file(join(outside, "asset.mov"), "generated unrelated managed source");
    const asset = await assets.import(original, { kind: "import" }, async () => ({
      originUs: 0,
      streams: [
        {
          id: "v",
          kind: "video",
          codec: "fixture",
          decodable: true,
          startUs: 0,
          endUs: 1_000_000,
          segments: [{ startUs: 0, endUs: 1_000_000, empty: false }],
          width: 1,
          height: 1,
        },
      ],
    }));
    const cache = new DerivedCache(store, library, (owner) => {
      assert.equal(owner.kind, "asset");
      assets.get(owner.id);
    });
    await cache.reconcile();
    async function seed(label) {
      const take = store.allocate().recording;
      store.ingestLifecycle(take.id, {
        sourceId: take.sourceId,
        sequence: 1,
        state: "interrupted",
        reason: "generated leftover fixture",
        sourceDurationUs: 1_000_000,
      });
      const directory = join(library, "recordings", take.id);
      const source = file(
        join(directory, "source", "video.mov"),
        `${label}: generated source leftover`,
      );
      if (label !== "sibling") return { ...take, directory, source };
      const cached = cache.reserve({ kind: "asset", id: asset.id });
      writeFileSync(cached.path, `${label}: derivative`);
      await cache.publish(cached.id);
      return { ...take, directory, source, cached };
    }
    let target, sibling;
    try {
      target = await seed("target");
      sibling = await seed("sibling");
      store.markDeleting(target.id);
    } finally {
      store.close();
    }
    const external = file(join(outside, "keep.bin"), "external target");
    symlinkSync(outside, join(target.directory, "external-directory"));
    symlinkSync(external, join(target.directory, "external-file"));
    const model = file(join(library, "models", "fixture.bin"), "shared model sentinel");
    const missingId = randomUUID();
    const unowned = file(join(library, "recordings", missingId, "keep.bin"), "no catalog owner");
    const preserved = [sibling.source, sibling.cached.path, external, model, unowned].map(
      (file) => [file, readFileSync(file)],
    );
    const call = async (operation, params = {}) => {
      const result = await callLocal(
        socketPath(home),
        { id: randomUUID(), operation, params },
        { timeoutMs: 30_000 },
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.data;
    };
    let instance;
    try {
      ({ instance } = await launchReady(home));
      // Observe startup cleanup before issuing delete; a public delete must not mask broken resume.
      await waitFor(
        () => !existsSync(target.directory),
        20_000,
        () => instance.diagnostics,
      );
      const catalog = new DatabaseSync(path, { readOnly: true });
      try {
        await waitFor(
          () =>
            !catalog
              .prepare("SELECT recordingId FROM recordings WHERE recordingId=?")
              .get(target.id),
          5_000,
          () => instance.diagnostics,
        );
        for (const table of ["recording_deletions", "jobs"])
          assert.deepEqual(
            catalog
              .prepare(
                `SELECT * FROM ${table} WHERE ${table === "recording_deletions" ? "recordingId=?" : "targetKind='recording' AND targetId=?"}`,
              )
              .all(target.id),
            [],
          );
      } finally {
        catalog.close();
      }
      assert.equal((await call("recording.get", { recordingId: sibling.id })).id, sibling.id);
      for (const [file, bytes] of preserved) assert.deepEqual(readFileSync(file), bytes, file);
      for (const recordingId of [target.id, missingId])
        assert.deepEqual(await call("recording.delete", { recordingId, requestId: randomUUID() }), {
          id: recordingId,
          deleted: true,
          freedBytes: recordingId === missingId ? 16 : 0,
        });
      assert.deepEqual(await instance.reap(), []);
      ({ instance } = await launchReady(home));
      for (const recordingId of [target.id, missingId])
        assert.deepEqual(await call("recording.delete", { recordingId, requestId: randomUUID() }), {
          id: recordingId,
          deleted: true,
          freedBytes: recordingId === missingId ? 16 : 0,
        });
      for (const [file, bytes] of preserved) assert.deepEqual(readFileSync(file), bytes, file);
    } finally {
      if (instance) assert.deepEqual(await instance.reap(), []);
    }
  },
);
