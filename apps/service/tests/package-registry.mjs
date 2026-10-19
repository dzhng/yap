import { projectArchiveContents } from "./fixtures/project-archive.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, readSync, fstatSync } from "node:fs";
import {
  mkdtemp,
  realpath,
  mkdir,
  open,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  chmod,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { CaptureStore } from "../../../packages/core/dist/capture-store.js";
import { parseProjectPackageManifest } from "../../../packages/core/dist/project-package.js";
import { resolveProjectPackageMetadata } from "../dist/project-package-metadata.js";
import { readMediaProbe } from "../dist/media-probe.js";
import { JobQueue } from "../../../packages/core/dist/jobs.js";
import { archiveLimits } from "../../../packages/core/dist/package-archive.js";
import { PackageRegistry } from "../dist/package-registry.js";
import { DerivativeDelivery } from "../dist/delivery.js";
import { mediaWorker } from "../dist/worker.js";

const native = process.env.YAP_NATIVE;
assert.ok(native, "YAP_NATIVE must select the built native executable");
const worker = mediaWorker({ YAP_NATIVE: native });
async function fixture(t, options = {}, content = "generated source") {
  const home = await realpath(await mkdtemp("/tmp/yap-registry-"));
  const directory = join(home, "packages");
  await mkdir(directory, { mode: 0o700 });
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const store = new CaptureStore(join(home, "library.sqlite"), {
    now: () => "fixture",
    newId: randomUUID,
  });
  const jobs = new JobQueue({
    store,
    targets: {
      pin(target) {
        assert.equal(target.kind, "recording");
        assert.equal(target.revisionId, null);
        assert.equal(store.isAvailable(target.id), true);
        return target;
      },
      isAvailable: (target) => store.isAvailable(target.id),
      isDeleting: (owner) =>
        owner.kind === "recording"
          ? store.isDeleting(owner.id)
          : owner.kind === "project" && projects.isDeleting(owner.id),
      isCapturing: () => store.isCapturing(),
    },
    providers: { newId: randomUUID },
    execute: async () => "library",
  });
  const delivery = new DerivativeDelivery();
  const registry = new PackageRegistry({
    validate: parseProjectPackageManifest,
    resolve: resolveProjectPackageMetadata,
    inlineRevisions: false,
    parent: { directory, handle },
    jobs,
    delivery,
    worker,
    limits: { ...archiveLimits, expandedBytes: 1024 ** 2 },
    ...options,
  });
  t.after(async () => {
    await registry.dispose();
    await jobs.close();
    delivery.dispose();
    store.close();
    await handle.close();
    await rm(home, { recursive: true, force: true });
  });
  const { assets, acquisitions, projects, snapshot, asset, mediaPath, files } =
    await projectArchiveContents(store, home, [content]);
  const input = join(home, "input.zip");
  async function writeArchive() {
    await writeFile(join(home, "files.json"), JSON.stringify(files));
    execFileSync("/usr/bin/python3", [
      fileURLToPath(new URL("../../macos/tests/fixtures/package-archive.py", import.meta.url)),
      join(home, "files.json"),
      input,
      "valid",
      mediaPath,
    ]);
  }
  await writeArchive();
  return {
    home,
    directory,
    handle,
    store,
    assets,
    acquisitions,
    projects,
    snapshot,
    asset,
    mediaPath,
    jobs,
    delivery,
    registry,
    input,
    files,
    writeArchive,
  };
}
async function waitFor(read, predicate) {
  const deadline = Date.now() + 5000;
  let value;
  while (Date.now() < deadline) {
    value = read();
    if (predicate(value)) return value;
    await setTimeout(1);
  }
  assert.fail(`State did not settle: ${JSON.stringify(value)}`);
}
const ready = (f, id) =>
  waitFor(
    () => f.registry.status(id),
    (value) => value.state === "ready" || ["failed", "cleanup_failed"].includes(value.state),
  ).then((value) => {
    assert.equal(value.state, "ready", JSON.stringify(value));
    return value.packageHandle;
  });

test("registry reserves before extraction, charges copied bytes, and closes without changing authored library state", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.registry.open(f.input), { code: "PROCESSING_BUSY" });
  await f.registry.recover();
  const bytes = (await stat(f.input)).size;
  const admission = await f.registry.open(f.input);
  assert.equal(admission.packageHandle, null);
  assert.equal(f.registry.usage().budgetBytes, bytes + 1024 ** 2);
  const handle = await ready(f, admission.id),
    context = f.registry.lookup(handle);
  const expanded = Object.values(f.files).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  assert.deepEqual(context.archiveUsage, { copiedBytes: bytes, expandedBytes: expanded });
  assert.equal(f.registry.usage().budgetBytes, bytes + expanded);
  assert.equal(f.registry.usage().confirmedBytes, bytes + expanded);
  assert.equal(f.store.catalog.prepare("SELECT COUNT(*) AS n FROM recordings").get().n, 0);
  assert.deepEqual(context.manifest.snapshot, f.snapshot);
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.projects.snapshot(f.snapshot.project.id))),
    f.snapshot,
  );
  assert.deepEqual(f.assets.get(f.asset.id), f.asset);
  await f.registry.close(admission.id);
  assert.equal(f.registry.status(admission.id).state, "closed");
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.registry.usage().budgetBytes, 0);
  assert.throws(() => f.registry.lookup(handle), { code: "CONTEXT_CLOSED" });
  assert.throws(() => context.files.open(f.mediaPath), { code: "CONTEXT_CLOSED" });
  await f.registry.close(admission.id);
  await f.registry.dispose();
  await assert.rejects(f.registry.open(f.input), { code: "OWNER_CLOSED" });
  await assert.rejects(f.registry.recover(), { code: "OWNER_CLOSED" });
});

test("64 GiB admission pool admits two exact-bound sparse reservations, refuses a third and releases canceled work", async (t) => {
  const f = await fixture(t, { limits: archiveLimits });
  await f.registry.recover();
  f.store.allocate(); // An unsettled generated take keeps the shared heavy lane paused.
  await truncate(f.input, 16 * 1024 ** 3);
  const first = await f.registry.open(f.input);
  assert.equal(f.registry.status(first.id).state, "queued");
  assert.equal(f.registry.usage().budgetBytes, 32 * 1024 ** 3);
  const second = await f.registry.open(f.input);
  assert.equal(f.registry.status(second.id).state, "queued");
  assert.equal(f.registry.usage().budgetBytes, 64 * 1024 ** 3);
  await assert.rejects(f.registry.open(f.input), { code: "CAPACITY_EXCEEDED" });
  assert.equal(f.registry.usage().owners, 2);
  assert.deepEqual(await readdir(f.directory), []);
  await f.registry.close(first.id);
  assert.equal(f.registry.status(first.id).state, "canceled");
  assert.equal(f.registry.usage().budgetBytes, 32 * 1024 ** 3);
  await f.registry.close(second.id);
  assert.equal(f.registry.status(second.id).state, "canceled");
  assert.equal(f.registry.usage().budgetBytes, 0);
  const later = await f.registry.open(f.input);
  await f.registry.close(later.id);
});

test("four same-content resource owners stay independent and failed close retains its slot and charge", async (t) => {
  const f = await fixture(t);
  await f.registry.recover();
  const admissions = await Promise.all(Array.from({ length: 4 }, () => f.registry.open(f.input)));
  const handles = await Promise.all(admissions.map((value) => ready(f, value.id)));
  assert.equal(new Set(handles).size, 4);
  const before = f.registry.usage();
  await assert.rejects(f.registry.open(f.input), { code: "CAPACITY_EXCEEDED" });
  const directory = join(f.directory, admissions[0].id);
  await chmod(directory, 0o500);
  try {
    const closing = f.registry.close(admissions[0].id);
    assert.equal(f.registry.close(admissions[0].id), closing);
    assert.throws(() => f.registry.lookup(handles[0]), { code: "CONTEXT_CLOSED" });
    await assert.rejects(closing, { code: "ARCHIVE_CLEANUP_FAILED" });
    assert.equal(f.registry.status(admissions[0].id).state, "cleanup_failed");
    assert.equal(f.registry.usage().owners, 4);
    assert.equal(f.registry.usage().budgetBytes, before.budgetBytes);
    await assert.rejects(f.registry.open(f.input), { code: "CAPACITY_EXCEEDED" });
    const sibling = f.registry.lookup(handles[1]).files.open(f.mediaPath);
    assert.ok(sibling.fd >= 0);
    sibling.close();
  } finally {
    await chmod(directory, 0o700);
  }
  await f.registry.close(admissions[0].id);
  assert.equal(f.registry.usage().owners, 3);
  assert.equal(f.registry.usage().budgetBytes, (before.budgetBytes * 3) / 4);
  const replacement = await f.registry.open(f.input);
  const replacementHandle = await ready(f, replacement.id);
  assert.notEqual(replacementHandle, handles[0]);
  assert.throws(() => f.registry.lookup(handles[0]), { code: "CONTEXT_CLOSED" });
});

test("bounded terminal receipts expire without resurrection", async (t) => {
  const f = await fixture(t);
  await f.registry.recover();
  const initial = await f.registry.open(f.input),
    handle = await ready(f, initial.id);
  await f.registry.close(initial.id);
  for (let i = 0; i < 32; i++) {
    const admission = await f.registry.open(f.input);
    await ready(f, admission.id);
    await f.registry.close(admission.id);
  }
  assert.equal(f.registry.usage().terminalReceipts, 32);
  assert.throws(() => f.registry.status(initial.id), { code: "NOT_FOUND" });
  assert.throws(() => f.registry.lookup(handle), { code: "CONTEXT_CLOSED" });
  await assert.rejects(f.registry.close(initial.id), { code: "NOT_FOUND" });
  assert.equal(f.registry.usage().owners, 0);
});

test("failed validation cleans up, while an unconfirmed nonempty creation keeps its reservation until explicit retry", async (t) => {
  const f = await fixture(t);
  await f.registry.recover();
  await writeFile(f.input, "not a ZIP");
  const invalid = await f.registry.open(f.input);
  await waitFor(
    () => f.registry.status(invalid.id),
    (value) => value.state === "failed",
  );
  assert.equal(f.registry.status(invalid.id).packageHandle, null);
  assert.equal(f.registry.usage().budgetBytes, 0);
  assert.deepEqual(await readdir(f.directory), []);
  let foreign;
  const g = await fixture(t, {
    worker: async (operation, params, options) => {
      const receipt = await worker(operation, params, options);
      if (operation === "packageWorkspace.create" && receipt.ok) {
        foreign = join(g.directory, params.name, "foreign");
        await writeFile(foreign, "preserve");
        return {
          ok: false,
          error: {
            code: "LOST_REPLY",
            message: "Creation reply lost",
            retryable: true,
            details: {},
          },
        };
      }
      return receipt;
    },
  });
  await g.registry.recover();
  const lost = await g.registry.open(g.input),
    budget = g.registry.usage().budgetBytes;
  await waitFor(
    () => g.registry.status(lost.id),
    (value) => value.state === "cleanup_failed",
  );
  assert.equal(g.registry.usage().budgetBytes, budget);
  assert.equal(g.registry.status(lost.id).packageHandle, null);
  assert.equal(await readFile(foreign, "utf8"), "preserve");
  await rm(foreign);
  await g.registry.close(lost.id);
  assert.equal(g.registry.status(lost.id).state, "failed");
  assert.equal(g.registry.usage().budgetBytes, 0);
  assert.deepEqual(await readdir(g.directory), []);
});

test("same-provenance project deletion and package close revoke only their own delivery namespaces", async (t) => {
  const [
    { DerivedCache },
    { SceneEvidenceStore, assetSceneOwner },
    { ScreenshotIndexStore },
    { projectIndexDomain },
    { projectComposition },
    { selectSource },
    { LibraryDeletion },
    { projectRetirement },
    { DeletionPlans },
    { ManagedFiles },
  ] = await Promise.all([
    import("../../../packages/core/dist/cache.js"),
    import("../../../packages/core/dist/scene-evidence.js"),
    import("../../../packages/core/dist/screenshot-index.js"),
    import("../../../packages/core/dist/project-index.js"),
    import("../../../packages/core/dist/project-window.js"),
    import("../../../packages/core/dist/source-selection.js"),
    import("../dist/library-deletion.js"),
    import("../dist/project-retirement.js"),
    import("../../../packages/core/dist/deletion-plans.js"),
    import("../dist/managed-files.js"),
  ]);
  const f = await fixture(t),
    projectId = f.snapshot.project.id;
  const acquisitions = f.acquisitions;
  const scenes = new SceneEvidenceStore(f.store, assetSceneOwner(f.assets, acquisitions));
  const index = new ScreenshotIndexStore(
    f.store,
    f.home,
    projectIndexDomain(
      {
        composition: (identity) => projectComposition(f.projects, f.assets, identity),
        source: (selection) => selectSource(f.assets, acquisitions, selection),
        scenes,
        isDeleting: (id) => f.projects.isDeleting(id),
      },
      { implementationId: "registry-deletion" },
    ),
  );
  const cache = new DerivedCache(f.store, f.home, (owner) => {
    assert.equal(owner.kind, "project");
    f.projects.get(owner.id);
  });
  await cache.reconcile();
  // No exports exist; export retirement is the external edge, not a simulated project deletion.
  const deletion = new LibraryDeletion(new DeletionPlans(f.store));
  deletion.register(
    projectRetirement({
      catalog: f.store,
      store: f.projects,
      jobs: f.jobs,
      cache,
      files: new ManagedFiles(f.home, worker),
      delivery: f.delivery,
      exports: { retireOwner: async () => {} },
      index,
      freedBytes: () => 0,
    }),
  );
  try {
    await f.registry.recover();
    const a = await f.registry.open(f.input),
      b = await f.registry.open(f.input);
    const first = await ready(f, a.id),
      second = await ready(f, b.id);
    const lease = (handle) => {
      const file = f.registry.lookup(handle).files.open(f.mediaPath);
      return {
        bytes: fstatSync(file.fd).size,
        read: (buffer, position) => readSync(file.fd, buffer, 0, buffer.length, position),
        release: () => file.close(),
      };
    };
    const target = f.delivery.open({ kind: "package", id: first }, () => lease(first));
    const sibling = f.delivery.open({ kind: "package", id: second }, () => lease(second));
    const library = f.delivery.open({ kind: "project", id: projectId }, () => lease(first));
    assert.deepEqual(f.registry.lookup(first).manifest.snapshot, f.snapshot);
    await deletion.delete({ kind: "project", id: projectId });
    assert.throws(() => f.projects.get(projectId), { code: "NOT_FOUND" });
    assert.deepEqual(f.assets.get(f.asset.id), f.asset);
    assert.throws(() => f.delivery.read(library.token, 0, 20), { code: "ARTIFACT_EXPIRED" });
    assert.equal(
      Buffer.from(f.delivery.read(target.token, 0, 20).data, "base64").toString(),
      "generated source",
    );
    await f.registry.close(a.id);
    assert.throws(() => f.delivery.read(target.token, 0, 20), { code: "ARTIFACT_EXPIRED" });
    assert.equal(
      Buffer.from(f.delivery.read(sibling.token, 0, 20).data, "base64").toString(),
      "generated source",
    );
    assert.deepEqual(f.registry.lookup(second).manifest.snapshot, f.snapshot);
  } finally {
    await deletion.close();
  }
});

test("startup remains blocked by a killed owner's actual native child while library jobs continue", async (t) => {
  const { withOrphanedPackageWorkspace } =
    await import("./fixtures/orphaned-package-workspace.mjs");
  const f = await fixture(t);
  await withOrphanedPackageWorkspace(f.directory, native, async ({ pid, name, finishChild }) => {
    await assert.rejects(f.registry.recover(), { code: "RECOVERY_BUSY", retryable: true });
    assert.equal(f.registry.usage().state, "recovery");
    await assert.rejects(f.registry.open(f.input), { code: "PROCESSING_BUSY" });
    assert.equal(
      await readFile(join(f.directory, name, "data"), "utf8"),
      "held by inherited native descriptor",
    );
    const recording = f.store.allocate().recording;
    for (const [i, state] of ["recording", "finalizing", "complete"].entries())
      f.store.ingestLifecycle(recording.id, {
        sourceId: recording.sourceId,
        sequence: i + 1,
        state,
        sourceDurationUs: 100,
      });
    const job = f.jobs.submit({
      target: { kind: "recording", id: recording.id, revisionId: null },
      artifact: "library",
      lane: "heavy",
      input: "{}",
    });
    assert.equal(
      (
        await waitFor(
          () => f.jobs.job(job.jobId),
          (value) => value.state === "ready",
        )
      ).state,
      "ready",
    );
    await finishChild();
    t.diagnostic(
      `Orphaned native child ${pid}: observed stopped, continued, then OS absent before recovery`,
    );
    await f.registry.recover();
    assert.equal(f.registry.usage().state, "ready");
    assert.deepEqual(await readdir(f.directory), []);
    const admission = await f.registry.open(f.input);
    await ready(f, admission.id);
  });
});

test("close fences delivery and drains an actual native media worker before removing its directory", async (t) => {
  let marker,
    library,
    directory,
    workerClosed = false,
    nativeStarted = false;
  const wrapped = async (operation, params, options) => {
    if (nativeStarted && ["archive.cleanup", "packageWorkspace.remove"].includes(operation))
      assert.equal(workerClosed, true, "Directory cleanup must follow actual worker closure");
    if (operation !== "media.probe") return worker(operation, params, options);
    const previousLibrary = process.env.DYLD_INSERT_LIBRARIES,
      previousMarker = process.env.YAP_TEST_NATIVE_HELD;
    process.env.DYLD_INSERT_LIBRARIES = library;
    process.env.YAP_TEST_NATIVE_HELD = marker;
    let pending;
    try {
      pending = worker(operation, params, { ...options, timeoutMs: 5000 });
      nativeStarted = true;
    } finally {
      if (previousLibrary === undefined) delete process.env.DYLD_INSERT_LIBRARIES;
      else process.env.DYLD_INSERT_LIBRARIES = previousLibrary;
      if (previousMarker === undefined) delete process.env.YAP_TEST_NATIVE_HELD;
      else process.env.YAP_TEST_NATIVE_HELD = previousMarker;
    }
    const result = await pending;
    assert.ok(
      (await stat(directory)).isDirectory(),
      "Directory remains until worker pipe closure is observed",
    );
    workerClosed = true;
    return result;
  };
  const f = await fixture(t, { worker: wrapped });
  marker = join(f.home, "native-held");
  library = join(f.home, "native-held.dylib");
  execFileSync("/usr/bin/clang", [
    "-dynamiclib",
    "-o",
    library,
    fileURLToPath(new URL("./fixtures/native-start-barrier.c", import.meta.url)),
  ]);
  await f.registry.recover();
  const admission = await f.registry.open(f.input),
    handle = await ready(f, admission.id);
  directory = join(f.directory, admission.id);
  const file = f.registry.lookup(handle).files.open(f.mediaPath);
  const delivery = f.delivery.open({ kind: "package", id: handle }, () => ({
    bytes: fstatSync(file.fd).size,
    read: (buffer, position) => readSync(file.fd, buffer, 0, buffer.length, position),
    release: () => file.close(),
  }));
  f.registry.submit(
    handle,
    { artifact: "held-native", lane: "heavy", input: "{}" },
    async (context, signal, { lifetime }) => {
      const source = context.files.open(f.mediaPath);
      try {
        return JSON.stringify(
          await readMediaProbe(wrapped, directory, "/dev/fd/4", signal, [lifetime.fd, source.fd]),
        );
      } finally {
        source.close();
      }
    },
  );
  let pid;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await readFile(marker, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      if (value) {
        pid = Number(value);
        break;
      }
      await setTimeout(1);
    }
    assert.ok(pid, "Actual native media worker must report its inherited descriptors");
    assert.equal(
      execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid=,command="], {
        encoding: "utf8",
      }).trim(),
      `${process.pid} ${native}`,
    );
    await waitFor(
      () =>
        execFileSync("/bin/ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" }).trim(),
      (value) => value.startsWith("T"),
    );
    const inherited = execFileSync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(pid), "-d", "3,4", "-F", "fi"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    assert.deepEqual(
      inherited.slice(1),
      [
        "f3",
        `i${(await stat(directory, { bigint: true })).ino}`,
        "f4",
        `i${fstatSync(file.fd, { bigint: true }).ino}`,
      ],
      "Native worker inherits its actual workspace and source descriptors",
    );
    const closing = f.registry.close(admission.id);
    assert.throws(() => f.registry.lookup(handle), { code: "CONTEXT_CLOSED" });
    assert.equal(
      Buffer.from(f.delivery.read(delivery.token, 0, 20).data, "base64").toString(),
      "generated source",
    );
    await closing;
    assert.equal(workerClosed, true);
    t.diagnostic(
      `Native child ${pid}: stopped before dispatch, awaited worker closure before cleanup`,
    );
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === "ESRCH",
    );
    assert.throws(() => f.delivery.read(delivery.token, 0, 20), { code: "ARTIFACT_EXPIRED" });
    assert.equal(f.registry.usage().budgetBytes, 0);
    assert.deepEqual(await readdir(f.directory), []);
  } finally {
    await f.registry.close(admission.id);
  }
});

test("correctly hashed malformed project resource metadata fails before readiness and releases its owner", async (t) => {
  const f = await fixture(t);
  const manifest = JSON.parse(f.files["manifest.json"]);
  const reference = manifest.resources[0].metadata;
  const resource = JSON.parse(f.files[reference.path]);
  resource.asset.streams[0].width = "invalid";
  const body = JSON.stringify(resource);
  f.files[reference.path] = body;
  reference.bytes = Buffer.byteLength(body);
  reference.sha256 = createHash("sha256").update(body).digest("hex");
  Object.assign(
    manifest.inventory.find((member) => member.path === reference.path),
    reference,
  );
  f.files["manifest.json"] = JSON.stringify(manifest);
  // Structural admission and exact hashes succeed; the canonical typed resource owner refuses.
  assert.equal(
    parseProjectPackageManifest(f.files["manifest.json"], archiveLimits).format,
    "yap-project",
  );
  await f.writeArchive();
  await f.registry.recover();
  const admission = await f.registry.open(f.input);
  const result = await waitFor(
    () => f.registry.status(admission.id),
    (value) => value.state === "failed",
  );
  assert.equal(result.packageHandle, null);
  assert.equal(result.error, "Invalid portable resource metadata identity or schema");
  await waitFor(
    () => f.registry.usage(),
    (value) => value.owners === 0,
  );
  assert.equal(f.registry.usage().budgetBytes, 0);
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.projects.snapshot(f.snapshot.project.id))),
    f.snapshot,
  );
});

test("default peak reservations block a fourth pending open but validated steady bytes allow it", async (t) => {
  const f = await fixture(t, { limits: archiveLimits });
  await f.registry.recover();
  const capture = f.store.allocate().recording;
  const admissions = [];
  for (let i = 0; i < 3; i++) admissions.push(await f.registry.open(f.input));
  assert.equal(f.registry.usage().budgetBytes, 3 * ((await stat(f.input)).size + 16 * 1024 ** 3));
  await assert.rejects(f.registry.open(f.input), { code: "CAPACITY_EXCEEDED" });
  f.store.ingestLifecycle(capture.id, {
    sourceId: capture.sourceId,
    sequence: 1,
    state: "canceled",
  });
  f.jobs.schedule();
  await Promise.all(admissions.map((value) => ready(f, value.id)));
  const fourth = await f.registry.open(f.input);
  await ready(f, fourth.id);
  assert.equal(f.registry.usage().owners, 4);
  assert.ok(f.registry.usage().budgetBytes < 1024 ** 3);
});

test("partial copy cancellation drains the actual worker before returning reservation and removing its tree", async (t) => {
  const { withArchiveCopyBarrier } =
    await import("../../macos/tests/fixtures/archive-copy-barrier.mjs");
  let selectedWorker = worker;
  const f = await fixture(
    t,
    { worker: (...args) => selectedWorker(...args) },
    "generated source".repeat(20_000),
  );
  const input = await readFile(f.input);
  await f.registry.recover();
  await withArchiveCopyBarrier(
    f.home,
    native,
    { partial: true },
    async ({ worker: heldWorker, held, drain }) => {
      let copying = false,
        copyClosed = false;
      selectedWorker = async (operation, params, options) => {
        if (copying && ["archive.cleanup", "packageWorkspace.remove"].includes(operation))
          assert.equal(copyClosed, true, "Copy worker closes before directory cleanup");
        if (operation !== "archive.extract") return heldWorker(operation, params, options);
        copying = true;
        try {
          return await heldWorker(operation, params, options);
        } finally {
          copyClosed = true;
        }
      };
      const admission = await f.registry.open(f.input);
      const completion = drain(
        waitFor(
          () => f.registry.status(admission.id),
          (value) => !["queued", "opening", "closing"].includes(value.state),
        ),
      );
      try {
        await held;
        const copied = (await stat(join(f.directory, admission.id, ".input"))).size;
        assert.ok(copied > 0 && copied < input.length);
        assert.equal(f.registry.status(admission.id).packageHandle, null);
        assert.equal(f.registry.usage().budgetBytes, input.length + 1024 ** 2);
        await f.registry.close(admission.id);
        assert.equal(copyClosed, true);
        assert.equal((await completion).state, "canceled");
        assert.equal(f.registry.usage().budgetBytes, 0);
        assert.deepEqual(await readdir(f.directory), []);
        assert.deepEqual(await readFile(f.input), input);
      } finally {
        try {
          await f.registry.close(admission.id);
        } finally {
          selectedWorker = worker;
          await Promise.allSettled([completion]);
        }
      }
    },
  );
});

for (const cancel of [false, true]) {
  test(`pre-ready descriptor hydration ${cancel ? "cancellation" : "failure"} closes its owner without publishing a handle`, async (t) => {
    let files, enter;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const f = await fixture(t, {
      resolve: async (input, signal) => {
        files = input.files;
        const file = files.open(f.mediaPath);
        file.close();
        enter();
        if (cancel)
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw new Error("Hydration did not complete");
      },
    });
    await f.registry.recover();
    const admission = await f.registry.open(f.input);
    await entered;
    assert.equal(f.registry.status(admission.id).packageHandle, null);
    if (cancel) await f.registry.close(admission.id);
    else
      await waitFor(
        () => f.registry.status(admission.id),
        (value) => value.state === "failed",
      );
    assert.equal(f.registry.status(admission.id).packageHandle, null);
    assert.throws(() => files.open(f.mediaPath));
    assert.equal(f.registry.usage().owners, 0);
    assert.deepEqual(await readdir(f.directory), []);
  });
}
