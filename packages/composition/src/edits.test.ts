import { omit } from "./omit.js";
import { expect, test } from "vitest";
import { applyBatch, CompositionError, validateComposition, projectToSource } from "./index.js";
const input = {
  canvas: {
    width: 160,
    height: 96,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  },
  tracks: [],
  clips: [],
  syncGroups: [],
  processing: [],
  groups: [],
};
const context = {
  namespace: "transaction",
  assets: [
    {
      id: "source",
      streams: [
        {
          id: "v",
          kind: "video",
          width: 640,
          height: 480,
          bounds: { startUs: 0, endUs: 2000000 },
          available: [{ startUs: 0, endUs: 2000000 }],
        },
        {
          id: "a",
          kind: "audio",
          bounds: { startUs: 200000, endUs: 1800000 },
          available: [{ startUs: 200000, endUs: 1800000 }],
        },
      ],
    },
  ],
};
const setup = [
  { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
  {
    operation: "place",
    label: "video",
    clip: {
      assetId: "source",
      streamId: "v",
      trackId: { label: "picture" },
      source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
    },
  },
  { operation: "track.add", track: { kind: "audio", order: 0 }, label: "sound" },
  {
    operation: "place",
    label: "audio",
    clip: {
      assetId: "source",
      streamId: "a",
      trackId: { label: "sound" },
      source: { kind: "range", range: { startUs: 200000, endUs: 1800000 } },
      placement: { kind: "project", range: { startUs: 200000, endUs: 1800000 } },
    },
  },
  { operation: "link", clipIds: [{ label: "video" }, { label: "audio" }], label: "av" },
];
test("one pure batch binds deterministic identities and links unequal AV without moving either", () => {
  const before = structuredClone({ input, context, setup });
  const result = applyBatch(input, setup, context);
  expect(applyBatch(input, setup, context)).toEqual(result);
  expect({ input, context, setup }).toEqual(before);
  expect(result.document.syncGroups).toEqual([
    { id: result.labels.av, clipIds: [result.labels.video, result.labels.audio] },
  ]);
  const model = validateComposition(result.document, context.assets);
  expect(projectToSource(model, 100000)).toMatchObject([
    { clipId: result.labels.video, sourceUs: 100000 },
  ]);
  expect(projectToSource(model, 250000)).toMatchObject([
    { clipId: result.labels.video, sourceUs: 250000 },
    { clipId: result.labels.audio, sourceUs: 250000 },
  ]);
  expect(result.createdIds.map((value) => value.kind)).toEqual([
    "track",
    "clip",
    "track",
    "clip",
    "syncGroup",
  ]);
  expect(result.linkChanges).toEqual([
    { kind: "syncGroup", id: result.labels.av, value: result.document.syncGroups[0] },
  ]);
});
test("failure in operation three leaves the caller's document unchanged", () => {
  const original = structuredClone(input);
  const operations = [
    ...setup.slice(0, 2),
    { operation: "track.remove", trackId: { label: "picture" } },
    { operation: "canvas.set", canvas: { width: 1080, height: 1920 } },
  ];
  expect(() => applyBatch(input, operations, context)).toThrow(CompositionError);
  try {
    applyBatch(input, operations, context);
  } catch (error) {
    expect(error).toMatchObject({ code: "INVALID_EDIT", details: { operationIndex: 2 } });
  }
  expect(input).toEqual(original);
  expect(applyBatch(input, [], context).document).toEqual(original);
});
test("link is idempotent and unlink removes only selected membership", () => {
  const first = applyBatch(input, setup, context);
  const same = applyBatch(
    first.document,
    [{ operation: "link", clipIds: [first.labels.audio, first.labels.video] }],
    context,
  );
  expect(same.changed).toBe(false);
  expect(same.createdIds).toEqual([]);
  const unlinked = applyBatch(
    first.document,
    [{ operation: "unlink", clipIds: [first.labels.audio] }],
    context,
  );
  expect(unlinked.document.syncGroups).toEqual([]);
  expect(unlinked.document.clips).toEqual(first.document.clips);
});
test("canvas and layer order changes preserve all clip timing", () => {
  const first = applyBatch(input, setup, context);
  const result = applyBatch(
    first.document,
    [
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "overlay" },
      {
        operation: "layers.reorder",
        targets: [
          { kind: "track", id: { label: "overlay" } },
          { kind: "track", id: first.labels.picture },
        ],
      },
      { operation: "canvas.set", canvas: { width: 1080, height: 1920 } },
    ],
    { ...context, namespace: "layout" },
  );
  expect(result.document.canvas).toEqual({ ...input.canvas, width: 1080, height: 1920 });
  expect(result.document.clips).toEqual(first.document.clips);
  expect(result.document.tracks.find((track) => track.id === first.labels.picture)?.order).toBe(1);
  expect(result.document.tracks.find((track) => track.id === result.labels.overlay)?.order).toBe(0);
});
test("net no-op and prototype-shaped labels keep a truthful result", () => {
  const result = applyBatch(
    input,
    [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "__proto__" },
      { operation: "track.remove", trackId: { label: "__proto__" } },
    ],
    context,
  );
  expect(result.document).toEqual(input);
  expect(result.changed).toBe(false);
  expect(Object.hasOwn(result.labels, "__proto__")).toBe(true);
  expect(JSON.parse(JSON.stringify(result.labels)).__proto__).toBe(result.createdIds[0]?.id);
});

test("linked split partitions unequal AV and attached media without changing sample mapping", () => {
  const first = applyBatch(
    input,
    [
      ...setup,
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "overlayTrack" },
      {
        operation: "place",
        label: "overlay",
        clip: {
          assetId: "source",
          streamId: "v",
          trackId: { label: "overlayTrack" },
          source: { kind: "range", range: { startUs: 0, endUs: 10 } },
          placement: {
            kind: "content",
            clipId: { label: "video" },
            sourceRange: { startUs: 0, endUs: 6 },
          },
        },
      },
    ],
    context,
  );
  const result = applyBatch(
    first.document,
    [{ operation: "split", clipIds: [first.labels.video], atUs: 2 }],
    { ...context, namespace: "split" },
  );
  const overlayParts = result.document.clips.filter(
    (clip) => clip.trackId === first.labels.overlayTrack,
  );
  expect(overlayParts.map((clip) => clip.source)).toEqual([
    { kind: "range", range: { startUs: 0, endUs: { numerator: 10, denominator: 3 } } },
    { kind: "range", range: { startUs: { numerator: 10, denominator: 3 }, endUs: 10 } },
  ]);
  expect(result.clipLineage).toEqual(
    expect.arrayContaining([
      { originalId: first.labels.overlay, clipIds: overlayParts.map((clip) => clip.id) },
    ]),
  );
  const old = validateComposition(first.document, context.assets);
  const model = validateComposition(result.document, context.assets);
  for (const at of [0, 1, 2, 3, 5, 6, 199999, 200000, 1799999, 1999999]) {
    const samples = (m: typeof model) =>
      projectToSource(m, at).map(({ trackId, sourceUs, available }) => ({
        trackId,
        sourceUs,
        available,
      }));
    expect(samples(model)).toEqual(samples(old));
  }
  const videoParts = result.document.clips.filter((clip) => clip.trackId === first.labels.picture);
  expect(result.document.syncGroups).toEqual([
    { id: first.labels.av, clipIds: [videoParts[1]!.id, first.labels.audio] },
  ]);
  expect(first.document.clips).toHaveLength(3);
});

test("splitting a held parent rebases normalized attachments and preserves nested content", () => {
  const document = {
    ...input,
    tracks: [
      { id: "base", kind: "video", order: 0 },
      { id: "overlay", kind: "video", order: 1 },
      { id: "nested", kind: "video", order: 2 },
    ],
    clips: [
      {
        id: "parent",
        assetId: "source",
        streamId: "v",
        trackId: "base",
        source: { kind: "hold", atUs: 0 },
        placement: { kind: "project", range: { startUs: 0, endUs: 12 } },
      },
      {
        id: "child",
        assetId: "source",
        streamId: "v",
        trackId: "overlay",
        source: { kind: "range", range: { startUs: 0, endUs: 12 } },
        placement: {
          kind: "clip",
          clipId: "parent",
          start: { numerator: 1, denominator: 3 },
          end: { numerator: 5, denominator: 6 },
        },
      },
      {
        id: "grandchild",
        assetId: "source",
        streamId: "v",
        trackId: "nested",
        source: { kind: "range", range: { startUs: 10, endUs: 20 } },
        placement: { kind: "content", clipId: "child", sourceRange: { startUs: 2, endUs: 8 } },
      },
    ],
  };
  const result = applyBatch(
    document,
    [{ operation: "split", clipIds: ["parent"], atUs: 6 }],
    context,
  );
  const children = result.document.clips.filter((clip) => clip.trackId === "overlay");
  const parents = result.document.clips.filter((clip) => clip.trackId === "base");
  expect(children.map((clip) => clip.placement)).toEqual([
    {
      kind: "clip",
      clipId: "parent",
      start: { numerator: 2, denominator: 3 },
      end: { numerator: 1, denominator: 1 },
    },
    {
      kind: "clip",
      clipId: parents[1]!.id,
      start: { numerator: 0, denominator: 1 },
      end: { numerator: 2, denominator: 3 },
    },
  ]);
  const before = validateComposition(document, context.assets);
  const after = validateComposition(result.document, context.assets);
  for (let at = 0; at < 12; at++) {
    const samples = (m: typeof before) =>
      projectToSource(m, at).map(({ trackId, sourceUs }) => ({ trackId, sourceUs }));
    expect(samples(after)).toEqual(samples(before));
  }
  expect(result.clipLineage.map((entry) => entry.originalId)).toEqual([
    "parent",
    "child",
    "grandchild",
  ]);
});

test("selected split unlinks its fragments while linked split preserves both AV halves", () => {
  const first = applyBatch(input, setup, context);
  const selected = applyBatch(
    first.document,
    [{ operation: "split", clipIds: [first.labels.video], atUs: 1000000, scope: "selected" }],
    { ...context, namespace: "selected" },
  );
  expect(selected.document.syncGroups).toEqual([]);
  expect(selected.document.clips.find((clip) => clip.id === first.labels.audio)).toEqual(
    first.document.clips.find((clip) => clip.id === first.labels.audio),
  );
  const linked = applyBatch(
    first.document,
    [{ operation: "split", clipIds: [first.labels.video], atUs: 1000000 }],
    { ...context, namespace: "linked" },
  );
  const video = linked.document.clips.filter((clip) => clip.trackId === first.labels.picture);
  const audio = linked.document.clips.filter((clip) => clip.trackId === first.labels.sound);
  expect(linked.document.syncGroups).toEqual([
    { id: first.labels.av, clipIds: [video[0]!.id, audio[0]!.id] },
    {
      id: linked.createdIds.find((entry) => entry.kind === "syncGroup")!.id,
      clipIds: [video[1]!.id, audio[1]!.id],
    },
  ]);
  const repeat = applyBatch(
    linked.document,
    [{ operation: "split", clipIds: [video[0]!.id], atUs: 1000000 }],
    { ...context, namespace: "again" },
  );
  expect(repeat.changed).toBe(false);
  expect(repeat.createdIds).toEqual([]);
  expect(repeat.clipLineage).toEqual([]);
});

test("selected members absent at a split keep their synchronization", () => {
  const ids = ["a", "b", "c"];
  const document = {
    ...input,
    tracks: ids.map((id, order) => ({ id, kind: "video", order })),
    clips: ids.map((id) => ({
      id,
      assetId: "source",
      streamId: "v",
      trackId: id,
      source: { kind: "range", range: { startUs: 0, endUs: id === "b" ? 10 : 5 } },
      placement: { kind: "project", range: { startUs: 0, endUs: id === "b" ? 10 : 5 } },
    })),
    syncGroups: [{ id: "group", clipIds: ids }],
  };
  const result = applyBatch(
    document,
    [{ operation: "split", clipIds: ["a", "b"], atUs: 7, scope: "selected" }],
    context,
  );
  expect(result.document.syncGroups).toEqual([{ id: "group", clipIds: ["a", "c"] }]);
  expect(result.clipLineage).toEqual([
    { originalId: "b", clipIds: ["b", result.createdIds[0]!.id] },
  ]);
});

test("a batch can address new split children by labels without guessing identities", () => {
  const first = applyBatch(input, setup, context);
  const result = applyBatch(
    first.document,
    [
      {
        operation: "split",
        clipIds: [first.labels.video],
        atUs: 1000000,
        rightLabels: [
          { clipId: first.labels.video, label: "rightVideo" },
          { clipId: first.labels.audio, label: "rightAudio" },
        ],
      },
      { operation: "unlink", clipIds: [{ label: "rightAudio" }] },
    ],
    { ...context, namespace: "named-split" },
  );
  expect(result.labels.rightVideo).toBe(
    result.clipLineage.find((entry) => entry.originalId === first.labels.video)!.clipIds[1],
  );
  expect(result.labels.rightAudio).toBe(
    result.clipLineage.find((entry) => entry.originalId === first.labels.audio)!.clipIds[1],
  );
  expect(result.document.syncGroups).toEqual([
    { id: first.labels.av, clipIds: [first.labels.video, first.labels.audio] },
  ]);
});

test("range removal cuts linked members without closing the gap", () => {
  const first = applyBatch(input, setup, context);
  const result = applyBatch(
    first.document,
    [
      {
        operation: "remove",
        clipIds: [first.labels.video],
        ranges: [
          { startUs: 500000, endUs: 800000 },
          { startUs: 700000, endUs: 1000000 },
        ],
        ripple: "none",
      },
    ],
    { ...context, namespace: "remove" },
  );
  const picture = result.document.clips.filter((clip) => clip.trackId === first.labels.picture);
  const sound = result.document.clips.filter((clip) => clip.trackId === first.labels.sound);
  expect(picture.map((clip) => clip.source)).toEqual([
    { kind: "range", range: { startUs: 0, endUs: 500000 } },
    { kind: "range", range: { startUs: 1000000, endUs: 2000000 } },
  ]);
  expect(sound.map((clip) => clip.source)).toEqual([
    { kind: "range", range: { startUs: 200000, endUs: 500000 } },
    { kind: "range", range: { startUs: 1000000, endUs: 1800000 } },
  ]);
  const model = validateComposition(result.document, context.assets);
  expect(projectToSource(model, 750000)).toEqual([]);
  expect(projectToSource(model, 1000000).map((item) => item.sourceUs)).toEqual([1000000, 1000000]);
  expect(result.document.syncGroups.map((group) => group.clipIds)).toEqual([
    [picture[0]!.id, sound[0]!.id],
    [picture[1]!.id, sound[1]!.id],
  ]);
});

test("removal restricts attached source mappings and deletes attachments without surviving content", () => {
  const first = applyBatch(
    input,
    [
      ...setup,
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "overlays" },
      {
        operation: "place",
        label: "survivor",
        clip: {
          assetId: "source",
          streamId: "v",
          trackId: { label: "overlays" },
          source: { kind: "range", range: { startUs: 0, endUs: 10 } },
          placement: {
            kind: "content",
            clipId: { label: "video" },
            sourceRange: { startUs: 500000, endUs: 2000000 },
          },
        },
      },
      {
        operation: "place",
        label: "deleted",
        clip: {
          assetId: "source",
          streamId: "v",
          trackId: { label: "overlays" },
          source: { kind: "hold", atUs: 0 },
          placement: {
            kind: "content",
            clipId: { label: "video" },
            sourceRange: { startUs: 0, endUs: 500000 },
          },
        },
      },
    ],
    context,
  );
  const result = applyBatch(
    first.document,
    [
      {
        operation: "remove",
        clipIds: [first.labels.video],
        ranges: [{ startUs: 0, endUs: 1000000 }],
        ripple: "none",
      },
    ],
    { ...context, namespace: "remove" },
  );
  expect(result.removedAttachments).toEqual([first.labels.deleted]);
  expect(result.document.clips.find((clip) => clip.id === first.labels.survivor)).toMatchObject({
    source: { kind: "range", range: { startUs: { numerator: 10, denominator: 3 }, endUs: 10 } },
    placement: {
      kind: "content",
      clipId: first.labels.video,
      sourceRange: { startUs: 1000000, endUs: 2000000 },
    },
  });
  expect(result.document.clips.find((clip) => clip.id === first.labels.video)?.source).toEqual({
    kind: "range",
    range: { startUs: 1000000, endUs: 2000000 },
  });
});

test("selected removal preserves counterpart samples and unaffected links", () => {
  const first = applyBatch(input, setup, context);
  const result = applyBatch(
    first.document,
    [
      {
        operation: "remove",
        clipIds: [first.labels.audio],
        scope: "selected",
        ranges: [{ startUs: 500000, endUs: 1000000 }],
        ripple: "none",
      },
    ],
    { ...context, namespace: "independent" },
  );
  const video = result.document.clips.filter((clip) => clip.trackId === first.labels.picture);
  const audio = result.document.clips.filter((clip) => clip.trackId === first.labels.sound);
  expect(result.document.syncGroups.map((group) => group.clipIds)).toEqual([
    [video[0]!.id, audio[0]!.id],
    [video[2]!.id, audio[1]!.id],
  ]);
  const model = validateComposition(result.document, context.assets);
  expect(projectToSource(model, 750000)).toMatchObject([
    { clipId: video[1]!.id, sourceUs: 750000 },
  ]);
  expect(projectToSource(model, 499999).map((item) => item.sourceUs)).toEqual([499999, 499999]);
  expect(projectToSource(model, 1000000).map((item) => item.sourceUs)).toEqual([1000000, 1000000]);
  const absent = applyBatch(
    first.document,
    [
      {
        operation: "remove",
        clipIds: [first.labels.audio],
        scope: "selected",
        ranges: [{ startUs: 1800000, endUs: 2000000 }],
        ripple: "none",
      },
    ],
    context,
  );
  expect(absent.changed).toBe(false);
  expect(absent.createdIds).toEqual([]);
});

test("whole linked removal leaves an editable empty project and repeated removal is a no-op", () => {
  const first = applyBatch(input, setup, context);
  const command = [{ operation: "remove", clipIds: [first.labels.video], ripple: "none" }];
  const result = applyBatch(first.document, command, { ...context, namespace: "empty" });
  expect(result.document.clips).toEqual([]);
  expect(result.document.syncGroups).toEqual([]);
  expect(result.document.tracks).toEqual(first.document.tracks);
  expect(validateComposition(result.document, context.assets).durationUs).toBe(0);
  expect(applyBatch(result.document, command, context).changed).toBe(false);
});

test("trim keeps the requested project interval and applies only its removed windows to linked members", () => {
  const first = applyBatch(input, setup, context);
  const shorterVideo = {
    ...first.document,
    clips: first.document.clips.map((clip) =>
      clip.id === first.labels.video
        ? {
            ...clip,
            source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
            placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          }
        : clip,
    ),
  };
  const result = applyBatch(
    shorterVideo,
    [
      {
        operation: "trim",
        clipId: first.labels.video,
        range: { startUs: 400000, endUs: 800000 },
        ripple: "none",
      },
    ],
    { ...context, namespace: "trim" },
  );
  expect(result.document.clips.find((clip) => clip.id === first.labels.video)?.source).toEqual({
    kind: "range",
    range: { startUs: 400000, endUs: 800000 },
  });
  expect(
    result.document.clips
      .filter((clip) => clip.trackId === first.labels.sound)
      .map((clip) => clip.source),
  ).toEqual([
    { kind: "range", range: { startUs: 400000, endUs: 800000 } },
    { kind: "range", range: { startUs: 1000000, endUs: 1800000 } },
  ]);
  expect(result.document.syncGroups).toEqual([
    { id: first.labels.av, clipIds: [first.labels.video, first.labels.audio] },
  ]);
  // A trim past the clip's interval clamps: range-admission.test.ts owns that contract.
});

test("fresh allocation cannot reuse an identity deleted earlier in the same batch", () => {
  const document = { ...input, tracks: [{ id: "track:reused:0", kind: "video", order: 0 }] };
  expect(() =>
    applyBatch(
      document,
      [
        { operation: "track.remove", trackId: "track:reused:0" },
        { operation: "track.add", track: { kind: "video", order: 0 } },
      ],
      { ...context, namespace: "reused" },
    ),
  ).toThrow(/collides/);
});

test("every small retimed removal preserves all surviving project samples", () => {
  for (let source = 1; source <= 5; source++)
    for (let duration = 2; duration <= 8; duration++)
      for (let startUs = 0; startUs < duration; startUs++)
        for (let endUs = startUs + 1; endUs <= duration; endUs++) {
          const document = {
            ...input,
            tracks: [{ id: "track", kind: "video", order: 0 }],
            clips: [
              {
                id: "clip",
                assetId: "source",
                streamId: "v",
                trackId: "track",
                source: { kind: "range", range: { startUs: 0, endUs: source } },
                placement: { kind: "project", range: { startUs: 0, endUs: duration } },
              },
            ],
          };
          const result = applyBatch(
            document,
            [
              {
                operation: "remove",
                clipIds: ["clip"],
                ranges: [{ startUs, endUs }],
                ripple: "none",
              },
            ],
            context,
          );
          const model = validateComposition(result.document, context.assets);
          for (let at = 0; at < duration; at++) {
            const samples = projectToSource(model, at).map((item) => item.sourceUs);
            expect(samples).toEqual(
              at >= startUs && at < endUs ? [] : [Math.floor((at * source) / duration)],
            );
          }
        }
});

test("explicit ripple shifts roots once and their attached overlays follow once", () => {
  const first = applyBatch(
    input,
    [
      ...setup,
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "overlayTrack" },
      {
        operation: "place",
        label: "overlay",
        clip: {
          assetId: "source",
          streamId: "v",
          trackId: { label: "overlayTrack" },
          source: { kind: "hold", atUs: 123 },
          placement: {
            kind: "content",
            clipId: { label: "video" },
            sourceRange: { startUs: 1000000, endUs: 2000000 },
          },
        },
      },
    ],
    context,
  );
  const command = {
    operation: "remove",
    clipIds: [first.labels.video],
    ranges: [{ startUs: 500000, endUs: 1000000 }],
    ripple: { trackIds: [first.labels.picture, first.labels.sound, first.labels.overlayTrack] },
  };
  const result = applyBatch(first.document, [command], { ...context, namespace: "ripple" });
  const model = validateComposition(result.document, context.assets);
  expect(model.durationUs).toBe(1500000);
  expect(
    projectToSource(model, 500000).map(({ trackId, sourceUs }) => ({ trackId, sourceUs })),
  ).toEqual([
    { trackId: first.labels.picture, sourceUs: 1000000 },
    { trackId: first.labels.sound, sourceUs: 1000000 },
    { trackId: first.labels.overlayTrack, sourceUs: 123 },
  ]);
  expect(() =>
    applyBatch(
      first.document,
      [{ ...command, ripple: { trackIds: [first.labels.overlayTrack] } }],
      { ...context, namespace: "child-ripple" },
    ),
  ).toThrow(/root/);
  expect(() =>
    applyBatch(first.document, [{ ...command, ripple: { trackIds: [first.labels.picture] } }], {
      ...context,
      namespace: "omitted-link",
    }),
  ).toThrow(/synchronization/);
});

test("ripple reports fixed project overlays and refuses unaddressed crossing content", () => {
  const first = applyBatch(
    input,
    [
      ...setup,
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "fixedTrack" },
      {
        operation: "place",
        label: "fixed",
        clip: {
          assetId: "source",
          streamId: "v",
          trackId: { label: "fixedTrack" },
          source: { kind: "hold", atUs: 7 },
          placement: { kind: "project", range: { startUs: 600000, endUs: 1600000 } },
        },
      },
    ],
    context,
  );
  const command = {
    operation: "remove",
    clipIds: [first.labels.video],
    ranges: [{ startUs: 500000, endUs: 1000000 }],
    ripple: { trackIds: [first.labels.picture, first.labels.sound] },
  };
  const result = applyBatch(first.document, [command], { ...context, namespace: "fixed" });
  expect(result.document.clips.find((clip) => clip.id === first.labels.fixed)).toEqual(
    first.document.clips.find((clip) => clip.id === first.labels.fixed),
  );
  expect(result.touchedFixedAnchors).toEqual([{ kind: "clip", id: first.labels.fixed }]);
  expect(() =>
    applyBatch(
      first.document,
      [{ ...command, ripple: { trackIds: [...command.ripple.trackIds, first.labels.fixedTrack] } }],
      { ...context, namespace: "crossing" },
    ),
  ).toThrow(/unremoved content/);
  const explicit = applyBatch(
    first.document,
    [
      {
        ...command,
        clipIds: [first.labels.video, first.labels.fixed],
        ripple: { trackIds: [...command.ripple.trackIds, first.labels.fixedTrack] },
      },
    ],
    { ...context, namespace: "explicit" },
  );
  expect(explicit.document.clips.find((clip) => clip.id === first.labels.fixed)?.placement).toEqual(
    { kind: "project", range: { startUs: 500000, endUs: 1100000 } },
  );
});

test("ripple collapses the requested union including empty project time", () => {
  const document = {
    ...input,
    tracks: [{ id: "track", kind: "video", order: 0 }],
    clips: [
      {
        id: "head",
        assetId: "source",
        streamId: "v",
        trackId: "track",
        source: { kind: "range", range: { startUs: 0, endUs: 500000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 500000 } },
      },
      {
        id: "tail",
        assetId: "source",
        streamId: "v",
        trackId: "track",
        source: { kind: "range", range: { startUs: 1000000, endUs: 2000000 } },
        placement: { kind: "project", range: { startUs: 1000000, endUs: 2000000 } },
      },
    ],
  };
  const result = applyBatch(
    document,
    [
      {
        operation: "remove",
        clipIds: ["head"],
        ranges: [
          { startUs: 500000, endUs: 800000 },
          { startUs: 700000, endUs: 1000000 },
        ],
        ripple: { trackIds: ["track"] },
      },
    ],
    context,
  );
  expect(result.document.clips.find((clip) => clip.id === "head")).toEqual(document.clips[0]);
  expect(result.document.clips.find((clip) => clip.id === "tail")).toMatchObject({
    source: document.clips[1]!.source,
    placement: { kind: "project", range: { startUs: 500000, endUs: 1500000 } },
  });
  expect(result.createdIds).toEqual([]);
  expect(result.clipLineage).toEqual([]);
});

test("removing an absent occurrence cannot ripple unrelated content", () => {
  const first = applyBatch(input, setup, context);
  const result = applyBatch(
    first.document,
    [
      {
        operation: "remove",
        clipIds: ["already-removed"],
        ranges: [{ startUs: 0, endUs: 500000 }],
        ripple: { trackIds: [first.labels.picture, first.labels.sound] },
      },
    ],
    { ...context, namespace: "absent-ripple" },
  );
  expect(result.changed).toBe(false);
  expect(result.document).toEqual(first.document);
});

test("retimed ripple preserves each surviving sample at its collapsed project position", () => {
  for (let source = 1; source <= 5; source++)
    for (let duration = 2; duration <= 8; duration++)
      for (let startUs = 0; startUs < duration; startUs++)
        for (let endUs = startUs + 1; endUs <= duration; endUs++) {
          const document = {
            ...input,
            tracks: [{ id: "track", kind: "video", order: 0 }],
            clips: [
              {
                id: "clip",
                assetId: "source",
                streamId: "v",
                trackId: "track",
                source: { kind: "range", range: { startUs: 0, endUs: source } },
                placement: { kind: "project", range: { startUs: 0, endUs: duration } },
              },
            ],
          };
          const result = applyBatch(
            document,
            [
              {
                operation: "remove",
                clipIds: ["clip"],
                ranges: [{ startUs, endUs }],
                ripple: { trackIds: ["track"] },
              },
            ],
            context,
          );
          const model = validateComposition(result.document, context.assets);
          expect(model.durationUs).toBe(duration - endUs + startUs);
          for (let at = 0; at < model.durationUs; at++) {
            const originalAt = at < startUs ? at : at + endUs - startUs;
            expect(projectToSource(model, at).map((item) => item.sourceUs)).toEqual([
              Math.floor((originalAt * source) / duration),
            ]);
          }
        }
});

test("move preserves linked offsets and selected move leaves the other stream in place", () => {
  const first = applyBatch(input, setup, context);
  const linked = applyBatch(
    first.document,
    [{ operation: "move", clipIds: [first.labels.audio], atUs: 3000000, ripple: "none" }],
    { ...context, namespace: "move" },
  );
  expect(linked.document.clips.map((clip) => clip.placement)).toEqual([
    { kind: "project", range: { startUs: 3000000, endUs: 5000000 } },
    { kind: "project", range: { startUs: 3200000, endUs: 4800000 } },
  ]);
  expect(linked.document.clips.map((clip) => clip.source)).toEqual(
    first.document.clips.map((clip) => clip.source),
  );
  expect(linked.document.syncGroups).toEqual(first.document.syncGroups);
  const selected = applyBatch(
    first.document,
    [
      {
        operation: "move",
        clipIds: [first.labels.audio],
        atUs: 3000000,
        scope: "selected",
        ripple: "none",
      },
    ],
    context,
  );
  expect(selected.document.clips[0]).toEqual(first.document.clips[0]);
  expect(selected.document.clips[1]!.placement).toEqual({
    kind: "project",
    range: { startUs: 3000000, endUs: 4600000 },
  });
  expect(selected.document.syncGroups).toEqual([]);
});

test("moving attached media preserves exact mapping and moves descendants only once", () => {
  const document = {
    ...input,
    tracks: [
      { id: "base", kind: "video", order: 0 },
      { id: "overlay", kind: "video", order: 1 },
      { id: "nested", kind: "video", order: 2 },
    ],
    clips: [
      {
        id: "parent",
        assetId: "source",
        streamId: "v",
        trackId: "base",
        source: { kind: "range", range: { startUs: 0, endUs: 20 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 12 } },
      },
      {
        id: "child",
        assetId: "source",
        streamId: "v",
        trackId: "overlay",
        source: { kind: "range", range: { startUs: 0, endUs: 10 } },
        placement: { kind: "content", clipId: "parent", sourceRange: { startUs: 5, endUs: 10 } },
      },
      {
        id: "nested",
        assetId: "source",
        streamId: "v",
        trackId: "nested",
        source: { kind: "hold", atUs: 0 },
        placement: {
          kind: "clip",
          clipId: "child",
          start: { numerator: 0, denominator: 1 },
          end: { numerator: 1, denominator: 1 },
        },
      },
    ],
  };
  const before = validateComposition(document, context.assets);
  const shifted = applyBatch(
    document,
    [{ operation: "move", clipIds: ["parent", "child"], atUs: 7, ripple: "none" }],
    context,
  );
  const after = validateComposition(shifted.document, context.assets);
  for (let at = 0; at < 12; at++)
    expect(projectToSource(after, at + 7)).toEqual(projectToSource(before, at));
  expect(shifted.document.clips.slice(1)).toEqual(before.document.clips.slice(1));
  const child = applyBatch(
    document,
    [{ operation: "move", clipIds: ["child"], atUs: 4, ripple: "none" }],
    context,
  );
  expect(child.document.clips[0]).toEqual(before.document.clips[0]);
  expect(child.document.clips[1]!.placement).toEqual({
    kind: "content",
    clipId: "parent",
    sourceRange: {
      startUs: { numerator: 20, denominator: 3 },
      endUs: { numerator: 35, denominator: 3 },
    },
  });
  expect(child.document.clips[2]).toEqual(before.document.clips[2]);
  expect(() =>
    applyBatch(
      document,
      [{ operation: "move", clipIds: ["child"], atUs: 10, ripple: "none" }],
      context,
    ),
  ).toThrow(/leaves its parent/);
  expect(
    applyBatch(
      document,
      [{ operation: "move", clipIds: ["child"], atUs: 3, scope: "selected", ripple: "none" }],
      context,
    ).changed,
  ).toBe(false);
});

test("selected move retains synchronization inside moving and stationary subsets", () => {
  const document = {
    ...input,
    tracks: [0, 1, 2, 3].map((order) => ({ id: `t${order}`, kind: "video", order })),
    clips: [0, 1, 2, 3].map((i) => ({
      id: `c${i}`,
      assetId: "source",
      streamId: "v",
      trackId: `t${i}`,
      source: { kind: "hold", atUs: 0 },
      placement: { kind: "project", range: { startUs: i, endUs: 10 + i } },
    })),
    syncGroups: [{ id: "group", clipIds: ["c0", "c1", "c2", "c3"] }],
  };
  const result = applyBatch(
    document,
    [{ operation: "move", clipIds: ["c0", "c1"], atUs: 20, scope: "selected", ripple: "none" }],
    context,
  );
  expect(result.document.syncGroups.map((group) => group.clipIds)).toEqual([
    ["c2", "c3"],
    ["c0", "c1"],
  ]);
  expect(result.document.syncGroups[0]!.id).toBe("group");
  expect(result.createdIds).toEqual([{ kind: "syncGroup", id: result.document.syncGroups[1]!.id }]);
});

test("move can change explicit destination tracks without changing link or source identity", () => {
  const first = applyBatch(
    input,
    [...setup, { operation: "track.add", track: { kind: "video", order: 1 }, label: "upper" }],
    context,
  );
  const operation = {
    operation: "move",
    clipIds: [first.labels.video],
    atUs: 0,
    ripple: "none",
    scope: "selected",
    tracks: [{ clipId: first.labels.video, trackId: first.labels.upper }],
  };
  const result = applyBatch(first.document, [operation], context);
  expect(result.document.clips[0]).toEqual({
    ...first.document.clips[0],
    trackId: first.labels.upper,
  });
  expect(result.document.clips[1]).toEqual(first.document.clips[1]);
  expect(result.document.syncGroups).toEqual(first.document.syncGroups);
  expect(applyBatch(result.document, [operation], context).changed).toBe(false);
  expect(() =>
    applyBatch(
      first.document,
      [{ ...operation, tracks: [{ clipId: first.labels.audio, trackId: first.labels.sound }] }],
      context,
    ),
  ).toThrow(/affected clips/);
  expect(() =>
    applyBatch(
      first.document,
      [{ ...operation, tracks: [operation.tracks[0], operation.tracks[0]] }],
      context,
    ),
  ).toThrow(/duplicates/);
  expect(() =>
    applyBatch(
      first.document,
      [{ ...operation, tracks: [{ clipId: first.labels.video, trackId: first.labels.sound }] }],
      context,
    ),
  ).toThrow(CompositionError);
});

test("detach freezes exact placement and reanchor changes dependency without moving samples", () => {
  const document = {
    ...input,
    tracks: [
      { id: "base", kind: "video", order: 0 },
      { id: "overlay", kind: "video", order: 1 },
    ],
    clips: [
      {
        id: "parent",
        assetId: "source",
        streamId: "v",
        trackId: "base",
        source: { kind: "range", range: { startUs: 0, endUs: 9 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 10 } },
      },
      {
        id: "child",
        assetId: "source",
        streamId: "v",
        trackId: "overlay",
        source: { kind: "range", range: { startUs: 10, endUs: 20 } },
        placement: { kind: "content", clipId: "parent", sourceRange: { startUs: 1, endUs: 4 } },
      },
    ],
  };
  const detached = applyBatch(document, [{ operation: "detach", clipIds: ["child"] }], context);
  expect(detached.document.clips[1]!.placement).toEqual({
    kind: "project",
    range: { startUs: { numerator: 10, denominator: 9 }, endUs: { numerator: 40, denominator: 9 } },
  });
  expect(
    applyBatch(detached.document, [{ operation: "detach", clipIds: ["child"] }], context).changed,
  ).toBe(false);
  const attached = applyBatch(
    detached.document,
    [{ operation: "reanchor", clipId: "child", placement: document.clips[1]!.placement }],
    context,
  );
  expect(attached.document).toEqual(validateComposition(document, context.assets).document);
  const moved = applyBatch(
    detached.document,
    [{ operation: "move", clipIds: ["parent"], atUs: 20, ripple: "none" }],
    context,
  );
  expect(moved.document.clips[1]).toEqual(detached.document.clips[1]);
  expect(() =>
    applyBatch(
      document,
      [
        {
          operation: "reanchor",
          clipId: "child",
          placement: { kind: "content", clipId: "parent", sourceRange: { startUs: 2, endUs: 5 } },
        },
      ],
      context,
    ),
  ).toThrow(/preserve the current project interval/);
  expect(() =>
    applyBatch(
      document,
      [
        {
          operation: "reanchor",
          clipId: "parent",
          placement: {
            kind: "clip",
            clipId: "child",
            start: { numerator: 0, denominator: 1 },
            end: { numerator: 1, denominator: 1 },
          },
        },
      ],
      context,
    ),
  ).toThrow(CompositionError);
});

test("duplicate copies linked media and attachments with fresh identities and later batch labels", () => {
  const first = applyBatch(
    input,
    [
      ...setup,
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "overlay" },
      {
        operation: "place",
        label: "child",
        clip: {
          assetId: "source",
          streamId: "v",
          trackId: { label: "overlay" },
          source: { kind: "hold", atUs: 0 },
          placement: {
            kind: "content",
            clipId: { label: "video" },
            sourceRange: { startUs: 500000, endUs: 1000000 },
          },
        },
      },
    ],
    context,
  );
  const operations = [
    {
      operation: "duplicate",
      clipIds: [first.labels.audio],
      scope: "linked",
      atUs: 3000000,
      copyLabels: [
        { clipId: first.labels.video, label: "newVideo" },
        { clipId: first.labels.child, label: "newChild" },
      ],
    },
  ];
  const result = applyBatch(first.document, operations, { ...context, namespace: "copy" });
  expect(applyBatch(first.document, operations, { ...context, namespace: "copy" })).toEqual(result);
  expect(result.document.clips.slice(0, 3)).toEqual(first.document.clips);
  const copies = result.document.clips.slice(3);
  expect(copies.map((clip) => clip.source)).toEqual(
    first.document.clips.map((clip) => clip.source),
  );
  expect(copies[0]!.placement).toEqual({
    kind: "project",
    range: { startUs: 3000000, endUs: 5000000 },
  });
  expect(copies[1]!.placement).toEqual({
    kind: "project",
    range: { startUs: 3200000, endUs: 4800000 },
  });
  expect(copies[2]!.placement).toEqual({
    kind: "content",
    clipId: copies[0]!.id,
    sourceRange: { startUs: 500000, endUs: 1000000 },
  });
  expect(result.document.syncGroups[0]).toEqual(first.document.syncGroups[0]);
  expect(result.document.syncGroups[1]!.clipIds).toEqual([copies[0]!.id, copies[1]!.id]);
  expect(result.createdIds.map((entry) => entry.id)).toEqual([
    ...copies.map((clip) => clip.id),
    result.document.syncGroups[1]!.id,
  ]);
  expect(result.labels.newVideo).toBe(copies[0]!.id);
  expect(result.labels.newChild).toBe(copies[2]!.id);
  const removed = applyBatch(
    first.document,
    [...operations, { operation: "remove", clipIds: [{ label: "newVideo" }], ripple: "none" }],
    { ...context, namespace: "copy" },
  );
  expect(removed.document).toEqual(first.document);
  const childOnly = applyBatch(
    first.document,
    [{ operation: "duplicate", clipIds: [first.labels.child], atUs: 3000000 }],
    { ...context, namespace: "childCopy" },
  );
  expect(childOnly.document.clips.slice(0, 3)).toEqual(first.document.clips);
  expect(childOnly.document.clips[3]!.placement).toEqual({
    kind: "project",
    range: { startUs: 3000000, endUs: 3500000 },
  });
});

test("duplicate selected scope copies only its dependency subtree and requires a free destination", () => {
  const first = applyBatch(input, setup, context);
  const result = applyBatch(
    first.document,
    [{ operation: "duplicate", clipIds: [first.labels.video], atUs: 2000000 }],
    { ...context, namespace: "copy" },
  );
  expect(result.document.clips).toMatchObject([
    { streamId: "v" },
    { streamId: "a" },
    { streamId: "v" },
  ]);
  expect(result.document.syncGroups).toEqual(first.document.syncGroups);
  expect(() =>
    applyBatch(
      first.document,
      [{ operation: "duplicate", clipIds: [first.labels.video], atUs: 1000000 }],
      context,
    ),
  ).toThrow(CompositionError);
  expect(() =>
    applyBatch(
      first.document,
      [
        {
          operation: "duplicate",
          clipIds: [first.labels.video],
          atUs: 2000000,
          copyLabels: [{ clipId: first.labels.audio, label: "absent" }],
        },
      ],
      context,
    ),
  ).toThrow(CompositionError);
});

test("retime scales a linked envelope and keeps audio/video source selection and offsets exact", () => {
  const first = applyBatch(input, setup, context);
  const result = applyBatch(
    first.document,
    [{ operation: "retime", clipIds: [first.labels.audio], durationUs: 3000000, ripple: "none" }],
    context,
  );
  expect(result.document.clips.map((clip) => clip.placement)).toEqual([
    { kind: "project", range: { startUs: 0, endUs: 3000000 } },
    { kind: "project", range: { startUs: 300000, endUs: 2700000 } },
  ]);
  expect(result.document.clips.map((clip) => clip.source)).toEqual(
    first.document.clips.map((clip) => clip.source),
  );
  expect(result.document.clips[0]).not.toHaveProperty("pitch");
  expect(result.document.clips[1]).toMatchObject({ pitch: "preserve" });
  expect(result.document.syncGroups).toEqual(first.document.syncGroups);
  const model = validateComposition(result.document, context.assets);
  expect(projectToSource(model, 1500000).map((sample) => sample.sourceUs)).toEqual([
    1000000, 1000000,
  ]);
  expect(
    applyBatch(
      result.document,
      [{ operation: "retime", clipIds: [first.labels.audio], durationUs: 3000000, ripple: "none" }],
      context,
    ).changed,
  ).toBe(false);
  const selected = applyBatch(
    first.document,
    [
      {
        operation: "retime",
        clipIds: [first.labels.audio],
        durationUs: 800000,
        scope: "selected",
        pitch: "follow",
        ripple: "none",
      },
    ],
    context,
  );
  expect(selected.document.clips[0]).toEqual(first.document.clips[0]);
  expect(selected.document.clips[1]!.placement).toEqual({
    kind: "project",
    range: { startUs: 200000, endUs: 1000000 },
  });
  expect(selected.document.clips[1]).toMatchObject({ pitch: "follow" });
  expect(selected.document.syncGroups).toEqual([]);
});

test("retime propagates through held-parent attachments once and preserves gaps", () => {
  const document = {
    ...input,
    tracks: [
      { id: "base", kind: "video", order: 0 },
      { id: "voice", kind: "audio", order: 0 },
    ],
    clips: [
      {
        id: "parent",
        assetId: "source",
        streamId: "v",
        trackId: "base",
        source: { kind: "hold", atUs: 0 },
        placement: { kind: "project", range: { startUs: 0, endUs: 9 } },
      },
      {
        id: "child",
        assetId: "source",
        streamId: "a",
        trackId: "voice",
        source: { kind: "range", range: { startUs: 200000, endUs: 1800000 } },
        placement: {
          kind: "clip",
          clipId: "parent",
          start: { numerator: 1, denominator: 3 },
          end: { numerator: 2, denominator: 3 },
        },
      },
    ],
  };
  const doubled = applyBatch(
    document,
    [{ operation: "retime", clipIds: ["parent", "child"], durationUs: 18, ripple: "none" }],
    context,
  );
  expect(doubled.document.clips[1]!.placement).toEqual(document.clips[1]!.placement);
  expect(doubled.document.clips[1]).toMatchObject({ pitch: "preserve" });
  expect(
    projectToSource(validateComposition(doubled.document, context.assets), 9).map(
      (sample) => sample.sourceUs,
    ),
  ).toEqual([0, 1000000]);
  const child = applyBatch(
    document,
    [{ operation: "retime", clipIds: ["child"], durationUs: 4, ripple: "none" }],
    context,
  );
  expect(child.document.clips[0]).toEqual(
    validateComposition(document, context.assets).document.clips[0],
  );
  expect(child.document.clips[1]!.placement).toEqual({
    kind: "clip",
    clipId: "parent",
    start: { numerator: 1, denominator: 3 },
    end: { numerator: 7, denominator: 9 },
  });
  expect(() =>
    applyBatch(
      document,
      [{ operation: "retime", clipIds: ["child"], durationUs: 7, ripple: "none" }],
      context,
    ),
  ).toThrow(/leaves its parent/);
  const gapped = {
    ...input,
    tracks: [{ id: "base", kind: "video", order: 0 }],
    clips: [{ ...document.clips[0], source: { kind: "range", range: { startUs: 0, endUs: 9 } } }],
  };
  const assets = [
    {
      id: "source",
      streams: [
        {
          id: "v",
          kind: "video",
          width: 640,
          height: 480,
          bounds: { startUs: 0, endUs: 9 },
          available: [
            { startUs: 0, endUs: 3 },
            { startUs: 6, endUs: 9 },
          ],
        },
      ],
    },
  ];
  const stretched = applyBatch(
    gapped,
    [{ operation: "retime", clipIds: ["parent"], durationUs: 18, ripple: "none" }],
    { ...context, assets },
  );
  const model = validateComposition(stretched.document, assets);
  expect(projectToSource(model, 5).map((sample) => sample.sourceUs)).toEqual([2]);
  expect(projectToSource(model, 8)).toEqual([
    {
      clipId: "parent",
      assetId: "source",
      streamId: "v",
      trackId: "base",
      sourceUs: 4,
      available: false,
    },
  ]);
  expect(projectToSource(model, 12).map((sample) => sample.sourceUs)).toEqual([6]);
});

test("insertion splits linked media and attachments then shifts named roots once", () => {
  const first = applyBatch(
    input,
    [
      ...setup,
      { operation: "track.add", track: { kind: "video", order: 1 }, label: "overlay" },
      {
        operation: "place",
        label: "child",
        clip: {
          assetId: "source",
          streamId: "v",
          trackId: { label: "overlay" },
          source: { kind: "range", range: { startUs: 0, endUs: 500000 } },
          placement: {
            kind: "content",
            clipId: { label: "video" },
            sourceRange: { startUs: 500000, endUs: 1000000 },
          },
        },
      },
    ],
    context,
  );
  const operation = {
    operation: "insert",
    atUs: 800000,
    durationUs: 500000,
    ripple: { trackIds: [first.labels.picture, first.labels.sound, first.labels.overlay] },
  };
  const result = applyBatch(first.document, [operation], { ...context, namespace: "insert" });
  const before = validateComposition(first.document, context.assets),
    after = validateComposition(result.document, context.assets);
  expect(after.durationUs).toBe(2500000);
  expect(projectToSource(after, 1000000)).toEqual([]);
  for (const at of [0, 250000, 500000, 799999, 1300000, 1450000, 2499999]) {
    const originalAt = at < 800000 ? at : at - 500000;
    const values = (model: typeof before, time: number) =>
      projectToSource(model, time).map((value) => omit(value, "clipId"));
    expect(values(after, at)).toEqual(values(before, originalAt));
  }
  expect(result.document.syncGroups.map((group) => group.clipIds.length)).toEqual([2, 2]);
  expect(result.clipLineage.map((entry) => entry.originalId)).toEqual(
    first.document.clips.map((clip) => clip.id),
  );
  expect(() =>
    applyBatch(first.document, [{ ...operation, ripple: { trackIds: [first.labels.picture] } }], {
      ...context,
      namespace: "insert",
    }),
  ).toThrow(/synchronization/);
  expect(() =>
    applyBatch(first.document, [{ ...operation, ripple: { trackIds: [first.labels.overlay] } }], {
      ...context,
      namespace: "insert",
    }),
  ).toThrow(/root track/);
  expect(
    applyBatch(first.document, [{ ...operation, atUs: 2000000 }], {
      ...context,
      namespace: "insert",
    }).changed,
  ).toBe(false);
});

test("insertion preserves every source sample across small retimed clips", () => {
  for (let duration = 1; duration <= 8; duration++)
    for (let source = 1; source <= 7; source++)
      for (let atUs = 0; atUs < duration; atUs++)
        for (let durationUs = 1; durationUs <= 3; durationUs++) {
          const document = {
            ...input,
            tracks: [{ id: "track", kind: "video", order: 0 }],
            clips: [
              {
                id: "clip",
                assetId: "source",
                streamId: "v",
                trackId: "track",
                source: { kind: "range", range: { startUs: 0, endUs: source } },
                placement: { kind: "project", range: { startUs: 0, endUs: duration } },
              },
            ],
          };
          const result = applyBatch(
            document,
            [{ operation: "insert", atUs, durationUs, ripple: { trackIds: ["track"] } }],
            context,
          );
          const model = validateComposition(result.document, context.assets);
          expect(model.durationUs).toBe(duration + durationUs);
          for (let at = 0; at < model.durationUs; at++) {
            const expected =
              at >= atUs && at < atUs + durationUs
                ? []
                : [Math.floor(((at < atUs ? at : at - durationUs) * source) / duration)];
            expect(projectToSource(model, at).map((sample) => sample.sourceUs)).toEqual(expected);
          }
        }
});

test("ripple retime shifts following synchronized media for both growth and shrinkage", () => {
  const first = applyBatch(input, setup, context);
  const following = first.document.clips.map((clip, i) => ({
    ...clip,
    id: `next${i}`,
    placement: {
      kind: "project" as const,
      range: { startUs: i === 0 ? 2000000 : 2200000, endUs: i === 0 ? 4000000 : 3800000 },
    },
  }));
  const document = {
    ...first.document,
    clips: [...first.document.clips, ...following],
    syncGroups: [
      ...first.document.syncGroups,
      { id: "next-group", clipIds: following.map((clip) => clip.id) },
    ],
  };
  for (const durationUs of [1000000, 3000000]) {
    const result = applyBatch(
      document,
      [
        {
          operation: "retime",
          clipIds: [first.labels.video],
          durationUs,
          ripple: { trackIds: [first.labels.picture, first.labels.sound] },
        },
      ],
      { ...context, namespace: "resize" },
    );
    expect(result.document.clips[2]!.placement).toEqual({
      kind: "project",
      range: { startUs: durationUs, endUs: durationUs + 2000000 },
    });
    expect(result.document.clips[3]!.placement).toEqual({
      kind: "project",
      range: { startUs: durationUs + 200000, endUs: durationUs + 1800000 },
    });
    expect(result.document.clips.slice(2).map((clip) => clip.source)).toEqual(
      following.map((clip) => clip.source),
    );
    expect(result.document.syncGroups).toEqual(document.syncGroups);
  }
  expect(() =>
    applyBatch(
      first.document,
      [
        {
          operation: "retime",
          clipIds: [first.labels.video],
          durationUs: 3000000,
          ripple: { trackIds: [first.labels.picture] },
        },
      ],
      context,
    ),
  ).toThrow(CompositionError);
});

test("ripple move closes the old occurrence window and inserts at the final destination", () => {
  const first = applyBatch(input, setup, context);
  const following = first.document.clips.map((clip, i) => ({
    ...clip,
    id: `next${i}`,
    placement: {
      kind: "project" as const,
      range: { startUs: i === 0 ? 2000000 : 2200000, endUs: i === 0 ? 4000000 : 3800000 },
    },
  }));
  const document = {
    ...first.document,
    clips: [...first.document.clips, ...following],
    syncGroups: [
      ...first.document.syncGroups,
      { id: "next-group", clipIds: following.map((clip) => clip.id) },
    ],
  };
  const operation = {
    operation: "move",
    clipIds: [first.labels.video],
    atUs: 2000000,
    ripple: { trackIds: [first.labels.picture, first.labels.sound] },
  };
  const result = applyBatch(document, [operation], { ...context, namespace: "reorder" });
  const byId = new Map(result.document.clips.map((clip) => [clip.id, clip]));
  expect(byId.get(first.labels.video!)!.placement).toEqual({
    kind: "project",
    range: { startUs: 2000000, endUs: 4000000 },
  });
  expect(byId.get(first.labels.audio!)!.placement).toEqual({
    kind: "project",
    range: { startUs: 2200000, endUs: 3800000 },
  });
  expect(byId.get("next0")!.placement).toEqual({
    kind: "project",
    range: { startUs: 0, endUs: 2000000 },
  });
  expect(byId.get("next1")!.placement).toEqual({
    kind: "project",
    range: { startUs: 200000, endUs: 1800000 },
  });
  expect(result.createdIds).toEqual([]);
  expect(result.removedAttachments).toEqual([]);
  expect(result.document.syncGroups).toEqual(document.syncGroups);
  const restored = applyBatch(result.document, [{ ...operation, atUs: 0 }], {
    ...context,
    namespace: "return",
  });
  expect(new Map(restored.document.clips.map((clip) => [clip.id, clip]))).toEqual(
    new Map(document.clips.map((clip) => [clip.id, clip])),
  );
  expect(applyBatch(document, [{ ...operation, atUs: 0 }], context).changed).toBe(false);
  expect(() =>
    applyBatch(document, [{ ...operation, ripple: { trackIds: [first.labels.picture] } }], context),
  ).toThrow(CompositionError);
});

test("ripple move splits destination media while preserving moved attachments and fixed roots", () => {
  const first = applyBatch(input, setup, context);
  const document = {
    ...first.document,
    tracks: [
      ...first.document.tracks,
      { id: "overlay-track", kind: "video", order: 1 },
      { id: "fixed-track", kind: "video", order: 2 },
    ],
    clips: [
      ...first.document.clips,
      {
        ...first.document.clips[0]!,
        id: "following",
        placement: { kind: "project", range: { startUs: 2000000, endUs: 4000000 } },
      },
      {
        ...first.document.clips[0]!,
        id: "overlay",
        trackId: "overlay-track",
        placement: {
          kind: "content",
          clipId: first.labels.video!,
          sourceRange: { startUs: 500000, endUs: 1500000 },
        },
      },
      {
        ...first.document.clips[0]!,
        id: "fixed",
        trackId: "fixed-track",
        placement: { kind: "project", range: { startUs: 1000000, endUs: 3000000 } },
      },
    ],
  };
  const before = structuredClone(document);
  const operation = {
    operation: "move",
    clipIds: [first.labels.video],
    atUs: 1000000,
    ripple: { trackIds: [first.labels.picture, first.labels.sound, "overlay-track"] },
  };
  const result = applyBatch(document, [operation], context);
  const model = validateComposition(result.document, context.assets);
  const intervals = new Map(model.clips.map((value) => [value.clip.id, value.range]));
  expect(intervals.get("overlay")).toEqual({
    start: { numerator: 1500000n, denominator: 1n },
    end: { numerator: 2500000n, denominator: 1n },
  });
  expect(result.document.clips.find((clip) => clip.id === "overlay")).toEqual(
    document.clips.find((clip) => clip.id === "overlay"),
  );
  expect(result.document.clips.find((clip) => clip.id === "fixed")).toEqual(
    document.clips.find((clip) => clip.id === "fixed"),
  );
  expect(result.touchedFixedAnchors).toEqual([{ kind: "clip", id: "fixed" }]);
  const line = result.clipLineage.find((entry) => entry.originalId === "following");
  expect(line).toBeDefined();
  expect(
    projectToSource(model, 500000).find((value) => value.clipId === "following")?.sourceUs,
  ).toBe(500000);
  expect(projectToSource(model, 3500000).find((value) => value.clipId !== "fixed")?.sourceUs).toBe(
    1500000,
  );
  expect(result.removedAttachments).toEqual([]);
  expect(document).toEqual(before);
  expect(() =>
    applyBatch(document, [{ ...operation, clipIds: ["overlay"], scope: "selected" }], context),
  ).toThrow(CompositionError);
});

test("a ripple move between tracks at the same time keeps synchronization and other media", () => {
  const first = applyBatch(input, setup, context);
  const document = {
    ...first.document,
    tracks: [...first.document.tracks, { id: "destination", kind: "video", order: 1 }],
  };
  const result = applyBatch(
    document,
    [
      {
        operation: "move",
        clipIds: [first.labels.video],
        scope: "selected",
        atUs: 0,
        tracks: [{ clipId: first.labels.video, trackId: "destination" }],
        ripple: { trackIds: [first.labels.picture, "destination"] },
      },
    ],
    context,
  );
  expect(result.document.clips).toEqual(
    document.clips.map((clip) =>
      clip.id === first.labels.video ? { ...clip, trackId: "destination" } : clip,
    ),
  );
  expect(result.document.syncGroups).toEqual(document.syncGroups);
  expect(result.clipLineage).toEqual([]);
});

test("ripple move preserves fractional duration when opening a split destination", () => {
  const document = {
    ...input,
    tracks: [{ id: "video", kind: "video", order: 0 }],
    clips: [
      {
        id: "moving",
        assetId: "source",
        streamId: "v",
        trackId: "video",
        source: { kind: "range", range: { startUs: 0, endUs: 7 } },
        placement: {
          kind: "project",
          range: { startUs: 0, endUs: { numerator: 7, denominator: 3 } },
        },
      },
      {
        id: "stationary",
        assetId: "source",
        streamId: "v",
        trackId: "video",
        source: { kind: "range", range: { startUs: 0, endUs: 7 } },
        placement: {
          kind: "project",
          range: {
            startUs: { numerator: 7, denominator: 3 },
            endUs: { numerator: 14, denominator: 3 },
          },
        },
      },
    ],
  };
  const result = applyBatch(
    document,
    [{ operation: "move", clipIds: ["moving"], atUs: 1, ripple: { trackIds: ["video"] } }],
    context,
  );
  const line = result.clipLineage.find((entry) => entry.originalId === "stationary")!;
  expect(line.clipIds).toHaveLength(2);
  const byId = new Map(result.document.clips.map((clip) => [clip.id, clip]));
  expect(byId.get("moving")!.placement).toEqual({
    kind: "project",
    range: { startUs: 1, endUs: { numerator: 10, denominator: 3 } },
  });
  expect(byId.get("stationary")!.source).toEqual({
    kind: "range",
    range: { startUs: 0, endUs: 3 },
  });
  expect(byId.get(line.clipIds[1]!)!.source).toEqual({
    kind: "range",
    range: { startUs: 3, endUs: 7 },
  });
  expect(byId.get(line.clipIds[1]!)!.placement).toEqual({
    kind: "project",
    range: { startUs: { numerator: 10, denominator: 3 }, endUs: { numerator: 14, denominator: 3 } },
  });
  expect(projectToSource(validateComposition(result.document, context.assets), 4)).toMatchObject([
    { clipId: line.clipIds[1], sourceUs: 5 },
  ]);
});

test("ripple move validates overlap after closure and insertion compose", () => {
  const media = {
    assetId: "source",
    streamId: "v",
    source: { kind: "range", range: { startUs: 0, endUs: 10 } },
  };
  const document = {
    ...input,
    tracks: [
      { id: "main", kind: "video", order: 0 },
      { id: "overlay", kind: "video", order: 1 },
    ],
    clips: [
      {
        ...media,
        id: "moving",
        trackId: "main",
        placement: { kind: "project", range: { startUs: 10, endUs: 20 } },
      },
      {
        ...media,
        id: "later",
        trackId: "main",
        placement: { kind: "project", range: { startUs: 20, endUs: 30 } },
      },
      {
        ...media,
        id: "fixed",
        trackId: "overlay",
        placement: { kind: "project", range: { startUs: 10, endUs: 20 } },
      },
      {
        ...media,
        id: "child",
        trackId: "overlay",
        placement: { kind: "content", clipId: "later", sourceRange: { startUs: 0, endUs: 10 } },
      },
    ],
  };
  const result = applyBatch(
    document,
    [{ operation: "move", clipIds: ["moving"], atUs: 0, ripple: { trackIds: ["main"] } }],
    context,
  );
  expect(result.document.clips).toEqual(
    document.clips.map((clip) =>
      clip.id === "moving"
        ? { ...clip, placement: { kind: "project", range: { startUs: 0, endUs: 10 } } }
        : clip,
    ),
  );
  expect(result.touchedFixedAnchors).toEqual([{ kind: "clip", id: "fixed" }]);
  expect(() =>
    applyBatch(
      document,
      [{ operation: "move", clipIds: ["moving"], atUs: 30, ripple: { trackIds: ["main"] } }],
      context,
    ),
  ).toThrow(CompositionError);
});

test("ripple move checks synchronization on the combined displacement", () => {
  const media = {
    assetId: "source",
    streamId: "v",
    source: { kind: "range", range: { startUs: 0, endUs: 10 } },
  };
  const document = {
    ...input,
    tracks: [
      { id: "main", kind: "video", order: 0 },
      { id: "overlay", kind: "video", order: 1 },
    ],
    clips: [
      {
        ...media,
        id: "moving",
        trackId: "main",
        placement: { kind: "project", range: { startUs: 10, endUs: 20 } },
      },
      {
        ...media,
        id: "later",
        trackId: "main",
        placement: { kind: "project", range: { startUs: 20, endUs: 30 } },
      },
      {
        ...media,
        id: "fixed",
        trackId: "overlay",
        placement: { kind: "project", range: { startUs: 10, endUs: 20 } },
      },
    ],
    syncGroups: [{ id: "pair", clipIds: ["later", "fixed"] }],
  };
  const result = applyBatch(
    document,
    [{ operation: "move", clipIds: ["moving"], atUs: 0, ripple: { trackIds: ["main"] } }],
    context,
  );
  expect(result.document.syncGroups).toEqual(document.syncGroups);
  expect(result.document.clips).toEqual(
    document.clips.map((clip) =>
      clip.id === "moving"
        ? { ...clip, placement: { kind: "project", range: { startUs: 0, endUs: 10 } } }
        : clip,
    ),
  );
  expect(() =>
    applyBatch(
      document,
      [{ operation: "move", clipIds: ["moving"], atUs: 30, ripple: { trackIds: ["main"] } }],
      context,
    ),
  ).toThrow(CompositionError);
});

test("replace audio keeps its linked video and interval while changing only the addressed source", () => {
  const first = applyBatch(input, setup, context);
  const assets = [
    ...context.assets,
    {
      id: "replacement",
      streams: [
        {
          id: "voice",
          kind: "audio",
          bounds: { startUs: 0, endUs: 3000000 },
          available: [{ startUs: 0, endUs: 3000000 }],
        },
      ],
    },
  ];
  const operation = {
    operation: "replace",
    clipId: first.labels.audio,
    kind: "audio",
    media: {
      assetId: "replacement",
      streamId: "voice",
      source: { kind: "range", range: { startUs: 0, endUs: 1600000 } },
    },
  };
  const result = applyBatch(first.document, [operation], { ...context, assets });
  expect(result.document.clips[0]).toEqual(first.document.clips[0]);
  expect(result.document.clips[1]).toEqual({ ...first.document.clips[1], ...operation.media });
  expect(result.document.syncGroups).toEqual(first.document.syncGroups);
  expect(result.createdIds).toEqual([]);
  expect(applyBatch(result.document, [operation], { ...context, assets }).changed).toBe(false);
  expect(() =>
    applyBatch(first.document, [{ ...operation, kind: "video" }], { ...context, assets }),
  ).toThrow(CompositionError);
  expect(() =>
    applyBatch(
      first.document,
      [
        {
          ...operation,
          media: {
            ...operation.media,
            source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          },
        },
      ],
      { ...context, assets },
    ),
  ).toThrow(CompositionError);
});

test("replacement removes old content attachments without retargeting them or changing linked media", () => {
  const first = applyBatch(input, setup, context);
  const document = {
    ...first.document,
    tracks: [...first.document.tracks, { id: "overlay", kind: "video", order: 1 }],
    clips: [
      ...first.document.clips,
      {
        id: "child",
        assetId: "source",
        streamId: "v",
        trackId: "overlay",
        source: { kind: "hold", atUs: 0 },
        placement: {
          kind: "content",
          clipId: first.labels.video!,
          sourceRange: { startUs: 500000, endUs: 1000000 },
        },
      },
    ],
  };
  const media = {
    assetId: "replacement",
    streamId: "v",
    source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
  };
  const assets = [...context.assets, { ...context.assets[0]!, id: "replacement" }];
  const operation = { operation: "replace", clipId: first.labels.video, kind: "video", media };
  const original = structuredClone(document);
  const result = applyBatch(document, [operation], { ...context, assets });
  expect(result.removedAttachments).toEqual(["child"]);
  expect(result.document.clips).toEqual([
    { ...first.document.clips[0], ...media },
    first.document.clips[1],
  ]);
  expect(result.document.syncGroups).toEqual(first.document.syncGroups);
  expect(
    applyBatch(document, [{ ...operation, media: { ...media, assetId: "source" } }], {
      ...context,
      assets,
    }).document,
  ).toEqual(document);
  expect(() =>
    applyBatch(
      document,
      [
        { operation: "canvas.set", canvas: { width: 320 } },
        { ...operation, media: { ...media, assetId: "absent" } },
      ],
      { ...context, assets },
    ),
  ).toThrow(CompositionError);
  expect(document).toEqual(original);
});

test("replacement only trims or stretches when explicitly requested", () => {
  const first = applyBatch(input, setup, context);
  const assets = [
    ...context.assets,
    {
      id: "replacement",
      streams: [
        {
          id: "voice",
          kind: "audio",
          bounds: { startUs: 0, endUs: 3000000 },
          available: [{ startUs: 0, endUs: 3000000 }],
        },
      ],
    },
  ];
  const operation = {
    operation: "replace",
    clipId: first.labels.audio,
    kind: "audio",
    media: {
      assetId: "replacement",
      streamId: "voice",
      source: { kind: "range", range: { startUs: 500000, endUs: 2500000 } },
    },
  };
  // Output by default: a source past the stream's end is clamped, reported, then trimmed to fit.
  const clamped = applyBatch(
    first.document,
    [
      {
        ...operation,
        fit: "trim",
        media: {
          ...operation.media,
          source: { kind: "range", range: { startUs: 0, endUs: 9000000 } },
        },
      },
    ],
    { ...context, assets },
  );
  expect(clamped.issues).toMatchObject([
    { code: "range-clamped", evidence: { applied: { startUs: 0, endUs: 3000000 } } },
  ]);
  expect(clamped.document.clips[1]!.source).toEqual({
    kind: "range",
    range: { startUs: 0, endUs: 1600000 },
  });
  const trimmed = applyBatch(first.document, [{ ...operation, fit: "trim" }], {
    ...context,
    assets,
  });
  expect(trimmed.document.clips[1]!.source).toEqual({
    kind: "range",
    range: { startUs: 500000, endUs: 2100000 },
  });
  const short = {
    ...operation,
    media: {
      ...operation.media,
      source: { kind: "range", range: { startUs: 500000, endUs: 1500000 } },
    },
  };
  expect(() =>
    applyBatch(first.document, [{ ...short, fit: "trim" }], { ...context, assets }),
  ).toThrow(CompositionError);
  const stretched = applyBatch(first.document, [{ ...short, fit: "stretch" }], {
    ...context,
    assets,
  });
  expect(stretched.document.clips[1]).toEqual({
    ...first.document.clips[1],
    ...short.media,
    pitch: "preserve",
  });
  expect(
    projectToSource(validateComposition(stretched.document, assets), 1000000).find(
      (value) => value.clipId === first.labels.audio,
    ),
  ).toMatchObject({ sourceUs: 1000000 });
  expect(stretched.document.clips[0]).toEqual(first.document.clips[0]);
  expect(
    applyBatch(first.document, [{ ...short, fit: "stretch", pitch: "follow" }], {
      ...context,
      assets,
    }).document.clips[1],
  ).toMatchObject({ pitch: "follow" });
});

test("ripple replacement adopts source duration and moves later audio without retiming video", () => {
  const first = applyBatch(input, setup, context);
  const later = {
    ...first.document.clips[1]!,
    id: "later-audio",
    placement: { kind: "project", range: { startUs: 1800000, endUs: 3400000 } },
  };
  const document = { ...first.document, clips: [...first.document.clips, later] };
  const assets = [
    ...context.assets,
    {
      id: "replacement",
      streams: [
        {
          id: "voice",
          kind: "audio",
          bounds: { startUs: 0, endUs: 3000000 },
          available: [{ startUs: 0, endUs: 3000000 }],
        },
      ],
    },
  ];
  for (const duration of [1000000, 2000000]) {
    const operation = {
      operation: "replace",
      clipId: first.labels.audio,
      kind: "audio",
      media: {
        assetId: "replacement",
        streamId: "voice",
        source: { kind: "range", range: { startUs: 0, endUs: duration } },
      },
      fit: "ripple",
      ripple: { trackIds: [first.labels.sound] },
    };
    const result = applyBatch(document, [operation], { ...context, assets });
    expect(result.document.clips[0]).toEqual(first.document.clips[0]);
    expect(result.document.clips[1]!.placement).toEqual({
      kind: "project",
      range: { startUs: 200000, endUs: 200000 + duration },
    });
    expect(result.document.clips[2]!.placement).toEqual({
      kind: "project",
      range: { startUs: 200000 + duration, endUs: 1800000 + duration },
    });
    expect(result.document.syncGroups).toEqual([]);
    expect(result.touchedFixedAnchors).toEqual([{ kind: "clip", id: first.labels.video }]);
    expect(() =>
      applyBatch(document, [{ ...operation, ripple: { trackIds: [first.labels.picture] } }], {
        ...context,
        assets,
      }),
    ).toThrow(CompositionError);
    expect(() =>
      applyBatch(document, [{ ...operation, ripple: undefined }], { ...context, assets }),
    ).toThrow(CompositionError);
  }
});

test("authored silence has duration and edit identity without inventing an asset or source clock", () => {
  const first = applyBatch(
    input,
    [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
      {
        operation: "place",
        label: "silence",
        clip: {
          trackId: { label: "audio" },
          source: { kind: "silence" },
          placement: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
        },
      },
    ],
    { ...context, assets: [] },
  );
  const model = validateComposition(first.document, []);
  expect(model.durationUs).toBe(3000000);
  expect(projectToSource(model, 1500000)).toEqual([]);
  expect(first.document.clips[0]).toEqual({
    id: first.labels.silence,
    trackId: first.labels.audio,
    source: { kind: "silence" },
    placement: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
  });
  const result = applyBatch(
    first.document,
    [
      { operation: "split", clipIds: [first.labels.silence], atUs: 1000000 },
      {
        operation: "retime",
        clipIds: [first.labels.silence],
        durationUs: 1500000,
        ripple: { trackIds: [first.labels.audio] },
      },
    ],
    { ...context, assets: [], namespace: "silence-edit" },
  );
  expect(result.document.clips.map((clip) => clip.placement)).toEqual([
    { kind: "project", range: { startUs: 0, endUs: 1500000 } },
    { kind: "project", range: { startUs: 1500000, endUs: 3500000 } },
  ]);
  expect(result.document.clips.map((clip) => clip.source)).toEqual([
    { kind: "silence" },
    { kind: "silence" },
  ]);
  expect(validateComposition(result.document, []).durationUs).toBe(3500000);
  expect(projectToSource(validateComposition(result.document, []), 2000000)).toEqual([]);
});

test("explicit hold and silence fits expand into linked tails without stretching media", () => {
  const first = applyBatch(input, setup, context);
  for (const [label, kind, fit, streamId, startUs] of [
    ["video", "video", "hold", "v", 0],
    ["audio", "audio", "silence", "a", 200000],
  ] as const) {
    const id = first.labels[label]!;
    const result = applyBatch(
      first.document,
      [
        {
          operation: "replace",
          clipId: id,
          kind,
          fit,
          media: {
            assetId: "source",
            streamId,
            source: { kind: "range", range: { startUs, endUs: startUs + 1000000 } },
          },
        },
      ],
      { ...context, namespace: fit },
    );
    const tailId = result.clipLineage.find((entry) => entry.originalId === id)!.clipIds[1]!;
    const prefix = result.document.clips.find((clip) => clip.id === id)!;
    const tail = result.document.clips.find((clip) => clip.id === tailId)!;
    expect(prefix.placement).toEqual({
      kind: "project",
      range: { startUs, endUs: startUs + 1000000 },
    });
    expect(tail.placement).toEqual({
      kind: "project",
      range: { startUs: startUs + 1000000, endUs: kind === "video" ? 2000000 : 1800000 },
    });
    expect(tail.source).toEqual(
      kind === "video" ? { kind: "hold", atUs: 999999 } : { kind: "silence" },
    );
    if (kind === "audio") expect(tail).not.toHaveProperty("assetId");
    expect(result.document.syncGroups).toEqual([
      {
        ...first.document.syncGroups[0],
        clipIds: [...first.document.syncGroups[0]!.clipIds, tailId],
      },
    ]);
    const untouched = kind === "video" ? first.labels.audio : first.labels.video;
    expect(result.document.clips.find((clip) => clip.id === untouched)).toEqual(
      first.document.clips.find((clip) => clip.id === untouched),
    );
    const moved = applyBatch(
      result.document,
      [{ operation: "move", clipIds: [id], atUs: 3000000, ripple: "none" }],
      { ...context, namespace: "move-tail" },
    );
    expect(validateComposition(moved.document, context.assets).durationUs).toBe(5000000);
    expect(moved.document.clips.find((clip) => clip.id === tailId)!.source).toEqual(tail.source);
  }
});

test("silence padding retains a sole final occurrence's duration and reports its editable pieces", () => {
  const first = applyBatch(input, setup, context);
  const only = applyBatch(
    first.document,
    [
      { operation: "remove", clipIds: [first.labels.video], scope: "selected", ripple: "none" },
      { operation: "track.remove", trackId: first.labels.picture },
    ],
    context,
  );
  const operation = {
    operation: "replace",
    clipId: first.labels.audio,
    kind: "audio",
    fit: "silence",
    media: {
      assetId: "source",
      streamId: "a",
      source: { kind: "range", range: { startUs: 200000, endUs: 1200000 } },
    },
  };
  const result = applyBatch(only.document, [operation], { ...context, namespace: "final-padding" });
  const tailId = result.clipLineage[0]!.clipIds[1]!;
  const model = validateComposition(result.document, context.assets);
  expect(model.durationUs).toBe(1800000);
  expect(projectToSource(model, 1500000)).toEqual([]);
  expect(result.document.syncGroups).toEqual([
    {
      id: result.createdIds.find((entry) => entry.kind === "syncGroup")!.id,
      clipIds: [first.labels.audio, tailId],
    },
  ]);
  expect(applyBatch(result.document, [operation], context).changed).toBe(false);
  const removed = applyBatch(
    result.document,
    [{ operation: "remove", clipIds: [first.labels.audio], ripple: "none" }],
    context,
  );
  expect(removed.document.clips).toEqual([]);
  const selected = applyBatch(
    result.document,
    [{ operation: "remove", clipIds: [first.labels.audio], scope: "selected", ripple: "none" }],
    context,
  );
  expect(selected.document.clips).toEqual([
    result.document.clips.find((clip) => clip.id === tailId),
  ]);
});

test("padding preserves exact fractional placement without inventing an intermediate source cut", () => {
  const endUs = { numerator: 6000000000000001, denominator: 3000000000000000 };
  const document = {
    ...input,
    tracks: [{ id: "audio", kind: "audio", order: 0 }],
    clips: [
      {
        id: "voice",
        assetId: "source",
        streamId: "a",
        trackId: "audio",
        source: { kind: "range", range: { startUs: 200000, endUs: 1800000 } },
        placement: { kind: "project", range: { startUs: 0, endUs } },
      },
    ],
  };
  const result = applyBatch(
    document,
    [
      {
        operation: "replace",
        clipId: "voice",
        kind: "audio",
        fit: "silence",
        media: {
          assetId: "source",
          streamId: "a",
          source: { kind: "range", range: { startUs: 200000, endUs: 200001 } },
        },
      },
    ],
    context,
  );
  expect(result.document.clips.map((clip) => clip.placement)).toEqual([
    { kind: "project", range: { startUs: 0, endUs: 1 } },
    { kind: "project", range: { startUs: 1, endUs } },
  ]);
  expect(result.document.clips[0]!.source).toEqual({
    kind: "range",
    range: { startUs: 200000, endUs: 200001 },
  });
  expect(result.document.clips[1]!.source).toEqual({ kind: "silence" });
});

test("padding expansion drops old attachments unless explicitly detached first", () => {
  const first = applyBatch(input, setup, context);
  const document = {
    ...first.document,
    syncGroups: [{ id: "existing", clipIds: [first.labels.video!, "child"] }],
    tracks: [...first.document.tracks, { id: "overlay", kind: "video", order: 1 }],
    clips: [
      {
        ...first.document.clips[0]!,
        placement: { kind: "project", range: { startUs: 0, endUs: 4000000 } },
      },
      first.document.clips[1]!,
      {
        id: "child",
        assetId: "source",
        streamId: "v",
        trackId: "overlay",
        source: { kind: "hold", atUs: 0 },
        placement: {
          kind: "clip",
          clipId: first.labels.video!,
          start: { numerator: 0, denominator: 1 },
          end: { numerator: 1, denominator: 1 },
        },
      },
    ],
  };
  const replacement = {
    operation: "replace",
    clipId: first.labels.video,
    kind: "video",
    fit: "hold",
    media: {
      assetId: "source",
      streamId: "v",
      source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
    },
  };
  const removed = applyBatch(document, [replacement], {
    ...context,
    namespace: "remove-old-anchor",
  });
  expect(removed.removedAttachments).toEqual(["child"]);
  expect(removed.document.syncGroups).toEqual([
    { id: "existing", clipIds: [first.labels.video, removed.clipLineage[0]!.clipIds[1]] },
  ]);
  expect(removed.createdIds.filter((entry) => entry.kind === "syncGroup")).toEqual([]);

  expect(removed.document.clips.some((clip) => clip.id === "child")).toBe(false);
  const retained = applyBatch(
    document,
    [{ operation: "detach", clipIds: ["child"] }, replacement],
    { ...context, namespace: "keep-old-overlay" },
  );
  expect(retained.removedAttachments).toEqual([]);
  expect(retained.document.clips.find((clip) => clip.id === "child")!.placement).toEqual({
    kind: "project",
    range: { startUs: 0, endUs: 4000000 },
  });
});

test("independent placements retain their own receipts before a following dependent removal", () => {
  const placements = [0, 1, 2].map((index) => ({
    operation: "place",
    label: `placed${index}`,
    clip: {
      assetId: "source",
      streamId: "a",
      trackId: { label: "sound" },
      source: { kind: "range", range: { startUs: 200000, endUs: 300000 } },
      placement: {
        kind: "project",
        range: { startUs: index * 100000, endUs: (index + 1) * 100000 },
      },
    },
  }));
  const operations = [
    { operation: "track.add", track: { kind: "audio", order: 0 }, label: "sound" },
    ...placements,
    { operation: "remove", clipIds: [{ label: "placed0" }], scope: "selected", ripple: "none" },
  ];
  const result = applyBatch(input, operations, context);
  const placed = result.normalized.slice(1, 4).map((operation) => operation.changes);
  expect(placed).toEqual(
    [0, 1, 2].map((index) => [
      {
        kind: "clip",
        id: `clip:transaction:${index + 1}`,
        value: {
          ...placements[index]!.clip,
          id: `clip:transaction:${index + 1}`,
          trackId: "track:transaction:0",
        },
      },
    ]),
  );
  expect(result.normalized[4]!.changes).toEqual([
    { kind: "clip", id: result.labels.placed0, value: null },
  ]);
  expect(result.document.clips.map((clip) => clip.id)).toEqual([
    result.labels.placed1,
    result.labels.placed2,
  ]);
  expect(input.clips).toEqual([]);
});

test.each(
  [false, true].flatMap((processing) =>
    ["source", "label", "identity"].map((later) => ({ processing, later })),
  ),
)(
  "an earlier append error precedes a later $later error with processing=$processing",
  ({ later, processing }) => {
    const clip = {
      id: "existing",
      trackId: "audio",
      assetId: "source",
      streamId: "a",
      source: { kind: "range", range: { startUs: 200000, endUs: 300000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 100000 } },
    };
    const document = {
      ...input,
      tracks: [{ id: "audio", kind: "audio", order: 0 }],
      processing: processing
        ? [
            {
              target: { kind: "track", id: "audio" },
              steps: [{ id: "gain", enabled: true, processor: { type: "gain", gain: 0.5 } }],
            },
          ]
        : [],
      clips: [
        clip,
        ...(later === "identity"
          ? [
              {
                ...clip,
                id: "clip:transaction:1",
                placement: { kind: "project", range: { startUs: 300000, endUs: 400000 } },
              },
            ]
          : []),
      ],
    };
    const placed = {
      trackId: "audio",
      assetId: "source",
      streamId: "a",
      source: clip.source,
      placement: clip.placement,
    };
    const operations = [
      { operation: "place", label: "first", clip: placed },
      {
        operation: "place",
        label: later === "label" ? "first" : "second",
        clip: {
          ...placed,
          streamId: later === "source" ? "missing" : "a",
          placement: { kind: "project", range: { startUs: 100000, endUs: 200000 } },
        },
      },
    ];
    expect(() => applyBatch(document, operations, context)).toThrow(
      expect.objectContaining({
        code: "INVALID_EDIT",
        message: "Overlapping clips on track: audio",
        details: { operationIndex: 0, cause: "INVALID_COMPOSITION" },
      }),
    );
    expect(document.clips[0]).toEqual(clip);
  },
);

test("independent stack updates keep frozen receipts, labels and a following dependent edit", () => {
  const document = {
    ...input,
    groups: [
      { id: "a", kind: "audio", order: 0 },
      { id: "b", kind: "audio", order: 1 },
    ],
  };
  const gain = (gain: number, extra = {}) => ({ processor: { type: "gain", gain }, ...extra });
  const result = applyBatch(
    document,
    [
      {
        operation: "processing.set",
        target: { kind: "group", id: "a" },
        steps: [gain(0.5, { label: "first" })],
      },
      {
        operation: "processing.set",
        target: { kind: "group", id: "b" },
        steps: [gain(2, { label: "second" })],
      },
      {
        operation: "processing.set",
        target: { kind: "group", id: "a" },
        steps: [gain(0.25, { id: { label: "first" } })],
      },
    ],
    context,
  );
  expect(result.labels).toEqual({
    first: "processingStep:transaction:0",
    second: "processingStep:transaction:1",
  });
  expect(result.createdIds).toEqual([
    { kind: "processingStep", id: result.labels.first },
    { kind: "processingStep", id: result.labels.second },
  ]);
  expect(result.normalized).toEqual([
    {
      operationIndex: 0,
      changes: [
        {
          kind: "processing",
          target: { kind: "group", id: "a" },
          steps: [
            { id: result.labels.first, enabled: true, processor: { type: "gain", gain: 0.5 } },
          ],
        },
      ],
    },
    {
      operationIndex: 1,
      changes: [
        {
          kind: "processing",
          target: { kind: "group", id: "b" },
          steps: [
            { id: result.labels.second, enabled: true, processor: { type: "gain", gain: 2 } },
          ],
        },
      ],
    },
    {
      operationIndex: 2,
      changes: [
        {
          kind: "processing",
          target: { kind: "group", id: "a" },
          steps: [
            { id: result.labels.first, enabled: true, processor: { type: "gain", gain: 0.25 } },
          ],
        },
      ],
    },
  ]);
  expect(result.document.processing[0]!.steps[0]!.processor).toEqual({ type: "gain", gain: 0.25 });
});

test("a new processing step with an invented id is told that id names an existing step", () => {
  const document = { ...input, groups: [{ id: "a", kind: "audio", order: 0 }] };
  expect(() =>
    applyBatch(
      document,
      [
        {
          operation: "processing.set",
          target: { kind: "group", id: "a" },
          steps: [{ id: "my-new-step", processor: { type: "gain", gain: 1 } }],
        },
      ],
      context,
    ),
  ).toThrow(/omit id to add a new step/);
});

test("an invalid independent processing prefix precedes later construction errors or repair", () => {
  const document = {
    ...input,
    groups: [
      { id: "a", kind: "audio", order: 0 },
      { id: "b", kind: "audio", order: 1 },
    ],
  };
  const invalid = {
    operation: "processing.set",
    target: { kind: "group", id: "b" },
    steps: [{ processor: { type: "opacity", opacity: 0.5 } }],
  };
  for (const next of [
    {
      operation: "processing.set",
      target: { kind: "group", id: "a" },
      steps: [{ id: "foreign", processor: { type: "gain", gain: 1 } }],
    },
    {
      operation: "processing.set",
      target: { kind: "group", id: "b" },
      steps: [{ processor: { type: "gain", gain: 1 } }],
    },
  ]) {
    try {
      applyBatch(document, [invalid, next], context);
      expect.fail("invalid prefix accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionError);
      expect((error as CompositionError).details).toMatchObject({ operationIndex: 0 });
    }
  }
  expect(document.processing).toEqual([]);
});

test.each([
  { name: "gain", processor: { type: "gain", gain: 0.5 } },
  {
    name: "windowed gain",
    processor: { type: "gain", gain: 2 },
    window: { kind: "project", range: { startUs: 0, endUs: 200000 } },
  },
  { name: "stateful fallback", processor: { type: "rnnoise" } },
])("placements beneath $name preserve scalar receipts and dependent edits", (named) => {
  const step = omit(named, "name");
  const document = applyBatch(
    { ...input, tracks: [{ id: "audio", kind: "audio", order: 0 }] },
    [{ operation: "processing.set", target: { kind: "track", id: "audio" }, steps: [step] }],
    { ...context, namespace: "processing" },
  ).document;
  const operations = [0, 1, 2].map((index) => ({
    operation: "place",
    label: `placed${index}`,
    clip: {
      trackId: "audio",
      assetId: "source",
      streamId: "a",
      source: { kind: "range", range: { startUs: 200000, endUs: 300000 } },
      placement: {
        kind: "project",
        range: { startUs: index * 100000, endUs: (index + 1) * 100000 },
      },
    },
  }));
  const tail = {
    operation: "remove",
    clipIds: [{ label: "placed1" }],
    scope: "selected",
    ripple: "none",
  };
  const batched = applyBatch(document, [...operations, tail], context);
  // Canvas no-ops preserve identities but force each placement through the scalar editor path.
  const scalar = applyBatch(
    document,
    [
      ...operations.flatMap((operation) => [operation, { operation: "canvas.set", canvas: {} }]),
      tail,
    ],
    context,
  );
  expect(batched).toEqual({
    ...scalar,
    normalized: scalar.normalized
      .filter((_, index) => index % 2 === 0)
      .map((entry, operationIndex) => ({ ...entry, operationIndex })),
  });
});

function moveFixture(kind: "audio" | "video") {
  return validateComposition(
    {
      ...input,
      tracks: [{ id: "track", kind, order: 0 }],
      clips: [0, 1, 2].map((i) => ({
        id: `move${i}`,
        trackId: "track",
        assetId: "source",
        streamId: kind === "audio" ? "a" : "v",
        source: { kind: "range", range: { startUs: 200000, endUs: 300000 } },
        placement: { kind: "project", range: { startUs: i * 400000, endUs: i * 400000 + 100000 } },
      })),
    },
    context.assets,
  ).document;
}
function scalarOperations(operations: ReturnType<typeof moving>[]) {
  // Explicit same-track destinations preserve behavior while taking the ordinary move path.
  return operations.map((operation) => ({
    ...operation,
    tracks: [{ clipId: operation.clipIds[0]!, trackId: "track" }],
  }));
}
function scalarMoves(document: unknown, operations: ReturnType<typeof moving>[]) {
  return applyBatch(document, scalarOperations(operations), context);
}
const moving = (id: string, atUs: number) => ({
  operation: "move",
  clipIds: [id],
  atUs,
  scope: "selected",
  ripple: "none",
});

test.each(["audio", "video"] as const)(
  "ordered %s moves preserve scalar receipts, no-ops and repeated targets",
  (kind) => {
    const document = moveFixture(kind);
    const operations = [
      moving("move0", 0),
      moving("move1", 100000),
      moving("move2", 200000),
      moving("move1", 100000),
    ];
    const result = applyBatch(document, operations, context);
    expect(result).toEqual(scalarMoves(document, operations));
    expect(result.normalized.map((r) => r.changes.length)).toEqual([0, 1, 1, 0]);
    expect(result.document.clips.map((c) => c.placement)).toEqual(
      [0, 100000, 200000].map((startUs) => ({
        kind: "project",
        range: { startUs, endUs: startUs + 100000 },
      })),
    );
  },
);

test("a later move cannot conceal an overlapping earlier prefix", () => {
  const document = moveFixture("audio");
  const operations = [moving("move2", 900000), moving("move0", 400000), moving("move1", 200000)];
  const failure = (ops: unknown[]) => {
    try {
      applyBatch(document, ops, context);
      throw Error("Expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(CompositionError);
      return e as CompositionError;
    }
  };
  const batch = failure(operations),
    scalar = failure(scalarOperations(operations));
  expect({ code: batch.code, message: batch.message, details: batch.details }).toEqual({
    code: scalar.code,
    message: scalar.message,
    details: scalar.details,
  });
  expect(batch.details.operationIndex).toBe(1);
});

test("dependent, linked and processed moves retain sequential transformations", () => {
  const base = moveFixture("video");
  const dependent = {
    ...base,
    tracks: [...base.tracks, { id: "childTrack", kind: "video", order: 1 }],
    clips: [
      ...base.clips,
      {
        ...base.clips[0],
        id: "child",
        trackId: "childTrack",
        placement: {
          kind: "clip",
          clipId: "move0",
          start: { numerator: 0, denominator: 1 },
          end: { numerator: 1, denominator: 1 },
        },
      },
    ],
  };
  const linked = { ...base, syncGroups: [{ id: "linked", clipIds: ["move0", "move1"] }] };
  const processed = applyBatch(
    base,
    [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 0.5 } }],
      },
    ],
    context,
  ).document;
  const stateful = applyBatch(
    moveFixture("audio"),
    [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "rnnoise" } }],
      },
    ],
    context,
  ).document;
  for (const document of [dependent, linked, processed, stateful]) {
    const operations = [moving("move0", 100000), moving("move1", 500000)];
    expect(applyBatch(document, operations, context)).toEqual(scalarMoves(document, operations));
  }
});

test("ordered move receipts stay frozen across a later move of the same clip", () => {
  const document = moveFixture("video");
  const operations = [moving("move1", 100000), moving("move2", 600000), moving("move1", 300000)];
  const result = applyBatch(document, operations, context);
  expect(result).toEqual(scalarMoves(document, operations));
  expect(result.normalized[0]!.changes).toMatchObject([
    { value: { placement: { range: { startUs: 100000 } } } },
  ]);
  expect(result.document.clips.find((c) => c.id === "move1")!.placement).toMatchObject({
    range: { startUs: 300000 },
  });
});

test.each([moving("missing", 0), moving("move2", Number.MAX_SAFE_INTEGER)])(
  "a later refused move preserves the scalar error after a valid run: %j",
  (operation) => {
    const document = moveFixture("audio"),
      operations = [moving("move1", 200000), operation];
    const failure = (ops: unknown[]) => {
      try {
        applyBatch(document, ops, context);
        throw Error("Expected refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(CompositionError);
        return e as CompositionError;
      }
    };
    const batch = failure(operations),
      scalar = failure(scalarOperations(operations));
    expect({ code: batch.code, message: batch.message, details: batch.details }).toEqual({
      code: scalar.code,
      message: scalar.message,
      details: scalar.details,
    });
    expect(batch.details.operationIndex).toBe(1);
  },
);

test("ordered moves can occupy previously freed space; the reverse order still refuses", () => {
  const document = moveFixture("video");
  const operations = [moving("move1", 200000), moving("move2", 400000)];
  expect(applyBatch(document, operations, context)).toEqual(scalarMoves(document, operations));
  expect(() => applyBatch(document, [...operations].reverse(), context)).toThrow(
    "Overlapping clips",
  );
  const crossing = [moving("move0", 1000000), moving("move1", 0)];
  expect(applyBatch(document, crossing, context)).toEqual(scalarMoves(document, crossing));
});

test("move batching compares and preserves fractional structural intervals", () => {
  const base = moveFixture("audio");
  const document = {
    ...base,
    clips: base.clips.map((clip, i) => ({
      ...clip,
      placement: {
        kind: "project",
        range: {
          startUs: i === 0 ? 0 : { numerator: i * 400000, denominator: 3 },
          endUs: i === 2 ? 300000 : { numerator: i * 400000 + 100000, denominator: 3 },
        },
      },
    })),
  };
  const operations = [moving("move1", 40000), moving("move2", 80000)];
  const result = applyBatch(document, operations, context);
  expect(result).toEqual(scalarMoves(document, operations));
  expect(result.document.clips[1]!.placement).toEqual({
    kind: "project",
    range: {
      startUs: 40000,
      endUs: { numerator: 220000, denominator: 3 },
    },
  });
});

test("alternating track and clip appends preserve complete scalar receipts and dependent edits", () => {
  const operations = [
    ...setup,
    { operation: "remove", clipIds: [{ label: "video" }], scope: "selected", ripple: "none" },
  ];
  const batched = applyBatch(input, operations, context);
  const scalar = applyBatch(
    input,
    operations.flatMap((operation) => [operation, { operation: "canvas.set", canvas: {} }]),
    context,
  );
  expect(batched).toEqual({
    ...scalar,
    normalized: scalar.normalized
      .filter((_, index) => index % 2 === 0)
      .map((entry, operationIndex) => ({ ...entry, operationIndex })),
  });
  expect(batched.normalized[1]!.changes[0]).toMatchObject({
    kind: "clip",
    id: batched.labels.video,
    value: { trackId: batched.labels.picture, assetId: "source", streamId: "v" },
  });
  expect(batched.document.clips.map((clip) => clip.id)).toEqual([batched.labels.audio]);
});

test.each([false, true])(
  "later tracks cannot repair an invalid placement prefix (prior track=%s)",
  (priorTrack) => {
    const operations = [
      ...(priorTrack ? [{ operation: "track.add", track: { kind: "audio", order: 0 } }] : []),
      {
        operation: "place",
        clip: {
          trackId: `track:transaction:${priorTrack ? 2 : 1}`,
          assetId: "source",
          streamId: "a",
          source: { kind: "range", range: { startUs: 200000, endUs: 300000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 100000 } },
        },
      },
      { operation: "track.add", track: { kind: "audio", order: priorTrack ? 1 : 0 } },
    ];
    const failure = (operations: unknown[]) => {
      try {
        applyBatch(input, operations, context);
        expect.fail("invalid prefix accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(CompositionError);
        return error as CompositionError;
      }
    };
    const batched = failure(operations);
    const scalar = failure(
      operations.flatMap((operation) => [operation, { operation: "canvas.set", canvas: {} }]),
    );
    expect({ code: batched.code, message: batched.message, details: batched.details }).toEqual({
      code: scalar.code,
      message: scalar.message,
      details: {
        ...scalar.details,
        operationIndex: Math.floor(Number(scalar.details.operationIndex) / 2),
      },
    });
    expect(batched.details).toEqual({
      operationIndex: priorTrack ? 1 : 0,
      cause: "INVALID_COMPOSITION",
    });
    expect(batched.message).toBe(`Unknown track: track:transaction:${priorTrack ? 2 : 1}`);
  },
);

test.each([
  { target: { kind: "output" }, processor: { type: "gain", gain: 0.5 } },
  {
    target: { kind: "group", id: "group" },
    processor: { type: "gain", gain: 2 },
    window: { kind: "project", range: { startUs: 0, endUs: 200000 } },
  },
  { target: { kind: "track", id: "existing" }, processor: { type: "rnnoise" } },
])(
  "mixed appends preserve processing receipts under $target.kind / $processor.type",
  ({ target, ...step }) => {
    const document = applyBatch(
      {
        ...input,
        groups: [{ id: "group", kind: "audio", order: 0 }],
        tracks: [{ id: "existing", kind: "audio", order: 0, parentId: "group" }],
      },
      [{ operation: "processing.set", target, steps: [step] }],
      { ...context, namespace: "processing" },
    ).document;
    const placed = {
      assetId: "source",
      streamId: "a",
      source: { kind: "range", range: { startUs: 200000, endUs: 300000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 100000 } },
    };
    const operations = [
      {
        operation: "track.add",
        label: "new",
        track: { kind: "audio", order: 1, parentId: "group" },
      },
      { operation: "track.add", track: { kind: "audio", order: 2, parentId: "group" } },
      { operation: "place", clip: { ...placed, trackId: { label: "new" } } },
      { operation: "place", clip: { ...placed, trackId: "existing" } },
      { operation: "place", clip: { ...placed, trackId: "track:transaction:1" } },
    ];
    const scalar = applyBatch(
      document,
      operations.flatMap((operation) => [operation, { operation: "canvas.set", canvas: {} }]),
      context,
    );
    expect(applyBatch(document, operations, context)).toEqual({
      ...scalar,
      normalized: scalar.normalized
        .filter((_, index) => index % 2 === 0)
        .map((entry, operationIndex) => ({ ...entry, operationIndex })),
    });
  },
);

test.each([
  { name: "unknown parent", track: { kind: "audio", order: 0, parentId: "missing" }, index: 0 },
  {
    name: "parent media mismatch",
    track: { kind: "audio", order: 0, parentId: "video-group" },
    index: 0,
  },
  { name: "duplicate video sibling order", track: { kind: "video", order: 0 }, index: 1 },
  {
    name: "missing source stream",
    track: { kind: "audio", order: 0 },
    streamId: "missing",
    index: 1,
  },
  { name: "source media mismatch", track: { kind: "audio", order: 0 }, streamId: "v", index: 1 },
])("mixed append $name precedes a later label error", ({ name, track, streamId, index }) => {
  const document = { ...input, groups: [{ id: "video-group", kind: "video", order: 1 }] };
  const operations = [
    { operation: "track.add", label: "first", track },
    ...(name === "duplicate video sibling order"
      ? [{ operation: "track.add", track }]
      : streamId
        ? [
            {
              operation: "place",
              clip: {
                trackId: { label: "first" },
                assetId: "source",
                streamId,
                source: { kind: "range", range: { startUs: 200000, endUs: 300000 } },
                placement: { kind: "project", range: { startUs: 0, endUs: 100000 } },
              },
            },
          ]
        : []),
    { operation: "track.add", label: "first", track: { kind: "audio", order: 3 } },
  ];
  const failure = (operations: unknown[]) => {
    try {
      applyBatch(document, operations, context);
      expect.fail("invalid prefix accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionError);
      return error as CompositionError;
    }
  };
  const batched = failure(operations);
  const scalar = failure(
    operations.flatMap((operation) => [operation, { operation: "canvas.set", canvas: {} }]),
  );
  expect({ code: batched.code, message: batched.message, details: batched.details }).toEqual({
    code: scalar.code,
    message: scalar.message,
    details: {
      ...scalar.details,
      operationIndex: Math.floor(Number(scalar.details.operationIndex) / 2),
    },
  });
  expect(batched.details).toEqual({ operationIndex: index, cause: "INVALID_COMPOSITION" });
});
