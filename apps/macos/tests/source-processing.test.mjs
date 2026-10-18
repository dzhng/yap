import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { startPublicService, seedCapture, importAcquisition } from "./fixtures/public-service.mjs";
import { journalRows } from "./fixtures/generated-capture.mjs";
import { app, temporary } from "./harness.mjs";

test("explicit source admission supports both spellings of an absolute temporary home", async () => {
  const native = process.env.YAP_NATIVE ?? join(dirname(app), "yap-native");
  for (const canonical of [false, true]) {
    const aliased = temporary("/tmp/scr-source-locator-"),
      home = canonical ? await realpath(aliased) : aliased;
    assert.ok(home.startsWith(canonical ? "/private/tmp/" : "/tmp/"));
    const take = await seedCapture(home, {
      recordingId: randomUUID(),
      sourceId: randomUUID(),
      sourceDurationUs: 1_000_000,
    });
    const source = join(home, "library", "recordings", take.recordingId, "source");
    await mkdir(source, { recursive: true });
    const movie = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=64x48:r=10:d=1",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        join(source, "video.mov"),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(movie.status, 0, movie.stderr);
    const samples = [0, 100_000, 800_000].map((sourceUs) => ({
      sourceUs,
      x: 10,
      y: 10,
      globalX: 10,
      globalY: 10,
      buttons: 0,
      eligibility: "inside",
      geometryEpoch: 1,
    }));
    const rows = journalRows({ sourceId: take.sourceId, width: 64, height: 48, samples });
    await writeFile(
      join(source, "capture.journal.jsonl"),
      rows.map((row, i) => JSON.stringify({ sequence: i + 1, ...row }) + "\n").join(""),
    );
    let service = await startPublicService(home, native);
    try {
      const { acquisition } = await importAcquisition(service, source);
      assert.ok(
        (await realpath(acquisition.evidence.receipt.file)).startsWith(
          (await realpath(home)) + "/",
        ),
        acquisition.evidence.receipt.file,
      );
      assert.ok(
        (await readFile(acquisition.evidence.receipt.file, "utf8")).includes('"cursorSample"'),
      );
      const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("video"));
      assert.ok(binding);
      const request = {
        assetId: binding.assetId,
        streamId: binding.streamId,
        acquisitionId: acquisition.id,
        sourceRange: { startUs: 0, endUs: 1_000_000 },
        limit: 10,
      };
      const raw = await service.call("cursor.raw", request);
      assert.equal(raw.ok, true, JSON.stringify(raw));
      assert.equal(raw.data.state, "ready");
      assert.deepEqual(
        raw.data.rows.map((row) => row.captureAtUs),
        [0, 100_000, 800_000],
      );
      await service.close();
      service = await startPublicService(canonical ? aliased : await realpath(home), native);
      const again = await service.call("cursor.raw", request);
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.deepEqual(again.data, raw.data);
    } finally {
      await service.close();
    }
  }
});
