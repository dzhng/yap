import { projectStoreFixture } from "./project-store.fixture.js";
import { validateComposition, projectToSource } from "@yap/composition";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { backup } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore, compositionAsset } from "./assets.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
async function setup({ memory = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "yap-projects-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "catalog.sqlite");
  const catalog = new Catalog(memory ? ":memory:" : path);
  cleanup.push(async () => catalog.close());
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  return { home, path, catalog, assets, store: projectStoreFixture(catalog, assets, home) };
}
const canvas = {
  width: 160,
  height: 96,
  fps: { numerator: 30, denominator: 1 },
  background: "#000000ff",
};
test("project edits survive restart and replay before stale-head checks with complete receipts", async () => {
  const { home, path, catalog, store } = await setup();
  const created = store.create({ requestId: "create", title: "Tutorial", canvas });
  const request = {
    requestId: "add",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "voice" },
      {
        operation: "processing.set",
        target: { kind: "track", id: { label: "voice" } },
        steps: [{ processor: { type: "gain", gain: 0.5 }, label: "gain" }],
      },
    ],
  };
  const edited = store.apply(created.project.projectId, request);
  expect(edited.edit.labels.gain).toBeTruthy();
  expect(edited.edit).not.toHaveProperty("document");
  const saved = catalog.catalog
    .prepare("SELECT result FROM project_requests WHERE projectId=? AND requestId=?")
    .get(created.project.projectId, request.requestId)!;
  expect(JSON.parse(saved.result as string)).toEqual(edited);
  const freshCatalog = new Catalog(path);
  try {
    const fresh = projectStoreFixture(freshCatalog, new AssetStore(freshCatalog, home), home);
    expect(fresh.apply(created.project.projectId, request)).toEqual(edited);
  } finally {
    freshCatalog.close();
  }
  // A pre-change persisted receipt projects to the same current response without re-execution.
  const historical = JSON.stringify({
    ...edited,
    edit: { ...edited.edit, document: edited.revision.document },
  });
  catalog.catalog
    .prepare("UPDATE project_requests SET result=? WHERE projectId=? AND requestId=?")
    .run(historical, created.project.projectId, request.requestId);
  expect(edited.revision.document.processing[0]!.steps[0]!.processor).toEqual({
    type: "gain",
    gain: 0.5,
  });
  expect(store.apply(created.project.projectId, request)).toEqual(edited);
  catalog.close();
  const nextCatalog = new Catalog(path);
  cleanup.push(async () => nextCatalog.close());
  const reopened = projectStoreFixture(nextCatalog, new AssetStore(nextCatalog, home), home);
  expect(reopened.apply(created.project.projectId, request)).toEqual(edited);
  expect(
    nextCatalog.catalog
      .prepare("SELECT result FROM project_requests WHERE projectId=? AND requestId=?")
      .get(created.project.projectId, request.requestId)!.result,
  ).toBe(historical);
  expect(
    reopened.create({ canvas: { ...canvas }, title: "Tutorial", requestId: "create" }),
  ).toEqual(created);
  expect(reopened.revision(created.project.projectId).id).toBe(edited.revision.id);
  expect(() => reopened.apply(created.project.projectId, { ...request, operations: [] })).toThrow(
    /different arguments/,
  );
  expect(() =>
    reopened.apply(created.project.projectId, { ...request, requestId: "other" }),
  ).toThrow(/revision has changed/);
});

test("no-op receipts do not grow history; undo and restore append identities and history pages stay pinned", async () => {
  const { store } = await setup();
  const original = store.create({ requestId: "create", canvas });
  const id = original.project.projectId;
  const one = store.apply(id, {
    requestId: "one",
    expectedRevisionId: original.revision.id,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  const two = store.apply(id, {
    requestId: "two",
    expectedRevisionId: one.revision.id,
    operations: [{ operation: "canvas.set", canvas: { height: 240 } }],
  });
  const page = store.history(id, null, 1);
  expect(page.revisions.map((r) => r.id)).toEqual([original.revision.id]);
  const nothing = { requestId: "noop", expectedRevisionId: two.revision.id, operations: [] };
  expect(store.apply(id, nothing).revision).toEqual(two.revision);
  expect(store.history(id).revisions.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  const undone = store.undo(id, { requestId: "undo-one", expectedRevisionId: two.revision.id });
  expect(undone.document).toEqual(one.revision.document);
  expect(undone.id).not.toBe(one.revision.id);
  expect(store.apply(id, nothing).revision).toEqual(two.revision);
  const undoneAgain = store.undo(id, { requestId: "undo-two", expectedRevisionId: undone.id });
  expect(undoneAgain.document).toEqual(original.revision.document);
  expect(() =>
    store.undo(id, { requestId: "undo-empty", expectedRevisionId: undoneAgain.id }),
  ).toThrow(/No active edit/);
  const restored = store.restore(id, {
    requestId: "restore",
    expectedRevisionId: undoneAgain.id,
    targetRevisionId: two.revision.id,
  });
  expect(restored.document).toEqual(two.revision.document);
  expect(restored.id).not.toBe(two.revision.id);
  expect(
    store.undo(id, { requestId: "undo-restore", expectedRevisionId: restored.id }).document,
  ).toEqual(original.revision.document);
  expect(store.history(id, page.nextCursor, 100).revisions.map((r) => r.ordinal)).toEqual([1, 2]);
});

test("speaker corrections are one reversible revision with stale and replay-safe request handling", async () => {
  const { store } = await setup();
  const created = store.create({ requestId: "create-speaker", canvas });
  const request = {
    requestId: "correct-speaker",
    expectedRevisionId: created.revision.id,
    corrections: [
      {
        id: "fix-1",
        occurrenceId: "clip-a",
        target: { wordIds: ["w7", "w8"] },
        value: { state: "unknown" as const },
        provenance: "caller reviewed the transcript",
      },
    ],
  };
  const corrected = store.correctSpeakers(created.project.projectId, request);
  expect(corrected.speakerCorrections).toEqual(request.corrections);
  expect(store.correctSpeakers(created.project.projectId, request)).toEqual(corrected);
  expect(() =>
    store.correctSpeakers(created.project.projectId, {
      ...request,
      requestId: "stale-speaker",
    }),
  ).toThrow(/revision has changed/);
  const undone = store.undo(created.project.projectId, {
    requestId: "undo-speaker",
    expectedRevisionId: corrected.id,
  });
  expect(undone.speakerCorrections).toBeUndefined();
  const restored = store.restore(created.project.projectId, {
    requestId: "restore-speaker",
    expectedRevisionId: undone.id,
    targetRevisionId: corrected.id,
  });
  expect(restored.speakerCorrections).toEqual(request.corrections);
});

test("late failed edits retain no partial state; historical revisions retain admitted media", async () => {
  const { store, assets, home } = await setup();
  const path = join(home, "input.wav");
  await writeFile(path, "fixture admission bytes");
  const asset = await assets.import(path, { kind: "import" }, async () => ({
    originUs: 9000,
    streams: [
      {
        id: "a",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 100,
        endUs: 300,
        segments: [
          { startUs: 100, endUs: 180, empty: false },
          { startUs: 180, endUs: 220, empty: true },
          { startUs: 220, endUs: 300, empty: false },
        ],
      },
    ],
  }));
  const created = store.create({ requestId: "create", canvas });
  const id = created.project.projectId;
  const operations = [
    { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
    {
      operation: "place",
      label: "clip",
      clip: {
        trackId: { label: "audio" },
        assetId: asset.id,
        streamId: "a",
        source: { kind: "range", range: { startUs: 100, endUs: 300 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 200 } },
      },
    },
  ];
  expect(() =>
    store.apply(id, {
      requestId: "attempt",
      expectedRevisionId: created.revision.id,
      operations: [...operations, { operation: "track.remove", trackId: { label: "audio" } }],
    }),
  ).toThrow(/clips explicitly/);
  expect(store.revision(id)).toEqual(created.revision);
  expect(assets.references(asset.id)).toEqual([]);
  const placed = store.apply(id, {
    requestId: "attempt",
    expectedRevisionId: created.revision.id,
    operations,
  });
  const mapped = validateComposition(placed.revision.document, [compositionAsset(asset)]);
  expect(projectToSource(mapped, 10)).toMatchObject([{ sourceUs: 110, available: true }]);
  expect(projectToSource(mapped, 100)).toMatchObject([{ sourceUs: 200, available: false }]);
  expect(assets.references(asset.id)).toEqual([{ kind: "revision", id: placed.revision.id }]);
  const removed = store.apply(id, {
    requestId: "remove",
    expectedRevisionId: placed.revision.id,
    operations: [{ operation: "remove", clipIds: [placed.edit.labels.clip], ripple: "none" }],
  });
  expect(removed.revision.document.clips).toEqual([]);
  expect(assets.references(asset.id)).toEqual([{ kind: "revision", id: placed.revision.id }]);
  const restored = store.undo(id, { requestId: "undo", expectedRevisionId: removed.revision.id });
  expect(restored.document).toEqual(placed.revision.document);
  expect(
    assets
      .references(asset.id)
      .map((r) => r.id)
      .sort(),
  ).toEqual([placed.revision.id, restored.id].sort());
});

test("independent catalog writers reject a stale head and keep project pagination scoped", async () => {
  const { store, path, home } = await setup();
  const original = store.create({ requestId: "one", title: "One", canvas });
  const second = store.create({ requestId: "two", title: "Two", canvas });
  const catalog = new Catalog(path);
  cleanup.push(async () => catalog.close());
  const competitor = projectStoreFixture(catalog, new AssetStore(catalog, home), home);
  const request = {
    requestId: "writer-one",
    expectedRevisionId: original.revision.id,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  };
  const changed = store.apply(original.project.projectId, request);
  expect(() =>
    competitor.apply(original.project.projectId, { ...request, requestId: "writer-two" }),
  ).toThrow(/revision has changed/);
  expect(competitor.revision(original.project.projectId)).toEqual(changed.revision);
  expect(() => competitor.revision(second.project.projectId, changed.revision.id)).toThrow(
    /in project/,
  );
  const page = store.list({ limit: 1 });
  expect(page.projects.map((p) => p.title)).toEqual(["Two"]);
  expect(store.list({ ...page.nextCursor!, limit: 1 }).projects.map((p) => p.title)).toEqual([
    "One",
  ]);
  expect(() =>
    store.history(second.project.projectId, {
      projectId: original.project.projectId,
      afterOrdinal: -1,
      throughOrdinal: 0,
    }),
  ).toThrow(/cursor/);
});

test("project pages are newest first and continue below the last project", async () => {
  const { store } = await setup();
  const first = store.create({ requestId: "first", title: "First", canvas });
  const second = store.create({ requestId: "second", title: "Second", canvas });
  const third = store.create({ requestId: "third", title: "Third", canvas });

  const page = store.list({ limit: 2 });
  expect(page.projects.map((project) => project.projectId)).toEqual([
    third.project.projectId,
    second.project.projectId,
  ]);
  expect(page.nextCursor).toEqual({ afterSequence: 2 });
  expect(
    store.list({ ...page.nextCursor!, limit: 2 }).projects.map((project) => project.projectId),
  ).toEqual([first.project.projectId]);
});

test("deletion fences reads and replayed edits, survives restart, and retains creation identity", async () => {
  const { home, path, catalog, store } = await setup();
  const created = store.create({ requestId: "delete-me", canvas });
  const id = created.project.projectId;
  const request = { requestId: "noop", expectedRevisionId: created.revision.id, operations: [] };
  store.apply(id, request);
  expect(store.markDeleting(id)).toBe(true);
  expect(store.list().projects).toEqual([]);
  expect(() => store.get(id)).toThrow(/does not exist/);
  expect(() => store.apply(id, request)).toThrow(/does not exist/);
  catalog.close();
  const reopenedCatalog = new Catalog(path);
  cleanup.push(async () => reopenedCatalog.close());
  const reopened = projectStoreFixture(
    reopenedCatalog,
    new AssetStore(reopenedCatalog, home),
    home,
  );
  expect(reopened.deletionsPage().projectIds).toEqual([id]);
  expect(reopened.isDeleting(id)).toBe(true);
  expect(reopened.finishDeletionPage(id)).toBe(true);
  expect(reopened.deletionsPage().projectIds).toEqual([]);
  expect(reopened.create({ requestId: "delete-me", canvas })).toEqual(created);
  expect(reopened.list().projects).toEqual([]);
  expect(reopened.markDeleting(id)).toBe(false);
  expect(reopened.markDeleting("absent")).toBe(false);
});

test("large deleted histories retire in restartable pages without losing the tombstone", async () => {
  const fixture = await setup({ memory: true });
  let { store, catalog } = fixture;
  const created = store.create({ requestId: "paged", canvas });
  let head = created.revision.id;
  for (let i = 0; i < 1500; i++) {
    head = store.apply(created.project.projectId, {
      requestId: `edit-${i}`,
      expectedRevisionId: head,
      operations: [{ operation: "canvas.set", canvas: { width: 200 + i } }],
    }).revision.id;
  }
  // Exercise deletion on disk without charging setup for 1,500 independent durable commits.
  await backup(catalog.catalog, fixture.path);
  const reopen = () => {
    catalog.close();
    catalog = new Catalog(fixture.path);
    store = projectStoreFixture(catalog, new AssetStore(catalog, fixture.home), fixture.home);
  };
  cleanup.push(async () => catalog.close());
  reopen();
  expect(
    catalog.catalog.prepare("SELECT COUNT(*) AS count FROM project_revisions").get()!.count,
  ).toBe(1501);
  expect(catalog.catalog.prepare("SELECT COUNT(*) AS count FROM project_undo").get()!.count).toBe(
    1500,
  );
  expect(
    catalog.catalog.prepare("SELECT COUNT(*) AS count FROM project_requests").get()!.count,
  ).toBe(1500);
  expect(store.revision(created.project.projectId).id).toBe(head);
  const id = created.project.projectId;
  store.markDeleting(id);
  let complete = false,
    restarted = false;
  while (!complete) {
    const before = Number(catalog.catalog.prepare("SELECT total_changes() AS count").get()!.count);
    complete = store.finishDeletionPage(id);
    const after = Number(catalog.catalog.prepare("SELECT total_changes() AS count").get()!.count);
    // Empty-media histories must not retire thousands of rows in one blocking transaction.
    expect(after - before).toBeLessThanOrEqual(1024);
    expect(after - before).toBeGreaterThan(0);
    if (!complete) {
      if (!restarted) {
        reopen();
        restarted = true;
        expect(store.isDeleting(id)).toBe(true);
      }
      expect(store.deletionsPage().projectIds).toEqual([id]);
    }
  }
  expect(restarted).toBe(true);
  expect(store.deletionsPage().projectIds).toEqual([]);
  expect(store.isDeleting(id)).toBe(true);
  expect(store.create({ requestId: "paged", canvas })).toEqual(created);
  expect(store.list().projects).toEqual([]);
});

test("portable adoption preserves history and active undo independently and publishes dependencies atomically", async () => {
  const donor = await setup(),
    receiver = await setup();
  const initial = donor.store.create({ requestId: "donor", title: "Portable", canvas });
  const id = initial.project.projectId;
  const first = donor.store.apply(id, {
    requestId: "first",
    expectedRevisionId: initial.revision.id,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  const second = donor.store.apply(id, {
    requestId: "second",
    expectedRevisionId: first.revision.id,
    operations: [{ operation: "canvas.set", canvas: { height: 240 } }],
  });
  donor.store.undo(id, { requestId: "undo-second", expectedRevisionId: second.revision.id });
  const snapshot = donor.store.snapshot(id);
  const input = { requestId: "adopt", packageIdentity: "verified-archive", snapshot };
  expect(() =>
    receiver.store.prepareAdoption(input).publish(() => {
      receiver.catalog.catalog
        .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
        .run("partial", "{}");
      throw new Error("dependency canceled");
    }),
  ).toThrow("dependency canceled");
  expect(receiver.assets.list().assets).toEqual([]);
  expect(receiver.store.list().projects).toEqual([]);
  const adopted = receiver.store.prepareAdoption(input).publish(() => {});
  expect(adopted.project.projectId).not.toBe(id);
  expect(receiver.store.get(adopted.project.projectId).currentRevisionId).toBe(adopted.revision.id);
  expect(
    receiver.store.prepareAdoption(input).publish(() => {
      throw new Error("must not publish twice");
    }),
  ).toEqual(adopted);
  expect(
    receiver.store.history(adopted.project.projectId).revisions.map((r) => r.document),
  ).toEqual(snapshot.revisions.map((r) => r.document));
  donor.store.markDeleting(id);
  const undone = receiver.store.undo(adopted.project.projectId, {
    requestId: "undo-first",
    expectedRevisionId: adopted.revision.id,
  });
  expect(undone.document).toEqual(initial.revision.document);
  expect(receiver.store.get(adopted.project.projectId).currentRevisionId).toBe(undone.id);
  expect(() =>
    receiver.store.prepareAdoption({ ...input, packageIdentity: "other" }).publish(() => {}),
  ).toThrow(/another package/);
  const broken = structuredClone(snapshot);
  broken.revisions.splice(1, 1);
  expect(() =>
    receiver.store
      .prepareAdoption({ ...input, requestId: "invalid", snapshot: broken })
      .publish(() => {}),
  ).toThrow(/incomplete/);
});

test("portable adoption retains media used only by a past revision and restores it through undo", async () => {
  const donor = await setup(),
    receiver = await setup();
  const source = join(donor.home, "source.wav");
  await writeFile(source, "lossless fixture bytes");
  const asset = await donor.assets.import(source, { kind: "generated" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "a",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 1000,
        segments: [{ startUs: 0, endUs: 1000, empty: false }],
      },
    ],
  }));
  const created = donor.store.create({ requestId: "create", canvas });
  const placed = donor.store.apply(created.project.projectId, {
    requestId: "place",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      {
        operation: "place",
        label: "voice",
        clip: {
          trackId: { label: "audio" },
          assetId: asset.id,
          streamId: "a",
          source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
        },
      },
    ],
  });
  donor.store.apply(created.project.projectId, {
    requestId: "remove",
    expectedRevisionId: placed.revision.id,
    operations: [{ operation: "remove", clipIds: [placed.edit.labels.voice], ripple: "none" }],
  });
  donor.assets.retain({ kind: "revision", id: created.revision.id }, [asset.id]);
  const staged = await receiver.assets.stagePortable(
    donor.assets.portable(asset.id),
    donor.assets.path(asset.id),
    new AbortController().signal,
  );
  const adopted = receiver.store
    .prepareAdoption({
      requestId: "copy",
      packageIdentity: "verified",
      snapshot: donor.store.snapshot(created.project.projectId),
    })
    .publish(() => staged.publish());
  await staged.close();
  expect(adopted.revision.document.clips).toEqual([]);
  expect(
    receiver.assets
      .references(asset.id)
      .map((owner) => owner.id)
      .sort(),
  ).toEqual(
    [adopted.revisionIds[placed.revision.id], adopted.revisionIds[created.revision.id]].sort(),
  );
  expect(receiver.store.snapshot(adopted.project.projectId).references).toContainEqual({
    revisionId: adopted.revisionIds[created.revision.id],
    resources: [{ kind: "asset", id: asset.id }],
  });
  await rm(source);
  await rm(donor.assets.path(asset.id));
  const undone = receiver.store.undo(adopted.project.projectId, {
    requestId: "undo",
    expectedRevisionId: adopted.revision.id,
  });
  expect(undone.document).toEqual(placed.revision.document);
  expect(receiver.assets.get(asset.id)).toEqual(asset);
});

test("prepared adoption stays invisible and concurrent publication uses the winning identities", async () => {
  const donor = await setup(),
    receiver = await setup();
  const created = donor.store.create({ requestId: "donor", canvas });
  const input = {
    requestId: "race",
    packageIdentity: "archive",
    snapshot: donor.store.snapshot(created.project.projectId),
  };
  const first = receiver.store.prepareAdoption(input);
  const second = receiver.store.prepareAdoption(input);
  expect(first.project.projectId).not.toBe(second.project.projectId);
  expect(receiver.store.list().projects).toEqual([]);
  expect(() => receiver.store.revision(first.project.projectId)).toThrow();
  const winner = first.publish(() => {});
  const loser = second.publish(() => {
    throw new Error("loser must not publish dependencies");
  });
  expect(loser).toEqual(winner);
  expect(winner.project).toEqual(first.project);
  expect(winner.revisionIds).toEqual(first.revisionIds);
  expect(receiver.store.list().projects).toEqual([winner.project]);
  const replay = receiver.store.prepareAdoption(input);
  expect(replay.project).toEqual(winner.project);
  expect(
    replay.publish(() => {
      throw new Error("replay must not publish");
    }),
  ).toEqual(winner);
  expect(() => receiver.store.prepareAdoption({ ...input, packageIdentity: "different" })).toThrow(
    /another package/,
  );
});

test("historical snapshots pin their own history and undo before later restore and edits", async () => {
  const donor = await setup(),
    receiver = await setup();
  const initial = donor.store.create({ requestId: "historical", canvas });
  const id = initial.project.projectId;
  const first = donor.store.apply(id, {
    requestId: "one",
    expectedRevisionId: initial.revision.id,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  }).revision;
  const second = donor.store.apply(id, {
    requestId: "two",
    expectedRevisionId: first.id,
    operations: [{ operation: "canvas.set", canvas: { height: 240 } }],
  }).revision;
  const undone = donor.store.undo(id, { requestId: "undo", expectedRevisionId: second.id });
  const restored = donor.store.restore(id, {
    requestId: "restore",
    expectedRevisionId: undone.id,
    targetRevisionId: second.id,
  });
  const later = donor.store.apply(id, {
    requestId: "later",
    expectedRevisionId: restored.id,
    operations: [{ operation: "canvas.set", canvas: { width: 640 } }],
  }).revision;
  for (const [selected, targets] of [
    [initial.revision, []],
    [second, [first, initial.revision]],
    [undone, [initial.revision]],
    [restored, [undone, initial.revision]],
  ] as const) {
    const snapshot = donor.store.snapshot(id, selected.id);
    expect(snapshot.project.currentRevisionId).toBe(selected.id);
    expect(snapshot.revisions.map((r) => r.id)).toEqual(
      [initial.revision, first, second, undone, restored]
        .slice(0, selected.ordinal + 1)
        .map((r) => r.id),
    );
    const adopted = receiver.store
      .prepareAdoption({ requestId: selected.id, packageIdentity: selected.id, snapshot })
      .publish(() => {});
    let head = adopted.revision;
    expect(head.document).toEqual(selected.document);
    for (const target of targets) {
      head = receiver.store.undo(adopted.project.projectId, {
        requestId: target.id,
        expectedRevisionId: head.id,
      });
      expect(head.document).toEqual(target.document);
    }
    expect(() =>
      receiver.store.undo(adopted.project.projectId, {
        requestId: "empty",
        expectedRevisionId: head.id,
      }),
    ).toThrow(/No active edit/);
  }
  expect(donor.store.snapshot(id, later.id)).toEqual(donor.store.snapshot(id));
  expect(donor.store.revision(id)).toEqual(later);
  expect(() => donor.store.snapshot(id, "missing")).toThrow(/Revision does not exist/);
});

test("shared state membership survives replay, undo and restored history without reusing old tokens", async () => {
  const { store } = await setup();
  const original = store.create({ requestId: "state-project", canvas });
  const id = original.project.projectId;
  const placed = store.apply(id, {
    requestId: "state-place",
    expectedRevisionId: original.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "track" },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 0, endUs: 4000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: { label: "clip" } },
        steps: [{ processor: { type: "rnnoise" } }],
      },
    ],
  });
  const request = {
    requestId: "state-split",
    expectedRevisionId: placed.revision.id,
    operations: [
      { operation: "split", clipIds: [placed.edit.labels.clip!], atUs: 2000000, scope: "selected" },
    ],
  };
  const split = store.apply(id, request);
  const token = split.revision.document.processing[0]!.steps[0]!.stateKey;
  expect(token).toBeTruthy();
  expect(store.apply(id, request)).toEqual(split);
  const undone = store.undo(id, { requestId: "state-undo", expectedRevisionId: split.revision.id });
  expect(undone.document).toEqual(placed.revision.document);
  const fresh = store.apply(id, {
    ...request,
    requestId: "state-new-split",
    expectedRevisionId: undone.id,
  });
  expect(fresh.revision.document.processing[0]!.steps[0]!.stateKey).not.toBe(token);
  const restored = store.restore(id, {
    requestId: "state-restore",
    expectedRevisionId: fresh.revision.id,
    targetRevisionId: split.revision.id,
  });
  expect(restored.document).toEqual(split.revision.document);
  expect(store.revision(id, split.revision.id).document).toEqual(split.revision.document);
});

test("pinned revision availability respects exact membership and deletion without document hydration", async () => {
  const { store, catalog } = await setup();
  const first = store.create({ requestId: "first", title: "first", canvas });
  const second = store.create({ requestId: "second", title: "second", canvas });
  const id = first.project.projectId;
  expect(store.hasRevision(id, first.revision.id)).toBe(true);
  expect(store.hasRevision(id, second.revision.id)).toBe(false);
  expect(store.hasRevision("missing", first.revision.id)).toBe(false);
  // Availability is a row-membership contract, not a content parser.
  catalog.catalog
    .prepare("UPDATE project_revisions SET content=? WHERE id=?")
    .run("not parsed", first.revision.id);
  expect(store.hasRevision(id, first.revision.id)).toBe(true);
  store.markDeleting(id);
  expect(store.hasRevision(id, first.revision.id)).toBe(false);
});

test("pinned revision ownership preserves missing, foreign and deleted project refusals", async () => {
  const { store } = await setup();
  const first = store.create({ requestId: "first", canvas });
  const second = store.create({ requestId: "second", canvas });
  const projectId = first.project.projectId,
    revisionId = first.revision.id;
  expect(store.requireRevision(projectId, revisionId)).toBeUndefined();
  expect(store.revisionDependencies(projectId, revisionId)).toEqual([]);
  const error = (run: () => unknown) => {
    try {
      run();
    } catch (failure) {
      if (!(failure instanceof CatalogError)) throw failure;
      return {
        code: failure.code,
        message: failure.message,
        details: failure.details,
        retryable: failure.retryable,
      };
    }
    throw new Error("Expected ownership refusal");
  };
  for (const [project, revision] of [
    [projectId, "missing"],
    [projectId, second.revision.id],
    ["missing", revisionId],
  ]) {
    const expected = error(() => store.revision(project!, revision!));
    expect(error(() => store.requireRevision(project!, revision!))).toEqual(expected);
    expect(error(() => store.revisionDependencies(project!, revision!))).toEqual(expected);
  }
  store.markDeleting(projectId);
  const expected = error(() => store.revision(projectId, revisionId));
  expect(error(() => store.requireRevision(projectId, revisionId))).toEqual(expected);
  expect(error(() => store.revisionDependencies(projectId, revisionId))).toEqual(expected);
});

test("LUT-only revision dependencies survive cleared stacks, relocation and restored history", async () => {
  const donor = await setup(),
    receiver = await setup();
  const source = join(donor.home, "look.cube");
  await writeFile(source, "immutable LUT bytes");
  const lut = await donor.assets.import(source, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [],
    lut: { format: "cube-3d", size: 2, domain: "unit", ordering: "red-fastest" },
  }));
  const original = donor.store.create({ requestId: "create", canvas });
  const id = original.project.projectId;
  const authored = donor.store.apply(id, {
    requestId: "look",
    expectedRevisionId: original.revision.id,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            processor: {
              type: "lut",
              assetId: lut.id,
              colorSpace: "linear-srgb",
              interpolation: "trilinear",
            },
          },
        ],
      },
    ],
  });
  const cleared = donor.store.apply(id, {
    requestId: "clear",
    expectedRevisionId: authored.revision.id,
    operations: [{ operation: "processing.set", target: { kind: "output" }, steps: [] }],
  });
  expect(donor.assets.references(lut.id)).toContainEqual({
    kind: "revision",
    id: authored.revision.id,
  });
  const staged = await receiver.assets.stagePortable(
    donor.assets.portable(lut.id),
    donor.assets.path(lut.id),
    new AbortController().signal,
  );
  const adopted = receiver.store
    .prepareAdoption({
      requestId: "relocate",
      packageIdentity: "lut-package",
      snapshot: donor.store.snapshot(id),
    })
    .publish(() => staged.publish());
  await staged.close();
  await rm(donor.assets.path(lut.id));
  const undone = receiver.store.undo(adopted.project.projectId, {
    requestId: "restore-look",
    expectedRevisionId: adopted.revision.id,
  });
  expect(undone.document).toEqual(authored.revision.document);
  expect(receiver.assets.get(lut.id).lut).toEqual(lut.lut);
  expect(cleared.revision.document.processing).toEqual([]);
});
