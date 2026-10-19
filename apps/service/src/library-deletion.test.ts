import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { DeletionPlans } from "@yap/core/deletion-plans";
import { LibraryDeletion, type DeletionRegistration } from "./library-deletion.js";
import { FaultingDeletionPlans, type DeletionBoundary } from "./deletion-faults.fixture.js";
import { Catalog, CatalogError } from "@yap/core/catalog";
import { recordingRetirement } from "./recording-retirement.js";
import { DerivativeDelivery } from "./delivery.js";
import type { CaptureSources } from "./capture-sources.js";
import type { CaptureStore } from "@yap/core/capture-store";
import type { JobQueue } from "@yap/core/jobs";

test("a failed phase resumes from its durable plan without reporting success early", async () => {
  const boundaries: DeletionBoundary[] = ["plan", "tombstone", "drain", "files", "rows", "clear"];
  for (const failedBoundary of boundaries) {
    const home = await mkdtemp("/tmp/yap-library-deletion-");
    const path = join(home, "catalog.sqlite");
    let catalog = new Catalog(path);
    let plans = new DeletionPlans(catalog);
    catalog.catalog.exec(
      "CREATE TABLE fixture_rows(id TEXT PRIMARY KEY); CREATE TABLE fixture_tombstones(id TEXT PRIMARY KEY); INSERT INTO fixture_rows VALUES ('one')",
    );
    const file = join(home, "owned");
    await writeFile(file, "owned");
    let tombstoned = false;
    let rows = true;
    const registration = {
      kind: "fixture",
      checkUsers: () => [],
      tombstone: () => {
        tombstoned = true;
        catalog.catalog.prepare("INSERT OR IGNORE INTO fixture_tombstones VALUES (?)").run("one");
        return true;
      },
      drain: () => {},
      files: async () => {
        await rm(file, { force: true });
      },
      rows: () => {
        rows = false;
        catalog.catalog.prepare("DELETE FROM fixture_rows WHERE id=?").run("one");
        catalog.catalog.prepare("DELETE FROM fixture_tombstones WHERE id=?").run("one");
        return true;
      },
      result: (subject: { id: string }) => ({ fixtureId: subject.id, deleted: true }),
      freedBytes: () => 0,
    };
    let fail = true;
    let deletion = new LibraryDeletion(
      new FaultingDeletionPlans(catalog, (boundary) => {
        if (fail && boundary === failedBoundary) throw new Error(`fault:${boundary}`);
      }),
    );
    deletion.register(registration);
    await expect(deletion.delete({ kind: "fixture", id: "one" })).rejects.toMatchObject({
      code: "DELETE_FAILED",
    });
    expect(tombstoned || failedBoundary === "plan").toBe(true);
    if (failedBoundary !== "plan") expect(plans.get("fixture", "one")).not.toBeNull();
    await deletion.close();
    catalog.close();

    catalog = new Catalog(path);
    plans = new DeletionPlans(catalog);
    fail = false;
    deletion = new LibraryDeletion(plans);
    deletion.register(registration);
    await expect(
      deletion.resume((error) => {
        throw error;
      }),
    ).resolves.toBeUndefined();
    if (failedBoundary === "plan")
      await expect(deletion.delete({ kind: "fixture", id: "one" })).resolves.toEqual({
        fixtureId: "one",
        deleted: true,
        freedBytes: 0,
      });
    expect(plans.get("fixture", "one")).toBeNull();
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rows).toBe(false);
    expect(tombstoned).toBe(true);
    expect(catalog.catalog.prepare("SELECT * FROM fixture_rows").all()).toEqual([]);
    expect(catalog.catalog.prepare("SELECT * FROM fixture_tombstones").all()).toEqual([]);
    await deletion.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("recording source admission stays fenced between file and row phases", async () => {
  const home = await mkdtemp("/tmp/yap-recording-scope-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  new AcquisitionStore(catalog);
  let sourceAdmissionAllowed = true;
  const store = Object.assign(catalog, {
    markDeleting: () => ({ recordingId: "one" }),
    deleting: () => ({ recordingId: "one" }),
    finishDeletion: () => {},
    deletionsPage: () => ({ recordings: [], nextAfterId: null }),
  }) as unknown as CaptureStore;
  const jobs = { drainOwner: async () => {}, forgetOwner: async () => {} } as unknown as JobQueue;
  const sources = {
    retire: async (
      _id: string,
      _signal: AbortSignal,
      run: (lifetime: undefined) => Promise<void>,
    ) => {
      sourceAdmissionAllowed = false;
      try {
        await run(undefined);
      } finally {
        sourceAdmissionAllowed = true;
      }
    },
    forget: () => {},
  } as unknown as CaptureSources;
  const deletion = new LibraryDeletion(
    new FaultingDeletionPlans(catalog, (phase, _subject, timing) => {
      if (phase === "files" && timing === "after") expect(sourceAdmissionAllowed).toBe(false);
    }),
  );
  const delivery = new DerivativeDelivery();
  deletion.register(
    recordingRetirement({
      store,
      jobs,
      capture: { quiesce: async () => {} },
      delivery,
      files: { removeRecordingDirectory: async () => {} },
      sources,
      users: {
        usersOf: () => ({
          usedBy: [],
          acquisitions: [],
          derivedAssets: [],
          freesBytes: 0,
          cascadeFreesBytes: 0,
        }),
        hasUsers: () => false,
      },
      freedBytes: () => 0,
    }),
  );
  await deletion.delete({ kind: "recording", id: "one" });
  expect(sourceAdmissionAllowed).toBe(true);
  await deletion.close();
  delivery.dispose();
  catalog.close();
  await rm(home, { recursive: true, force: true });
});

async function fixtureDeletion(registration: Partial<DeletionRegistration> = {}) {
  const home = await mkdtemp("/tmp/yap-library-deletion-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const deletion = new LibraryDeletion(new DeletionPlans(catalog));
  deletion.register({
    kind: "fixture",
    checkUsers: () => [],
    tombstone: () => true,
    drain: () => {},
    files: async () => {},
    rows: () => true,
    result: (subject: { id: string }) => ({ fixtureId: subject.id, deleted: true }),
    freedBytes: () => 0,
    ...registration,
  });
  return {
    deletion,
    close: async () => {
      await deletion.close();
      catalog.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("a later delete of the same identity reports the bytes it frees, not an earlier delete's", async () => {
  let bytes = 7;
  const f = await fixtureDeletion({ freedBytes: () => bytes });
  // Content-addressed assets return under the same identity when the same file is imported again.
  await expect(
    f.deletion.delete({ kind: "fixture", id: "one" }, { requestId: "a-first" }),
  ).resolves.toMatchObject({ freedBytes: 7 });
  bytes = 11;
  await expect(
    f.deletion.delete({ kind: "fixture", id: "one" }, { requestId: "b-second" }),
  ).resolves.toMatchObject({ freedBytes: 11 });
  await f.close();
});

test("a member's IN_USE refusal reaches the caller as IN_USE in every error mode", async () => {
  for (const errorMode of ["preserve-catalog", "delete-failed"] as const) {
    const f = await fixtureDeletion({
      errorMode,
      files: async () => {
        throw new CatalogError("IN_USE", "member gained a user", { usedBy: [] });
      },
    });
    await expect(f.deletion.delete({ kind: "fixture", id: "one" })).rejects.toMatchObject({
      code: "IN_USE",
      details: { usedBy: [], fixtureId: "one" },
    });
    await f.close();
  }
});

test("a finished delete's requestId keeps returning its first result after the subject is gone", async () => {
  let runs = 0;
  let bytes = 7;
  const f = await fixtureDeletion({
    tombstone: () => {
      runs += 1;
      return true;
    },
    freedBytes: () => bytes,
  });
  const first = await f.deletion.delete({ kind: "fixture", id: "one" }, { requestId: "kept" });
  bytes = 0;
  await expect(
    f.deletion.delete({ kind: "fixture", id: "one" }, { requestId: "kept" }),
  ).resolves.toEqual(first);
  expect(first).toEqual({ fixtureId: "one", deleted: true, freedBytes: 7 });
  expect(runs).toBe(1);
  await f.close();
});

test("a crash right after planning still lets the same requestId replay the finished delete", async () => {
  const home = await mkdtemp("/tmp/yap-library-deletion-");
  const path = join(home, "catalog.sqlite");
  let catalog = new Catalog(path);
  let runs = 0;
  const registration: DeletionRegistration = {
    kind: "fixture",
    checkUsers: () => [],
    tombstone: () => {
      runs += 1;
      return true;
    },
    drain: () => {},
    files: async () => {},
    rows: () => true,
    result: (subject: { id: string }) => ({ fixtureId: subject.id, deleted: true }),
    freedBytes: () => 7,
  };
  let armed = true;
  let deletion = new LibraryDeletion(
    new FaultingDeletionPlans(catalog, (boundary, _subject, timing) => {
      if (armed && boundary === "plan" && timing === "after") {
        armed = false;
        throw new Error("crash after planning");
      }
    }),
  );
  deletion.register(registration);
  await expect(
    deletion.delete({ kind: "fixture", id: "one" }, { requestId: "retry-me" }),
  ).rejects.toMatchObject({ code: "DELETE_FAILED" });
  await deletion.close();
  catalog.close();

  catalog = new Catalog(path);
  deletion = new LibraryDeletion(new DeletionPlans(catalog));
  deletion.register(registration);
  await deletion.resume((error) => {
    throw error;
  });
  await expect(
    deletion.delete({ kind: "fixture", id: "one" }, { requestId: "retry-me" }),
  ).resolves.toEqual({ fixtureId: "one", deleted: true, freedBytes: 7 });
  expect(runs).toBe(1);
  await deletion.close();
  catalog.close();
  await rm(home, { recursive: true, force: true });
});
