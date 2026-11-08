import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Catalog, CatalogError } from "./catalog.js";
import { SourceEvidenceStore, type EvidenceIdentity } from "./evidence.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(count = 2) {
  const directory = mkdtempSync(join(tmpdir(), "evidence-owner-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const catalog = new Catalog(join(directory, "catalog.sqlite"));
  cleanup.push(() => catalog.close());
  const file = join(directory, "observations.jsonl");
  const body = Array.from(
    { length: count },
    (_, sequence) =>
      JSON.stringify({
        event: "audioAcquired",
        data: { role: "narration", startUs: sequence * 20, endUs: sequence * 20 + 10 },
      }) + "\n",
  ).join("");
  writeFileSync(file, body);
  const receipt = {
    file,
    journal: "capture.journal.jsonl",
    header: { sessionID: "session" },
    cursorSamples: 0,
    geometryRecords: 0,
    displaySpaces: 0,
    pauseEvents: 0,
    audioIntervals: count,
    lastSequence: count,
    incompleteTail: false,
    finished: true,
    bytes: Buffer.byteLength(body),
  };
  return { directory, catalog, file, receipt };
}
const identity: EvidenceIdentity = {
  owner: { kind: "acquisition", id: "same-id" },
  sourceId: "session",
  generation: "same-attempt",
};

test("one catalog isolates acquisition ownership, purges only its owner", async () => {
  const f = fixture();
  const sibling: EvidenceIdentity = {
    ...identity,
    owner: { kind: "recording", id: "same-id" },
  };
  const other: EvidenceIdentity = {
    ...identity,
    owner: { kind: "acquisition", id: "other-id" },
  };
  const store = new SourceEvidenceStore(f.catalog, ({ sourceId }) => {
    if (sourceId !== "session") throw new CatalogError("INVALID_EVIDENCE", "Unknown source");
  });
  const metadata = await store.ingest({ ...identity, file: f.file, receipt: f.receipt });
  await store.ingest({ ...sibling, file: f.file, receipt: f.receipt });
  await store.ingest({ ...other, file: f.file, receipt: f.receipt });
  const expected = [
    { startUs: 0, endUs: 10 },
    { startUs: 20, endUs: 30 },
  ];
  expect(store.audio(metadata, "narration", { startUs: 0, endUs: 40 })).toEqual(expected);
  await store.purge(identity.owner, new AbortController().signal);
  expect(() => store.audio(identity, "narration", { startUs: 0, endUs: 40 })).toThrow(
    "not indexed",
  );
  expect(store.audio(sibling, "narration", { startUs: 0, endUs: 40 })).toEqual(expected);
  expect(store.audio(other, "narration", { startUs: 0, endUs: 40 })).toEqual(expected);
});

test("an acquisition retired during ingestion cannot publish and its unfinished rows are reclaimed", async () => {
  const f = fixture(300);
  let available = true;
  const store = new SourceEvidenceStore(f.catalog, () => {
    if (!available) throw new CatalogError("NOT_FOUND", "Acquisition retired");
  });
  const work = store.ingest({ ...identity, file: f.file, receipt: f.receipt });
  setImmediate(() => {
    available = false;
  });
  await expect(work).rejects.toThrow("Acquisition retired");
  expect(() => store.audio(identity, "narration", { startUs: 0, endUs: 40 })).toThrow(
    "not indexed",
  );
  available = true;
  const retry = await store.ingest({ ...identity, file: f.file, receipt: f.receipt });
  expect(store.audio(retry, "narration", { startUs: 0, endUs: 40 })).toEqual([
    { startUs: 0, endUs: 10 },
    { startUs: 20, endUs: 30 },
  ]);
});
