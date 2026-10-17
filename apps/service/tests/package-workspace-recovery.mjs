import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { withOrphanedPackageWorkspace } from "./fixtures/orphaned-package-workspace.mjs";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  recoverPackageWorkspaces,
  removePackageWorkspace,
  provisionPackageWorkspace,
  cleanupFailedPackageWorkspace,
} from "../dist/package-workspace.js";
import { mediaWorker } from "../dist/worker.js";
const binary = process.env.YAP_NATIVE ?? resolve("helpers/mac/.build/debug/yap-native");
const worker = mediaWorker({ YAP_NATIVE: binary });
async function fixture(t) {
  const root = await realpath(await mkdtemp("/tmp/yap-recovery-"));
  const directory = join(root, "parent");
  await mkdir(directory, { mode: 0o700 });
  const handle = await open(directory);
  t.after(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  async function orphan() {
    const name = randomUUID(),
      path = join(directory, name);
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "data"), name);
    return { name, path };
  }
  return { root, parent: { directory, handle }, orphan };
}
test("recovery removes bounded orphan trees through retained parent after locator replacement", async (t) => {
  const f = await fixture(t);
  const a = await f.orphan();
  await f.orphan();
  const original = join(f.root, "original");
  await rename(f.parent.directory, original);
  await mkdir(f.parent.directory, { mode: 0o700 });
  await mkdir(join(f.parent.directory, a.name));
  await writeFile(join(f.parent.directory, a.name, "sentinel"), "foreign");
  assert.deepEqual(await recoverPackageWorkspaces(f.parent, worker), { recovered: 2 });
  assert.deepEqual(await readdir(original), []);
  assert.equal(await readFile(join(f.parent.directory, a.name, "sentinel"), "utf8"), "foreign");
  assert.deepEqual(await recoverPackageWorkspaces(f.parent, worker), { recovered: 0 });
});
test("recovery preflights invalid and overbound roots without partial deletion", async (t) => {
  const f = await fixture(t);
  const a = await f.orphan();
  await writeFile(join(f.parent.directory, "unexpected"), "preserve");
  await assert.rejects(recoverPackageWorkspaces(f.parent, worker), {
    code: "INVALID_STORAGE",
    retryable: false,
  });
  assert.equal(await readFile(join(a.path, "data"), "utf8"), a.name);
  await rm(join(f.parent.directory, "unexpected"));
  const others = [];
  for (let i = 0; i < 4; i++) others.push(await f.orphan());
  await assert.rejects(recoverPackageWorkspaces(f.parent, worker), {
    code: "INVALID_STORAGE",
    retryable: false,
  });
  for (const child of [a, ...others])
    assert.equal(await readFile(join(child.path, "data"), "utf8"), child.name);
  await rm(others.pop().path, { recursive: true });
  assert.deepEqual(await recoverPackageWorkspaces(f.parent, worker), { recovered: 4 });
});
test("recovery rejects linked or nonprivate children and preserves every orphan", async (t) => {
  const f = await fixture(t);
  const a = await f.orphan();
  const target = join(f.root, "outside");
  await mkdir(target);
  await writeFile(join(target, "sentinel"), "foreign");
  const linked = join(f.parent.directory, randomUUID());
  await symlink(target, linked);
  await assert.rejects(recoverPackageWorkspaces(f.parent, worker), {
    code: "INVALID_STORAGE",
    retryable: false,
  });
  assert.equal(await readFile(join(a.path, "data"), "utf8"), a.name);
  assert.equal(await readFile(join(target, "sentinel"), "utf8"), "foreign");
  await rm(linked);
  await mkdir(linked, { mode: 0o755 });
  await assert.rejects(recoverPackageWorkspaces(f.parent, worker), {
    code: "INVALID_STORAGE",
    retryable: false,
  });
  assert.equal(await readFile(join(a.path, "data"), "utf8"), a.name);
});
test("unconfirmed creation recovery permits only empty private children or absence", async (t) => {
  const f = await fixture(t);
  const name = randomUUID();
  await removePackageWorkspace(f.parent, name, null, worker);
  await mkdir(join(f.parent.directory, name), { mode: 0o700 });
  await removePackageWorkspace(f.parent, name, null, worker);
  await assert.rejects(stat(join(f.parent.directory, name)), { code: "ENOENT" });
  const nonempty = await f.orphan();
  await assert.rejects(removePackageWorkspace(f.parent, nonempty.name, null, worker), {
    code: "INVALID_STORAGE",
  });
  await assert.rejects(
    cleanupFailedPackageWorkspace(f.parent, nonempty.name, { details: { identity: {} } }, worker),
    { code: "INVALID_STORAGE" },
  );
  assert.equal(await readFile(join(nonempty.path, "data"), "utf8"), nonempty.name);
});
test("failed provision cleanup retains exact identity and rejects a replacement", async (t) => {
  const f = await fixture(t);
  const name = randomUUID(),
    directory = join(f.parent.directory, name);
  const failedWorker = async (operation, params, options) => {
    if (operation === "packageWorkspace.admit" || operation === "packageWorkspace.remove")
      return {
        ok: false,
        error: {
          code: "MEDIA_WORKER_FAILED",
          message: "generated failure",
          retryable: true,
          details: {},
        },
      };
    const reply = await worker(operation, params, options);
    if (operation === "packageWorkspace.create" && reply.ok)
      await writeFile(join(directory, "data"), "owned");
    return reply;
  };
  let failure;
  try {
    await provisionPackageWorkspace(f.parent, failedWorker, { name });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, "INVALID_STORAGE");
  const original = join(f.root, "original");
  await rename(directory, original);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "sentinel"), "foreign");
  await assert.rejects(cleanupFailedPackageWorkspace(f.parent, name, failure, worker), {
    code: "STORAGE_CHANGED",
    retryable: true,
  });
  assert.equal(await readFile(join(directory, "sentinel"), "utf8"), "foreign");
  await rm(directory, { recursive: true });
  await rename(original, directory);
  await cleanupFailedPackageWorkspace(f.parent, name, failure, worker);
  assert.deepEqual(await readdir(f.parent.directory), []);
});
test(
  "killed owner leaves native inherited lock busy until actual child termination",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const unheld = await f.orphan();
    await withOrphanedPackageWorkspace(
      f.parent.directory,
      binary,
      async ({ name, finishChild }) => {
        await assert.rejects(recoverPackageWorkspaces(f.parent, worker), {
          code: "RECOVERY_BUSY",
          retryable: true,
        });
        assert.equal(await readFile(join(unheld.path, "data"), "utf8"), unheld.name);
        assert.equal(
          await readFile(join(f.parent.directory, name, "data"), "utf8"),
          "held by inherited native descriptor",
        );
        await finishChild();
        assert.deepEqual(await recoverPackageWorkspaces(f.parent, worker), { recovered: 2 });
        assert.deepEqual(await readdir(f.parent.directory), []);
      },
    );
  },
);
test("orphan fixture reaps the stopped native child when consumer assertions fail", async (t) => {
  const f = await fixture(t);
  let nativePid;
  await assert.rejects(
    withOrphanedPackageWorkspace(f.parent.directory, binary, async ({ pid }) => {
      nativePid = pid;
      throw new Error("generated consumer failure");
    }),
    /generated consumer failure/,
  );
  assert.ok(nativePid);
  assert.throws(
    () => process.kill(nativePid, 0),
    (error) => error.code === "ESRCH",
  );
  assert.deepEqual(await recoverPackageWorkspaces(f.parent, worker), { recovered: 1 });
});

/** Kills a native child and waits until it no longer exists, so fixture removal never races it. */
async function reapNativeChild(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 3000;
  while (isAlive(pid)) {
    assert.ok(Date.now() < deadline, "Native process must terminate before fixture removal");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test(
  "normal fixture IPC disconnect terminates and reaps its stopped native child",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const owner = fork(
      fileURLToPath(new URL("./fixtures/package-workspace-owner.mjs", import.meta.url)),
      [f.parent.directory],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: { ...process.env, YAP_NATIVE: binary },
      },
    );
    const closed = once(owner, "exit");
    let pid;
    // A reap failure is rethrown only after the test body passed, so it never masks the body's error.
    let reapFailure;
    try {
      const [message] = await Promise.race([
        once(owner, "message"),
        closed.then(() => {
          throw new Error("Owner exited before child receipt");
        }),
      ]);
      pid = message.pid;
      const disconnected = once(owner, "disconnect");
      owner.disconnect();
      await Promise.all([closed, disconnected]);
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
      );
      assert.deepEqual(await recoverPackageWorkspaces(f.parent, worker), { recovered: 1 });
    } finally {
      owner.kill("SIGKILL");
      await closed;
      if (pid) {
        try {
          await reapNativeChild(pid);
        } catch (error) {
          reapFailure = error;
        }
      }
    }
    if (reapFailure) throw reapFailure;
  },
);
