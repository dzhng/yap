import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { catalogFormat, minimumSupportedCatalogFormat } from "./catalog.js";
import { CaptureStore } from "./capture-store.js";

const roots: string[] = [];
const stores: CaptureStore[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yap-capture-facts-"));
  roots.push(root);
  let id = 0;
  const path = join(root, "catalog.sqlite");
  const providers = { now: () => "2026-10-01T00:00:00.000Z", newId: () => `take-${++id}` };
  const store = new CaptureStore(path, providers);
  stores.push(store);
  return { store, path, providers };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("camera allocation is durable and cannot change on a replay", () => {
  const { store, path, providers } = fixture();
  const request = {
    requestId: "selected-camera",
    arguments: JSON.stringify(["screen", "camera-a"]),
    cameraDeviceId: "camera-a",
  };
  const allocated = store.allocate(request).recording;
  expect(allocated.camera).toEqual({ sourceId: "take-3", deviceId: "camera-a" });
  expect(allocated.camera?.sourceId).not.toBe(allocated.sourceId);
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  expect(reopened.allocate(request)).toEqual({ recording: allocated, replay: true });
  expect(() => reopened.allocate({ ...request, cameraDeviceId: "camera-b" })).toThrowError(
    expect.objectContaining({ code: "REQUEST_CONFLICT" }),
  );
  expect(reopened.get(allocated.id)).toEqual(allocated);
  expect(reopened.allocate().recording.camera).toBeNull();
});

test("physical closure makes a published camera eligible while primary publication is pending", () => {
  const { store, path, providers } = fixture();
  const recording = store.allocate({
    requestId: "independent-camera",
    arguments: "camera-a",
    cameraDeviceId: "camera-a",
  }).recording;
  const { id: recordingId, sourceId, camera } = recording;
  if (!camera) throw new Error("Missing camera allocation");
  const identity = { bytes: 10, sha256: "a".repeat(64) };
  const receipt = {
    kind: "camera",
    sourceId: camera.sourceId,
    sourceDurationUs: 100,
    originHostUs: 200,
    binding: { recordingId, sourceId: camera.sourceId, deviceId: camera.deviceId },
    journal: { file: "capture.journal.jsonl", ...identity, lastSequence: 3, layout: 1 },
    members: Object.fromEntries(
      ["video.mov", "camera.publication.json", "camera.mapping.jsonl"].map((name) => [
        name,
        { ...identity, bytes: "10" },
      ]),
    ),
  };
  const publication = {
    generation: "native-generation",
    sourceId,
    inputsClosed: false,
    primary: null,
    camera: null,
  };
  store.ingestLifecycle(recordingId, { sourceId, sequence: 1, state: "recording", publication });
  expect(store.isCapturing()).toBe(true);
  expect(() => store.publishedSource(recordingId, camera.sourceId)).toThrowError(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  const closed = {
    ...publication,
    inputsClosed: true,
    primary: {
      state: "pending",
      error: { code: "IO_ERROR", message: "Primary output held", retryable: true },
    },
    camera: { state: "published", source: receipt },
  };
  const finalizing = store.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 2,
    state: "finalizing",
    publication: closed,
  });
  expect(finalizing.state).toBe("finalizing");
  expect(finalizing.sourceDurationUs).toBeNull();
  expect(store.isCapturing()).toBe(false);
  expect(store.publishedSource(recordingId, camera.sourceId)).toEqual(receipt);
  expect(() => store.publishedSource(recordingId, sourceId)).toThrowError(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  store.catalog
    .prepare(
      "UPDATE recordings SET publication=json_set(publication,'$.observation.primary.error.retryable',json('false')) WHERE recordingId=?",
    )
    .run(recordingId);
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  expect(reopened.publishedSource(recordingId, camera.sourceId)).toEqual(receipt);
  expect(reopened.get(recordingId).publication).toEqual(closed);
  expect(reopened.isCapturing()).toBe(false);
  const retrying = {
    ...closed,
    primary: { state: "unavailable", error: { code: "NO_VIDEO", message: "Primary has no video" } },
    camera: {
      state: "pending",
      error: { code: "IO_ERROR", message: "Camera cannot be reread", retryable: true },
    },
  };
  reopened.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 3,
    state: "finalizing",
    publication: retrying,
  });
  expect(() => reopened.publishedSource(recordingId, camera.sourceId)).toThrowError(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  expect(() =>
    reopened.ingestLifecycle(recordingId, {
      sourceId,
      sequence: 4,
      state: "finalizing",
      publication: {
        ...retrying,
        camera: { state: "published", source: { ...receipt, originHostUs: 201 } },
      },
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
  expect(reopened.get(recordingId).publication).toEqual(retrying);
  reopened.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 4,
    state: "finalizing",
    publication: { ...retrying, camera: closed.camera },
  });
  expect(reopened.publishedSource(recordingId, camera.sourceId)).toEqual(receipt);
  const changed = {
    ...retrying,
    camera: {
      state: "unavailable",
      error: {
        code: "INVALID_JOURNAL_PREFIX",
        message: "Camera authority changed",
      },
    },
  };
  reopened.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 5,
    state: "finalizing",
    publication: changed,
  });
  expect(reopened.get(recordingId).publication).toEqual(changed);
  expect(() => reopened.publishedSource(recordingId, camera.sourceId)).toThrowError(
    expect.objectContaining({ code: "UNAVAILABLE" }),
  );
});

test("fresh capture settles and reopens without creating a revision or project", () => {
  const { store, path, providers } = fixture();
  const request = { requestId: "capture-one", arguments: "selected-screen-and-audio" };
  const allocated = store.allocate(request).recording;
  const { id: recordingId, sourceId } = allocated;
  const journal = [
    { sourceId, sequence: 1, state: "recording" as const },
    { sourceId, sequence: 2, state: "paused" as const },
    { sourceId, sequence: 3, state: "recording" as const },
    { sourceId, sequence: 4, state: "finalizing" as const },
  ];
  expect(journal.map((event) => store.ingestLifecycle(recordingId, event).state)).toEqual([
    "recording",
    "paused",
    "recording",
    "finalizing",
  ]);
  const terminal = { sourceId, sequence: 5, state: "complete" as const, sourceDurationUs: 1200 };
  const expected = {
    ...allocated,
    state: "complete",
    lifecycleSequence: 5,
    sourceDurationUs: 1200,
  };
  expect(store.ingestLifecycle(recordingId, terminal)).toEqual(expected);
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  expect(reopened.allocate(request)).toEqual({ recording: expected, replay: true });
  expect(() => reopened.allocate({ ...request, arguments: "another-screen" })).toThrowError(
    expect.objectContaining({ code: "REQUEST_CONFLICT" }),
  );
  for (const event of journal)
    expect(reopened.ingestLifecycle(recordingId, event)).toEqual(expected);
  expect(reopened.ingestLifecycle(recordingId, terminal)).toEqual(expected);
  expect(() =>
    reopened.ingestLifecycle(recordingId, { ...terminal, sequence: 6, sourceDurationUs: 1300 }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_STATE" }));
  expect(reopened.get(recordingId)).toEqual(expected);
  expect(reopened.latest()).toEqual(expected);
  expect(reopened.list()).toEqual({ recordings: [expected], nextCursor: null });
  expect(reopened.unsettled()).toEqual([]);
  expect(Object.hasOwn(reopened.get(recordingId), "currentRevisionId")).toBe(false);
  expect(
    reopened.catalog
      .prepare("PRAGMA table_info(recordings)")
      .all()
      .map((column) => column.name),
  ).not.toContain("currentRevisionId");
  expect(
    reopened.catalog
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('revisions','edit_requests','undo_stack','projects','project_revisions')",
      )
      .all(),
  ).toEqual([]);
});

test("invalid source durations leave capture facts unchanged and no-video remains final", () => {
  const { store } = fixture();
  const recording = store.allocate().recording;
  for (const duration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => store.registerSource(recording.id, duration)).toThrowError(
      expect.objectContaining({ code: "INVALID_RANGE" }),
    );
    expect(store.get(recording.id)).toEqual(recording);
  }
  const terminal = store.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "interrupted",
    reason: "NO_VIDEO",
    sourceDurationUs: null,
  });
  expect(terminal).toEqual({
    ...recording,
    state: "interrupted",
    lifecycleSequence: 1,
    interruptionReason: "NO_VIDEO",
  });
  expect(store.latest()).toEqual(terminal);
  expect(store.list().recordings).toEqual([terminal]);
  const contradicted = expect.objectContaining({
    code: "INVALID_STATE",
    details: { state: "interrupted", interruptionReason: "NO_VIDEO" },
  });
  expect(() => store.registerSource(recording.id, 1200)).toThrowError(contradicted);
  expect(() =>
    store.ingestLifecycle(recording.id, {
      sourceId: recording.sourceId,
      sequence: 2,
      state: "interrupted",
      reason: "recovered_prefix",
      sourceDurationUs: 8,
    }),
  ).toThrowError(contradicted);
  expect(store.get(recording.id)).toEqual(terminal);
});

test("fresh deletion fences replay across reopen and removes only the named capture", () => {
  const { store, path, providers } = fixture();
  const sibling = store.allocate().recording;
  const request = { requestId: "discard-one", arguments: "screen" };
  const take = store.allocate(request).recording;
  expect(() => store.finishDeletion(take.id)).toThrowError(
    expect.objectContaining({ code: "INVALID_STATE" }),
  );
  expect(store.markDeleting(take.id)).toEqual(take);
  const canceled = store.settleDeletingCapture(take.id);
  expect(canceled).toEqual({ ...take, state: "canceled" });
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  expect(reopened.deleting(take.id)).toEqual(canceled);
  expect(reopened.unsettled()).toEqual([sibling]);
  expect(reopened.list()).toEqual({ recordings: [sibling], nextCursor: null });
  expect(() => reopened.allocate(request)).toThrowError(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  reopened.finishDeletion(take.id);
  reopened.finishDeletion(take.id);
  expect(reopened.deleting(take.id)).toBeNull();
  expect(reopened.deletionsPage()).toEqual({ recordings: [], nextAfterId: null });
  expect(reopened.get(sibling.id)).toEqual(sibling);
});

test("terminal diagnostics survive reopen and duplicate journal delivery", () => {
  const { store, path, providers } = fixture();
  const take = store.allocate().recording;
  const event = {
    sourceId: take.sourceId,
    sequence: 1,
    state: "interrupted" as const,
    reason: "AUDIO_WRITE_FAILED",
    message: "Narration stopped after a disk write failed.",
    sourceDurationUs: null,
  };
  store.ingestLifecycle(take.id, event);
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  const expected = {
    interruptionReason: event.reason,
    interruptionMessage: event.message,
    sourceDurationUs: null,
  };
  expect(reopened.get(take.id)).toMatchObject(expected);
  expect(reopened.latest()).toMatchObject(expected);
  expect(reopened.list().recordings[0]).toMatchObject(expected);
  expect(reopened.ingestLifecycle(take.id, { ...event, message: "duplicate" })).toMatchObject(
    expected,
  );
  const withVideo = reopened.allocate().recording;
  reopened.ingestLifecycle(withVideo.id, {
    ...event,
    sourceId: withVideo.sourceId,
    sourceDurationUs: 100,
  });
  expect(reopened.get(withVideo.id)).toMatchObject({
    interruptionReason: event.reason,
    interruptionMessage: event.message,
  });
});
test("new incomplete allocation remains latest ahead of a finalized older take", () => {
  const { store } = fixture();
  const first = store.allocate().recording;
  store.registerSource(first.id, 20);
  const second = store.allocate().recording;
  expect(store.latest()).toEqual({ ...second, sourceDurationUs: null });
  expect(store.get(first.id)).toEqual({
    ...first,
    sourceDurationUs: 20,
  });
  expect(second.state).toBe("preparing");
  expect(second.lifecycleSequence).toBe(0);
  expect(second.creationSequence).toBeGreaterThan(first.creationSequence);
});

test("a settled take keeps its outcome when late or contradicting reports arrive", () => {
  const { store } = fixture();
  const { id: recordingId, sourceId } = store.allocate().recording;
  store.ingestLifecycle(recordingId, { sourceId, sequence: 4, state: "recording" });
  store.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 6,
    state: "interrupted",
    reason: "service_died",
    sourceDurationUs: 8,
  });
  const settled = store.get(recordingId);
  expect(settled).toEqual(
    expect.objectContaining({
      state: "interrupted",
      interruptionReason: "service_died",
      sourceDurationUs: 8,
      lifecycleSequence: 6,
    }),
  );
  expect(
    store.ingestLifecycle(recordingId, {
      sourceId,
      sequence: 5,
      state: "complete",
      sourceDurationUs: 20,
    }),
  ).toEqual(settled);
  expect(() =>
    store.ingestLifecycle(recordingId, {
      sourceId,
      sequence: 7,
      state: "complete",
      sourceDurationUs: 20,
    }),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_STATE",
      details: { state: "interrupted", reportedState: "complete" },
    }),
  );
  expect(() =>
    store.ingestLifecycle(recordingId, {
      sourceId,
      sequence: 8,
      state: "interrupted",
      reason: "no_decodable_video",
      sourceDurationUs: null,
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_STATE", details: { sourceDurationUs: 8 } }));
  expect(store.get(recordingId)).toEqual(settled);
});

test("a discarded take refuses a source registered after the fact", () => {
  const { store } = fixture();
  const { id: recordingId, sourceId } = store.allocate().recording;
  store.ingestLifecycle(recordingId, { sourceId, sequence: 1, state: "canceled" });
  expect(() => store.registerSource(recordingId, 20)).toThrow(
    expect.objectContaining({ code: "INVALID_STATE", details: { state: "canceled" } }),
  );
  expect(store.get(recordingId)).toEqual(expect.objectContaining({ sourceDurationUs: null }));
});

test("an event stamped with another capture session leaves the recording untouched", () => {
  const { store } = fixture();
  const first = store.allocate().recording;
  const second = store.allocate().recording;
  expect(() =>
    store.ingestLifecycle(first.id, {
      sourceId: second.sourceId,
      sequence: 1,
      state: "recording",
    }),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_STATE",
      details: { sourceId: first.sourceId, reportedSourceId: second.sourceId },
    }),
  );
  expect(store.get(first.id)).toEqual(first);
});

test("a completion for a take that never started capturing leaves all source facts unchanged", () => {
  const { store } = fixture();
  const { id: recordingId, sourceId } = store.allocate().recording;
  expect(() =>
    store.ingestLifecycle(recordingId, {
      sourceId,
      sequence: 1,
      state: "complete",
      sourceDurationUs: 20,
    }),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_STATE",
      details: { state: "preparing", reportedState: "complete" },
    }),
  );
  expect(store.get(recordingId)).toEqual(
    expect.objectContaining({ state: "preparing", sourceDurationUs: null, lifecycleSequence: 0 }),
  );
});

test("recording pages keep newest-first identity across new takes, source updates and relaunch", () => {
  const { store, path, providers } = fixture();
  const oldest = store.allocate().recording;
  store.registerSource(oldest.id, 20);
  const canceled = store.allocate().recording;
  store.ingestLifecycle(canceled.id, {
    sourceId: canceled.sourceId,
    sequence: 1,
    state: "canceled",
  });
  const middle = store.allocate().recording;
  const newest = store.allocate().recording;
  const first = store.list(null, 1);
  expect(first.recordings).toEqual([newest]);
  expect(first.nextCursor).not.toBeNull();
  const added = store.allocate().recording;
  store.ingestLifecycle(oldest.id, {
    sourceId: oldest.sourceId,
    sequence: 1,
    state: "interrupted",
    sourceDurationUs: 20,
    reason: "SOURCE_LOST",
  });
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  const rest = reopened.list(first.nextCursor, 2);
  expect(rest.recordings.map((recording) => recording.id)).toEqual([middle.id, oldest.id]);
  expect(rest.recordings[1]).toMatchObject({
    state: "interrupted",
    sourceDurationUs: 20,
    interruptionReason: "SOURCE_LOST",
  });
  expect(rest.nextCursor).toBeNull();
  expect(reopened.list(null, 1).recordings).toEqual([added]);
});

test("recording discovery uses the shared default page bound", () => {
  const { store } = fixture();
  expect(store.list()).toEqual({ recordings: [], nextCursor: null });
  const recordings = Array.from({ length: 21 }, () => store.allocate().recording);
  const first = store.list();
  expect(first.recordings).toEqual(recordings.reverse());
  expect(first.nextCursor).toBeNull();
  expect(() => store.list(null, 1001)).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
});

test("listable hides a recording once its deletion marker exists", () => {
  const { store } = fixture();
  const recording = store.allocate().recording;
  expect(store.listable(recording.id)).toBe(true);
  store.catalog.prepare("INSERT INTO recording_deletions(recordingId) VALUES(?)").run(recording.id);
  expect(store.listable(recording.id)).toBe(false);
  expect(store.list().recordings).toEqual([]);
});

test("an allocation request is a durable receipt that replays and refuses different arguments", () => {
  const { store, path, providers } = fixture();
  const window = JSON.stringify(["window", 7, false]);
  const first = store.allocate({ requestId: "take-1", arguments: window });
  expect(first.replay).toBe(false);
  expect(store.allocate({ requestId: "take-1", arguments: window })).toEqual({
    recording: first.recording,
    replay: true,
  });
  // The same request ID asking for a different take is a caller mistake, not a second take.
  expect(() =>
    store.allocate({ requestId: "take-1", arguments: JSON.stringify(["window", 7, true]) }),
  ).toThrow(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
  expect(store.latest()).toEqual(first.recording);
  // A request with no receipt of its own is always a fresh take.
  expect(store.allocate({ requestId: "take-2", arguments: window }).replay).toBe(false);
  expect(store.allocate().replay).toBe(false);

  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  expect(reopened.allocate({ requestId: "take-1", arguments: window })).toEqual({
    recording: first.recording,
    replay: true,
  });
  expect(() =>
    reopened.allocate({ requestId: "take-1", arguments: JSON.stringify(["display", 1, false]) }),
  ).toThrow(expect.objectContaining({ code: "REQUEST_CONFLICT" }));
});

test("a pre-launch catalog is refused without mutating its bytes", () => {
  const { store, path, providers } = fixture();
  const { recording } = store.allocate();
  store.registerSource(recording.id, 20);
  store.close();
  const reopened = new CaptureStore(path, providers);
  expect(reopened.get(recording.id).sourceDurationUs).toBe(20);
  reopened.close();
  const prior = join(roots.at(-1)!, "prior.sqlite");
  const old = new DatabaseSync(prior);
  old.exec("PRAGMA user_version=28");
  old.close();
  const priorBytes = readFileSync(prior);
  expect(() => new CaptureStore(prior, providers)).toThrow(
    expect.objectContaining({
      code: "UNSUPPORTED_CATALOG",
      details: { format: 28, supportedFormat: catalogFormat },
    }),
  );
  expect(readFileSync(prior)).toEqual(priorBytes);
  for (const format of [
    ...Array.from({ length: minimumSupportedCatalogFormat }, (_, format) => format),
    catalogFormat + 1,
    2147483647,
  ]) {
    const other = new DatabaseSync(path);
    other.exec(`PRAGMA user_version=${format}`);
    other.close();
    const before = readFileSync(path);
    expect(() => new CaptureStore(path, providers)).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_CATALOG" }),
    );
    expect(readFileSync(path).equals(before)).toBe(true);
  }
});

test("deletion intent hides a take and fences replay and late source publication across restart", () => {
  const { store, path, providers } = fixture();
  const older = store.allocate().recording;
  const request = { requestId: "delete-me", arguments: "capture" };
  const recording = store.allocate(request).recording;
  store.registerSource(recording.id, 20);
  expect(store.markDeleting(recording.id)?.id).toBe(recording.id);
  expect(store.markDeleting(recording.id)?.sourceId).toBe(recording.sourceId);
  expect(store.markDeleting("absent")).toBeNull();
  expect(store.latest()).toEqual(older);
  expect(store.list().recordings).toEqual([older]);
  expect(() => store.get(recording.id)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(() => store.allocate(request)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(() => store.registerSource(recording.id, 20)).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  expect(() =>
    store.ingestLifecycle(recording.id, {
      sourceId: recording.sourceId,
      sequence: 1,
      state: "recording",
    }),
  ).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(store.settleDeletingCapture(recording.id)).toMatchObject({
    state: "canceled",
    sourceDurationUs: 20,
  });
  expect(store.isDeleting(recording.id)).toBe(true);
  expect(store.unsettled()).toEqual([older]);
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  expect(reopened.deleting(recording.id)?.sourceId).toBe(recording.sourceId);
  expect(() => reopened.get(recording.id)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  expect(reopened.latest()).toEqual(older);
});

test("final deletion requires intent and rolls back if another owner retains a reference", () => {
  const { store } = fixture();
  const first = store.allocate().recording,
    sibling = store.allocate().recording;
  store.registerSource(first.id, 20);
  expect(() => store.finishDeletion(first.id)).toThrowError(
    expect.objectContaining({ code: "INVALID_STATE" }),
  );
  store.catalog.exec(
    "CREATE TABLE deletion_sentinel(recordingId TEXT REFERENCES recordings(recordingId))",
  );
  store.catalog.prepare("INSERT INTO deletion_sentinel VALUES(?)").run(first.id);
  store.markDeleting(first.id);
  expect(() => store.finishDeletion(first.id)).toThrow();
  expect(store.deleting(first.id)?.sourceId).toBe(first.sourceId);
  expect(store.deleting(first.id)?.sourceDurationUs).toBe(20);
  store.catalog.exec("DELETE FROM deletion_sentinel");
  store.finishDeletion(first.id);
  store.finishDeletion(first.id);
  expect(store.deleting(first.id)).toBeNull();
  expect(store.isDeleting(first.id)).toBe(false);
  expect(store.get(sibling.id)).toEqual(sibling);
  for (const table of ["recordings", "recording_deletions"])
    expect(
      store.catalog.prepare(`SELECT count(*) AS n FROM ${table} WHERE recordingId=?`).get(first.id),
    ).toEqual({ n: 0 });
});

test("deletion replay pages use stable recording IDs and survive restart", () => {
  const { store, path, providers } = fixture();
  const records = Array.from({ length: 5 }, () => store.allocate().recording);
  for (const recording of [records[3]!, records[0]!, records[4]!]) store.markDeleting(recording.id);
  const expected = [records[0]!, records[3]!, records[4]!].sort((a, b) => a.id.localeCompare(b.id));
  const first = store.deletionsPage(undefined, 2);
  expect(first).toEqual({
    recordings: expected.slice(0, 2),
    nextAfterId: expected[1]!.id,
  });
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  reopened.finishDeletion(expected[0]!.id);
  expect(reopened.deletionsPage(first.nextAfterId!, 2)).toEqual({
    recordings: [expected[2]],
    nextAfterId: null,
  });
  expect(() => reopened.deletionsPage(undefined, 201)).toThrowError(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
});

test("finalization failure survives reopen and reads until an explicit attempt or terminal result", () => {
  const { store, path, providers } = fixture();
  const take = store.allocate().recording;
  const failure = {
    code: "INVALID_EVIDENCE",
    message: "Retained media needs a retry",
    retryable: true,
  };
  store.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 1,
    state: "finalizing",
    finalizationError: { ...failure, retryable: false },
  });
  store.close();
  const reopened = new CaptureStore(path, providers);
  stores.push(reopened);
  expect(reopened.get(take.id).finalizationError).toEqual(failure);
  expect(reopened.latest()!.finalizationError).toEqual(failure);
  expect(reopened.list().recordings[0]!.finalizationError).toEqual(failure);
  reopened.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 2,
    state: "finalizing",
  });
  expect(reopened.get(take.id).finalizationError).toEqual(failure);
  reopened.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 3,
    state: "finalizing",
    finalizationError: null,
  });
  expect(reopened.get(take.id).finalizationError).toBeNull();
  reopened.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 4,
    state: "finalizing",
    finalizationError: failure,
  });
  reopened.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 5,
    state: "interrupted",
    reason: "NO_SOURCE_MEDIA",
    sourceDurationUs: null,
  });
  expect(reopened.get(take.id)).toMatchObject({
    finalizationError: null,
    interruptionReason: "NO_SOURCE_MEDIA",
  });
});

test("a lifecycle write that fails after attaching the source rolls back all capture facts", () => {
  const { store } = fixture();
  const { id: recordingId, sourceId } = store.allocate().recording;
  const capturing = store.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 1,
    state: "recording",
  });
  // A real late SQLite failure occurs after the source-duration update, not at input validation.
  store.catalog.exec(`CREATE TRIGGER block_lifecycle BEFORE UPDATE OF state ON recordings
    BEGIN SELECT RAISE(ABORT, 'blocked lifecycle write'); END`);
  const terminal = {
    sourceId,
    sequence: 2,
    state: "interrupted" as const,
    reason: "writer_died",
    sourceDurationUs: 8,
  };
  expect(() => store.ingestLifecycle(recordingId, terminal)).toThrow("blocked lifecycle write");
  expect(store.get(recordingId)).toEqual(capturing);
  store.catalog.exec("DROP TRIGGER block_lifecycle");
  expect(store.ingestLifecycle(recordingId, terminal)).toEqual({
    ...capturing,
    state: "interrupted",
    lifecycleSequence: 2,
    sourceDurationUs: 8,
    interruptionReason: "writer_died",
  });
});

test("a discarded take leaves discovery while its restart request still names one new take", () => {
  const { store } = fixture();
  const older = store.allocate().recording;
  store.registerSource(older.id, 20);
  const abandoned = store.allocate({ requestId: "start-1", arguments: "{}" }).recording;
  store.ingestLifecycle(abandoned.id, {
    sourceId: abandoned.sourceId,
    sequence: 1,
    state: "recording",
  });
  store.registerSource(abandoned.id, 12);
  store.ingestLifecycle(abandoned.id, {
    sourceId: abandoned.sourceId,
    sequence: 2,
    state: "canceled",
  });
  expect(store.latest()!.id).toBe(older.id);
  const restarted = store.allocate({ requestId: "restart-1", arguments: "{}" }).recording;
  expect(restarted.id).not.toBe(abandoned.id);
  expect(store.latest()).toEqual(restarted);
  expect(store.allocate({ requestId: "restart-1", arguments: "{}" })).toEqual({
    recording: restarted,
    replay: true,
  });
  expect(store.get(abandoned.id)).toMatchObject({
    state: "canceled",
    sourceDurationUs: 12,
  });
  expect(store.isAvailable(abandoned.id)).toBe(false);
});

test("libraries from 0.1.33 on keep opening: format 29 migrates to the current format", () => {
  expect(minimumSupportedCatalogFormat).toBe(29);
  expect(catalogFormat).toBe(30);
});

test("a take whose recovery failed stops holding back an update; a take still in progress holds it", () => {
  const { store } = fixture();
  const { id: recordingId, sourceId } = store.allocate({
    requestId: "stranded",
    arguments: "screen",
  }).recording;
  store.ingestLifecycle(recordingId, { sourceId, sequence: 1, state: "recording" });
  expect(store.updateBlocked).toBe(true);
  store.ingestLifecycle(recordingId, { sourceId, sequence: 2, state: "finalizing" });
  expect(store.updateBlocked).toBe(true);
  // Recovery gave up: the take waits for an explicit retry, which an update must not wait on.
  store.ingestLifecycle(recordingId, {
    sourceId,
    sequence: 3,
    state: "finalizing",
    finalizationError: {
      code: "CAPTURE_RECOVERY_UNRESOLVED",
      message: "Recovered media could not be reconciled",
      retryable: true,
    },
  });
  expect(store.updateBlocked).toBe(false);
});
