import { parseProjectPackageManifest } from "@yap/core/project-package";
import { Catalog } from "@yap/core/catalog";
import { projectArchiveContents } from "./fixtures/project-archive.mjs";
import { withArchiveCopyBarrier } from "../../macos/tests/fixtures/archive-copy-barrier.mjs";
import { admitArchive } from "../dist/archive-input.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdtemp,
  writeFile,
  open,
  readdir,
  rm,
  mkdir,
  rename,
  symlink,
  readFile,
  stat,
  realpath,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mediaWorker } from "../dist/worker.js";
import { verifyPackageArchive } from "../dist/package-archive.js";
import { archiveLimits } from "../../../packages/core/dist/package-archive.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const native = resolve(process.env.YAP_NATIVE ?? join(root, "helpers/mac/.build/debug/yap-native"));
const run = mediaWorker({ YAP_NATIVE: native });
const fixtureWriter = fileURLToPath(
  new URL("../../macos/tests/fixtures/package-archive.py", import.meta.url),
);
const results = [];

async function fixture(mode = "valid", contents) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "yap-archive-")));
  const store = new Catalog(join(home, "catalog.sqlite"));
  let generated;
  try {
    generated = await projectArchiveContents(store, home, contents);
  } finally {
    store.close();
  }
  const { files, snapshot, mediaPath } = generated;
  const directory = join(home, "workspace");
  await mkdir(directory, { mode: 0o700 });
  const workspace = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const archive = join(home, "fixture.zip");
  await writeFile(join(home, "files.json"), JSON.stringify(files));
  execFileSync(
    "/usr/bin/python3",
    [fixtureWriter, join(home, "files.json"), archive, mode, mediaPath],
    {
      stdio: "pipe",
    },
  );
  const inputHash = hash("sha256", await readFile(archive));
  return {
    home,
    directory,
    workspace,
    archive,
    input: admitArchive(archive),
    files,
    snapshot,
    mediaPath,
    async close() {
      assert.equal(hash("sha256", await readFile(archive)), inputHash);
      this.input.close();
      await workspace.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
async function inspect(f, options = {}, worker = run) {
  try {
    return await verifyPackageArchive(f.input, f.workspace, worker, {
      ...options,
      validate: parseProjectPackageManifest,
      inlineRevisions: false,
    });
  } finally {
    assert.deepEqual(await readdir(f.directory), []);
  }
}

test("native archive verifies inventory and pinned project revision with admitted history, then empties workspace", async () => {
  const f = await fixture();
  try {
    const receipt = await inspect(f);
    assert.equal(receipt.manifest.project.currentRevisionId, f.snapshot.project.currentRevisionId);
    assert.deepEqual(
      receipt.manifest.revisions,
      f.snapshot.revisions.map((revision) => `revisions/${revision.ordinal}.json`),
    );
    assert.equal(
      receipt.expandedBytes,
      Object.values(f.files).reduce((sum, value) => sum + Buffer.byteLength(value), 0),
    );
    assert.equal(receipt.archiveSha256, hash("sha256", await readFile(f.archive)));
    results.push({ case: "valid", ...receipt, manifest: undefined });
  } finally {
    await f.close();
  }
});

for (const mode of [
  "extra",
  "bad-central",
  "bad-local",
  "undercount",
  "undercount-bad",
  "crc",
  "hash",
  "mac",
  "duplicate",
  "case",
  "directory",
  "file-directory",
  "symlink",
  "fifo",
  "absolute",
  "parent",
  "backslash",
  "nul",
  "nul-empty",
  "unicode-duplicate",
  "unicode-parent",
  "encrypted",
  "size-lie",
]) {
  test(`hostile ${mode} fails with no remaining extracted files`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(inspect(f), (error) =>
        ["INVALID_PACKAGE", "LIMIT_EXCEEDED"].includes(error.code),
      );
    } finally {
      await f.close();
    }
    results.push({ case: mode, rejected: true });
  });
}

test("safe parser Unicode alias is inventoried by effective ASCII name", async () => {
  const f = await fixture("unicode-alias");
  try {
    assert.equal((await inspect(f)).memberCount, Object.keys(f.files).length);
  } finally {
    await f.close();
  }
});

test("actual expansion, member, manifest and entry counts enforce exact bounds", async () => {
  const f = await fixture("deflate");
  try {
    const actual = await inspect(f);
    const constraints = {
      expandedBytes: actual.expandedBytes,
      memberBytes: Math.max(...Object.values(f.files).map((v) => Buffer.byteLength(v))),
      manifestBytes: Buffer.byteLength(f.files["manifest.json"]),
      entries: Object.keys(f.files).length,
      compressedBytes: (await stat(f.archive)).size,
      history: 2,
      pathBytes: Math.max(...Object.keys(f.files).map((p) => p.length)),
      componentBytes: Math.max(
        ...Object.keys(f.files).flatMap((p) => p.split("/").map((part) => part.length)),
      ),
      depth: 2,
    };
    for (const [key, value] of Object.entries(constraints)) {
      await inspect(f, { limits: { ...archiveLimits, [key]: value } });
      await assert.rejects(
        inspect(f, { limits: { ...archiveLimits, [key]: value - 1 } }),
        (error) => error.code === (key === "history" ? "INVALID_PACKAGE" : "LIMIT_EXCEEDED"),
        key,
      );
    }
    results.push({ case: "exact-limits", constraints });
  } finally {
    await f.close();
  }
});

for (const mode of ["metadata-many", "metadata-large", "metadata-default"])
  test(`initial parser input budget rejects ${mode} before unbounded metadata intake`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(
        inspect(f, {
          limits: {
            ...archiveLimits,
            initialReadBytes: mode === "metadata-default" ? archiveLimits.initialReadBytes : 8192,
          },
        }),
        (error) => {
          assert.equal(error.code, "LIMIT_EXCEEDED");
          assert.ok(
            error.details.peakResidentBytes > 0 &&
              error.details.peakResidentBytes < 192 * 1024 ** 2,
          );
          results.push({
            case: mode,
            peakResidentBytes: error.details.peakResidentBytes,
            error: error.message,
          });
          return true;
        },
      );
    } finally {
      await f.close();
    }
  });

test("retained workspace descriptor survives ancestor replacement without touching external sentinel", async () => {
  const f = await fixture();
  const retained = join(f.home, "retained"),
    outside = join(f.home, "outside");
  try {
    await rename(f.directory, retained);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "untouched");
    await symlink(outside, f.directory);
    const receipt = await verifyPackageArchive(f.input, f.workspace, run, {
      validate: parseProjectPackageManifest,
      inlineRevisions: false,
    });
    assert.equal(receipt.manifest.project.currentRevisionId, f.snapshot.project.currentRevisionId);
    assert.deepEqual(await readdir(retained), []);
    assert.deepEqual(await readdir(outside), ["sentinel"]);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched");
  } finally {
    await f.close();
  }
});

test("nonempty workspace admission preserves existing files", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "sentinel"), "untouched");
    await assert.rejects(
      verifyPackageArchive(f.input, f.workspace, run, {
        validate: parseProjectPackageManifest,
        inlineRevisions: false,
      }),
      (error) => error.code === "INVALID_STORAGE",
    );
    assert.equal(await readFile(join(f.directory, "sentinel"), "utf8"), "untouched");
  } finally {
    await f.close();
  }
});

function pauseParserAt(path, action) {
  return async (operation, params, options) => {
    const pending = run(operation, params, { ...options, timeoutMs: 5000 });
    if (operation !== "archive.extract") return pending;
    let done = false;
    void pending.then(() => {
      done = true;
    });
    try {
      const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
      }).split("\n");
      const match = rows
        .map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
        .find((row) => row && Number(row[2]) === process.pid && row[3] === native);
      assert.ok(match, "Owned native worker must exist before the file barrier");
      const pid = Number(match[1]);
      while (!done) {
        const created = await stat(path).then(
          () => true,
          () => false,
        );
        if (created) {
          process.kill(pid, "SIGSTOP");
          let actionFailure;
          try {
            await action(pid);
          } catch (error) {
            actionFailure = error;
          }
          try {
            process.kill(pid, "SIGCONT");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          if (actionFailure) throw actionFailure;
          return await pending;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error("Parser exited before the controlled live-worker barrier");
    } finally {
      await pending;
    }
  };
}

test("killed stopped parser is reaped before cleanup through parent-retained root FD", async () => {
  const f = await fixture("valid", ["x".repeat(32 * 1024 * 1024)]);
  const controller = new AbortController();
  let stopped;
  const wrapped = pauseParserAt(join(f.directory, ".input"), (pid) => {
    stopped = pid;
    controller.abort();
  });
  try {
    await assert.rejects(
      inspect(f, { signal: controller.signal }, wrapped),
      (error) => error.code === "CANCELED",
    );
    assert.ok(stopped, "actual owned native parser must be observed live");
    assert.throws(
      () => process.kill(stopped, 0),
      (error) => error.code === "ESRCH",
    );
    results.push({ case: "forced-kill-cleanup", parserPid: stopped, reaped: true });
  } finally {
    await f.close();
  }
});

test("inner directory replacement fails without following its symlink outside workspace", async () => {
  const f = await fixture("deflate", ["x".repeat(64 * 1024 * 1024), "following source"]);
  const outside = join(f.home, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "untouched");
  let stopped;
  const extracted = join(f.directory, "content", f.mediaPath);
  const wrapped = pauseParserAt(extracted, async (pid) => {
    stopped = pid;
    await rename(dirname(extracted), join(f.directory, "content/retained-media"));
    await symlink(outside, dirname(extracted));
  });
  try {
    let failure;
    try {
      await inspect(f, {}, wrapped);
    } catch (error) {
      failure = error;
    }
    assert.deepEqual(await readdir(outside), ["sentinel"]);
    assert.equal(failure?.code, "INVALID_STORAGE");
    assert.ok(stopped, "actual parser must be paused at member traversal");
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched");
    assert.throws(
      () => process.kill(stopped, 0),
      (error) => error.code === "ESRCH",
    );
    results.push({
      case: "inner-replacement",
      parserPid: stopped,
      externalSentinelUntouched: true,
    });
  } finally {
    await f.close();
  }
});

test("opened input descriptor retains source bytes across pathname replacement", async () => {
  const f = await fixture("valid", ["x".repeat(32 * 1024 * 1024)]);
  const pinned = join(f.home, "pinned.zip");
  const originalHash = hash("sha256", await readFile(f.archive));
  let replaced = false;
  const wrapped = async (operation, params, options) => {
    if (operation === "archive.extract") {
      await rename(f.archive, pinned);
      await writeFile(f.archive, "foreign replacement");
      replaced = true;
    }
    return run(operation, params, options);
  };
  try {
    assert.equal((await inspect(f, {}, wrapped)).archiveSha256, originalHash);
    assert.equal(await readFile(f.archive, "utf8"), "foreign replacement");
  } finally {
    if (replaced) {
      await rm(f.archive);
      await rename(pinned, f.archive);
    }
    await f.close();
  }
});

test("admission rejects changed input before copy and preserves independent descriptor reads", async () => {
  const f = await fixture();
  const original = await readFile(f.archive);
  try {
    const first = await inspect(f);
    const second = await inspect(f);
    assert.equal(first.archiveSha256, hash("sha256", original));
    assert.equal(second.archiveSha256, first.archiveSha256);
    assert.equal(second.copiedBytes, original.length);
    await writeFile(f.archive, Buffer.concat([original, Buffer.from("changed")]));
    await assert.rejects(inspect(f), { code: "ARCHIVE_CHANGED" });
  } finally {
    await writeFile(f.archive, original);
    await f.close();
  }
});

test("copy rejects an in-place input change at a confirmed syscall barrier", async () => {
  const f = await fixture();
  let original;
  try {
    original = await readFile(f.archive);
    await withArchiveCopyBarrier(f.home, native, {}, async ({ worker, held, resume, drain }) => {
      const rejected = drain(assert.rejects(inspect(f, {}, worker), { code: "ARCHIVE_CHANGED" }));
      await held;
      assert.equal(
        (await stat(join(f.directory, ".input"))).size,
        0,
        "First source chunk is held before its snapshot write",
      );
      const file = await open(f.archive, "r+");
      try {
        await file.write(Buffer.from("!"), 0, 1, original.length);
      } finally {
        await file.close();
      }
      await resume();
      await rejected;
    });
  } finally {
    if (original) await writeFile(f.archive, original);
    await f.close();
  }
});

test("partial copy barrier cancels after actual snapshot bytes and drains the native worker", async () => {
  const f = await fixture("valid", ["generated".repeat(32_768)]);
  try {
    const controller = new AbortController();
    await withArchiveCopyBarrier(
      f.home,
      native,
      { partial: true },
      async ({ worker, held, resume, drain }) => {
        const canceled = drain(
          assert.rejects(inspect(f, { signal: controller.signal }, worker), {
            code: "CANCELED",
          }),
        );
        await held;
        const copied = (await stat(join(f.directory, ".input"))).size;
        assert.ok(
          copied > 0 && copied < (await stat(f.archive)).size,
          "Barrier must expose a real partial snapshot",
        );
        controller.abort();
        await canceled;
        await resume();
      },
    );
  } finally {
    await f.close();
  }
});

test("copy barrier callback failure drains inspection cleanup before fixture removal", async () => {
  const f = await fixture();
  let pid;
  try {
    await assert.rejects(
      withArchiveCopyBarrier(f.home, native, {}, async ({ worker, held, drain }) => {
        drain(inspect(f, {}, worker));
        ({ pid } = await held);
        throw new Error("generated callback failure");
      }),
      /generated callback failure/,
    );
    assert.deepEqual(await readdir(f.directory), []);
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === "ESRCH",
    );
  } finally {
    await f.close();
  }
});

test("copy barrier reports preparation failure instead of leaving its wait pending", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      withArchiveCopyBarrier(
        f.home,
        join(f.home, "missing-native"),
        {},
        async ({ worker, held, drain }) => {
          drain(inspect(f, {}, worker));
          await held;
        },
      ),
      { code: "MEDIA_WORKER_NOT_RUNNABLE" },
    );
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    await f.close();
  }
});

test("workspace lock survives preparation worker exit and refuses a second open owner", async () => {
  const f = await fixture();
  const other = await open(
    f.directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await inspect(f);
    await assert.rejects(
      verifyPackageArchive(f.input, other, run, {
        validate: parseProjectPackageManifest,
        inlineRevisions: false,
      }),
      (error) => error.code === "INVALID_STORAGE",
    );
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    await other.close();
    await f.close();
  }
});

test("cleanup ownership loss is explicit and original descriptor supports recovery", async () => {
  const f = await fixture();
  const wrapped = async (operation, params, options) => {
    const result = await run(operation, params, options);
    if (operation === "archive.extract") await chmod(f.directory, 0o500);
    return result;
  };
  try {
    await assert.rejects(
      verifyPackageArchive(f.input, f.workspace, wrapped, {
        validate: parseProjectPackageManifest,
        inlineRevisions: false,
      }),
      (error) => error.code === "ARCHIVE_CLEANUP_FAILED",
    );
    assert.ok((await readdir(f.directory)).length > 0);
    await chmod(f.directory, 0o700);
    const info = await f.workspace.stat({ bigint: true });
    assert.deepEqual(
      (
        await run(
          "archive.cleanup",
          { identity: { dev: String(info.dev), ino: String(info.ino) } },
          { descriptors: [f.workspace.fd] },
        )
      ).data,
      { removed: true },
    );
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    await chmod(f.directory, 0o700);
    await f.close();
  }
});

test("bounded receipt rejects metadata that cannot fit the existing transport", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      inspect(f, { limits: { ...archiveLimits, receiptBytes: 1000 } }),
      (error) => error.code === "LIMIT_EXCEEDED",
    );
  } finally {
    await f.close();
  }
});

test("native file-size fault leaves workspace empty after worker termination", async () => {
  const f = await fixture();
  try {
    const wrapper = join(f.home, "limited-native");
    await writeFile(wrapper, `#!/bin/sh\nulimit -f 1\nexec '${native}'\n`);
    await chmod(wrapper, 0o700);
    await assert.rejects(inspect(f, {}, mediaWorker({ YAP_NATIVE: wrapper })), (error) =>
      ["MEDIA_WORKER_FAILED", "INVALID_STORAGE"].includes(error.code),
    );
  } finally {
    await f.close();
  }
});

process.on("exit", () => {
  if (process.env.YAP_ARCHIVE_EVIDENCE)
    execFileSync(process.execPath, [
      "-e",
      'require("node:fs").writeFileSync(process.argv[1],process.argv[2])',
      process.env.YAP_ARCHIVE_EVIDENCE,
      JSON.stringify(
        {
          scope:
            "Generated archive container/manifest validation; payloads are not media or accepted evidence",
          results,
        },
        null,
        2,
      ),
    ]);
});
