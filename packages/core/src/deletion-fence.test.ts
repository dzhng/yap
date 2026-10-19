import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { Catalog } from "./catalog.js";
import { DeletionPlans } from "./deletion-plans.js";
import { AssetStore } from "./assets.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { JobQueue } from "./jobs.js";

const canvas = {
  width: 160,
  height: 96,
  fps: { numerator: 30, denominator: 1 },
  background: "#000000ff",
};
const probe = async () => ({
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
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yap-fence-"));
  const catalog = new Catalog(join(root, "catalog.sqlite"));
  const assets = new AssetStore(catalog, root);
  await assets.recover();
  const input = join(root, "input.png");
  await writeFile(input, "pixels");
  const asset = await assets.import(input, { kind: "import" }, probe);
  const projects = projectStoreFixture(catalog, assets, root);
  const project = projects.create({ requestId: "create", canvas });
  projects.apply(project.project.id, {
    requestId: "place",
    expectedRevisionId: project.revision.id,
    operations: [
      { operation: "track.add", label: "track", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: "a",
          source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
        },
      },
    ],
  });
  return { root, catalog, assets, projects, asset, projectId: project.project.id };
}
function tombstone(catalog: Catalog, id: string) {
  const plans = new DeletionPlans(catalog);
  plans.create("asset", id, false);
  plans.setPhase("asset", id, "tombstoned");
  return plans;
}

test("revision publication refuses a tombstoned asset and succeeds after clearing", async () => {
  const f = await fixture();
  try {
    const current = f.projects.revision(f.projectId);
    const plans = tombstone(f.catalog, f.asset.id);
    expect(() =>
      f.projects.apply(f.projectId, {
        requestId: "late",
        expectedRevisionId: current.id,
        operations: [{ operation: "canvas.set", canvas: { width: 161 } }],
      }),
    ).toThrowError(expect.objectContaining({ code: "DELETE_IN_PROGRESS" }));
    plans.clear("asset", f.asset.id);
    expect(
      f.projects.apply(f.projectId, {
        requestId: "late-2",
        expectedRevisionId: current.id,
        operations: [{ operation: "canvas.set", canvas: { width: 161 } }],
      }).revision,
    ).toBeTruthy();
  } finally {
    f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("jobs.retainInputs refuses a tombstoned asset and succeeds after clearing", async () => {
  const f = await fixture();
  const queue = new JobQueue({
    store: f.catalog,
    targets: {
      pin: (target) => {
        if (target.kind !== "asset") throw new Error("Unexpected owner");
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: async () => "ok",
    providers: { newId: () => crypto.randomUUID() },
  });
  try {
    const plans = tombstone(f.catalog, f.asset.id);
    expect(() =>
      queue.submit(
        {
          target: { kind: "asset", id: f.asset.id },
          artifact: "test",
          lane: "frame",
          input: "x",
        },
        (value) => queue.retainInputs(value.jobId, "asset", [f.asset.id]),
      ),
    ).toThrowError(expect.objectContaining({ code: "DELETE_IN_PROGRESS" }));
    plans.clear("asset", f.asset.id);
    const retry = queue.submit(
      {
        target: { kind: "asset", id: f.asset.id },
        artifact: "test-2",
        lane: "frame",
        input: "x",
      },
      (value) => queue.retainInputs(value.jobId, "asset", [f.asset.id]),
    );
    expect(f.assets.references(f.asset.id)).toContainEqual({ kind: "job-input", id: retry.jobId });
  } finally {
    await queue.close();
    f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("asset publication fence refuses a tombstoned existing row and permits publication after clearing", async () => {
  const f = await fixture();
  try {
    const staged = await f.assets.stage(join(f.root, "input.png"), { kind: "import" }, probe);
    const plans = tombstone(f.catalog, staged.asset.id);
    expect(() => f.catalog.transaction(() => staged.publish())).toThrowError(
      expect.objectContaining({ code: "DELETE_IN_PROGRESS" }),
    );
    await staged.close();
    expect(f.assets.has(staged.asset.id)).toBe(true);
    plans.clear("asset", staged.asset.id);
    const retry = await f.assets.stage(join(f.root, "input.png"), { kind: "import" }, probe);
    f.catalog.transaction(() => retry.publish());
    expect(f.assets.has(retry.asset.id)).toBe(true);
    await retry.close();
  } finally {
    f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("asset publication removes a newly linked file when a tombstone wins before its row", async () => {
  const f = await fixture();
  try {
    const fresh = join(f.root, "fresh.png");
    await writeFile(fresh, "new pixels");
    const staged = await f.assets.stage(fresh, { kind: "import" }, probe);
    const plans = tombstone(f.catalog, staged.asset.id);
    expect(() => f.catalog.transaction(() => staged.publish())).toThrowError(
      expect.objectContaining({ code: "DELETE_IN_PROGRESS" }),
    );
    await staged.close();
    expect(f.assets.has(staged.asset.id)).toBe(false);
    expect(() => f.assets.path(staged.asset.id)).toThrow();
    plans.clear("asset", staged.asset.id);
  } finally {
    f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

/** Every asset row has its file and every managed file has its row, before and after restart. */
async function expectAgreement(root: string, catalog: Catalog) {
  const check = async (store: Catalog) => {
    const files = (await readdir(join(root, "assets"))).sort();
    const rows = (
      store.catalog.prepare("SELECT metadata FROM assets").all() as { metadata: string }[]
    )
      .map((row) => (JSON.parse(row.metadata) as { fileName: string }).fileName)
      .sort();
    expect(files).toEqual(rows);
  };
  await check(catalog);
  const reopened = new Catalog(join(root, "catalog.sqlite"));
  try {
    await new AssetStore(reopened, root).recover();
    await check(reopened);
  } finally {
    reopened.close();
  }
}

/** The deletion side of the race: tombstone, unlink under the publication lock, drop the row. */
async function deleteAsset(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const plans = tombstone(f.catalog, id);
  await f.assets.unlinkFile(id);
  f.catalog.catalog.prepare("DELETE FROM assets WHERE id=?").run(id);
  return plans;
}

test("a re-import staged before deletion cannot publish its row after the file is unlinked", async () => {
  const f = await fixture();
  try {
    const input = join(f.root, "race.png");
    await writeFile(input, "race pixels");
    const first = await f.assets.import(input, { kind: "import" }, probe);
    // The re-import holds verified bytes and waits to publish while deletion runs.
    const staged = await f.assets.stage(input, { kind: "import" }, probe);
    await deleteAsset(f, first.id);
    expect(() => f.catalog.transaction(() => staged.publish())).toThrowError(
      expect.objectContaining({ code: "DELETE_IN_PROGRESS" }),
    );
    await staged.close();
    expect(f.assets.has(first.id)).toBe(false);
    await expectAgreement(f.root, f.catalog);
  } finally {
    f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a re-import queued behind the deletion's unlink is refused before it links", async () => {
  const f = await fixture();
  try {
    const input = join(f.root, "race.png");
    await writeFile(input, "race pixels");
    const first = await f.assets.import(input, { kind: "import" }, probe);
    const plans = tombstone(f.catalog, first.id);
    // Unlink takes the publication lock first; staging the same bytes queues behind it.
    const unlinked = f.assets.unlinkFile(first.id);
    const staged = f.assets.stage(input, { kind: "import" }, probe);
    await unlinked;
    await expect(staged).rejects.toMatchObject({ code: "DELETE_IN_PROGRESS" });
    f.catalog.catalog.prepare("DELETE FROM assets WHERE id=?").run(first.id);
    await expectAgreement(f.root, f.catalog);
    plans.clear("asset", first.id);
    const again = await f.assets.import(input, { kind: "import" }, probe);
    expect(again.id).toBe(first.id);
    await expectAgreement(f.root, f.catalog);
  } finally {
    f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("package adoption refuses a tombstoned asset and succeeds after clearing", async () => {
  const f = await fixture();
  try {
    const snapshot = f.projects.snapshot(f.projectId);
    const plans = tombstone(f.catalog, f.asset.id);
    const adoption = f.projects.prepareAdoption({
      requestId: "adopt",
      packageIdentity: "pkg",
      snapshot,
    });
    expect(() => adoption.publish(() => {})).toThrowError(
      expect.objectContaining({ code: "DELETE_IN_PROGRESS" }),
    );
    plans.clear("asset", f.asset.id);
    const retry = f.projects.prepareAdoption({
      requestId: "adopt-2",
      packageIdentity: "pkg",
      snapshot,
    });
    expect(retry.publish(() => {}).project.id).toBeTruthy();
  } finally {
    f.catalog.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
