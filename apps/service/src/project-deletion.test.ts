import { ProjectStore } from "@yap/core/projects";
import { TranscriptStore } from "@yap/core/transcript";
import { assetTranscriptOwner } from "@yap/core/transcript-processing";
import { selectSource } from "@yap/core/source-selection";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { DerivedCache } from "@yap/core/cache";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { JobQueue } from "@yap/core/jobs";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { SceneEvidenceStore, assetSceneOwner } from "@yap/core/scene-evidence";
import { ScreenshotIndexStore } from "@yap/core/screenshot-index";
import {
  projectIndexDomain,
  projectIndexPlan,
  type ProjectIndexRecords,
} from "@yap/core/project-index";
import { projectComposition } from "@yap/core/project-window";
import { DerivativeDelivery } from "./delivery.js";
import { DeletionPlans } from "@yap/core/deletion-plans";
import { LibraryDeletion } from "./library-deletion.js";
import { projectRetirement } from "./project-retirement.js";
import { type DeletionFault, type DeletionPhase } from "./library-deletion.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("deletion drains canceled executors before releasing shared media; interruption resumes", async () => {
  const home = await mkdtemp(join(tmpdir(), "sr-del-"));
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  const projects = projectStoreFixture(catalog, assets, home);
  const acquisitions = new AcquisitionStore(catalog);
  const scenes = new SceneEvidenceStore(catalog, assetSceneOwner(assets, acquisitions));
  const index = new ScreenshotIndexStore(
    catalog,
    home,
    projectIndexDomain(
      {
        composition: (identity) => projectComposition(projects, assets, identity),
        source: (selection) => selectSource(assets, acquisitions, selection),
        scenes,
        isDeleting: (id) => projects.isDeleting(id),
      },
      { implementationId: "deletion-test" },
    ),
  );
  const started = deferred();
  const aborted = deferred();
  const exit = deferred();
  const queue = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin(target) {
        if (target.kind !== "project") throw new Error("Expected project");
        projects.revision(target.projectId, target.revisionId);
        return target;
      },
      isAvailable(target) {
        if (target.kind !== "project") return false;
        try {
          projects.revision(target.projectId, target.revisionId);
          return true;
        } catch {
          return false;
        }
      },
      isDeleting: (owner) => owner.kind === "project" && projects.isDeleting(owner.projectId),
      isCapturing: () => false,
    },
    execute: async ({ signal }) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      await exit.promise;
      return "late-result";
    },
  });
  const cache = new DerivedCache(catalog, home, (owner) => {
    if (owner.kind !== "project") throw new Error("Expected project cache owner");
    projects.get(owner.projectId);
  });
  await cache.reconcile();
  // Native filesystem deletion is the external seam; catalog, leases and lifetime are real.
  const files = {
    async removeCacheFiles(ids: string[]) {
      for (const id of ids) await unlink(join(home, "cache", "derived", `${id}.cache`));
    },
  };
  const delivery = new DerivativeDelivery();
  const exports = { retireOwner: async () => {} };
  const deletion = new LibraryDeletion(new DeletionPlans(catalog));
  deletion.register(
    projectRetirement({
      catalog,
      store: projects,
      jobs: queue,
      cache,
      files,
      delivery,
      exports,
      index,
      freedBytes: () => 0,
    }),
  );
  let releaseRead: (() => void) | undefined;
  try {
    await assets.recover();
    const path = join(home, "source.wav");
    await writeFile(path, "retained source bytes");
    const asset = await assets.import(path, { kind: "import" }, async () => ({
      originUs: 0,
      streams: [
        {
          id: "audio",
          kind: "audio",
          codec: "pcm",
          decodable: true,
          startUs: 0,
          endUs: 1000,
          segments: [{ startUs: 0, endUs: 1000, empty: false }],
        },
      ],
    }));
    const create = (requestId: string) =>
      projects.create({
        requestId,
        canvas: {
          width: 160,
          height: 96,
          fps: { numerator: 30, denominator: 1 },
          background: "#000000ff",
        },
      });
    const one = create("one"),
      two = create("two");
    const indexIdentity = (projectId: string, generation: string) => ({
      ...projectIndexPlan(
        projectComposition(projects, assets, { projectId }),
        {},
        { implementationId: "deletion-test" },
      ).identity,
      generation,
      scenes: [],
    });
    const interruptedIndex = indexIdentity(one.project.projectId, "unfinished");
    index.begin(interruptedIndex);
    const unfinishedPicture = index.outputPath(interruptedIndex, 0);
    await writeFile(unfinishedPicture, "unpublished worker output");
    const siblingIndex = indexIdentity(two.project.projectId, "ready-empty");
    index.begin(siblingIndex);
    const siblingMetadata = await index.finish(siblingIndex);
    const place = (project: typeof one) =>
      projects.apply(project.project.projectId, {
        requestId: "place",
        expectedRevisionId: project.revision.revisionId,
        operations: [
          { operation: "track.add", track: { kind: "audio", order: 0 }, label: "track" },
          {
            operation: "place",
            clip: {
              trackId: { label: "track" },
              assetId: asset.id,
              streamId: "audio",
              source: { kind: "range", range: { startUs: 0, endUs: 1000 } },
              placement: { kind: "project", range: { startUs: 0, endUs: 1000 } },
            },
          },
        ],
      });
    const first = place(one),
      second = place(two);
    const target = {
      kind: "project" as const,
      projectId: one.project.projectId,
      revisionId: first.revision.revisionId,
    };
    const cached = cache.reserve(target);
    await writeFile(cached.path, "cached first project");
    await cache.publish(cached.id);
    const sibling = cache.reserve({ kind: "project", projectId: two.project.projectId });
    await writeFile(sibling.path, "cached second project");
    await cache.publish(sibling.id);
    const delivered = delivery.open({ kind: "project", id: target.projectId }, () =>
      cache.acquire(cached.id),
    );
    const siblingDelivery = delivery.open({ kind: "project", id: two.project.projectId }, () =>
      cache.acquire(sibling.id),
    );
    const read = cache.acquire(cached.id)!;
    releaseRead = () => read.release();
    const job = queue.submit({ target, artifact: "fixture", lane: "heavy", input: "input" });
    await started.promise;
    const removing = deletion.delete({ kind: "project", id: target.projectId });
    expect(deletion.delete({ kind: "project", id: target.projectId })).toBe(removing);
    await aborted.promise;
    expect(await readFile(unfinishedPicture, "utf8")).toBe("unpublished worker output");
    expect(() => delivery.read(delivered.token, 0, 32)).toThrow(
      expect.objectContaining({ code: "ARTIFACT_EXPIRED" }),
    );
    expect(Buffer.from(delivery.read(siblingDelivery.token, 0, 32).data, "base64").toString()).toBe(
      "cached second project",
    );
    expect(
      assets
        .references(asset.id)
        .map((r) => r.id)
        .sort(),
    ).toEqual([first.revision.revisionId, second.revision.revisionId].sort());
    expect(() => projects.get(target.projectId)).toThrow(/does not exist/);
    expect(() => queue.retry(job.jobId)).toThrow();
    const failed = expect(removing).rejects.toMatchObject({
      code: "DELETE_FAILED",
      retryable: true,
    });
    const closing = deletion.close();
    exit.resolve();
    await failed;
    await closing;
    expect(projects.deletionsPage().projectIds).toEqual([target.projectId]);
    const resumed = new LibraryDeletion(new DeletionPlans(catalog));
    resumed.register(
      projectRetirement({
        catalog,
        store: projects,
        jobs: queue,
        cache,
        files,
        delivery,
        exports,
        index,
        freedBytes: () => 0,
      }),
    );
    try {
      const failures: unknown[] = [];
      await resumed.resume((error) => failures.push(error));
      expect(failures).toEqual([
        expect.objectContaining({ code: "DELETE_FAILED", retryable: true }),
      ]);
      expect(projects.deletionsPage().projectIds).toEqual([target.projectId]);
      expect(
        assets
          .references(asset.id)
          .map((ref) => ref.id)
          .sort(),
      ).toEqual([first.revision.revisionId, second.revision.revisionId].sort());
      expect(await readFile(cached.path, "utf8")).toBe("cached first project");
      expect(() => cache.acquire(cached.id)).toThrow(/does not exist/);
      releaseRead();
      releaseRead = undefined;
      failures.length = 0;
      await resumed.resume((error) => failures.push(error));
      expect(failures).toEqual([]);
      expect([...cache.usageFiles(target)]).toEqual([]);
      await expect(readFile(cached.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sibling.path, "utf8")).toBe("cached second project");
      expect(await readFile(assets.path(asset.id), "utf8")).toBe("retained source bytes");
      expect(projects.deletionsPage().projectIds).toEqual([]);
      await expect(readFile(unfinishedPicture)).rejects.toMatchObject({ code: "ENOENT" });
      expect(index.metadata(siblingIndex)).toEqual(siblingMetadata);
      expect(
        catalog.catalog
          .prepare(
            "SELECT generation FROM screenshot_index_generations WHERE ownerKind='project' AND ownerId=?",
          )
          .all(target.projectId),
      ).toEqual([]);
      expect(assets.references(asset.id)).toEqual([
        { kind: "revision", id: second.revision.revisionId },
      ]);
      expect(assets.get(asset.id)).toEqual(asset);
      expect(() => queue.job(job.jobId)).toThrow(/not found|does not exist/i);
      expect(projects.revision(two.project.projectId)).toEqual(second.revision);
      expect(await resumed.delete({ kind: "project", id: target.projectId })).toEqual({
        projectId: target.projectId,
        deleted: true,
        freedBytes: 0,
      });
    } finally {
      await resumed.close();
    }
  } finally {
    releaseRead?.();
    delivery.dispose();
    exit.resolve();
    await deletion.close();
    await queue.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("project plans resume every phase boundary with the real retirement registration", async () => {
  const boundaries: Array<[DeletionPhase, "before" | "after"]> = [
    ["check", "before"],
    ["plan", "before"],
    ["plan", "after"],
    ["tombstone", "before"],
    ["tombstone", "after"],
    ["drain", "before"],
    ["drain", "after"],
    ["files", "before"],
    ["files", "after"],
    ["rows", "before"],
    ["rows", "after"],
    ["clear", "before"],
    ["clear", "after"],
  ];
  for (const [failedPhase, failedTiming] of boundaries) {
    const home = await mkdtemp(join(tmpdir(), "sr-project-plan-"));
    let armed = true;
    const first = await projectPlanFixture(home, (phase, _subject, timing) => {
      if (armed && phase === failedPhase && timing === failedTiming) {
        armed = false;
        throw new Error(`fault:${phase}:${timing}`);
      }
    });
    const project = first.projects.create({
      requestId: "phase-plan",
      canvas: {
        width: 160,
        height: 96,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    }).project;
    await expect(
      first.deletion.delete({ kind: "project", id: project.projectId }),
    ).rejects.toMatchObject({
      code: "DELETE_FAILED",
    });
    await first.close();
    const resumed = await projectPlanFixture(home);
    const failures: unknown[] = [];
    await resumed.deletion.resume((error) => failures.push(error));
    if (failedPhase === "check" || failedPhase === "plan")
      await expect(
        resumed.deletion.delete({ kind: "project", id: project.projectId }),
      ).resolves.toMatchObject({ projectId: project.projectId, deleted: true });
    expect(failures, `${failedPhase}:${failedTiming}`).toEqual([]);
    expect(resumed.projects.deletionsPage().projectIds).toEqual([]);
    expect(resumed.catalog.catalog.prepare("SELECT * FROM deletion_plans").all()).toEqual([]);
    expect(
      resumed.catalog.catalog
        .prepare("SELECT * FROM project_revisions WHERE projectId=?")
        .all(project.projectId),
    ).toEqual([]);
    await resumed.close();
    await rm(home, { recursive: true, force: true });
  }
});

function projectStoreFixture(catalog: Catalog, assets: AssetStore, home: string) {
  const acquisitions = new AcquisitionStore(catalog);
  return new ProjectStore(
    catalog,
    assets,
    new TranscriptStore(catalog, home, assetTranscriptOwner(assets, acquisitions)),
    acquisitions,
  );
}

async function projectPlanFixture(home: string, fault?: DeletionFault) {
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  const projects = projectStoreFixture(catalog, assets, home);
  const queue = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin(target) {
        if (target.kind !== "project") throw new Error("Expected project");
        projects.revision(target.projectId, target.revisionId);
        return target;
      },
      isAvailable(target) {
        if (target.kind !== "project") return false;
        try {
          projects.revision(target.projectId, target.revisionId);
          return true;
        } catch {
          return false;
        }
      },
      isDeleting: (owner) => owner.kind === "project" && projects.isDeleting(owner.projectId),
      isCapturing: () => false,
    },
    execute: async () => "ready",
  });
  const cache = new DerivedCache(catalog, home, (owner) => {
    if (owner.kind !== "project") throw new Error("Expected project cache owner");
    projects.get(owner.projectId);
  });
  await cache.reconcile();
  const deletion = new LibraryDeletion(new DeletionPlans(catalog), fault ? { fault } : {});
  deletion.register(
    projectRetirement({
      catalog,
      store: projects,
      jobs: queue,
      cache,
      files: { removeCacheFiles: async () => {} },
      delivery: new DerivativeDelivery(),
      exports: { retireOwner: async () => {} },
      index: { reclaim: async () => {} } as unknown as ScreenshotIndexStore<ProjectIndexRecords>,
      freedBytes: () => 0,
    }),
  );
  return {
    catalog,
    projects,
    deletion,
    async close() {
      await deletion.close();
      await queue.close();
      catalog.close();
    },
  };
}
