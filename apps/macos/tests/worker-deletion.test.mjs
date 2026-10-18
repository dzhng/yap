import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { callLocal } from "@yap/client";
import { CaptureStore } from "@yap/core/capture-store";
import { importAcquisition } from "./fixtures/public-service.mjs";
import { startProjectService } from "../../service/dist/project-service.js";
import { mediaWorker } from "../../service/dist/worker.js";
import { withArchiveCopyBarrier } from "./fixtures/archive-copy-barrier.mjs";
import { alive, temporary, waitFor } from "./harness.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function snapshotFiles(path, out = new Map()) {
  if (!existsSync(path)) return out;
  const stat = statSync(path);
  if (stat.isFile()) {
    out.set(path, stat.size);
    return out;
  }
  for (const entry of readdirSync(path)) snapshotFiles(join(path, entry), out);
  return out;
}

async function generated(home, seconds) {
  await mkdir(join(home, "library"), { recursive: true, mode: 0o700 });
  const store = new CaptureStore(join(home, "library", "catalog.sqlite"), {
    now: () => new Date().toISOString(),
    newId: randomUUID,
  });
  let take;
  try {
    take = store.allocate().recording;
    for (const [i, state] of ["recording", "finalizing", "complete"].entries())
      store.ingestLifecycle(take.recordingId, {
        sourceId: take.sourceId,
        sequence: i + 1,
        state,
        ...(state === "complete" ? { sourceDurationUs: seconds * 1_000_000 } : {}),
      });
  } finally {
    store.close();
  }
  const directory = join(home, "library", "recordings", take.recordingId),
    source = join(directory, "source");
  await mkdir(source, { recursive: true, mode: 0o700 });
  const video = join(source, "video.mov");
  const encoded = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=blue:s=320x180:r=30:d=${seconds}`,
      "-an",
      "-c:v",
      "libx264",
      "-bf",
      "0",
      video,
    ],
    { timeout: 15_000, encoding: "utf8" },
  );
  assert.equal(encoded.status, 0, encoded.stderr);
  const rows = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: take.sourceId,
        source: { kind: "window", windowID: 1 },
        width: 320,
        height: 180,
        microphone: false,
        systemAudio: false,
      },
    },
    { event: "origin", data: { hostUs: 1_000_000 } },
    {
      event: "geometry",
      data: {
        epoch: 1,
        hostUs: 1_000_000,
        sourceUs: 0,
        geometry: {
          outputWidth: 320,
          outputHeight: 180,
          contentScale: 1,
          scaleFactor: 1,
          contentRect: { x: 0, y: 0, width: 320, height: 180 },
          screenRect: { x: 0, y: 0, width: 320, height: 180 },
        },
      },
    },
    { event: "finished", data: {} },
  ];
  await writeFile(
    join(source, "capture.journal.jsonl"),
    rows.map((row, i) => JSON.stringify({ sequence: i + 1, ...row })).join("\n") + "\n",
  );
  return { ...take, directory, video };
}

test(
  "public deletion reaps a live native media worker before removing its recording",
  { timeout: 60_000 },
  async () => {
    const home = temporary("/tmp/scr-worker-delete-");
    const sibling = await generated(home, 2);
    const native =
      process.env.YAP_NATIVE ??
      fileURLToPath(new URL("../../../helpers/mac/.build/debug/yap-native", import.meta.url));
    const directWorker = mediaWorker({ YAP_NATIVE: native });
    let report;
    await withArchiveCopyBarrier(
      home,
      native,
      { operation: "media.sourceEvidence", minimumFd: 3 },
      async ({ worker: heldWorker, held }) => {
        let holdTarget = false,
          heldTargetResult;
        const service = await startProjectService({
          home,
          worker: async (operation, params, options) => {
            if (!holdTarget) return directWorker(operation, params, options);
            const result = await heldWorker(operation, params, options);
            if (operation === "media.sourceEvidence") heldTargetResult = result;
            return result;
          },
        });
        try {
          const servicePid = process.pid;
          const call = (operation, params = {}) =>
            callLocal(
              service.socketPath,
              { id: randomUUID(), operation, params },
              { timeoutMs: 20_000 },
            );
          const succeeds = async (operation, params) => {
            const result = await call(operation, params);
            assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`);
            return result.data;
          };
          const siblingImport = await importAcquisition(
            { call },
            join(sibling.directory, "source"),
          );
          const binding = siblingImport.acquisition.bindings.find((value) =>
            value.sourceRoles.includes("video"),
          );
          assert.ok(binding);
          const selector = {
            assetId: binding.assetId,
            streamId: binding.streamId,
            acquisitionId: siblingImport.acquisition.id,
          };
          const siblingIndex = await waitFor(async () => {
            const result = await succeeds("index.get", { ...selector, limit: 1 });
            if (["failed", "unavailable"].includes(result.state))
              throw new Error(JSON.stringify(result));
            return result.state === "ready" && result;
          }, 20_000);
          const reference = siblingIndex.entries[0].reference;
          const readSibling = async () => {
            const frame = await succeeds("index.frame", reference);
            try {
              const chunk = await succeeds("artifact.read", {
                token: frame.delivery.token,
                offsetBytes: 0,
                maxBytes: 524288,
              });
              assert.equal(chunk.eof, true);
              return Buffer.from(chunk.data, "base64");
            } finally {
              await succeeds("artifact.close", { token: frame.delivery.token });
            }
          };
          const siblingImage = await readSibling(),
            siblingHash = digest(await readFile(sibling.video));
          // Seed only after the sibling is ready, so the service's sole native media child is attributable.
          const take = await generated(home, 30);
          holdTarget = true;
          let heldPid, heldError;
          void held.then(
            ({ pid }) => {
              heldPid = pid;
            },
            (error) => {
              heldError = error;
            },
          );
          const importJob = await succeeds("acquisition.import", {
            requestId: randomUUID(),
            path: join(take.directory, "source"),
          });
          const worker = {
            pid: await waitFor(
              () => {
                if (heldError) throw heldError;
                return heldPid;
              },
              5_000,
              () => "Target acquisition native reader did not reach its owned descriptor barrier",
            ),
          };
          assert.equal(
            Number(
              execFileSync("/bin/ps", ["-p", String(worker.pid), "-o", "ppid="], {
                encoding: "utf8",
              }).trim(),
            ),
            servicePid,
          );
          const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(worker.pid)], {
            encoding: "utf8",
          }).trim();
          assert.match(
            state,
            /T/,
            "The actual native worker must be stopped before deletion starts",
          );
          const catalog = new DatabaseSync(join(home, "library", "catalog.sqlite"), {
            readOnly: true,
          });
          let active;
          try {
            catalog.exec("PRAGMA busy_timeout=1000");
            active = catalog
              .prepare("SELECT targetKind,targetId,artifact FROM jobs WHERE state='running'")
              .all();
          } finally {
            catalog.close();
          }
          assert.ok(active.length > 0);
          assert.ok(
            active.every(
              (job) =>
                job.targetKind === "acquisition" && job.targetId === importJob.target.acquisitionId,
            ),
            JSON.stringify(active),
          );
          assert.ok(active.some((job) => job.artifact === "acquisition.import"));
          assert.equal(existsSync(take.directory), true);
          assert.equal(alive(worker.pid), true);
          const filesBeforeDelete = snapshotFiles(join(home, "library"));

          const recordingBefore = await succeeds("recording.get", {
            recordingId: take.recordingId,
          });
          assert.equal(recordingBefore.recordingId, take.recordingId);
          let finished = false,
            observations = 0,
            sawDirectoryRemoved = false;
          const deletion = call("recording.delete", {
            recordingId: take.recordingId,
            requestId: randomUUID(),
          }).finally(() => {
            finished = true;
          });
          const monitor = (async () => {
            do {
              const present = existsSync(take.directory);
              if (!present) {
                sawDirectoryRemoved = true;
                assert.equal(
                  alive(worker.pid),
                  false,
                  "Recording directory disappeared while its native media worker was alive",
                );
              }
              observations++;
              await delay(1);
            } while (!finished);
          })();
          const [result] = await Promise.all([deletion, monitor]);
          assert.equal(result.ok, true, JSON.stringify(result));
          const filesAfterDelete = snapshotFiles(join(home, "library"));
          const freedMeasured = [...filesBeforeDelete].reduce(
            (sum, [path, bytes]) => sum + (filesAfterDelete.has(path) ? 0 : bytes),
            0,
          );
          assert.equal(result.data.recordingId, take.recordingId);
          assert.equal(result.data.deleted, true);
          assert.ok(result.data.freedBytes > 0);
          assert.equal(alive(worker.pid), false);
          assert.equal(existsSync(take.directory), false);
          assert.equal(heldTargetResult?.ok, false, JSON.stringify(heldTargetResult));
          assert.equal(
            heldTargetResult.error.code,
            "CANCELED",
            "Deletion must cancel the held native reader before fixture cleanup, rather than wait for its timeout",
          );
          assert.equal(
            (await call("recording.get", { recordingId: take.recordingId })).error.code,
            "NOT_FOUND",
          );
          const recordingAfter = await call("recording.get", { recordingId: take.recordingId });
          assert.equal(recordingAfter.ok, false);
          assert.equal(recordingAfter.error.code, "NOT_FOUND");
          assert.deepEqual(await readSibling(), siblingImage);
          assert.equal(digest(await readFile(sibling.video)), siblingHash);
          assert.equal((await succeeds("service.health")).status, "ready");
          assert.equal(alive(worker.pid), false);
          report = {
            generated: true,
            ownedProcessesReaped: true,
            recordingBefore,
            recordingAfter: recordingAfter.error.code,
            servicePid,
            workerPid: worker.pid,
            workerStateBeforeDelete: state,
            active,
            observations,
            sawDirectoryRemoved,
            deleted: result.data,
            workerGone: !alive(worker.pid),
            heldTargetResult,
            directoryGone: !existsSync(take.directory),
            siblingImageSha256: digest(siblingImage),
            siblingSourceSha256: siblingHash,
            siblingUsable: true,
            scope:
              "Generated media with an OS-stopped real native worker; no capture devices or user recordings.",
          };
        } finally {
          await service.close();
        }
      },
    );
    console.log(JSON.stringify(report));
    if (process.env.YAP_WORKER_DELETE_EVIDENCE)
      await writeFile(
        process.env.YAP_WORKER_DELETE_EVIDENCE,
        JSON.stringify(report, null, 2) + "\n",
        { flag: "wx" },
      );
  },
);
