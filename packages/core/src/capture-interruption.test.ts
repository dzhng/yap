import { projectStoreFixture } from "./project-store.fixture.js";
import { SourceEvents } from "./source-events.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { EditOperation } from "@yap/composition";
import { Catalog } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore, AcquisitionImporter } from "./acquisitions.js";
import { SourceEvidenceStore, type SourceEvidenceReceipt } from "./evidence.js";
import { CaptureSourceRead } from "./capture-source-read.js";
import { DerivedCache } from "./cache.js";
import { JobQueue } from "./jobs.js";
import { TranscriptStore } from "./transcript.js";
import { TranscriptProcessing, assetTranscriptOwner } from "./transcript-processing.js";
import { Models } from "./models.js";
import {
  ProjectEvidenceInspection,
  type ProjectEvidenceInput,
  type ProjectEventRow,
} from "./project-evidence.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
type Observation = { event: string; data: Record<string, unknown> };
async function fixture({
  originUs = 500,
  durationUs = 1000,
  audioEndUs = durationUs,
  supportEndUs = durationUs,
}: { originUs?: number; durationUs?: number; audioEndUs?: number; supportEndUs?: number } = {}) {
  const home = await mkdtemp("/tmp/capture-interruption-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const records = new SourceEvidenceStore(catalog, (identity) => {
    if (identity.owner.kind !== "acquisition") throw Error("Wrong owner");
    acquisitions.intent(identity.owner.acquisitionId);
  });
  const importer = new AcquisitionImporter(catalog, acquisitions, assets, records, home);
  await importer.recover(new AbortController().signal);
  const capture = new CaptureSourceRead(assets, acquisitions, records);
  const projects = projectStoreFixture(catalog, assets, home, acquisitions);
  const cache = new DerivedCache(catalog, home, (owner) => {
    if (owner.kind !== "project") throw Error("Wrong owner");
    projects.get(owner.projectId);
  });
  await cache.reconcile();
  let inspection: ProjectEvidenceInspection;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind !== "project") throw Error("No model work expected");
        return { ...target, revisionId: projects.revision(target.projectId, target.revisionId).id };
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: (execution) => inspection.execute(execution),
  });
  const transcripts = new TranscriptStore(
    catalog,
    home,
    assetTranscriptOwner(assets, acquisitions),
  );
  inspection = new ProjectEvidenceInspection({
    projects,
    assets,
    jobs,
    cache,
    events: new SourceEvents({ assets, acquisitions, capture }),
    records: transcripts,
    transcripts: new TranscriptProcessing({
      jobs,
      transcripts,
      models: new Models(home, globalThis.fetch, undefined, catalog).transcription("parakeet"),
      asset: { assets, acquisitions },
      transcribe: async () => {
        throw Error("Capture inspection cannot infer speech");
      },
    }),
  });
  cleanup.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  let reads = 0;
  const pointRecords = records.pointRecords.bind(records);
  records.pointRecords = (...args) => {
    reads++;
    return pointRecords(...args);
  };
  async function importCapture(
    rows: Observation[] = [],
    provenance: Partial<SourceEvidenceReceipt> = {},
  ) {
    const id = randomUUID(),
      donor = join(home, id);
    await mkdir(donor);
    await writeFile(join(donor, "capture.journal.jsonl"), JSON.stringify({ id, rows, provenance }));
    await writeFile(join(donor, "video.mov"), `video-${id}`);
    await writeFile(join(donor, "narration.mov"), `audio-${id}`);
    const prepared = await importer.prepareImport(id, donor);
    const intent = catalog.transaction(() => acquisitions.admitImport(prepared));
    const normalized = [
      ...rows,
      {
        event: "audioAcquired",
        data: { role: "narration", startUs: originUs, endUs: originUs + audioEndUs },
      },
    ];
    // Only native parsing/probing is controlled here; admission and retention use their actual owners.
    const acquired = await importer.executeImport(
      intent.acquisitionId,
      id,
      {
        probe: async (path) => {
          const kind = (await readFile(path, "utf8")).startsWith("video") ? "video" : "audio";
          const endUs = kind === "video" ? durationUs : audioEndUs;
          const supported = Math.min(endUs, supportEndUs);
          return {
            originUs,
            streams: [
              {
                id: "track:1",
                kind,
                ...(kind === "video" ? { orientedWidth: 64, orientedHeight: 48 } : {}),
                codec: "fixture",
                decodable: true,
                startUs: 0,
                endUs,
                segments: [
                  { startUs: 0, endUs: supported, empty: false },
                  ...(supported < endUs ? [{ startUs: supported, endUs, empty: true }] : []),
                ],
              },
            ],
          };
        },
        exportSource: async (_directory, output) => {
          const body = normalized.map((row) => JSON.stringify(row) + "\n").join("");
          await writeFile(output, body);
          return {
            normalizationVersion: 2,
            file: output,
            journal: "capture.journal.jsonl",
            header: { sessionID: id },
            cursorSamples: rows.filter((r) => r.event === "cursorSample").length,
            geometryRecords: rows.filter((r) => r.event === "geometry").length,
            displaySpaces: 0,
            pauseEvents: rows.filter((r) => r.event === "pause").length,
            audioIntervals: 1,
            lastSequence: rows.length + 10,
            incompleteTail: false,
            finished: true,
            bytes: Buffer.byteLength(body),
            ...provenance,
          };
        },
      },
      new AbortController().signal,
    );
    const select = (role: string) => {
      const binding = acquired.bindings.find((b) =>
        b.sourceRoles.includes(role as "video" | "narration"),
      )!;
      return { assetId: binding.assetId, streamId: binding.streamId, acquisitionId: acquired.id };
    };
    return { acquired, video: select("video"), audio: select("narration") };
  }
  function project(operations: EditOperation[]) {
    const created = projects.create({
      requestId: randomUUID(),
      canvas: {
        width: 64,
        height: 48,
        fps: { numerator: 30, denominator: 1 },
        background: "#000000ff",
      },
    });
    const applied = projects.apply(created.project.projectId, {
      requestId: randomUUID(),
      expectedRevisionId: created.revision.id,
      operations,
    });
    return {
      projectId: created.project.projectId,
      revisionId: applied.revision.id,
      labels: applied.edit.labels,
    };
  }
  async function pages(input: ProjectEvidenceInput) {
    const rows: ProjectEventRow[] = [];
    let cursor: unknown;
    let empty = 0,
      maxReads = 0;
    for (let n = 0; n < 10000; n++) {
      const before = reads;
      const result = await inspection.events({
        ...input,
        ...(cursor === undefined ? {} : { cursor }),
      });
      maxReads = Math.max(maxReads, reads - before);
      if (!result.page) {
        await jobs.idle();
        continue;
      }
      rows.push(...result.page.rows);
      if (!result.page.nextCursor) return { rows, empty, maxReads };
      if (!result.page.rows.length) empty++;
      cursor = result.page.nextCursor;
    }
    throw Error("Capture pages did not advance");
  }
  return {
    home,
    catalog,
    assets,
    acquisitions,
    importer,
    records,
    capture,
    projects,
    jobs,
    inspection,
    reads: () => reads,
    importCapture,
    project,
    pages,
  };
}
const interrupted = (durationUs = 1500, sequence = 2): Partial<SourceEvidenceReceipt> => ({
  completion: {
    state: "interrupted",
    durationUs,
    sequence,
    failureCode: "DEVICE_LOST",
    failureMessage: "Microphone disconnected",
  },
  lastLifecycle: { state: "interrupted", reason: "DEVICE_LOST" },
});
const coverage = (value: ReturnType<CaptureSourceRead["events"]>) =>
  value.context.coverage.find((c) => c.kind === "interruption");
const pause = (atSourceUs: number): Observation => ({
  event: "pause",
  data: { atSourceUs, elapsedPauseUs: 10 },
});
const track: EditOperation = {
  operation: "track.add",
  label: "v",
  track: { kind: "video", order: 0 },
};
const place = (
  selection: { assetId: string; streamId: string; acquisitionId: string },
  label: string,
  startUs: number,
  endUs: number,
  sourceStart = 0,
  sourceEnd = 1000,
  trackLabel = "v",
): EditOperation => ({
  operation: "place",
  label,
  clip: {
    ...selection,
    trackId: { label: trackLabel },
    source: { kind: "range", range: { startUs: sourceStart, endUs: sourceEnd } },
    placement: { kind: "project", range: { startUs, endUs } },
  },
});

test("completion coverage distinguishes normal, explicit interrupted, absent, damaged and contradictory provenance", async () => {
  const f = await fixture();
  for (const [receipt, state, reason, count] of [
    [{ completion: { sequence: 2, state: "complete", durationUs: 1500 } }, "ready", null, 0],
    [interrupted(), "ready", null, 1],
    [{}, "unavailable", "capture_completion_unknown", 0],
    [{ lastLifecycle: { state: "interrupted" } }, "unavailable", "capture_completion_unknown", 0],
    [{ ...interrupted(), incompleteTail: true }, "unavailable", "capture_completion_untrusted", 0],
    [{ ...interrupted(), invalidAtSequence: 11 }, "unavailable", "capture_completion_untrusted", 0],
    [
      {
        completion: { sequence: 2, state: "complete", durationUs: 1500 },
        lastLifecycle: { state: "interrupted" },
      },
      "unavailable",
      "capture_completion_conflict",
      0,
    ],
    [
      { ...interrupted(), lastLifecycle: { state: "canceled" } },
      "unavailable",
      "capture_completion_conflict",
      0,
    ],
  ] as const) {
    const source = await f.importCapture([], receipt);
    const result = f.capture.events(source.video);
    expect(coverage(result)).toEqual({ kind: "interruption", state, reason });
    expect(result.page!.rows.filter((r) => r.kind === "interruption")).toHaveLength(count);
  }
});

test("source boundaries keep capture offset and closing ownership without relocating to short audio", async () => {
  const f = await fixture({ audioEndUs: 600 });
  const source = await f.importCapture([pause(1499)], interrupted());
  const result = f.capture.events(source.video);
  expect(result.page!.rows.map((r) => [r.kind, r.sourceAtUs])).toEqual([
    ["pause", 999],
    ["interruption", 1000],
  ]);
  expect(result.page!.rows[1]).toMatchObject({
    captureAtUs: 1500,
    sourceSequence: 2,
    observation: {
      durationUs: 1500,
      failureCode: "DEVICE_LOST",
      failureMessage: "Microphone disconnected",
    },
  });
  expect(f.capture.events(source.audio).page!.rows).toEqual([]);
  expect(
    f.capture.events({ ...source.video, sourceRange: { startUs: 0, endUs: 999 } }).page!.rows,
  ).toEqual([]);
  expect(
    f.capture
      .events({ ...source.video, sourceRange: { startUs: 999, endUs: 1000 } })
      .page!.rows.map((r) => r.kind),
  ).toEqual(["pause", "interruption"]);
  const excluded = await fixture({ supportEndUs: 999 });
  const masked = await excluded.importCapture([], interrupted());
  expect(excluded.capture.events(masked.video).page!.rows).toEqual([]);
  const cursor = f.capture.cursor(source.video);
  expect(cursor.page!.rows).toEqual([]);
});

test("project audio keeps the recorded capture endpoint outside an earlier-ending audio occurrence", async () => {
  const f = await fixture({ audioEndUs: 600 });
  const source = await f.importCapture([], interrupted());
  const project = f.project([
    { operation: "track.add", label: "v", track: { kind: "audio", order: 0 } },
    place(source.audio, "audio", 0, 1000, 0, 600),
  ]);
  expect((await f.pages({ ...project, limit: 1 })).rows).toEqual([]);
});

test("capture and timeline event ranges past the stream clamp with range-clamped; wholly outside refuses", async () => {
  const f = await fixture();
  const source = await f.importCapture([], interrupted());
  const events = new SourceEvents({
    assets: f.assets,
    acquisitions: f.acquisitions,
    capture: f.capture,
  });
  const clamp = {
    code: "range-clamped",
    evidence: {
      requested: { startUs: 999, endUs: 1500 },
      applied: { startUs: 999, endUs: 1000 },
      bounds: { startUs: 0, endUs: 1000 },
    },
  };
  for (const read of [f.capture, events]) {
    const clamped = read.events({ ...source.video, sourceRange: { startUs: 999, endUs: 1500 } });
    expect(clamped).toMatchObject({ sourceRange: { startUs: 999, endUs: 1000 }, issues: [clamp] });
    const applied = read.events({ ...source.video, sourceRange: { startUs: 999, endUs: 1000 } });
    expect(applied.issues).toEqual([]);
    expect(clamped.page!.rows).toEqual(applied.page!.rows);
    expect(clamped.page!.rows.length).toBeGreaterThan(0);
    expect(() =>
      read.events({ ...source.video, sourceRange: { startUs: 1000, endUs: 1500 } }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_RANGE",
        details: expect.objectContaining({ bounds: { startUs: 0, endUs: 1000 } }),
      }),
    );
  }
});

test("an interior interruption uses left-owned query windows while tied ordinary points remain half-open", async () => {
  const f = await fixture();
  const source = await f.importCapture([pause(1000)], interrupted(1000, 2));
  const first = f.capture.events({ ...source.video, sourceRange: { startUs: 0, endUs: 500 } });
  const second = f.capture.events({ ...source.video, sourceRange: { startUs: 500, endUs: 1000 } });
  expect(first.page!.rows.map((row) => row.kind)).toEqual(["interruption"]);
  expect(second.page!.rows.map((row) => row.kind)).toEqual(["pause"]);
  const all = f.capture.events(source.video);
  expect(all.page!.rows.map((row) => [row.kind, row.sourceSequence])).toEqual([
    ["pause", 1],
    ["interruption", 2],
  ]);
});

test("source page-one continuation retains an unconsumed terminal head and tied observation order", async () => {
  const f = await fixture();
  const source = await f.importCapture([pause(1499), pause(1499)], interrupted());
  const first = f.capture.events({ ...source.video, limit: 1 });
  const second = f.capture.events({ ...source.video, limit: 1, cursor: first.page!.nextCursor });
  const third = f.capture.events({ ...source.video, limit: 1, cursor: second.page!.nextCursor });
  expect(
    [...first.page!.rows, ...second.page!.rows, ...third.page!.rows].map((r) => r.kind),
  ).toEqual(["pause", "pause", "interruption"]);
});

test("adjacent clip endpoints merge next opening ties by existing clip ID order across page-one checkpoints", async () => {
  const f = await fixture();
  const source = await f.importCapture([pause(500), pause(500), pause(500)], interrupted(1500, 6));
  const project = f.project([
    track,
    place(source.video, "opening", 1000, 2000),
    place(source.video, "ending", 0, 1000),
  ]);
  expect(project.labels.opening! < project.labels.ending!).toBe(true);
  const result = await f.pages({ ...project, limit: 1 });
  expect(
    result.rows.map((r) => [
      r.projectAtUs,
      r.kind === "cut" ? (r.after ?? r.before)!.clipId : r.clipId,
      r.kind,
      "sourceSequence" in r ? r.sourceSequence : null,
    ]),
  ).toEqual([
    ...[1, 2, 3].map((n) => [0, project.labels.ending, "pause", n]),
    [1000, project.labels.opening, "cut", null],
    ...[1, 2, 3].map((n) => [1000, project.labels.opening, "pause", n]),
    [1000, project.labels.ending, "interruption", 6],
    [2000, project.labels.opening, "interruption", 6],
  ]);
  expect((await f.pages({ ...project, limit: 500 })).rows).toEqual(result.rows);
  const left = await f.pages({ ...project, range: { startUs: 0, endUs: 1000 }, limit: 1 });
  const right = await f.pages({ ...project, range: { startUs: 1000, endUs: 2000 }, limit: 1 });
  expect(left.rows.filter((r) => r.kind === "interruption").map((r) => r.projectAtUs)).toEqual([
    1000,
  ]);
  expect(right.rows.filter((r) => r.kind === "interruption").map((r) => r.projectAtUs)).toEqual([
    2000,
  ]);
});

test("reordered, repeated and rationally retimed capture endpoints retain exact occurrence identity", async () => {
  const f = await fixture();
  const source = await f.importCapture([], interrupted(1000));
  const project = f.project([
    track,
    place(source.video, "later", 1000, 2001, 0, 1000),
    place(source.video, "earlier", 0, 1000, 0, 1000),
  ]);
  const result = await f.pages({ ...project, limit: 1 });
  expect(
    result.rows.map((r) => [
      r.kind === "cut" ? (r.after ?? r.before)!.clipId : r.clipId,
      r.kind === "cut" ? null : r.sourceAtUs,
      "captureAtUs" in r ? r.captureAtUs : null,
      r.projectAtUs,
    ]),
  ).toEqual([
    [project.labels.earlier, 500, 1000, 500],
    [project.labels.later, null, null, 1000],
    [project.labels.later, 500, 1000, { numerator: 3001, denominator: 2 }],
  ]);
});

test("many tied endpoint tracks make bounded forward progress including empty continuation pages", async () => {
  const f = await fixture();
  const source = await f.importCapture([], interrupted());
  const operations: EditOperation[] = [];
  for (let i = 0; i < 140; i++)
    operations.push(
      { operation: "track.add", label: `v${i}`, track: { kind: "video", order: i } },
      place(source.video, `c${i}`, 0, 1000, 0, 1000, `v${i}`),
    );
  const project = f.project(operations);
  const result = await f.pages({ ...project, limit: 1 });
  expect(result.rows).toHaveLength(140);
  expect(result.rows.map((r) => r.trackRank)).toEqual(Array.from({ length: 140 }, (_, n) => n));
  expect(result.empty).toBeGreaterThan(0);
  expect(result.maxReads).toBeLessThanOrEqual(128);
});
