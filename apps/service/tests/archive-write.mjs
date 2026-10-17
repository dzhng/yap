import {
  projectPackageManifest,
  parseProjectPackageManifest,
  resourceMetadataMember,
  resourceMembers,
} from "@yap/core/project-package";
import { resolveProjectPackageMetadata } from "../dist/project-package-metadata.js";
import { fixture as projectFixture } from "./fixtures/project-export.mjs";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { withArchiveCopyBarrier } from "../../macos/tests/fixtures/archive-copy-barrier.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  realpath,
  mkdtemp,
  mkdir,
  open,
  writeFile,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileIdentity } from "@yap/core/files";
import { archiveLimits } from "@yap/core/package-archive";
import { writeArchive } from "../dist/archive-write.js";
import { mediaWorker } from "../dist/worker.js";
import { Publication } from "../dist/publication.js";
import { admitArchive } from "../dist/archive-input.js";
import { openPackageArchive } from "../dist/package-archive.js";
const worker = mediaWorker({
  YAP_NATIVE: process.env.YAP_NATIVE ?? resolve("helpers/mac/.build/debug/yap-native"),
});
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, contents) {
  const root = await realpath(await mkdtemp("/tmp/yap-zip-write-"));
  const paths = Object.fromEntries(
    ["input", "scratch", "stage", "output", "read"].map((name) => [name, join(root, name)]),
  );
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
  const members = [];
  for (const [path, value] of Object.entries(contents)) {
    await mkdir(dirname(join(paths.input, path)), { recursive: true });
    await writeFile(join(paths.input, path), value);
    const file = await open(join(paths.input, path));
    const info = await file.stat({ bigint: true });
    members.push({
      path,
      bytes: Number(info.size),
      sha256: sha(value),
      identity: fileIdentity(info),
    });
    await file.close();
  }
  await writeFile(join(root, "plan"), JSON.stringify(members));
  const handles = Object.fromEntries(
    await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await open(path)])),
  );
  const plan = await open(join(root, "plan"));
  t.after(async () => {
    await plan.close();
    for (const handle of Object.values(handles)) await handle.close();
    await rm(root, { recursive: true, force: true });
  });
  const input = {
    handle: handles.input,
    plan,
    bytes: members.reduce((n, member) => n + member.bytes, 0),
  };
  const workspace = { directory: paths.scratch, handle: handles.scratch };
  return { root, paths, handles, input, workspace, members, contents };
}
test("streamed ZIP publishes through the existing no-clobber owner and independent reader", async (t) => {
  const project = await projectFixture(t);
  const pinned = project.packages.pin(project.projectId);
  const contents = Object.fromEntries(
    pinned.snapshot.revisions.map((revision) => [
      `revisions/${revision.ordinal}.json`,
      JSON.stringify(revision),
    ]),
  );
  for (const resource of pinned.resources) {
    const metadata = resourceMetadataMember(resource);
    contents[metadata.reference.metadata.path] = metadata.body;
    assert.equal(resource.kind, "asset");
    const [member] = resourceMembers(resource);
    contents[member.path] = await readFile(project.assets.path(resource.asset.id));
  }
  const inventory = Object.entries(contents).map(([path, bytes]) => ({
    path,
    bytes: Buffer.byteLength(bytes),
    sha256: sha(bytes),
  }));
  contents["manifest.json"] = JSON.stringify(
    projectPackageManifest(pinned.snapshot, pinned.resources, inventory),
  );
  const f = await fixture(t, contents);
  const zip = await writeArchive(f.input, f.workspace, worker);
  t.after(() => zip.close());
  assert.equal(zip.receipt.expandedBytes, f.input.bytes);
  assert.equal(zip.receipt.sha256, sha(await readFile(join(f.paths.scratch, "payload.zip"))));
  const publication = await Publication.open(f.paths.stage, f.paths.output, worker);
  try {
    await publication.prepare(zip.file, "project.zip", zip.receipt.bytes);
    assert.equal((await publication.commit()).state, "committed");
    await publication.acknowledge();
  } finally {
    await publication.close();
  }
  await zip.close();
  assert.deepEqual(await readdir(f.paths.scratch), []);
  const archive = admitArchive(join(f.paths.output, "project.zip"));
  try {
    const result = await openPackageArchive(
      archive,
      { directory: f.paths.read, handle: f.handles.read },
      worker,
      {
        validate: parseProjectPackageManifest,
        resolve: resolveProjectPackageMetadata,
        inlineRevisions: false,
      },
    );
    try {
      assert.deepEqual(result.manifest.snapshot, JSON.parse(JSON.stringify(pinned.snapshot)));
      const member = resourceMembers(pinned.resources[0])[0];
      assert.equal(
        result.manifest.inventory.find((entry) => entry.path === member.path).sha256,
        project.asset.id,
      );
      assert.deepEqual(
        await readFile(join(f.paths.read, "content", member.path)),
        f.contents[member.path],
      );
    } finally {
      await result.close();
    }
  } finally {
    archive.close();
  }
});
test("substituted or modified inputs fail and only private ZIP bytes are cleaned", async (t) => {
  const f = await fixture(t, { "source.bin": "expected bytes" });
  await rename(join(f.paths.input, "source.bin"), join(f.paths.input, "kept"));
  await writeFile(join(f.paths.input, "source.bin"), "expected bytes");
  await assert.rejects(writeArchive(f.input, f.workspace, worker), { code: "ARCHIVE_CHANGED" });
  assert.deepEqual(await readdir(f.paths.scratch), []);
  assert.equal(await readFile(join(f.paths.input, "kept"), "utf8"), "expected bytes");
});
test("writer refuses foreign scratch and symlink ancestors", async (t) => {
  const f = await fixture(t, { "nested/source.bin": "expected bytes" });
  await writeFile(join(f.paths.scratch, "foreign"), "untouched");
  await assert.rejects(writeArchive(f.input, f.workspace, worker), {
    code: "PACKAGE_STORAGE_UNAVAILABLE",
    retryable: true,
  });
  assert.equal(await readFile(join(f.paths.scratch, "foreign"), "utf8"), "untouched");
  await rm(join(f.paths.scratch, "foreign"));
  await rename(join(f.paths.input, "nested"), join(f.root, "moved"));
  await symlink(join(f.root, "moved"), join(f.paths.input, "nested"));
  await assert.rejects(writeArchive(f.input, f.workspace, worker), {
    code: "PACKAGE_STORAGE_UNAVAILABLE",
    retryable: true,
  });
  assert.equal(await readFile(join(f.root, "moved/source.bin"), "utf8"), "expected bytes");
});
test("a writer refused after opening its ZIP answers without touching freed memory", async (t) => {
  // Guard Malloc unmaps freed allocations, so a trailer flush through a destroyed callback
  // context crashes the worker every time instead of occasionally corrupting its heap.
  const guarded = (operation, params, options) => {
    const previous = process.env.DYLD_INSERT_LIBRARIES;
    process.env.DYLD_INSERT_LIBRARIES = "/usr/lib/libgmalloc.dylib";
    try {
      return worker(operation, params, options);
    } finally {
      if (previous === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
      else process.env.DYLD_INSERT_LIBRARIES = previous;
    }
  };
  const f = await fixture(t, { "nested/source.bin": "expected bytes" });
  await rename(join(f.paths.input, "nested"), join(f.root, "moved"));
  await symlink(join(f.root, "moved"), join(f.paths.input, "nested"));
  await assert.rejects(writeArchive(f.input, f.workspace, guarded), {
    code: "PACKAGE_STORAGE_UNAVAILABLE",
    retryable: true,
  });
  assert.deepEqual(await readdir(f.paths.scratch), []);
});
test("observed ZIP output limit refuses a partial archive and drains cleanup", async (t) => {
  const f = await fixture(t, { "source.bin": Buffer.alloc(1024 * 1024, 17) });
  await assert.rejects(
    writeArchive(f.input, f.workspace, worker, {
      limits: { ...archiveLimits, compressedBytes: 1024 },
    }),
    { code: "LIMIT_EXCEEDED" },
  );
  assert.deepEqual(await readdir(f.paths.scratch), []);
});

test("cancellation drains a stopped partial writer before cleaning owned ZIP bytes", async (t) => {
  const f = await fixture(t, { "source.bin": Buffer.alloc(2 * 1024 * 1024, 17) });
  const native = process.env.YAP_NATIVE ?? resolve("helpers/mac/.build/debug/yap-native");
  await withArchiveCopyBarrier(
    f.root,
    native,
    { partial: true, operation: "archive.write", minimumFd: 6 },
    async ({ worker, held, drain }) => {
      const abort = new AbortController();
      const pending = drain(writeArchive(f.input, f.workspace, worker, { signal: abort.signal }));
      const rejected = assert.rejects(pending, { code: "CANCELED" });
      const { pid } = await held;
      assert.ok((await readFile(join(f.paths.scratch, "payload.zip"))).length > 0);
      abort.abort();
      await rejected;
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
      );
      assert.deepEqual(await readdir(f.paths.scratch), []);
    },
  );
});

test("killed service cannot retire scratch while its stopped native writer survives", async (t) => {
  const f = await fixture(t, { "source.bin": Buffer.alloc(2 * 1024 * 1024, 17) });
  const binary = process.env.YAP_NATIVE ?? resolve("helpers/mac/.build/debug/yap-native");
  const library = join(f.root, "barrier.dylib"),
    marker = join(f.root, "stopped");
  execFileSync("/usr/bin/clang", [
    "-dynamiclib",
    "-o",
    library,
    fileURLToPath(new URL("../../macos/tests/fixtures/archive-copy-barrier.c", import.meta.url)),
  ]);
  const owner = fork(
    fileURLToPath(new URL("../../macos/tests/fixtures/archive-writer-owner.mjs", import.meta.url)),
    [f.root, binary, library, marker],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(() => owner.kill("SIGKILL"));
  let pid;
  const deadline = Date.now() + 5000;
  while (!pid && Date.now() < deadline) {
    pid = Number(await readFile(marker, "utf8").catch(() => ""));
    if (!pid) await delay(5);
  }
  assert.ok(pid, "Native writer reached stopped partial-copy barrier");
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  const terminal = once(owner, "close");
  owner.kill("SIGKILL");
  await terminal;
  const info = await f.handles.scratch.stat({ bigint: true });
  const params = { identity: { dev: String(info.dev), ino: String(info.ino) } };
  const options = { descriptors: [f.handles.scratch.fd] };
  const busy = await worker("archive.cleanup", params, options);
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, "INVALID_STORAGE");
  assert.ok((await readFile(join(f.paths.scratch, "payload.zip"))).length > 0);
  process.kill(pid, "SIGKILL");
  let cleared;
  for (let attempt = 0; attempt < 100; attempt++) {
    cleared = await worker("archive.cleanup", params, options);
    if (cleared.ok) break;
    await delay(5);
  }
  assert.equal(cleared.ok, true);
  assert.deepEqual(await readdir(f.paths.scratch), []);
  assert.equal((await readFile(join(f.paths.input, "source.bin"))).length, 2 * 1024 * 1024);
});
test("input mutation during streaming fails after the actual copied bytes are checked", async (t) => {
  const f = await fixture(t, { "source.bin": Buffer.alloc(2 * 1024 * 1024, 17) });
  const native = process.env.YAP_NATIVE ?? resolve("helpers/mac/.build/debug/yap-native");
  await withArchiveCopyBarrier(
    f.root,
    native,
    { partial: true, operation: "archive.write", minimumFd: 6 },
    async ({ worker, held, drain, resume }) => {
      const pending = drain(writeArchive(f.input, f.workspace, worker));
      const rejected = assert.rejects(pending, { code: "ARCHIVE_CHANGED" });
      await held;
      const file = await open(join(f.paths.input, "source.bin"), "r+");
      await file.write(Buffer.from([99]), 0, 1, 0);
      await file.close();
      await resume();
      await rejected;
      assert.deepEqual(await readdir(f.paths.scratch), []);
    },
  );
});
test("large member uses bounded native memory and produces the independently expected digest", async (t) => {
  const value = Buffer.alloc(128 * 1024 * 1024, 19);
  const f = await fixture(t, { "source.bin": value });
  const zip = await writeArchive(f.input, f.workspace, worker);
  try {
    assert.equal(zip.receipt.expandedBytes, value.length);
    assert.ok(zip.receipt.peakResidentBytes < 96 * 1024 * 1024, JSON.stringify(zip.receipt));
    assert.equal(zip.receipt.sha256, sha(await readFile(join(f.paths.scratch, "payload.zip"))));
  } finally {
    await zip.close();
  }
});

test("expected member digest is enforced independently of file identity", async (t) => {
  const f = await fixture(t, { "source.bin": "expected bytes" });
  f.members[0].sha256 = "0".repeat(64);
  await writeFile(join(f.root, "plan"), JSON.stringify(f.members));
  await assert.rejects(writeArchive(f.input, f.workspace, worker), { code: "ARCHIVE_CHANGED" });
  assert.deepEqual(await readdir(f.paths.scratch), []);
});
test("replaced scratch locator is rejected and cleanup follows only its retained descriptor", async (t) => {
  const f = await fixture(t, { "source.bin": "expected bytes" });
  const moved = join(f.root, "owned-scratch");
  const wrapped = async (operation, params, options) => {
    const result = await worker(operation, params, options);
    if (operation === "archive.write" && result.ok) {
      await rename(f.paths.scratch, moved);
      await mkdir(f.paths.scratch, { mode: 0o700 });
      await writeFile(join(f.paths.scratch, "payload.zip"), "foreign bytes");
    }
    return result;
  };
  await assert.rejects(writeArchive(f.input, f.workspace, wrapped), { code: "INVALID_STORAGE" });
  assert.equal(await readFile(join(f.paths.scratch, "payload.zip"), "utf8"), "foreign bytes");
  assert.deepEqual(await readdir(moved), []);
});
test("member names and declared counts cannot escape the bounded plan", async (t) => {
  const f = await fixture(t, { one: "1", two: "2" });
  await assert.rejects(
    writeArchive(f.input, f.workspace, worker, { limits: { ...archiveLimits, entries: 1 } }),
    { code: "LIMIT_EXCEEDED" },
  );
  f.members[0].path = "../outside";
  await writeFile(join(f.root, "plan"), JSON.stringify(f.members));
  await assert.rejects(writeArchive(f.input, f.workspace, worker), { code: "INVALID_PACKAGE" });
  assert.deepEqual(await readdir(f.paths.scratch), []);
});
