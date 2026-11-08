import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captionSidecar,
  createCompiler,
  createSourceRangeProjection,
  validateComposition,
} from "@yap/composition";
import { Catalog } from "./catalog.js";
import { AssetStore, compositionAsset } from "./assets.js";
import { projectStoreFixture } from "./project-store.fixture.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(fps = { numerator: 24, denominator: 1 }) {
  const home = await mkdtemp(join(tmpdir(), "yap-exact-remove-"));
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  cleanup.push(async () => {
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const mediaPath = join(home, "control.mov"),
    fontPath = join(home, "control.ttf");
  await writeFile(mediaPath, "admitted stream control");
  await writeFile(fontPath, "admitted font control");
  // Probe admission is the external boundary; no media is decoded by structural edits.
  const media = await assets.import(mediaPath, { kind: "import" }, async () => ({
    originUs: 0,
    streams: [
      {
        id: "v",
        kind: "video",
        codec: "control",
        decodable: true,
        width: 16,
        height: 16,
        orientedWidth: 16,
        orientedHeight: 16,
        startUs: 0,
        endUs: 2000000,
        segments: [{ startUs: 0, endUs: 2000000, empty: false }],
      },
      {
        id: "a",
        kind: "audio",
        codec: "control",
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
    fontFaces: [{ postScriptName: "Control", familyName: "Control" }],
  }));
  const store = projectStoreFixture(catalog, assets, home);
  const created = store.create({
    requestId: "create",
    canvas: {
      width: 16,
      height: 16,
      fps,
      background: "#000000ff",
    },
  });
  const projectId = created.project.id;
  const authored = store.apply(projectId, {
    requestId: "place",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "picture", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      { operation: "track.add", label: "captions", track: { kind: "video", order: 1 } },
      ...["v", "a"].map((streamId) => ({
        operation: "place",
        label: streamId,
        clip: {
          trackId: { label: streamId === "v" ? "picture" : "audio" },
          assetId: media.id,
          streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      })),
      { operation: "link", clipIds: [{ label: "v" }, { label: "a" }] },
      {
        operation: "place",
        label: "caption",
        clip: {
          trackId: { label: "captions" },
          source: {
            kind: "text",
            text: "A complete thought",
            font: { assetId: font.id, postScriptName: "Control" },
            width: 16,
            height: 16,
            size: 8,
            color: "#ffffffff",
            alignment: "center",
            wrap: true,
          },
          placement: {
            kind: "content",
            clipId: { label: "v" },
            sourceRange: { startUs: 0, endUs: 2000000 },
          },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: { label: "v" } },
        steps: [
          {
            processor: {
              type: "opacity",
              opacity: {
                keys: [
                  { at: { numerator: 0, denominator: 1 }, value: 0, interpolation: "linear" },
                  { at: { numerator: 1, denominator: 1 }, value: 1, interpolation: "linear" },
                ],
              },
            },
          },
        ],
      },
    ],
  });
  return {
    home,
    catalog,
    assets,
    media,
    font,
    store,
    projectId,
    authored,
    controls: [media, font].map(compositionAsset),
  };
}

test("one exact 24fps ripple frame preserves retimed source, linked captions and animation through replay and undo", async () => {
  const f = await fixture();
  const request = {
    requestId: "remove-frame",
    expectedRevisionId: f.authored.revision.id,
    operations: [
      {
        operation: "remove",
        clipIds: [f.authored.edit.labels.v],
        ranges: [
          {
            startUs: { numerator: 125000, denominator: 3 },
            endUs: { numerator: 250000, denominator: 3 },
          },
        ],
        ripple: { trackIds: [f.authored.edit.labels.picture, f.authored.edit.labels.audio] },
      },
    ],
  };
  const removed = f.store.apply(f.projectId, request);
  const model = validateComposition(removed.revision.document, f.controls);
  const projection = createSourceRangeProjection(model);
  // Two source seconds occupy one project second; frame 1 removes source [1/12, 1/6) seconds.
  const expected = [
    {
      source: {
        start: { numerator: 0n, denominator: 1n },
        end: { numerator: 250000n, denominator: 3n },
      },
      project: {
        start: { numerator: 0n, denominator: 1n },
        end: { numerator: 125000n, denominator: 3n },
      },
    },
    {
      source: {
        start: { numerator: 500000n, denominator: 3n },
        end: { numerator: 2000000n, denominator: 1n },
      },
      project: {
        start: { numerator: 125000n, denominator: 3n },
        end: { numerator: 2875000n, denominator: 3n },
      },
    },
  ];
  for (const streamId of ["v", "a"])
    expect(
      projection
        .all({ assetId: f.media.id, streamId, range: { startUs: 0, endUs: 2000000 } })
        .flatMap((row) => row.fragments),
    ).toEqual(expected);
  const captionIds = removed.revision.document.clips
    .filter((clip) => clip.source.kind === "text")
    .map((clip) => clip.id);
  expect(
    captionSidecar(model, { kind: "vtt", placementIds: captionIds }).cues.map((cue) => ({
      text: cue.text,
      exact: cue.exact,
    })),
  ).toEqual([
    {
      text: "A complete thought",
      exact: { startUs: 0, endUs: { numerator: 125000, denominator: 3 } },
    },
    {
      text: "A complete thought",
      exact: {
        startUs: { numerator: 125000, denominator: 3 },
        endUs: { numerator: 2875000, denominator: 3 },
      },
    },
  ]);
  const compiler = createCompiler(model, removed.revision.id);
  const joinFrame = [...compiler.frames({ startUs: 41666, endUs: 83334 })].find(
    (frame) => frame.index === 1,
  )!;
  expect(joinFrame.layers.find((layer) => layer.kind === "video")).toMatchObject({
    sourceUs: { numerator: 500000, denominator: 3 },
  });
  expect(
    joinFrame.visual
      .flatMap((node) => node.operations)
      .filter((operation) => operation.kind === "opacity"),
  ).toEqual([{ kind: "opacity", opacity: 1 / 12 }]);
  const receiptPath = process.env.YAP_EXACT_REMOVAL_RECEIPT;
  if (receiptPath)
    await writeFile(
      receiptPath,
      JSON.stringify(
        {
          scope:
            "Deterministic admitted-stream controls; no decoded-media or native execution claim",
          controls: f.controls,
          request,
          response: removed,
          joinedFrame: joinFrame,
          captions: captionSidecar(model, { kind: "vtt", placementIds: captionIds }),
        },
        null,
        2,
      ) + "\n",
    );
  expect(f.store.apply(f.projectId, request)).toEqual(removed);
  const reopened = new Catalog(join(f.home, "catalog.sqlite"));
  try {
    const restarted = projectStoreFixture(reopened, new AssetStore(reopened, f.home), f.home);
    expect(restarted.apply(f.projectId, request)).toEqual(removed);
    expect(
      restarted.undo(f.projectId, {
        requestId: "undo",
        expectedRevisionId: removed.revision.id,
      }).document,
    ).toEqual(f.authored.revision.document);
  } finally {
    reopened.close();
  }
});

test("adjacent and overlapping 30000/1001 selections collapse their exact union once", async () => {
  const f = await fixture({ numerator: 30000, denominator: 1001 });
  const removed = f.store.apply(f.projectId, {
    requestId: "remove-union",
    expectedRevisionId: f.authored.revision.id,
    operations: [
      {
        operation: "remove",
        clipIds: [f.authored.edit.labels.v],
        ranges: [
          {
            startUs: { numerator: 100100, denominator: 3 },
            endUs: { numerator: 200200, denominator: 3 },
          },
          { startUs: { numerator: 200200, denominator: 3 }, endUs: 100100 },
          { startUs: { numerator: 100100, denominator: 3 }, endUs: 100100 },
        ],
        ripple: { trackIds: [f.authored.edit.labels.picture, f.authored.edit.labels.audio] },
      },
    ],
  });
  const model = validateComposition(removed.revision.document, f.controls);
  const projection = createSourceRangeProjection(model);
  for (const streamId of ["v", "a"])
    expect(
      projection
        .all({ assetId: f.media.id, streamId, range: { startUs: 0, endUs: 2000000 } })
        .flatMap((row) => row.fragments),
    ).toEqual([
      {
        source: {
          start: { numerator: 0n, denominator: 1n },
          end: { numerator: 200200n, denominator: 3n },
        },
        project: {
          start: { numerator: 0n, denominator: 1n },
          end: { numerator: 100100n, denominator: 3n },
        },
      },
      {
        source: {
          start: { numerator: 200200n, denominator: 1n },
          end: { numerator: 2000000n, denominator: 1n },
        },
        project: {
          start: { numerator: 100100n, denominator: 3n },
          end: { numerator: 2799800n, denominator: 3n },
        },
      },
    ]);
  const frames = [
    ...createCompiler(model, removed.revision.id).frames({ startUs: 0, endUs: 100100 }),
  ];
  expect(
    frames.map((frame) => frame.layers.find((layer) => layer.kind === "video")?.sourceUs),
  ).toEqual([0, 200200, { numerator: 800800, denominator: 3 }]);
});

test("fractional removal refuses changed synchronization and malformed intervals without committing partial edits", async () => {
  const f = await fixture();
  const operation = {
    operation: "remove",
    clipIds: [f.authored.edit.labels.v],
    ranges: [
      {
        startUs: { numerator: 125000, denominator: 3 },
        endUs: { numerator: 250000, denominator: 3 },
      },
    ],
    ripple: { trackIds: [f.authored.edit.labels.picture] },
  };
  const before = f.store.history(f.projectId);
  expect(() =>
    f.store.apply(f.projectId, {
      requestId: "refused",
      expectedRevisionId: f.authored.revision.id,
      operations: [{ operation: "canvas.set", canvas: { width: 32 } }, operation],
    }),
  ).toThrow(/synchronization/);
  expect(f.store.history(f.projectId)).toEqual(before);
  expect(f.store.revision(f.projectId)).toEqual(f.authored.revision);
  for (const ranges of [
    [{ startUs: { numerator: 250000, denominator: 6 }, endUs: 100000 }],
    [
      {
        startUs: { numerator: 125000, denominator: 3 },
        endUs: { numerator: 125000, denominator: 3 },
      },
    ],
    [
      {
        startUs: { numerator: 250000, denominator: 3 },
        endUs: { numerator: 125000, denominator: 3 },
      },
    ],
  ]) {
    expect(() =>
      f.store.apply(f.projectId, {
        requestId: "malformed",
        expectedRevisionId: f.authored.revision.id,
        operations: [{ ...operation, ranges }],
      }),
    ).toThrow();
    expect(f.store.history(f.projectId)).toEqual(before);
  }
  // A refused request does not reserve its identity or block the corrected request.
  expect(
    f.store.apply(f.projectId, {
      requestId: "refused",
      expectedRevisionId: f.authored.revision.id,
      operations: [
        {
          ...operation,
          ripple: { trackIds: [f.authored.edit.labels.picture, f.authored.edit.labels.audio] },
        },
      ],
    }).revision.document.canvas.width,
  ).toBe(16);
});
