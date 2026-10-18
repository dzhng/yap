import assert from "node:assert/strict";
import { test } from "node:test";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, until, nativeBinary, gate } from "./fixtures/project-export.mjs";

test("substituted project package input blocks publication and cleanup until owned identity returns", async (t) => {
  let f,
    moved,
    original,
    replace = true;
  f = await fixture(t, {
    wrap:
      (run) =>
      async (operation, ...args) => {
        if (operation === "archive.write" && replace) {
          replace = false;
          const reservation = JSON.parse(
            f.catalog.catalog
              .prepare("SELECT assembly FROM export_intents WHERE kind='processed-package'")
              .get().assembly,
          );
          original = join(f.home, "package-exports", reservation.input.name);
          moved = original + "-owned";
          await rename(original, moved);
          await mkdir(original, { mode: 0o700 });
          await writeFile(join(original, "foreign"), "preserve replacement");
        }
        return run(operation, ...args);
      },
  });
  const request = { ...f.request(), kind: "processed-package", leaf: "substituted.zip" };
  await f.exports.create(request);
  await f.jobs.idle();
  assert.equal(f.exports.status(request.exportId).state, "failed");
  await assert.rejects(stat(join(f.output, "substituted.zip")), { code: "ENOENT" });
  f.exports.resumeRecovery();
  await f.jobs.idle();
  const recovery = f.exports.status(request.exportId).recovery;
  assert.equal(recovery.state, "failed");
  assert.equal(recovery.retryable, true);
  assert.equal(await readFile(join(original, "foreign"), "utf8"), "preserve replacement");
  await rm(original, { recursive: true });
  await rename(moved, original);
  f.exports.recover(request.exportId);
  await f.jobs.idle();
  assert.equal(f.exports.status(request.exportId).recovery.state, "ready");
  assert.equal(
    f.catalog.catalog
      .prepare("SELECT assembly FROM export_intents WHERE exportId=?")
      .get(request.exportId).assembly,
    null,
  );
  await f.exports.abandon(request.exportId);
  assert.deepEqual(await readdir(f.output), []);
  assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
});

test("project package refuses source mutation after an actual descriptor read during copying", async (t) => {
  const f = await fixture(t);
  const path = f.assets.path(f.asset.id);
  await chmod(path, 0o600);
  const writer = await open(path, "r+");
  await chmod(path, 0o400);
  const identity = await writer.stat({ bigint: true });
  const prototype = Object.getPrototypeOf(writer),
    read = prototype.read;
  let changed = false;
  prototype.read = async function (...args) {
    const result = await read.apply(this, args);
    if (!changed && result.bytesRead > 0) {
      const info = await this.stat({ bigint: true });
      if (info.dev === identity.dev && info.ino === identity.ino) {
        changed = true;
        await writer.write(Buffer.from([99]), 0, 1, 0);
      }
    }
    return result;
  };
  const request = { ...f.request(), kind: "processed-package", leaf: "changed.zip" };
  try {
    await f.exports.create(request);
    await f.jobs.idle();
  } finally {
    prototype.read = read;
    await writer.close();
  }
  assert.equal(changed, true, "A real read of the selected source preceded its mutation");
  const failed = f.exports.status(request.exportId);
  assert.equal(failed.state, "failed");
  assert.match(failed.reason, /source changed during copying/i);
  await assert.rejects(stat(join(f.output, "changed.zip")), { code: "ENOENT" });
  await f.exports.abandon(request.exportId);
  assert.deepEqual(await readdir(f.output), []);
  assert.equal((await readFile(path))[0], 99);
});

test(
  "surviving native project package writer fences project deletion after owner SIGKILL",
  { timeout: 20000 },
  async (t) => {
    const original = await fixture(t, { admission: false });
    const request = { ...original.request(), kind: "processed-package", leaf: "uncommitted.zip" };
    await original.exports.create(request);
    await original.close();
    const library = join(original.home, "copy-barrier.dylib"),
      marker = join(original.home, "copy-stopped");
    const compiled = spawnSync(
      "/usr/bin/clang",
      ["-dynamiclib", "-o", library, resolve("apps/macos/tests/fixtures/archive-copy-barrier.c")],
      { encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const existing = {
      home: original.home,
      output: original.output,
      projectId: original.projectId,
      asset: { id: original.asset.id },
      placed: { revision: { revisionId: original.placed.revision.revisionId } },
      library,
      marker,
    };
    const child = fork(
      fileURLToPath(new URL("./fixtures/project-export-crash.mjs", import.meta.url)),
      [JSON.stringify(existing), "package-survivor"],
      {
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: { ...process.env, YAP_NATIVE: nativeBinary },
      },
    );
    const closed = once(child, "close");
    const group = (signal) => {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    // The owned group is known before any worker can publish its barrier marker.
    t.after(async () => {
      group("SIGKILL");
      await closed;
      await until(() => !group(0));
    });
    const pid = await until(async () =>
      Number(
        await readFile(marker, "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        }),
      ),
    );
    const observed = spawnSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "ppid=,pgid=,state=,command="],
      { encoding: "utf8" },
    );
    assert.equal(observed.status, 0, observed.stderr);
    const [parent, processGroup, state, ...command] = observed.stdout.trim().split(/\s+/);
    assert.equal(Number(parent), child.pid);
    assert.equal(Number(processGroup), child.pid);
    assert.match(state, /^T/);
    assert.equal(command.join(" "), nativeBinary);
    assert.equal(child.kill("SIGKILL"), true);
    assert.deepEqual(await closed, [null, "SIGKILL"]);
    const f = await fixture(t, { existing: original });
    const assembly = () =>
      f.catalog.catalog
        .prepare("SELECT assembly FROM export_intents WHERE exportId=?")
        .get(request.exportId).assembly;
    const before = assembly(),
      reservation = JSON.parse(before);
    assert.ok(reservation.input.identity && reservation.zip.identity);
    await assert.rejects(
      f.deletion.delete({ kind: "project", id: f.projectId }),
      (error) => error.retryable === true,
    );
    assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
    assert.ok(
      (await stat(join(f.home, "package-exports", reservation.zip.name, "payload.zip"))).size > 0,
    );
    assert.equal(assembly(), before);
    process.kill(pid, "SIGKILL");
    await until(async () => {
      try {
        await f.deletion.delete({ kind: "project", id: f.projectId });
        return true;
      } catch (error) {
        if (!error.retryable) throw error;
        return false;
      }
    });
    assert.equal(f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM export_intents").get().n, 0);
    assert.throws(() => f.projects.get(f.projectId), { code: "NOT_FOUND" });
    assert.deepEqual(await readdir(join(f.home, "package-exports")), []);
    assert.deepEqual(await readdir(f.output), []);
    assert.equal(await readFile(f.assets.path(f.asset.id), "utf8"), "source identity");
  },
);

test("project package refuses a normalized acquisition member changed after its frozen pin", async (t) => {
  const entered = gate(),
    release = gate();
  t.after(() => release.resolve());
  const f = await fixture(t, {
    render: async (request, signal, render) => {
      entered.resolve();
      await release.promise;
      return render(request, signal);
    },
  });
  const donor = join(f.home, "capture-donor");
  await mkdir(donor);
  const journal = JSON.stringify({
    sessionID: "package-receipt",
    intervals: [{ startUs: 0, endUs: 1000000 }],
  });
  await writeFile(join(donor, "capture.journal.jsonl"), journal);
  await writeFile(join(donor, "video.mov"), "captured video");
  await writeFile(join(donor, "narration.mov"), "captured audio");
  await f.acquisitionImports.recover(new AbortController().signal);
  const prepared = await f.acquisitionImports.prepareImport("capture", donor);
  const intent = f.acquisitions.admitImport(prepared);
  const acquired = await f.acquisitionImports.executeImport(
    intent.acquisitionId,
    "capture-attempt",
    {
      exportSource: async (directory, output) => {
        const input = JSON.parse(await readFile(join(directory, "capture.journal.jsonl"), "utf8"));
        const body = input.intervals
          .map(
            (interval) =>
              JSON.stringify({ event: "audioAcquired", data: { role: "narration", ...interval } }) +
              "\n",
          )
          .join("");
        await writeFile(output, body);
        return {
          file: output,
          journal: "capture.journal.jsonl",
          header: { sessionID: input.sessionID },
          cursorSamples: 0,
          geometryRecords: 0,
          displaySpaces: 0,
          pauseEvents: 0,
          audioIntervals: input.intervals.length,
          lastSequence: input.intervals.length,
          incompleteTail: false,
          finished: true,
          bytes: Buffer.byteLength(body),
        };
      },
      probe: async (path) => {
        const kind = (await readFile(path, "utf8")) === "captured video" ? "video" : "audio";
        return {
          originUs: 0,
          streams: [
            {
              id: "track:1",
              kind,
              codec: "fixture",
              ...(kind === "video"
                ? { width: 160, height: 96, orientedWidth: 160, orientedHeight: 96 }
                : {}),
              decodable: true,
              startUs: 0,
              endUs: 1000000,
              segments: [{ startUs: 0, endUs: 1000000, empty: false }],
            },
          ],
        };
      },
    },
    new AbortController().signal,
  );
  const video = acquired.bindings.find((binding) => binding.sourceRoles.includes("video"));
  assert.ok(video);
  f.projects.apply(f.projectId, {
    requestId: "capture-context",
    expectedRevisionId: f.placed.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "capture" },
      {
        operation: "place",
        clip: {
          trackId: { label: "capture" },
          assetId: video.assetId,
          streamId: video.streamId,
          acquisitionId: acquired.id,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
  });
  const normalized = acquired.evidence.receipt.file;
  const original = await readFile(normalized, "utf8"),
    altered = original + "\n";
  assert.equal(Buffer.byteLength(original), acquired.evidence.receipt.bytes);
  assert.equal(Buffer.byteLength(altered), acquired.evidence.receipt.bytes + 1);
  await chmod(normalized, 0o600);
  await f.preview.request({ projectId: f.projectId, revisionId: f.placed.revision.revisionId });
  await entered.promise;
  const request = { ...f.request(), kind: "processed-package", leaf: "changed-normalized.zip" };
  await f.exports.create(request);
  assert.equal(f.exports.status(request.exportId).state, "queued");
  const pinned = JSON.parse(
    f.catalog.catalog
      .prepare("SELECT snapshot FROM export_intents WHERE exportId=?")
      .get(request.exportId).snapshot,
  ).acquisitionFiles[acquired.id].normalized;
  assert.equal(pinned.bytes, acquired.evidence.receipt.bytes);
  await writeFile(normalized, altered);
  assert.equal((await stat(normalized)).size, pinned.bytes + 1);
  assert.equal(f.acquisitions.get(acquired.id).evidence.receipt.bytes, pinned.bytes);
  release.resolve();
  await f.jobs.idle();
  const failed = f.exports.status(request.exportId);
  assert.equal(failed.state, "failed", JSON.stringify(failed));
  assert.equal(f.jobs.job(failed.jobId).errorCode, "SOURCE_CHANGED");
  await assert.rejects(stat(join(f.output, request.leaf)), { code: "ENOENT" });
  await f.exports.abandon(request.exportId);
  assert.deepEqual(await readdir(f.output), []);
  assert.equal(await readFile(normalized, "utf8"), altered);
  assert.equal(await readFile(f.acquisitionImports.journalPath(acquired.id), "utf8"), journal);
  assert.equal(await readFile(f.assets.path(video.assetId), "utf8"), "captured video");
});
