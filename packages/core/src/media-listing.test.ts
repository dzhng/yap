import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { CaptureStore } from "./capture-store.js";
import { DeletionPlans } from "./deletion-plans.js";
import { MediaListing } from "./media-listing.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(
  sizeOf: (subject: { kind: "recording" | "asset"; id: string }) => number = () => 0,
) {
  const root = await mkdtemp(join("/tmp", "yap-media-listing-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const catalog = new CaptureStore(join(root, "catalog.sqlite"), {
    now: () => "2026-01-01T00:00:00.000Z",
    newId: randomUUID,
  });
  cleanup.push(async () => catalog.close());
  catalog.catalog.exec(
    `CREATE TABLE assets (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, metadata TEXT NOT NULL); CREATE TABLE asset_origins (assetId TEXT NOT NULL, provenance TEXT NOT NULL);`,
  );
  const plans = new DeletionPlans(catalog);
  const listing = new MediaListing(catalog, plans, sizeOf, (recordingId) =>
    catalog.listable(recordingId),
  );
  return { catalog, listing, plans };
}

function insertAsset(catalog: CaptureStore, assetId: string, createdAt: string, source: string) {
  catalog.catalog.prepare("INSERT INTO assets(id,metadata) VALUES(?,?)").run(
    assetId,
    JSON.stringify({
      id: assetId,
      bytes: 7,
      createdAt,
      fileName: `${assetId}.mov`,
      originUs: 0,
      streams: [
        { id: "v", kind: "video", codec: "fixture", decodable: true, startUs: 0, endUs: 500 },
      ],
    }),
  );
  catalog.catalog
    .prepare("INSERT INTO asset_origins(assetId,provenance) VALUES(?,?)")
    .run(assetId, JSON.stringify({ kind: "import", source }));
}

test("media listing measures only rows returned on the page", async () => {
  const measured: string[] = [];
  const { catalog, listing } = await fixture((subject) => {
    measured.push(`${subject.kind}:${subject.id}`);
    return 1;
  });
  insertAsset(catalog, "asset-a", "2026-01-02T00:00:00.000Z", "/imports/a.mov");
  insertAsset(catalog, "asset-b", "2026-01-01T00:00:00.000Z", "/imports/b.mov");
  listing.list({ limit: 1 });
  expect(measured).toEqual(["asset:asset-a"]);
});

test("media listing merges imports and recordings newest first and continues across equal timestamps", async () => {
  const { catalog, listing } = await fixture();
  const first = catalog.allocate().recording;
  const second = catalog.allocate().recording;
  catalog.catalog
    .prepare("UPDATE recordings SET createdAt=? WHERE recordingId=?")
    .run("2026-01-03T00:00:00.000Z", first.recordingId);
  catalog.catalog
    .prepare("UPDATE recordings SET createdAt=? WHERE recordingId=?")
    .run("2026-01-02T00:00:00.000Z", second.recordingId);
  for (const [recordingId, sourceId, duration] of [
    [first.recordingId, first.sourceId, 100],
    [second.recordingId, second.sourceId, 200],
  ] as const) {
    catalog.ingestLifecycle(recordingId, { sourceId, sequence: 1, state: "recording" });
    catalog.ingestLifecycle(recordingId, { sourceId, sequence: 2, state: "finalizing" });
    catalog.ingestLifecycle(recordingId, {
      sourceId,
      sequence: 3,
      state: "complete",
      sourceDurationUs: duration,
    });
  }
  insertAsset(catalog, "asset-1", "2026-01-02T00:00:00.000Z", "/imports/photo.mov");

  const all: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = listing.list({ ...(cursor === undefined ? {} : { cursor }), limit: 1 });
    all.push(
      ...page.media.map(
        (row) => `${row.kind}:${"recordingId" in row ? row.recordingId : row.assetId}`,
      ),
    );
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  expect(all).toEqual([
    `recording:${first.recordingId}`,
    `imported:asset-1`,
    `recording:${second.recordingId}`,
  ]);

  const pair = listing.list({ limit: 2 });
  expect(pair.media).toHaveLength(2);
  expect(pair.nextCursor).toBeTruthy();
  const continued = listing.list({ cursor: pair.nextCursor!, limit: 2 });
  expect(continued.media).toHaveLength(1);
  expect(continued.nextCursor).toBeNull();
  expect([
    ...pair.media.map(
      (row) => `${row.kind}:${"recordingId" in row ? row.recordingId : row.assetId}`,
    ),
    ...continued.media.map(
      (row) => `${row.kind}:${"recordingId" in row ? row.recordingId : row.assetId}`,
    ),
  ]).toEqual(all);
});

test("media listing excludes copies, derivatives, canceled takes and tombstoned rows while preferring import provenance", async () => {
  const { catalog, listing, plans } = await fixture();
  const canceled = catalog.allocate().recording;
  catalog.ingestLifecycle(canceled.recordingId, {
    sourceId: canceled.sourceId,
    sequence: 1,
    state: "canceled",
  });
  const tombstonedRecording = catalog.allocate().recording;
  catalog.ingestLifecycle(tombstonedRecording.recordingId, {
    sourceId: tombstonedRecording.sourceId,
    sequence: 1,
    state: "recording",
  });
  catalog.ingestLifecycle(tombstonedRecording.recordingId, {
    sourceId: tombstonedRecording.sourceId,
    sequence: 2,
    state: "finalizing",
  });
  catalog.ingestLifecycle(tombstonedRecording.recordingId, {
    sourceId: tombstonedRecording.sourceId,
    sequence: 3,
    state: "complete",
    sourceDurationUs: 1,
  });
  plans.adopt("recording", tombstonedRecording.recordingId);

  const insert = (assetId: string, origins: unknown[]) => {
    insertAsset(catalog, assetId, "2026-01-05T00:00:00.000Z", `/imports/${assetId}.mov`);
    catalog.catalog.prepare("DELETE FROM asset_origins WHERE assetId=?").run(assetId);
    const statement = catalog.catalog.prepare(
      "INSERT INTO asset_origins(assetId,provenance) VALUES(?,?)",
    );
    for (const origin of origins) statement.run(assetId, JSON.stringify(origin));
  };
  insert("capture-copy", [{ kind: "capture", source: "take" }]);
  insert("hdr-derived", [{ kind: "hdr-conversion", source: { assetId: "source" } }]);
  insert("voice-derived", [{ kind: "voice-generation", modelId: "model" }]);
  insert("both-origins", [
    { kind: "capture", source: "take" },
    { kind: "import", source: "/originals/clip.mov" },
  ]);
  insert("tombstoned-asset", [{ kind: "import", source: "/originals/deleted.mov" }]);
  plans.adopt("asset", "tombstoned-asset");

  const result = listing.list({ limit: 100 });
  expect(result.media.map((row) => ("assetId" in row ? row.assetId : row.recordingId))).toEqual([
    "both-origins",
  ]);
  expect(result.media[0]).toMatchObject({
    kind: "imported",
    assetId: "both-origins",
    title: "clip.mov",
  });
});
