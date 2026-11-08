import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Catalog } from "@yap/core/catalog";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { DeletionPlans } from "@yap/core/deletion-plans";
import { ResourceReferences } from "@yap/core/references";
import { acquisitionRetirement } from "./acquisition-retirement.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("an asset cascade retires its acquisition without deleting sibling assets", async () => {
  const home = await mkdtemp("/tmp/yap-acquisition-retirement-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const store = new AcquisitionStore(catalog);
  const acquisitionId = "capture-acquisition";
  catalog.catalog
    .prepare("INSERT INTO acquisitions(id,requestId,admission,metadata) VALUES(?,?,?,?)")
    .run(acquisitionId, "request", JSON.stringify({ kind: "capture", recordingId: "take" }), "{}");
  const references = new ResourceReferences(catalog);
  references.retain("asset", { kind: "acquisition", id: acquisitionId }, ["video-a", "audio-b"]);
  references.retain("asset", { kind: "revision", id: "project-p2-revision" }, ["audio-b"]);
  new DeletionPlans(catalog).adopt("asset", "video-a");
  const removed: string[] = [];
  const registration = acquisitionRetirement({
    catalog,
    store,
    importer: { purge: async () => {} },
    jobs: { drainOwner: async () => {}, forgetOwner: async () => {} } as never,
  });
  await registration.cascadeMembers!(
    { kind: "acquisition", id: acquisitionId },
    [
      { memberKind: "asset", memberId: "video-a" },
      { memberKind: "asset", memberId: "audio-b" },
    ],
    new AbortController().signal,
    async (member) => {
      removed.push(member.id);
      return {};
    },
  );
  expect(removed).toEqual([]);
  expect(references.owners("asset", "audio-b")).toEqual([
    { kind: "acquisition", id: acquisitionId },
    { kind: "revision", id: "project-p2-revision" },
  ]);
});
