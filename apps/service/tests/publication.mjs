import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Publication } from "../dist/publication.js";
import { mediaWorker } from "../dist/worker.js";
const binary = process.env.YAP_NATIVE ?? resolve("helpers/mac/.build/debug/yap-native");
const worker = mediaWorker({ YAP_NATIVE: binary });
const script = fileURLToPath(import.meta.url);
if (process.argv[2] === "owner") {
  process.on("message", () => {});
  const root = process.argv[3],
    mode = process.argv[4];
  const controlledWorker = async (operation, params, options) => {
    if (mode !== "stopped" || operation !== "publication.commit")
      return worker(operation, params, options);
    const child = spawn(binary, [], {
      stdio: ["pipe", "pipe", "ignore", ...options.descriptors],
    });
    await once(child, "spawn");
    // Stop before handing over the request. Kernel-held descriptors must survive owner death.
    child.kill("SIGSTOP");
    child.stdin.end(JSON.stringify({ id: "stopped", operation, params }) + "\n");
    process.send({ state: "stopped", pid: child.pid });
    await new Promise(() => {});
  };
  const publication = await Publication.open(
    join(root, "stage"),
    join(root, "output"),
    controlledWorker,
  );
  const source = await open(join(root, "source"));
  await publication.prepare(source, "export.mp4", 1024);
  await source.close();
  if (mode === "stopped") await publication.commit();
  else {
    if (mode === "committed") assert.equal((await publication.commit()).state, "committed");
    process.send({ state: mode });
    await new Promise(() => {});
  }
} else {
  async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "yap-publication-service-"));
    await mkdir(join(root, "stage"), { mode: 0o700 });
    await mkdir(join(root, "output"), { mode: 0o755 });
    await writeFile(join(root, "source"), "known complete output");
    t.after(() => rm(root, { recursive: true, force: true }));
    const openOwner = () => Publication.open(join(root, "stage"), join(root, "output"), worker);
    return { root, openOwner };
  }
  async function killedOwner(t, f, mode) {
    const child = fork(script, ["owner", f.root, mode], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      env: { ...process.env, YAP_NATIVE: binary },
    });
    t.after(() => child.kill("SIGKILL"));
    const [message] = await once(child, "message");
    const closed = once(child, "close");
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    return message;
  }
  test("destination ownership fences a different staging owner and admission inspection", async (t) => {
    const f = await fixture(t);
    const first = await f.openOwner();
    t.after(() => first.close());
    await mkdir(join(f.root, "other-stage"), { mode: 0o700 });
    await assert.rejects(
      Publication.open(join(f.root, "other-stage"), join(f.root, "output"), worker),
      (error) => error.code === "PUBLICATION_BUSY",
    );
    const parent = await open(join(f.root, "output"));
    const info = await parent.stat({ bigint: true });
    await parent.close();
    const identity = { dev: String(info.dev), ino: String(info.ino) };
    await assert.rejects(
      Publication.inspect(join(f.root, "output"), identity, "export.mp4", worker),
      (error) => error.code === "PUBLICATION_BUSY",
    );
    await first.close();
    const second = await Publication.open(
      join(f.root, "other-stage"),
      join(f.root, "output"),
      worker,
    );
    await second.close();
    assert.equal(
      await Publication.inspect(join(f.root, "output"), identity, "export.mp4", worker),
      null,
    );
  });
  test("private staging usage observes partial bytes while the publication owner holds its lock", async (t) => {
    const f = await fixture(t);
    const owner = await f.openOwner();
    t.after(() => owner.close());
    const stage = await open(join(f.root, "stage"));
    t.after(() => stage.close());
    const stat = await stage.stat({ bigint: true });
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    await writeFile(join(f.root, "stage/payload"), "partial");
    assert.equal(await Publication.usage(join(f.root, "stage"), identity, worker), 7);
    await writeFile(join(f.root, "stage/payload"), "completed payload");
    assert.equal(await Publication.usage(join(f.root, "stage"), identity, worker), 17);
    await owner.discard();
    assert.equal(await Publication.usage(join(f.root, "stage"), identity, worker), 0);
  });
  test("private staging usage rejects replacement and linked payloads without reading external data", async (t) => {
    const f = await fixture(t);
    const handle = await open(join(f.root, "stage"));
    const stat = await handle.stat({ bigint: true });
    await handle.close();
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    await rename(join(f.root, "stage"), join(f.root, "original"));
    await mkdir(join(f.root, "stage"), { mode: 0o700 });
    await assert.rejects(Publication.usage(join(f.root, "stage"), identity, worker));
    await symlink(join(f.root, "source"), join(f.root, "original/payload"));
    await assert.rejects(Publication.usage(join(f.root, "original"), identity, worker), {
      code: "INVALID_STORAGE",
    });
    assert.equal(await readFile(join(f.root, "source"), "utf8"), "known complete output");
  });
  test("private staging usage counts prepared files and clears after acknowledgement without counting the movie", async (t) => {
    const f = await fixture(t);
    const owner = await f.openOwner();
    t.after(() => owner.close());
    const stage = await open(join(f.root, "stage"));
    const stat = await stage.stat({ bigint: true });
    await stage.close();
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    const source = await open(join(f.root, "source"));
    try {
      await owner.prepare(source, "export.mp4", 1024);
    } finally {
      await source.close();
    }
    const receiptBytes = (await readFile(join(f.root, "stage/prepared.json"))).length;
    assert.equal(
      await Publication.usage(join(f.root, "stage"), identity, worker),
      21 + receiptBytes,
    );
    await owner.commit();
    assert.equal(await Publication.usage(join(f.root, "stage"), identity, worker), receiptBytes);
    await owner.acknowledge();
    assert.equal(await Publication.usage(join(f.root, "stage"), identity, worker), 0);
    assert.equal(
      await readFile(join(f.root, "output/export.mp4"), "utf8"),
      "known complete output",
    );
    const sparse = await open(join(f.root, "stage/payload"), "w");
    try {
      await sparse.truncate(3 * 1024 ** 3 + 7);
    } finally {
      await sparse.close();
    }
    assert.equal(
      await Publication.usage(join(f.root, "stage"), identity, worker),
      3 * 1024 ** 3 + 7,
    );
  });
  test("killed owner after commit reconciles exact bytes and inode before acknowledgement", async (t) => {
    const f = await fixture(t);
    await killedOwner(t, f, "committed");
    const owner = await f.openOwner();
    t.after(() => owner.close());
    assert.equal((await owner.reconcile()).state, "committed");
    assert.equal(
      await readFile(join(f.root, "output/export.mp4"), "utf8"),
      "known complete output",
    );
    assert.equal((await owner.commit()).state, "committed");
    await owner.acknowledge();
    assert.deepEqual(await readdir(join(f.root, "stage")), []);
    await rm(join(f.root, "source"));
    assert.equal(
      await readFile(join(f.root, "output/export.mp4"), "utf8"),
      "known complete output",
    );
  });
  test("killed owner before commit leaves a resumable prepared file", async (t) => {
    const f = await fixture(t);
    await killedOwner(t, f, "prepared");
    const owner = await f.openOwner();
    t.after(() => owner.close());
    assert.equal((await owner.reconcile()).state, "missing");
    assert.equal((await owner.commit()).state, "committed");
    await owner.acknowledge();
  });
  test("stopped surviving publisher fences recovery until actual descriptor release", async (t) => {
    const f = await fixture(t);
    const { pid } = await killedOwner(t, f, "stopped");
    t.after(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    });
    process.kill(pid, 0);
    await assert.rejects(f.openOwner(), (e) => e.code === "PUBLICATION_BUSY");
    process.kill(pid, "SIGKILL");
    // Poll the actual inherited lock, bounded by the native worker deadline; a PID is not ownership.
    let owner;
    const until = Date.now() + 5000;
    while (!owner) {
      try {
        owner = await f.openOwner();
      } catch (e) {
        if (e.code !== "PUBLICATION_BUSY" || Date.now() >= until) throw e;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    t.after(() => owner.close());
    assert.equal((await owner.reconcile()).state, "missing");
    assert.equal((await owner.commit()).state, "committed");
  });
  test("reopened owner refuses a replacement output parent and preserves both trees", async (t) => {
    const f = await fixture(t);
    await killedOwner(t, f, "committed");
    await rename(join(f.root, "output"), join(f.root, "original-output"));
    await mkdir(join(f.root, "output"));
    await writeFile(join(f.root, "output/export.mp4"), "sentinel");
    const owner = await f.openOwner();
    t.after(() => owner.close());
    await assert.rejects(owner.reconcile(), (e) => e.code === "PUBLICATION_CHANGED");
    await assert.rejects(owner.commit(), (e) => e.code === "PUBLICATION_CHANGED");
    assert.equal(await readFile(join(f.root, "output/export.mp4"), "utf8"), "sentinel");
    assert.equal(
      await readFile(join(f.root, "original-output/export.mp4"), "utf8"),
      "known complete output",
    );
  });
  test("abort before commit prevents publication; abort after native commit preserves observed truth", async (t) => {
    const f = await fixture(t);
    const source = await open(join(f.root, "source"));
    t.after(() => source.close());
    const controller = new AbortController();
    const owner = await Publication.open(
      join(f.root, "stage"),
      join(f.root, "output"),
      async (op, params, options) => {
        const value = await worker(op, params, options);
        if (op === "publication.commit") {
          controller.abort();
          return {
            ok: false,
            error: {
              code: "CANCELED",
              message: "late cancellation",
              details: {},
              retryable: true,
            },
          };
        }
        return value;
      },
    );
    t.after(() => owner.close());
    await owner.prepare(source, "export.mp4", 1024);
    const already = new AbortController();
    already.abort();
    await assert.rejects(owner.commit({ signal: already.signal }), (e) => e.code === "CANCELED");
    assert.equal((await owner.reconcile()).state, "missing");
    assert.equal((await owner.commit({ signal: controller.signal })).state, "committed");
    assert.equal(
      await readFile(join(f.root, "output/export.mp4"), "utf8"),
      "known complete output",
    );
  });
  test("kernel write-limit failure never publishes and explicit discard removes only owned leaves", async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, "source"), Buffer.alloc(128 * 1024, 7));
    const executable = join(f.root, "limited-worker");
    await writeFile(
      executable,
      `#!/bin/sh\nulimit -f 1\nexec '${binary.replaceAll("'", "'\\''")}'\n`,
      { mode: 0o700 },
    );
    const limited = mediaWorker({ YAP_NATIVE: executable });
    const owner = await Publication.open(join(f.root, "stage"), join(f.root, "output"), limited);
    t.after(() => owner.close());
    const source = await open(join(f.root, "source"));
    t.after(() => source.close());
    await assert.rejects(
      owner.prepare(source, "export.mp4", 256 * 1024),
      (e) => e.code === "MEDIA_WORKER_FAILED",
    );
    await assert.rejects(readFile(join(f.root, "output/export.mp4")), {
      code: "ENOENT",
    });
    const partial = await readFile(join(f.root, "stage/payload"));
    assert.ok(partial.length > 0 && partial.length < 128 * 1024);
    await writeFile(join(f.root, "stage/unexpected"), "keep this");
    await owner.discard();
    assert.deepEqual(await readdir(join(f.root, "stage")), ["unexpected"]);
    assert.equal(await readFile(join(f.root, "stage/unexpected"), "utf8"), "keep this");
  });
  test("publication refuses a destination inside its disposable staging", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      Publication.open(join(f.root, "stage"), join(f.root, "stage"), worker),
      (e) => e.code === "INVALID_STORAGE",
    );
    assert.deepEqual(await readdir(join(f.root, "stage")), []);
  });
  test("one publication deadline covers preparation, commit, reconciliation and acknowledgement", async (t) => {
    const f = await fixture(t);
    const owner = await Publication.open(
      join(f.root, "stage"),
      join(f.root, "output"),
      mediaWorker({ YAP_NATIVE: binary }, 1),
      { timeoutMs: 5000 },
    );
    t.after(() => owner.close());
    const source = await open(join(f.root, "source"));
    t.after(() => source.close());
    await owner.prepare(source, "export.mp4", 1024);
    assert.equal((await owner.commit()).state, "committed");
    assert.equal((await owner.reconcile()).state, "committed");
    await owner.acknowledge();
  });

  test("all close callers wait for the active native operation before descriptors release", async (t) => {
    const f = await fixture(t),
      entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const owner = await Publication.open(
      join(f.root, "stage"),
      join(f.root, "output"),
      async (...args) => {
        const result = await worker(...args);
        entered.resolve();
        await release.promise;
        return result;
      },
    );
    const source = await open(join(f.root, "source"));
    t.after(() => source.close());
    const preparing = owner.prepare(source, "export.mp4", 1024);
    await entered.promise;
    const first = owner.close(),
      second = owner.close();
    let closed = false;
    second.then(() => {
      closed = true;
    });
    try {
      await new Promise(setImmediate);
      assert.equal(closed, false);
    } finally {
      release.resolve();
      await Promise.all([preparing, first, second]);
    }
    const reopened = await f.openOwner();
    t.after(() => reopened.close());
    assert.equal((await reopened.reconcile()).state, "missing");
  });
}
