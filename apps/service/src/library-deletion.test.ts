import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "@yap/core/catalog";
import { DeletionPlans } from "@yap/core/deletion-plans";
import { LibraryDeletion, type DeletionPhase } from "./library-deletion.js";
import { recordingRetirement } from "./recording-retirement.js";
import { DerivativeDelivery } from "./delivery.js";
import type { CaptureSources } from "./capture-sources.js";
import type { CaptureStore } from "@yap/core/capture-store";
import type { JobQueue } from "@yap/core/jobs";

test("a failed phase resumes from its durable plan without reporting success early", async () => {
  const boundaries: DeletionPhase[] = [
    "check",
    "plan",
    "tombstone",
    "drain",
    "files",
    "rows",
    "clear",
  ];
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
    let deletion = new LibraryDeletion(plans, {
      fault: (boundary) => {
        if (fail && boundary === failedBoundary) throw new Error(`fault:${boundary}`);
      },
    });
    deletion.register(registration);
    await expect(deletion.delete({ kind: "fixture", id: "one" })).rejects.toMatchObject({
      code: "DELETE_FAILED",
    });
    expect(tombstoned || failedBoundary === "check" || failedBoundary === "plan").toBe(true);
    if (!["check", "plan"].includes(failedBoundary))
      expect(plans.get("fixture", "one")).not.toBeNull();
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
    if (["check", "plan"].includes(failedBoundary))
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
  let sourceAdmissionAllowed = true;
  const store = {
    markDeleting: () => ({ recordingId: "one" }),
    deleting: () => ({ recordingId: "one" }),
    finishDeletion: () => {},
    deletionsPage: () => ({ recordings: [], nextAfterId: null }),
  } as unknown as CaptureStore;
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
  const deletion = new LibraryDeletion(new DeletionPlans(catalog), {
    fault: (phase, _subject, timing) => {
      if (phase === "files" && timing === "after") expect(sourceAdmissionAllowed).toBe(false);
    },
  });
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
