import { projectStoreFixture } from "./project-store.fixture.js";
import { projectResourceRoots } from "./project-package.js";
import { assetTranscriptOwner } from "./transcript-processing.js";
import { afterEach, expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { validateComposition, createCompiler, type TextSeedCue, omit } from "@yap/composition";
import { Catalog } from "./catalog.js";
import { AssetStore, compositionAsset } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { speechExecution, TranscriptStore, transcriptGenerationResource } from "./transcript.js";
import { selectSource } from "./source-selection.js";
import { ProjectStore } from "./projects.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  words = [
    { text: "Hello,", source: { startUs: 250000, endUs: 500000 } },
    { text: "world!", source: { startUs: 750000, endUs: 1000000 } },
  ],
) {
  const home = await mkdtemp("/tmp/text-seeds-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home),
    acquisitions = new AcquisitionStore(catalog);
  await assets.recover();
  const mediaPath = join(home, "media.wav"),
    fontPath = join(home, "font.ttf");
  await writeFile(mediaPath, "retained media");
  await writeFile(fontPath, "retained font");
  const media = await assets.import(mediaPath, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "a",
        kind: "audio",
        codec: "pcm",
        decodable: true,
        startUs: 0,
        endUs: 2000000,
        segments: [{ startUs: 0, endUs: 2000000, empty: false }],
      },
    ],
  }));
  const font = await assets.import(fontPath, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [],
    fontFaces: [{ postScriptName: "Fixture", familyName: "Fixture" }],
  }));
  const records = new TranscriptStore(catalog, home, assetTranscriptOwner(assets, acquisitions));
  const store = new ProjectStore(catalog, assets, records, acquisitions);
  const selection = { assetId: media.id, streamId: "a" };
  const selected = selectSource(assets, acquisitions, selection);
  const identity = {
    owner: { kind: "asset" as const, assetId: media.id },
    sourceId: media.id,
    generation: "words",
  };
  const output = await records.reserve(identity);
  const range = { startUs: 0, endUs: 2000000 };
  const raw =
    JSON.stringify({ ordinal: 0, source: range, owned: range, state: "transcribed", words }) + "\n";
  await writeFile(output, raw);
  const pins = {
    runtime: "FluidAudio",
    runtimeVersion: "0.15.7",
    runtimeRevision: "fixture",
    decoder: "parakeet-tdt-batch",
    model: "fixture",
    modelRevision: "fixture",
    modelDigest: "a".repeat(64),
  };
  await records.ingest({
    identity,
    source: {
      kind: "asset",
      streamId: "a",
      durationUs: selected.durationUs,
      supportDigest: selected.supportDigest,
    },
    request: {
      execution: speechExecution(),
      models: { directory: home, files: [] },
      track: selected.track,
      output,
    },
    receipt: {
      output: {
        file: output,
        bytes: Buffer.byteLength(raw),
        sha256: createHash("sha256").update(raw).digest("hex"),
      },
      engine: { ...pins, encoderPrecision: "int8", computeUnits: "cpu" },
      segments: [
        { ordinal: 0, source: range, owned: range, state: "transcribed", wordCount: words.length },
      ],
      execution: speechExecution(),
      wordCount: words.length,
      available: selected.track.available,
    },
    pins,
    signal: new AbortController().signal,
  });
  const created = store.create({
    requestId: "create",
    canvas: {
      width: 320,
      height: 100,
      fps: { numerator: 8, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const authored = store.apply(projectId, {
    requestId: "place",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      { operation: "track.add", label: "text", track: { kind: "video", order: 0 } },
      ...[0, 2000000].map((start, i) => ({
        operation: "place",
        label: "speech" + i,
        clip: {
          trackId: { label: "audio" },
          ...selection,
          source: { kind: "range", range },
          placement: { kind: "project", range: { startUs: start, endUs: start + 2000000 } },
        },
      })),
    ],
  });
  const cue = (i: number, anchor: TextSeedCue["anchor"] = "content"): TextSeedCue => ({
    trackId: authored.edit.labels.text!,
    label: "caption" + i,
    source: selection,
    generation: "words",
    occurrenceClipId: authored.edit.labels["speech" + i]!,
    words: words.map((word, ordinal) => ({ ordinal, sourceRange: word.source })),
    separator: " ",
    anchor,
    style: {
      font: { assetId: font.id, postScriptName: "Fixture" },
      width: 320,
      height: 100,
      size: 32,
      color: "#ffffffff",
      alignment: "left",
      wrap: true,
    },
  });
  return { home, catalog, assets, records, store, media, font, identity, projectId, authored, cue };
}

test("seeding keeps repeated occurrence identity, mutable display and transcript resource closure", async () => {
  const f = await fixture();
  const request = {
    requestId: "seed",
    expectedRevisionId: f.authored.revision.revisionId,
    cues: [f.cue(0), f.cue(1, "clip")],
  };
  const seeded = f.store.seedText(f.projectId, request);
  expect(seeded.edit).not.toHaveProperty("document");
  const reopened = new Catalog(join(f.home, "catalog.sqlite"));
  try {
    const fresh = projectStoreFixture(reopened, new AssetStore(reopened, f.home), f.home);
    expect(fresh.seedText(f.projectId, request)).toEqual(seeded);
  } finally {
    reopened.close();
  }
  expect(f.store.seedText(f.projectId, request)).toEqual(seeded);
  const historical = JSON.stringify({
    ...seeded,
    edit: { ...seeded.edit, document: seeded.revision.document },
  });
  f.catalog.catalog
    .prepare("UPDATE project_requests SET result=? WHERE projectId=? AND requestId=?")
    .run(historical, f.projectId, request.requestId);
  expect(f.store.seedText(f.projectId, request)).toEqual(seeded);
  expect(
    f.catalog.catalog
      .prepare("SELECT result FROM project_requests WHERE projectId=? AND requestId=?")
      .get(f.projectId, request.requestId)!.result,
  ).toBe(historical);
  expect(() => f.store.seedText(f.projectId, { ...request, cues: [f.cue(0)] })).toThrow(
    /different arguments/,
  );
  const captions = seeded.revision.document.clips.filter((clip) => clip.source.kind === "text");
  expect(captions.map((clip) => clip.source.kind === "text" && clip.source.text)).toEqual([
    "Hello, world!",
    "Hello, world!",
  ]);
  const model = validateComposition(
    seeded.revision.document,
    [f.media, f.font].map(compositionAsset),
  );
  expect(
    [...createCompiler(model, "r").frames({ startUs: 0, endUs: 4000000 })]
      .filter((frame) => frame.layers.length)
      .map((frame) => frame.sampleAtUs),
  ).toEqual([
    250000, 375000, 500000, 625000, 750000, 875000, 2250000, 2375000, 2500000, 2625000, 2750000,
    2875000,
  ]);
  const first = captions[0]!;
  if (first.source.kind !== "text") throw new Error("text");
  const changed = f.store.apply(f.projectId, {
    requestId: "correct",
    expectedRevisionId: seeded.revision.revisionId,
    operations: [
      {
        operation: "text.set",
        clipId: first.id,
        source: { ...first.source, text: "Corrected display" },
      },
    ],
  });
  expect(changed.revision.document.clips.find((clip) => clip.id === first.id)).toMatchObject({
    seed: "seed" in first ? first.seed : undefined,
    source: { text: "Corrected display" },
  });
  expect(f.records.wordRecords(f.identity, { limit: 10 }).map((word) => word.text)).toEqual([
    "Hello,",
    "world!",
  ]);
  expect(f.store.revisionDependencies(f.projectId, changed.revision.revisionId)).toContainEqual({
    kind: "transcript-generation",
    id: transcriptGenerationResource(f.identity),
  });
  const split = f.store.apply(f.projectId, {
    requestId: "split",
    expectedRevisionId: changed.revision.revisionId,
    operations: [{ operation: "split", clipIds: [f.authored.edit.labels.speech0], atUs: 625000 }],
  });
  const removed = f.store.apply(f.projectId, {
    requestId: "remove-origin",
    expectedRevisionId: split.revision.revisionId,
    operations: [
      { operation: "remove", clipIds: [f.authored.edit.labels.speech0], ripple: "none" },
    ],
  });
  expect(
    removed.revision.document.clips.some((clip) => clip.id === f.authored.edit.labels.speech0),
  ).toBe(false);
  expect(
    removed.revision.document.clips.some(
      (clip) => "seed" in clip && clip.seed?.occurrenceClipId === f.authored.edit.labels.speech0,
    ),
  ).toBe(true);
  expect(projectResourceRoots({ ...f.store.snapshot(f.projectId), references: [] })).toContainEqual(
    { kind: "transcript-generation", id: transcriptGenerationResource(f.identity) },
  );
  const captionOnly = f.store.apply(f.projectId, {
    requestId: "caption-only",
    expectedRevisionId: removed.revision.revisionId,
    operations: [
      {
        operation: "detach",
        clipIds: removed.revision.document.clips
          .filter((clip) => clip.source.kind === "text")
          .map((clip) => clip.id),
      },
      {
        operation: "remove",
        clipIds: removed.revision.document.clips
          .filter((clip) => clip.source.kind === "range")
          .map((clip) => clip.id),
        ripple: "none",
      },
    ],
  });
  expect(f.store.revisionDependencies(f.projectId, captionOnly.revision.revisionId)).toContainEqual(
    {
      kind: "asset",
      id: f.media.id,
    },
  );
  await f.records.reclaim(f.identity.owner, () => false, new AbortController().signal);
  expect(f.records.retainedGeneration(f.identity).generation).toBe("words");
  const adopted = f.store.prepareAdoption({
    requestId: "adopt",
    packageIdentity: "fixture",
    snapshot: f.store.snapshot(f.projectId),
  });
  expect(adopted.publish(() => {}).revision.document).toEqual(captionOnly.revision.document);
  expect(f.store.snapshot(f.projectId).references.at(-1)!.resources).toContainEqual({
    kind: "transcript-generation",
    id: transcriptGenerationResource(f.identity),
  });
});

test("a stale generation seeds no new captions, while captions an existing revision pins keep editing", async () => {
  const f = await fixture();
  const seeded = f.store.seedText(f.projectId, {
    requestId: "seed",
    expectedRevisionId: f.authored.revision.revisionId,
    cues: [f.cue(0)],
  });
  const row = f.catalog.catalog
    .prepare("SELECT execution FROM transcript_generations WHERE generation='words'")
    .get() as { execution: string };
  f.catalog.catalog
    .prepare("UPDATE transcript_generations SET execution=? WHERE generation='words'")
    .run(JSON.stringify({ ...JSON.parse(row.execution), recipe: "foreign-recipe-v0" }));
  expect(() =>
    f.store.seedText(f.projectId, {
      requestId: "seed-stale",
      expectedRevisionId: seeded.revision.revisionId,
      cues: [f.cue(1)],
    }),
  ).toThrow(
    expect.objectContaining({
      code: "NOT_FOUND",
      details: expect.objectContaining({ stale: true }),
    }),
  );
  const caption = seeded.revision.document.clips.find((clip) => clip.source.kind === "text")!;
  if (caption.source.kind !== "text") throw new Error("text");
  const edited = f.store.apply(f.projectId, {
    requestId: "edit-pinned",
    expectedRevisionId: seeded.revision.revisionId,
    operations: [
      { operation: "text.set", clipId: caption.id, source: { ...caption.source, text: "Kept" } },
    ],
  });
  expect(f.store.revisionDependencies(f.projectId, edited.revision.revisionId)).toContainEqual({
    kind: "transcript-generation",
    id: transcriptGenerationResource(f.identity),
  });
});

test("missing or false generation/word/origin pins refuse atomically, including ordinary placement", async () => {
  const f = await fixture();
  for (const [name, patch] of [
    ["generation", { generation: "missing" }],
    ["word", { words: [{ ordinal: 3, sourceRange: { startUs: 250000, endUs: 500000 } }] }],
    ["origin", { occurrenceClipId: "absent" }],
  ] as const) {
    expect(() =>
      f.store.seedText(f.projectId, {
        requestId: name,
        expectedRevisionId: f.authored.revision.revisionId,
        cues: [{ ...f.cue(0), ...patch }],
      }),
    ).toThrow();
    expect(f.store.get(f.projectId).currentRevisionId).toBe(f.authored.revision.revisionId);
  }
  const cue = f.cue(0),
    { style, trackId, ...pins } = omit(cue, "anchor", "separator", "label");
  expect(() =>
    f.store.apply(f.projectId, {
      requestId: "forged",
      expectedRevisionId: f.authored.revision.revisionId,
      operations: [
        {
          operation: "place",
          clip: {
            trackId,
            source: { kind: "text", text: "Forged", ...style },
            seed: { kind: "transcript", ...pins, generation: "missing" },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ],
    }),
  ).toThrow(/generation/);
  expect(f.store.history(f.projectId).revisions).toHaveLength(2);
});

test.each(["content", "clip", "project"] as const)(
  "%s seed uses existing anchor algebra through retime",
  async (anchor) => {
    const f = await fixture();
    const seeded = f.store.seedText(f.projectId, {
      requestId: "seed",
      expectedRevisionId: f.authored.revision.revisionId,
      cues: [f.cue(0, anchor)],
    });
    const edited = f.store.apply(f.projectId, {
      requestId: "retime",
      expectedRevisionId: seeded.revision.revisionId,
      operations: [
        {
          operation: "retime",
          clipIds: [f.authored.edit.labels.speech0],
          durationUs: 1000000,
          ripple: "none",
        },
      ],
    });
    const model = validateComposition(
      edited.revision.document,
      [f.media, f.font].map(compositionAsset),
    );
    const caption = model.clips.find((value) => value.clip.source.kind === "text")!;
    expect(caption.range).toEqual({
      start: { numerator: anchor === "project" ? 250000n : 125000n, denominator: 1n },
      end: { numerator: anchor === "project" ? 1000000n : 500000n, denominator: 1n },
    });
  },
);

test("adoption keeps captions seeded from a generation that has since gone stale", async () => {
  const f = await fixture();
  f.store.seedText(f.projectId, {
    requestId: "seed",
    expectedRevisionId: f.authored.revision.revisionId,
    cues: [f.cue(0)],
  });
  const row = f.catalog.catalog
    .prepare("SELECT execution FROM transcript_generations WHERE generation='words'")
    .get() as { execution: string };
  f.catalog.catalog
    .prepare("UPDATE transcript_generations SET execution=? WHERE generation='words'")
    .run(JSON.stringify({ ...JSON.parse(row.execution), recipe: "foreign-recipe-v0" }));
  const before = f.store.list().projects.length;
  f.store
    .prepareAdoption({
      requestId: "stale-package",
      packageIdentity: "stale",
      snapshot: f.store.snapshot(f.projectId),
    })
    .publish(() => {});
  expect(f.store.list().projects).toHaveLength(before + 1);
});

test("adoption rejects rewritten seed word pins before publishing a project", async () => {
  const f = await fixture();
  f.store.seedText(f.projectId, {
    requestId: "seed",
    expectedRevisionId: f.authored.revision.revisionId,
    cues: [f.cue(0)],
  });
  const snapshot = f.store.snapshot(f.projectId);
  const forged = {
    ...snapshot,
    revisions: snapshot.revisions.map((revision) => ({
      ...revision,
      document: {
        ...revision.document,
        clips: revision.document.clips.map((clip) =>
          "seed" in clip && clip.seed
            ? {
                ...clip,
                seed: {
                  ...clip.seed,
                  words: [{ ordinal: 999, sourceRange: { startUs: 250000, endUs: 500000 } }],
                },
              }
            : clip,
        ),
      },
    })),
  };
  const before = f.store.list().projects.length;
  expect(() =>
    f.store
      .prepareAdoption({ requestId: "forged-package", packageIdentity: "forged", snapshot: forged })
      .publish(() => {}),
  ).toThrow(/word pin/);
  expect(f.store.list().projects).toHaveLength(before);
});

test("seeding after retime preserves fractional project and partial-content boundaries", async () => {
  const f = await fixture();
  const retimed = f.store.apply(f.projectId, {
    requestId: "retime-first",
    expectedRevisionId: f.authored.revision.revisionId,
    operations: [
      {
        operation: "retime",
        clipIds: [f.authored.edit.labels.speech0],
        durationUs: 1000003,
        ripple: "none",
      },
    ],
  });
  const seeded = f.store.seedText(f.projectId, {
    requestId: "project-seed",
    expectedRevisionId: retimed.revision.revisionId,
    cues: [f.cue(0, "project")],
  });
  expect(
    seeded.revision.document.clips.find((clip) => clip.source.kind === "text")!.placement,
  ).toEqual({
    kind: "project",
    range: {
      startUs: { numerator: 1000003, denominator: 8 },
      endUs: { numerator: 1000003, denominator: 2 },
    },
  });
  const split = f.store.apply(f.projectId, {
    requestId: "split-fraction",
    expectedRevisionId: seeded.revision.revisionId,
    operations: [{ operation: "split", clipIds: [f.authored.edit.labels.speech0], atUs: 187501 }],
  });
  const tail = split.revision.document.clips.find(
    (clip) => clip.source.kind === "range" && typeof clip.source.range.startUs === "object",
  )!;
  const extraTrack = f.store.apply(f.projectId, {
    requestId: "extra-track",
    expectedRevisionId: split.revision.revisionId,
    operations: [{ operation: "track.add", label: "extra", track: { kind: "video", order: 1 } }],
  });
  const partial = f.store.seedText(f.projectId, {
    requestId: "partial-seed",
    expectedRevisionId: extraTrack.revision.revisionId,
    cues: [{ ...f.cue(0), occurrenceClipId: tail.id, trackId: extraTrack.edit.labels.extra }],
  });
  expect(partial.revision.document.clips.at(-1)!.placement).toEqual({
    kind: "content",
    clipId: tail.id,
    sourceRange: {
      startUs: tail.source.kind === "range" ? tail.source.range.startUs : 0,
      endUs: 1000000,
    },
  });
});

test("trimming keeps immutable cue origin even when a selected word is no longer audible", async () => {
  const f = await fixture();
  const seeded = f.store.seedText(f.projectId, {
    requestId: "seed",
    expectedRevisionId: f.authored.revision.revisionId,
    cues: [f.cue(0)],
  });
  const caption = seeded.revision.document.clips.find((clip) => "seed" in clip)!;
  const trimmed = f.store.apply(f.projectId, {
    requestId: "trim",
    expectedRevisionId: seeded.revision.revisionId,
    operations: [
      {
        operation: "trim",
        clipId: f.authored.edit.labels.speech0,
        range: { startUs: 500000, endUs: 1500000 },
        ripple: "none",
      },
    ],
  });
  const retained = trimmed.revision.document.clips.find((clip) => clip.source.kind === "text")!;
  expect(retained).toMatchObject({
    seed: "seed" in caption ? caption.seed : undefined,
    source: { text: "Hello, world!" },
  });
  expect(retained.placement).toEqual({
    kind: "content",
    clipId: f.authored.edit.labels.speech0,
    sourceRange: { startUs: 500000, endUs: 1000000 },
  });
});

test("text seeds retain instant pins at the occurrence start and overlapping word envelopes", async () => {
  const sourceWords = [
    { text: "point", source: { startUs: 0, endUs: 0 } },
    { text: "long", source: { startUs: 0, endUs: 1000000 } },
    { text: "short", source: { startUs: 100000, endUs: 200000 } },
    { text: "another point", source: { startUs: 100000, endUs: 100000 } },
  ];
  const f = await fixture(sourceWords);
  const seeded = f.store.seedText(f.projectId, {
    requestId: "overlap-seed",
    expectedRevisionId: f.authored.revision.revisionId,
    cues: [f.cue(0)],
  });
  const caption = seeded.revision.document.clips.at(-1)!;
  expect(caption).toMatchObject({
    seed: { words: f.cue(0).words },
    placement: { kind: "content", sourceRange: { startUs: 0, endUs: 1000000 } },
    source: { text: "point long short another point" },
  });
  const revision = seeded.revision.revisionId;
  expect(() =>
    f.store.seedText(f.projectId, {
      requestId: "point-only",
      expectedRevisionId: revision,
      cues: [{ ...f.cue(0), words: [f.cue(0).words[0]!, f.cue(0).words[3]!] }],
    }),
  ).toThrow(/instant.*authored.*duration/i);
  expect(f.store.get(f.projectId).currentRevisionId).toBe(revision);
  const cue = f.cue(0);
  const literal = f.store.apply(f.projectId, {
    requestId: "authored-point-text",
    expectedRevisionId: revision,
    operations: [
      {
        operation: "place",
        clip: {
          trackId: cue.trackId,
          source: { kind: "text", text: "point", ...cue.style },
          seed: {
            kind: "transcript",
            source: cue.source,
            generation: cue.generation,
            occurrenceClipId: cue.occurrenceClipId,
            words: [cue.words[0]!],
          },
          placement: { kind: "project", range: { startUs: 1500000, endUs: 2000000 } },
        },
      },
    ],
  });
  expect(literal.revision.document.clips.at(-1)).toMatchObject({
    seed: { words: [cue.words[0]] },
    placement: { kind: "project", range: { startUs: 1500000, endUs: 2000000 } },
  });
});
