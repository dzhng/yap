import { openDirectoryLease } from "./files.js";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CaptureStore } from "./capture-store.js";
import { CatalogError } from "./catalog.js";
import { AcquisitionStore, AcquisitionImporter } from "./acquisitions.js";
import { AssetStore } from "./assets.js";
import { SourceEvidenceStore } from "./evidence.js";
import { JobQueue } from "./jobs.js";
import type { SourceExporter } from "./source-admission.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const signal = () => new AbortController().signal;
function publication(sourceId: string) {
  const journal = JSON.stringify({ sessionID: sourceId });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    generation: `fixture-${sourceId}`,
    sourceId,
    inputsClosed: true,
    primary: {
      state: "published",
      source: {
        kind: "primary",
        sourceId,
        sourceDurationUs: 100,
        originHostUs: 0,
        journal: {
          file: "source.journal.jsonl",
          bytes: Buffer.byteLength(journal),
          sha256: hash(journal),
          lastSequence: 2,
          layout: 2,
        },
        members: { "video.mov": { bytes: "5", sha256: hash("video") } },
      },
    },
    camera: null,
  } as const;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "capture-acquisition-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let donor: string;
  async function reopen() {
    const captures = new CaptureStore(join(root, "catalog.sqlite"), {
      newId: randomUUID,
      now: () => "2026-10-01T00:00:00.000Z",
    });
    cleanup.push(async () => captures.close());
    const acquisitions = new AcquisitionStore(captures);
    const assets = new AssetStore(captures, root);
    await assets.recover();
    const evidence = new SourceEvidenceStore(captures, (identity) => {
      if (identity.owner.kind !== "acquisition") throw new Error("Wrong domain");
      acquisitions.intent(identity.owner.id);
    });
    const importer = new AcquisitionImporter(captures, acquisitions, assets, evidence, root);
    await importer.recover(signal());
    const exportSource: SourceExporter = async (
      directory,
      output,
      _signal,
      _canonical,
      _lifetimes,
      authority,
    ) => {
      const header = JSON.parse(await readFile(join(directory, "capture.journal.jsonl"), "utf8"));
      await writeFile(output, "");
      return {
        file: output,
        journal: "capture.journal.jsonl",
        header,
        originHostUs: 0,
        completion: { sequence: 2, state: "complete" as const, durationUs: 100 },
        cursorSamples: 0,
        geometryRecords: 0,
        displaySpaces: 0,
        pauseEvents: 0,
        audioIntervals: 0,
        lastSequence: 2,
        incompleteTail: false,
        finished: true,
        bytes: 0,
        ...(authority ? { verifiedSourceAuthority: authority.source } : {}),
      };
    };
    const native = {
      exportSource,
      probe: async () => ({
        originUs: 0,
        streams: [
          {
            id: "track:1",
            kind: "video",
            codec: "fixture",
            width: 16,
            height: 16,
            orientedWidth: 16,
            orientedHeight: 16,
            decodable: true,
            startUs: 0,
            endUs: 100,
            segments: [{ startUs: 0, endUs: 100, empty: false }],
          },
        ],
      }),
    };
    const queue = new JobQueue({
      store: captures,
      providers: { newId: randomUUID },
      deferExecution: true,
      targets: {
        pin(target) {
          if (target.kind !== "acquisition") throw new Error("Wrong domain");
          acquisitions.intent(target.id);
          return target;
        },
        isAvailable: (target) => target.kind === "acquisition" && !!acquisitions.intent(target.id),
        isDeleting: () => false,
        isCapturing: () => captures.isCapturing(),
      },
      execute: async ({ job, signal }) => {
        if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
        const value = await importer.executeImport(job.target.id, job.attemptId, native, signal);
        return JSON.stringify({ acquisitionId: value.id });
      },
    });
    cleanup.push(async () => {
      if (captures.catalog.isOpen) await queue.close();
    });
    return {
      captures,
      acquisitions,
      assets,
      evidence,
      importer,
      queue,
      native,
      admit: (recordingId: string, admitted?: () => void) =>
        queue.submit(() => {
          const intent = acquisitions.admitCapture(captures, recordingId, donor);
          return {
            target: { kind: "acquisition", id: intent.acquisitionId },
            artifact: "acquisition.import",
            lane: "heavy",
            input: "capture",
          };
        }, admitted),
    };
  }
  const state = await reopen();
  const recording = state.captures.allocate().recording;
  donor = join(root, "recordings", recording.id, "source");
  await mkdir(donor, { recursive: true, mode: 0o700 });
  await writeFile(
    join(donor, "source.publication.json"),
    JSON.stringify(publication(recording.sourceId).primary.source),
  );
  state.captures.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "finalizing",
  });
  state.captures.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 2,
    state: "complete",
    sourceDurationUs: 100,
    publication: publication(recording.sourceId),
  });
  return { root, donor, recording, reopen, ...state };
}

test("settled capture reserves one acquisition and job atomically before source files are opened", async () => {
  const f = await fixture();
  expect(() =>
    f.admit(f.recording.id, () => {
      throw new CatalogError("REFUSED", "Refused");
    }),
  ).toThrow("Refused");
  expect(f.captures.catalog.prepare("SELECT id FROM acquisitions").all()).toEqual([]);
  expect(f.captures.catalog.prepare("SELECT jobId FROM jobs").all()).toEqual([]);
  const job = f.admit(f.recording.id);
  expect(f.admit(f.recording.id)).toEqual(job);
  expect(job.state).toBe("queued");
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  expect(f.acquisitions.intent(job.target.id)).toMatchObject({
    kind: "capture",
    recordingId: f.recording.id,
    sourceId: f.recording.sourceId,
    path: f.donor,
    files: {},
  });
  expect(
    f.captures.catalog
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('spans','projects')")
      .all(),
  ).toEqual([]);
});

test("capture admission stages its complete private authority and strips it before READY", async () => {
  const f = await fixture();
  const source = publication(f.recording.sourceId).primary.source;
  const bytes = JSON.stringify({
    ...source,
    recovery: { fixturePrivateBasis: "must reach native intact" },
  });
  await writeFile(
    join(f.donor, "source.journal.jsonl"),
    JSON.stringify({ sessionID: f.recording.sourceId }),
  );
  await writeFile(join(f.donor, "video.mov"), "video");
  await writeFile(join(f.donor, "source.publication.json"), bytes);
  const ordinary = f.native.exportSource;
  let stage: string | undefined;
  f.native.exportSource = async (...args) => {
    stage = args[0];
    expect(await readFile(join(stage, "source.publication.json"), "utf8")).toBe(bytes);
    const authority = args[5];
    expect(authority).toEqual({
      source,
      receipt: {
        bytes: String(Buffer.byteLength(bytes)),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    return { ...(await ordinary(...args)), verifiedSourceAuthority: source };
  };
  const job = f.admit(f.recording.id);
  f.queue.start();
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({ state: "ready" });
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  expect(f.acquisitions.get(job.target.id).evidence.receipt).not.toHaveProperty(
    "verifiedSourceAuthority",
  );
  await expect(readFile(join(stage!, "source.publication.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each(["missing", "different"])(
  "capture authority verification %s refuses before READY",
  async (mode) => {
    const f = await fixture();
    await writeFile(
      join(f.donor, "source.journal.jsonl"),
      JSON.stringify({ sessionID: f.recording.sourceId }),
    );
    await writeFile(join(f.donor, "video.mov"), "video");
    const ordinary = f.native.exportSource;
    f.native.exportSource = async (...args) => {
      const { verifiedSourceAuthority, ...receipt } = await ordinary(...args);
      return mode === "missing"
        ? receipt
        : {
            ...receipt,
            verifiedSourceAuthority: {
              ...verifiedSourceAuthority!,
              sourceId: "another-source",
            },
          };
    };
    const job = f.admit(f.recording.id);
    f.queue.start();
    await f.queue.idle();
    expect(f.queue.inspect(job.jobId)).toMatchObject({
      state: "failed",
      errorCode: "SOURCE_CHANGED",
    });
    if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
    const acquisitionId = job.target.id;
    expect(() => f.acquisitions.get(acquisitionId)).toThrow();
  },
);

test("partial freeze survives relaunch; replay keeps failure and explicit retry publishes the same acquisition", async () => {
  const f = await fixture();
  await writeFile(
    join(f.donor, "source.journal.jsonl"),
    JSON.stringify({ sessionID: f.recording.sourceId }),
  );
  const job = f.admit(f.recording.id);
  f.queue.start();
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "failed",
    errorCode: "ACQUISITION_NOT_FOUND",
    retryable: true,
  });
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  const frozen = f.acquisitions.intent(job.target.id);
  expect(frozen).toMatchObject({
    files: { "capture.journal.jsonl": { bytes: expect.any(Number) } },
  });
  await f.queue.close();
  f.captures.close();
  const reopened = await f.reopen();
  expect(reopened.acquisitions.intent(job.target.id)).toEqual(frozen);
  await writeFile(join(f.donor, "video.mov"), "video");
  expect(reopened.admit(f.recording.id)).toMatchObject({
    jobId: job.jobId,
    state: "failed",
  });
  reopened.queue.start();
  await reopened.queue.idle();
  expect(reopened.queue.inspect(job.jobId).state).toBe("failed");
  reopened.queue.retry(job.jobId);
  await reopened.queue.idle();
  expect(reopened.queue.inspect(job.jobId)).toMatchObject({
    state: "ready",
    published: { output: { acquisitionId: job.target.id } },
  });
  const value = reopened.acquisitions.get(job.target.id);
  expect(value.sourceId).toBe(f.recording.sourceId);
  expect(value.bindings.map((binding) => binding.sourceRoles)).toEqual([["video"]]);
  await rm(f.donor, { recursive: true });
  expect(reopened.admit(f.recording.id)).toMatchObject({
    jobId: job.jobId,
    state: "ready",
  });
  expect(
    await reopened.importer.executeImport(value.id, "ready-replay", reopened.native, signal()),
  ).toEqual(value);
});

test("a changed frozen journal refuses before observing newly available video", async () => {
  const f = await fixture();
  const journal = join(f.donor, "source.journal.jsonl");
  await writeFile(journal, JSON.stringify({ sessionID: f.recording.sourceId }));
  const job = f.admit(f.recording.id);
  f.queue.start();
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "failed",
    errorCode: "ACQUISITION_NOT_FOUND",
  });
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  const frozen = f.acquisitions.intent(job.target.id);
  await writeFile(journal, JSON.stringify({ sessionID: "changed" }));
  await writeFile(join(f.donor, "video.mov"), "video");
  f.queue.retry(job.jobId);
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "failed",
    errorCode: "SOURCE_CHANGED",
    retryable: false,
  });
  expect(f.acquisitions.intent(job.target.id)).toEqual(frozen);
  expect(f.acquisitions.ready(job.target.id)).toBe(false);
});

test("observed optional absence cannot be replaced after a failed native attempt", async () => {
  const f = await fixture();
  await writeFile(
    join(f.donor, "source.journal.jsonl"),
    JSON.stringify({ sessionID: f.recording.sourceId }),
  );
  await writeFile(join(f.donor, "video.mov"), "video");
  const exportSource = f.native.exportSource;
  f.native.exportSource = async () => {
    throw new Error("Native unavailable");
  };
  const job = f.admit(f.recording.id);
  f.queue.start();
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({ state: "failed", retryable: true });
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  const frozen = f.acquisitions.intent(job.target.id);
  expect(frozen).toMatchObject({ files: { "narration.mov": null } });
  f.native.exportSource = exportSource;
  await writeFile(join(f.donor, "narration.mov"), "late audio");
  f.queue.retry(job.jobId);
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "failed",
    errorCode: "SOURCE_CHANGED",
    retryable: false,
  });
  expect(f.acquisitions.intent(job.target.id)).toEqual(frozen);
});

test("a foreign source journal fails before publishing evidence or assets", async () => {
  const f = await fixture();
  await writeFile(
    join(f.donor, "source.journal.jsonl"),
    JSON.stringify({ sessionID: "foreign-source" }),
  );
  await writeFile(join(f.donor, "video.mov"), "video");
  const job = f.admit(f.recording.id);
  f.queue.start();
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "failed",
    errorCode: "SOURCE_CHANGED",
    retryable: false,
    published: null,
  });
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  expect(f.acquisitions.ready(job.target.id)).toBe(false);
  expect(f.captures.catalog.prepare("SELECT id FROM assets").all()).toEqual([]);
  expect(f.captures.catalog.prepare("SELECT * FROM source_evidence_generations").all()).toEqual([]);
});

test("capture authority refuses live, canceled, no-video and foreign-connection inputs without jobs", async () => {
  const f = await fixture();
  for (const state of ["preparing", "canceled", "interrupted"] as const) {
    const recording = f.captures.allocate().recording;
    if (state === "canceled")
      f.captures.ingestLifecycle(recording.id, {
        sourceId: recording.sourceId,
        sequence: 1,
        state,
      });
    if (state === "interrupted")
      f.captures.ingestLifecycle(recording.id, {
        sourceId: recording.sourceId,
        sequence: 1,
        state,
        reason: "no-video",
        sourceDurationUs: null,
      });
    expect(() => f.admit(recording.id)).toThrow(
      expect.objectContaining({
        code: state === "preparing" ? "NOT_READY" : "UNAVAILABLE",
      }),
    );
  }
  const other = await fixture();
  expect(() =>
    f.captures.transaction(() =>
      f.acquisitions.admitCapture(other.captures, other.recording.id, other.donor),
    ),
  ).toThrow("shared catalog connection");
  expect(f.captures.catalog.prepare("SELECT id FROM acquisitions").all()).toEqual([]);
  expect(f.captures.catalog.prepare("SELECT jobId FROM jobs").all()).toEqual([]);
});

test("an interrupted take with video retains canceled work and refuses a changed path", async () => {
  const f = await fixture();
  const recording = f.captures.allocate().recording;
  f.captures.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "interrupted",
    reason: "device-disconnected",
    sourceDurationUs: 100,
    publication: publication(recording.sourceId),
  });
  const job = f.admit(recording.id);
  f.queue.cancel(job.jobId);
  expect(f.admit(recording.id)).toMatchObject({ jobId: job.jobId, state: "canceled" });
  expect(() =>
    f.captures.transaction(() =>
      f.acquisitions.admitCapture(f.captures, recording.id, join(f.root, "other")),
    ),
  ).toThrow("already names another input");
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  expect(f.acquisitions.intent(job.target.id)).toMatchObject({
    sourceId: recording.sourceId,
    path: f.donor,
    files: {},
  });
  expect(f.captures.catalog.prepare("SELECT id FROM acquisitions").all()).toEqual([
    { id: job.target.id },
  ]);
});

test.each(["source", "parent"])(
  "temporary %s directory access refusal retains frozen identity and permits explicit retry",
  async (directory) => {
    const f = await fixture();
    await writeFile(
      join(f.donor, "source.journal.jsonl"),
      JSON.stringify({ sessionID: f.recording.sourceId }),
    );
    const job = f.admit(f.recording.id);
    f.queue.start();
    await f.queue.idle();
    expect(f.queue.inspect(job.jobId)).toMatchObject({
      state: "failed",
      errorCode: "ACQUISITION_NOT_FOUND",
    });
    if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
    const frozen = f.acquisitions.intent(job.target.id);
    await writeFile(join(f.donor, "video.mov"), "video");
    const refusedDirectory = directory === "source" ? f.donor : dirname(f.donor);
    await chmod(refusedDirectory, 0);
    try {
      f.queue.retry(job.jobId);
      await f.queue.idle();
      expect(f.queue.inspect(job.jobId)).toMatchObject({
        state: "failed",
        errorCode: "ACQUISITION_PATH_UNAVAILABLE",
        retryable: true,
      });
      expect(f.acquisitions.intent(job.target.id)).toEqual(frozen);
    } finally {
      await chmod(refusedDirectory, 0o700);
    }
    expect(f.admit(f.recording.id)).toMatchObject({ jobId: job.jobId, state: "failed" });
    f.queue.retry(job.jobId);
    await f.queue.idle();
    expect(f.queue.inspect(job.jobId)).toMatchObject({
      state: "ready",
      published: { output: { acquisitionId: job.target.id } },
    });
    expect(f.acquisitions.intent(job.target.id)).toMatchObject(frozen);
  },
);

test("post-freeze donor copy access failure preserves the acquisition for explicit retry", async () => {
  const f = await fixture();
  await writeFile(
    join(f.donor, "source.journal.jsonl"),
    JSON.stringify({ sessionID: f.recording.sourceId }),
  );
  await writeFile(join(f.donor, "video.mov"), "video");
  const exportSource = f.native.exportSource;
  f.native.exportSource = async (...args) => {
    const receipt = await exportSource(...args);
    await chmod(f.donor, 0);
    return receipt;
  };
  const job = f.admit(f.recording.id);
  f.queue.start();
  let frozen;
  try {
    await f.queue.idle();
    expect(f.queue.inspect(job.jobId)).toMatchObject({
      state: "failed",
      errorCode: "ACQUISITION_PATH_UNAVAILABLE",
      retryable: true,
      published: null,
    });
    if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
    frozen = f.acquisitions.intent(job.target.id);
    expect(frozen).toMatchObject({ files: { "video.mov": { bytes: 5 }, "narration.mov": null } });
    expect(f.captures.catalog.prepare("SELECT id FROM assets").all()).toEqual([]);
    expect(f.captures.catalog.prepare("SELECT * FROM source_evidence_generations").all()).toEqual(
      [],
    );
  } finally {
    await chmod(f.donor, 0o700);
    f.native.exportSource = exportSource;
  }
  expect(f.admit(f.recording.id)).toMatchObject({ jobId: job.jobId, state: "failed" });
  f.queue.retry(job.jobId);
  await f.queue.idle();
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "ready",
    published: { output: { acquisitionId: job.target.id } },
  });
  expect(f.acquisitions.intent(job.target.id)).toEqual(frozen);
});

test("explicit imports keep their existing post-freeze donor access disposition", async () => {
  const f = await fixture();
  await writeFile(
    join(f.donor, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: f.recording.sourceId }),
  );
  await writeFile(join(f.donor, "video.mov"), "video");
  const prepared = await f.importer.prepareImport("explicit", f.donor);
  const intent = f.captures.transaction(() => f.acquisitions.admitImport(prepared));
  const exportSource = f.native.exportSource;
  f.native.exportSource = async (...args) => {
    const receipt = await exportSource(...args);
    await chmod(f.donor, 0);
    return receipt;
  };
  try {
    await expect(
      f.importer.executeImport(intent.acquisitionId, "explicit-attempt", f.native, signal()),
    ).rejects.toMatchObject({ code: "INVALID_PATH", retryable: false });
    expect(f.acquisitions.intent(intent.acquisitionId)).toEqual(intent);
  } finally {
    await chmod(f.donor, 0o700);
  }
});

test("a busy donor lease preserves frozen capture identity for explicit retry", async () => {
  const f = await fixture();
  await writeFile(
    join(f.donor, "source.journal.jsonl"),
    JSON.stringify({ sessionID: f.recording.sourceId }),
  );
  const job = f.admit(f.recording.id);
  f.queue.start();
  await f.queue.idle();
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  const frozen = f.acquisitions.intent(job.target.id);
  await writeFile(join(f.donor, "video.mov"), "video");
  const lease = await openDirectoryLease(dirname(f.donor), "exclusive");
  try {
    f.queue.retry(job.jobId);
    await f.queue.idle();
    expect(f.queue.inspect(job.jobId)).toMatchObject({
      state: "failed",
      errorCode: "RECORDING_BUSY",
      retryable: true,
    });
    expect(f.acquisitions.intent(job.target.id)).toEqual(frozen);
  } finally {
    await lease.close();
  }
  f.queue.retry(job.jobId);
  await f.queue.idle();
  expect(f.queue.inspect(job.jobId)).toMatchObject({
    state: "ready",
    published: { output: { acquisitionId: job.target.id } },
  });
});

/** A published companion camera whose native proof has one off gap (source 150..250 of 100..400). */
async function cameraTake(f: Awaited<ReturnType<typeof fixture>>) {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const identity = (value: string) => ({
    bytes: String(Buffer.byteLength(value)),
    sha256: hash(value),
  });
  const recording = f.captures.allocate({
    requestId: "camera-take",
    arguments: "camera-a",
    cameraDeviceId: "camera-a",
  }).recording;
  const camera = recording.camera!;
  const binding = { recordingId: recording.id, ...camera };
  const donor = join(f.root, "recordings", recording.id, "camera");
  await mkdir(donor, { recursive: true, mode: 0o700 });
  const bodies = {
    "capture.journal.jsonl": JSON.stringify({
      sessionID: camera.sourceId,
      schemaVersion: 1,
      source: { kind: "camera" },
      cameraBinding: binding,
    }),
    "video.mov": "video",
    "camera.publication.json": "camera receipt",
    "camera.mapping.jsonl": "camera mapping\n",
  };
  for (const [name, body] of Object.entries(bodies)) await writeFile(join(donor, name), body);
  const journal = bodies["capture.journal.jsonl"];
  const source = {
    kind: "camera" as const,
    sourceId: camera.sourceId,
    sourceDurationUs: 400,
    originHostUs: 0,
    binding,
    journal: {
      file: "capture.journal.jsonl" as const,
      bytes: Buffer.byteLength(journal),
      sha256: hash(journal),
      lastSequence: 2,
      layout: 1 as const,
    },
    members: {
      "video.mov": identity(bodies["video.mov"]),
      "camera.publication.json": identity(bodies["camera.publication.json"]),
      "camera.mapping.jsonl": identity(bodies["camera.mapping.jsonl"]),
    },
  };
  await writeFile(join(donor, "source.publication.json"), JSON.stringify(source));
  f.captures.ingestLifecycle(recording.id, {
    sourceId: recording.sourceId,
    sequence: 1,
    state: "finalizing",
    publication: {
      generation: "camera-take",
      sourceId: recording.sourceId,
      inputsClosed: true,
      primary: { state: "unavailable", error: { code: "NO_VIDEO", message: "Fixture" } },
      camera: { state: "published", source },
    },
  });
  const ordinary = f.native.exportSource;
  f.native.exportSource = async (...args) => ({
    ...(await ordinary(...args)),
    publications: {
      video: {
        canonical: source.members["video.mov"],
        receipt: source.members["camera.publication.json"],
        mapping: source.members["camera.mapping.jsonl"],
        support: { startUs: 100, endUs: 400 },
        gaps: [{ startUs: 150, endUs: 250 }],
        representedFrames: 6,
      },
    },
  });
  const job = f.queue.submit(() => {
    const intent = f.acquisitions.admitCapture(f.captures, recording.id, donor, camera.sourceId);
    return {
      target: { kind: "acquisition", id: intent.acquisitionId },
      artifact: "acquisition.import",
      lane: "heavy",
      input: "capture",
    };
  });
  if (job.target.kind !== "acquisition") throw new Error("Wrong domain");
  return { jobId: job.jobId, acquisitionId: job.target.id };
}
const cameraProbe =
  (segments: { startUs: number; endUs: number; empty: boolean }[]) => async () => ({
    originUs: 100,
    streams: [
      {
        id: "track:1",
        kind: "video",
        codec: "fixture",
        width: 16,
        height: 16,
        orientedWidth: 16,
        orientedHeight: 16,
        decodable: true,
        startUs: 0,
        endUs: 300,
        segments,
      },
    ],
  });

test("a captured camera with off time publishes its gap as unavailable acquisition support", async () => {
  const f = await fixture();
  const take = await cameraTake(f);
  f.native.probe = cameraProbe([
    { startUs: 0, endUs: 50, empty: false },
    { startUs: 50, endUs: 150, empty: true },
    { startUs: 150, endUs: 300, empty: false },
  ]);
  f.queue.start();
  await f.queue.idle();
  expect(f.queue.inspect(take.jobId)).toMatchObject({ state: "ready" });
  expect(f.acquisitions.get(take.acquisitionId).bindings).toMatchObject([
    {
      sourceRoles: ["video"],
      available: [
        { startUs: 0, endUs: 50 },
        { startUs: 150, endUs: 300 },
      ],
      supportBasis: "physical",
    },
  ]);
});

test("a captured camera movie holding a picture across its off time is refused", async () => {
  const f = await fixture();
  const take = await cameraTake(f);
  f.native.probe = cameraProbe([{ startUs: 0, endUs: 300, empty: false }]);
  f.queue.start();
  await f.queue.idle();
  expect(f.queue.inspect(take.jobId)).toMatchObject({
    state: "failed",
    errorCode: "INVALID_EVIDENCE",
    retryable: false,
  });
  expect(() => f.acquisitions.get(take.acquisitionId)).toThrow();
});
