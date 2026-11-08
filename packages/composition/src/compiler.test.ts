import { expect, test } from "vitest";
import {
  createCompiler,
  applyBatch,
  validateComposition,
  type Composition,
  requireWindowReady,
  executionWindowManifestSchema,
  compiledFrameSchema,
  compiledAudioSchema,
} from "./index.js";

const document: Composition = {
  canvas: {
    width: 640,
    height: 480,
    fps: { numerator: 30000, denominator: 1001 },
    background: "#000000ff",
  },
  tracks: [{ id: "v", kind: "video", order: 0 }],
  groups: [],
  processing: [],
  syncGroups: [],
  clips: [
    {
      id: "c",
      trackId: "v",
      assetId: "asset",
      streamId: "video",
      source: { kind: "range", range: { startUs: 500000, endUs: 1500000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  ],
};
const assets = [
  {
    id: "asset",
    streams: [
      {
        id: "video",
        kind: "video",
        width: 640,
        height: 480,
        bounds: { startUs: 0, endUs: 2000000 },
        available: [{ startUs: 0, endUs: 2000000 }],
      },
    ],
  },
];

test("range frames preserve the full project phase and source clock", () => {
  const compiler = createCompiler(validateComposition(document, assets), "revision");
  const full = [...compiler.frames({ startUs: 0, endUs: 1000000 })];
  const part = [...compiler.frames({ startUs: 50001, endUs: 180000 })];
  expect(part).toEqual(
    full
      .filter((frame) => frame.visibleRange.endUs > 50001 && frame.visibleRange.startUs < 180000)
      .map((frame) => ({
        ...frame,
        visibleRange: {
          startUs: Math.max(50001, frame.visibleRange.startUs),
          endUs: Math.min(180000, frame.visibleRange.endUs),
        },
      })),
  );
  expect(
    part.map((frame) => [
      frame.index,
      frame.sampleAtUs,
      frame.layers[0]?.kind === "video" ? frame.layers[0].sourceUs : undefined,
    ]),
  ).toEqual([
    [1, 33366, { numerator: 1600100, denominator: 3 }],
    [2, 66733, { numerator: 1700200, denominator: 3 }],
    [3, 100100, 600100],
    [4, 133466, { numerator: 1900400, denominator: 3 }],
    [5, 166833, { numerator: 2000500, denominator: 3 }],
  ]);
});

test("audio windows clip absolute sample bounds without restarting source mapping", () => {
  const input = structuredClone(document);
  input.tracks = [{ id: "a", kind: "audio", order: 0 }];
  input.clips = [
    {
      id: "voice",
      trackId: "a",
      assetId: "asset",
      streamId: "audio",
      source: { kind: "range", range: { startUs: 500000, endUs: 1500000 } },
      placement: { kind: "project", range: { startUs: 10001, endUs: 1010001 } },
    },
  ];
  const audioAssets = [
    {
      id: "asset",
      streams: [
        {
          id: "audio",
          kind: "audio",
          bounds: { startUs: 0, endUs: 2000000 },
          available: [
            { startUs: 0, endUs: 600000 },
            { startUs: 700000, endUs: 2000000 },
          ],
        },
      ],
    },
  ];
  const compiler = createCompiler(validateComposition(input, audioAssets), "revision");
  expect([...compiler.audio({ startUs: 0, endUs: 1100000 }, 48000)]).toEqual([
    {
      clipId: "voice",
      trackId: "a",
      context: [
        { source: { startUs: 500000, endUs: 600000 }, sampleRange: { start: 480, end: 5280 } },
        { source: { startUs: 700000, endUs: 1500000 }, sampleRange: { start: 10080, end: 48480 } },
      ],
      sampleRange: { start: 480, end: 48480 },
      placement: { startUs: 10001, endUs: 1010001 },
      source: {
        kind: "range",
        assetId: "asset",
        streamId: "audio",
        range: { startUs: 500000, endUs: 1500000 },
      },
      pitch: "preserve",
      available: [
        { start: 480, end: 5280 },
        { start: 10080, end: 48480 },
      ],
    },
  ]);
  const short = [...compiler.audio({ startUs: 200001, endUs: 300001 }, 48000)][0]!;
  expect(short.sampleRange).toEqual({ start: 9600, end: 14400 });
  expect(short.placement).toEqual({ startUs: 10001, endUs: 1010001 });
  expect(short.available).toEqual([{ start: 10080, end: 14400 }]);
  expect(short.context.map((part) => part.source)).toEqual([{ startUs: 700000, endUs: 1500000 }]);
});

test("processing instructions apply ordered steps after each combined child result", () => {
  const input = structuredClone(document);
  input.tracks = [
    { id: "a", kind: "audio", order: 0, parentId: "inner" },
    { id: "music", kind: "audio", order: 1 },
  ];
  input.groups = [
    { id: "inner", kind: "audio", order: 0, parentId: "outer" },
    { id: "outer", kind: "audio", order: 0 },
  ];
  input.clips = [
    {
      id: "silence",
      trackId: "a",
      source: { kind: "silence" },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  ];
  const gain = (id: string, multiplier: number, enabled = true) => ({
    id,
    enabled,
    processor: { type: "gain" as const, gain: multiplier },
  });
  input.processing = [
    { target: { kind: "group", id: "inner" }, steps: [gain("one", 2), gain("two", 3, false)] },
    { target: { kind: "output" }, steps: [gain("out", 0.5)] },
  ];
  const compiler = createCompiler(validateComposition(input, []), "revision");
  expect(
    compiler
      .processing({ startUs: 0, endUs: 1000000 })
      .map((node) => [node.target, node.inputs, node.steps.map((step) => [step.id, step.enabled])]),
  ).toEqual([
    [{ kind: "clip", id: "silence" }, [], []],
    [{ kind: "track", id: "a" }, [{ kind: "clip", id: "silence" }], []],
    [
      { kind: "group", id: "inner" },
      [{ kind: "track", id: "a" }],
      [
        ["one", true],
        ["two", false],
      ],
    ],
    [{ kind: "group", id: "outer" }, [{ kind: "group", id: "inner" }], []],
    [{ kind: "output" }, [{ kind: "group", id: "outer" }], [["out", true]]],
  ]);
});

test("frame membership respects gaps, holds, nested ordering and half-open cuts", () => {
  const input = structuredClone(document);
  input.canvas.fps = { numerator: 10, denominator: 1 };
  input.groups = [{ id: "top", kind: "video", order: 1 }];
  input.tracks.push({ id: "overlay", kind: "video", order: -10, parentId: "top" });
  input.clips.push({
    id: "held",
    trackId: "overlay",
    assetId: "asset",
    streamId: "video",
    source: { kind: "hold", atUs: 700000 },
    placement: { kind: "project", range: { startUs: 100000, endUs: 200000 } },
  });
  const media = structuredClone(assets);
  media[0]!.streams[0]!.available = [
    { startUs: 0, endUs: 600000 },
    { startUs: 700000, endUs: 2000000 },
  ];
  const compiler = createCompiler(validateComposition(input, media), "revision");
  expect(
    [...compiler.frames({ startUs: 100000, endUs: 300000 })].map((frame) =>
      frame.layers.map((layer) => [
        layer.clipId,
        layer.kind === "video" ? layer.sourceUs : undefined,
        layer.availability,
      ]),
    ),
  ).toEqual([
    [
      ["c", 600000, "source-unavailable"],
      ["held", 700000, "available"],
    ],
    [["c", 700000, "available"]],
  ]);
  expect(compiler.processing({ startUs: 100000, endUs: 200000 }).at(-1)?.inputs).toEqual([
    { kind: "track", id: "v" },
    { kind: "group", id: "top" },
  ]);
});

test("two-hour requests are lazy and late repeated clips do not replay earlier frames", () => {
  const input = structuredClone(document);
  input.clips = Array.from({ length: 10000 }, (_, index) => ({
    ...document.clips[0]!,
    id: `repeat-${index}`,
    placement: {
      kind: "project",
      range: { startUs: index * 1000000, endUs: (index + 1) * 1000000 },
    },
  }));
  const compiler = createCompiler(validateComposition(input, assets), "revision");
  const full = compiler.frames({ startUs: 0, endUs: 7200000000 });
  expect(full.next().value?.index).toBe(0);
  full.return(undefined);
  const late = [...compiler.frames({ startUs: 7199990000, endUs: 7200010000 })];
  expect(
    late.map((frame) => [
      frame.index,
      frame.sampleAtUs,
      frame.layers[0]?.clipId,
      frame.layers[0]?.kind === "video" ? frame.layers[0].sourceUs : undefined,
    ]),
  ).toEqual([
    [215783, 7199959433, "repeat-7199", { numerator: 4378300, denominator: 3 }],
    [215784, 7199992800, "repeat-7199", 1492800],
  ]);
  expect(
    compiler.processing({ startUs: 7199500000, endUs: 7199600000 }).map((node) => node.target),
  ).toEqual([{ kind: "clip", id: "repeat-7199" }, { kind: "track", id: "v" }, { kind: "output" }]);
});

test("returned plan mutation cannot change a later plan for the same revision", () => {
  const compiler = createCompiler(validateComposition(document, assets), "revision");
  const plan = compiler.processing({ startUs: 0, endUs: 1 });
  Reflect.set(plan[0]!.steps, "0", {
    id: "injected",
    enabled: true,
    processor: { type: "gain", gain: 0 },
  });
  expect(compiler.processing({ startUs: 0, endUs: 1 })[0]!.steps).toEqual([]);
});

test("a leading frame clips its end before converting an enormous next timestamp", () => {
  const input = structuredClone(document);
  input.canvas.fps = { numerator: 1, denominator: Number.MAX_SAFE_INTEGER };
  const compiler = createCompiler(validateComposition(input, assets), "revision");
  expect(
    [...compiler.frames({ startUs: 1, endUs: 2 })].map((frame) => [
      frame.index,
      frame.sampleAtUs,
      frame.visibleRange,
    ]),
  ).toEqual([[0, 0, { startUs: 1, endUs: 2 }]]);
});

test("target taps exclude parents and later steps while preserving child processing", () => {
  const input = structuredClone(document);
  input.tracks = [{ id: "audio", kind: "audio", order: 0, parentId: "group" }];
  input.groups = [{ id: "group", kind: "audio", order: 0 }];
  input.clips = [
    {
      id: "quiet",
      trackId: "audio",
      source: { kind: "silence" },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  ];
  const gain = (id: string, gain: number) => ({
    id,
    enabled: true,
    processor: { type: "gain" as const, gain },
  });
  input.processing = [
    { target: { kind: "track", id: "audio" }, steps: [gain("child", 2)] },
    { target: { kind: "group", id: "group" }, steps: [gain("first", 3), gain("second", 4)] },
    { target: { kind: "output" }, steps: [gain("parent", 5)] },
  ];
  const compiler = createCompiler(validateComposition(input, []), "revision");
  const request = {
    range: { startUs: 100001, endUs: 300009 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "group", id: "group" }, point: { kind: "after-step", stepId: "first" } },
  };
  const window = compiler.window(request);
  expect(
    window.manifest.processing.map((node) => [node.target, node.steps.map((step) => step.id)]),
  ).toEqual([
    [{ kind: "clip", id: "quiet" }, []],
    [{ kind: "track", id: "audio" }, ["child"]],
    [{ kind: "group", id: "group" }, ["first"]],
  ]);
  expect([...window.frames()]).toEqual([]);
  expect([...window.audio()].map((segment) => segment.sampleRange)).toEqual([
    { start: 4800, end: 14400 },
  ]);
  const dry = compiler.window({
    ...request,
    tap: { target: request.tap.target, point: { kind: "dry" } },
  });
  expect(dry.manifest.processing.flatMap((node) => node.steps.map((step) => step.id))).toEqual([
    "child",
  ]);
});

test("window identity pins source mapping, rendition and unresolved retiming across short previews", () => {
  const input = structuredClone(document);
  input.tracks = [{ id: "a", kind: "audio", order: 0 }];
  input.clips = [
    {
      id: "speech",
      trackId: "a",
      assetId: "source",
      streamId: "audio",
      source: { kind: "range", range: { startUs: 500000, endUs: 1500000 } },
      placement: { kind: "project", range: { startUs: 10001, endUs: 710001 } },
    },
  ];
  const media = [
    {
      id: "source",
      streams: [
        {
          id: "audio",
          kind: "audio",
          bounds: { startUs: 0, endUs: 2000000 },
          available: [{ startUs: 0, endUs: 2000000 }],
        },
      ],
    },
  ];
  const model = validateComposition(input, media);
  const compiler = createCompiler(model, "pinned-revision");
  const request = {
    range: { startUs: 200001, endUs: 300001 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "clip", id: "speech" }, point: { kind: "dry" } },
  };
  const first = compiler.window(request);
  expect(first.manifest.revisionId).toBe("pinned-revision");
  expect(first.manifest.sources).toEqual([
    {
      clipId: "speech",
      context: [
        { source: { startUs: 500000, endUs: 1500000 }, sampleRange: { start: 480, end: 34080 } },
      ],
      assetId: "source",
      streamId: "audio",
      source: input.clips[0]!.source,
      placement: { startUs: 10001, endUs: 710001 },
      pitch: "preserve",
    },
  ]);
  expect(first.manifest.requirements).toEqual([
    { kind: "executor", mediaKind: "audio", implementationId: null },
    {
      kind: "retime",
      clipId: "speech",
      sampleCount: 33600,
      pitch: "preserve",
      implementationId: null,
    },
  ]);
  const later = compiler.window({ ...request, range: { startUs: 300001, endUs: 400001 } });
  expect(later.manifest.requirements).toEqual(first.manifest.requirements);
  expect(later.manifest.sources).toEqual(first.manifest.sources);
  expect(later.manifest).not.toEqual(first.manifest);
  expect(
    compiler.window({ tap: request.tap, rendition: request.rendition, range: request.range })
      .manifest,
  ).toEqual(first.manifest);
  expect(createCompiler(model, "other-revision").window(request).manifest).not.toEqual(
    first.manifest,
  );
  expect(() => requireWindowReady(first.manifest)).toThrowError(
    expect.objectContaining({ code: "NOT_READY" }),
  );
  expect(executionWindowManifestSchema.parse(JSON.parse(JSON.stringify(first.manifest)))).toEqual(
    first.manifest,
  );
  request.range.startUs = 0;
  expect([...first.audio()][0]!.sampleRange).toEqual({ start: 9600, end: 14400 });
});

test("a visual target tap excludes siblings from schedules and rejects foreign step identities", () => {
  const input = structuredClone(document);
  input.tracks.push({ id: "other", kind: "video", order: 1 });
  input.clips.push({ ...input.clips[0]!, id: "other-clip", trackId: "other" });
  const compiler = createCompiler(validateComposition(input, assets), "revision");
  const request = {
    range: { startUs: 100001, endUs: 200001 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "track", id: "other" }, point: { kind: "processed" } },
  };
  const window = compiler.window(request);
  expect([...window.frames()].map((frame) => frame.layers.map((layer) => layer.clipId))).toEqual([
    ["other-clip"],
    ["other-clip"],
    ["other-clip"],
    ["other-clip"],
  ]);
  expect([...window.audio()]).toEqual([]);
  expect(window.manifest.sources.map((source) => source.clipId)).toEqual(["other-clip"]);
  expect(() =>
    compiler.window({
      ...request,
      tap: { target: request.tap.target, point: { kind: "after-step", stepId: "absent" } },
    }),
  ).toThrow("Unknown step");
  expect(() =>
    compiler.window({
      ...request,
      tap: { target: { kind: "group", id: "absent" }, point: { kind: "dry" } },
    }),
  ).toThrow("Unknown processing tap target");
  expect(() =>
    compiler.window({ ...request, rendition: { sampleRate: 44100, channels: 2 } }),
  ).toThrow();
});

test("a target tap does not read unrelated availability while iterating its schedules", () => {
  const input = structuredClone(document);
  input.tracks = [
    { id: "chosen", kind: "audio", order: 0 },
    { id: "unrelated", kind: "audio", order: 1 },
  ];
  input.clips = ["chosen", "unrelated"].map((id) => ({
    id,
    trackId: id,
    source: { kind: "silence" },
    placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
  }));
  const model = validateComposition(input, []);
  let unrelatedReads = 0;
  // Observe metadata work without a wall-clock threshold or changing its immutable values.
  const measured = Object.freeze({
    ...model,
    clips: Object.freeze(
      model.clips.map((value) =>
        value.clip.id !== "unrelated"
          ? value
          : Object.freeze({
              ...value,
              get available() {
                unrelatedReads++;
                return value.available;
              },
            }),
      ),
    ),
  });
  const compiler = createCompiler(measured, "revision");
  const window = compiler.window({
    range: { startUs: 0, endUs: 1000000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "clip", id: "chosen" }, point: { kind: "processed" } },
  });
  unrelatedReads = 0;
  expect([...window.audio()].map((segment) => [segment.clipId, segment.sampleRange])).toEqual([
    ["chosen", { start: 0, end: 48000 }],
  ]);
  expect(unrelatedReads).toBe(0);
});

test("partial first frames retain their old source and exact visible coverage", () => {
  const input = structuredClone(document);
  input.clips = [
    {
      assetId: "asset",
      streamId: "video",
      trackId: "v",
      id: "old",
      source: { kind: "range", range: { startUs: 500000, endUs: 550000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 50000 } },
    },
    {
      assetId: "asset",
      streamId: "video",
      trackId: "v",
      id: "new",
      source: { kind: "range", range: { startUs: 800000, endUs: 1750000 } },
      placement: { kind: "project", range: { startUs: 50000, endUs: 1000000 } },
    },
  ];
  const compiler = createCompiler(validateComposition(input, assets), "revision");
  const request = {
    range: { startUs: 50001, endUs: 70000 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  };
  const window = compiler.window(request);
  expect(
    [...window.frames()].map((frame) => [
      frame.index,
      frame.sampleAtUs,
      frame.visibleRange,
      frame.layers[0]?.clipId,
      frame.layers[0]?.kind === "video" ? frame.layers[0].sourceUs : undefined,
    ]),
  ).toEqual([
    [1, 33366, { startUs: 50001, endUs: 66733 }, "old", { numerator: 1600100, denominator: 3 }],
    [2, 66733, { startUs: 66733, endUs: 70000 }, "new", { numerator: 2450200, denominator: 3 }],
  ]);
  expect(window.manifest.sources.map((source) => source.clipId)).toEqual(["old", "new"]);
  expect(
    compiler
      .window({ ...request, range: { startUs: 50001, endUs: 60000 } })
      .manifest.sources.map((source) => source.clipId),
  ).toEqual(["old"]);
  expect(
    [...compiler.frames({ startUs: 66733, endUs: 66734 })].map((frame) => frame.index),
  ).toEqual([2]);
});

test("stream records round-trip strictly and refuse impossible presentation/sample coverage", () => {
  const compiler = createCompiler(validateComposition(document, assets), "revision");
  const frame = [...compiler.frames({ startUs: 50001, endUs: 60000 })][0]!;
  expect(compiledFrameSchema.parse(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  expect(
    compiledFrameSchema.safeParse({ ...frame, visibleRange: { startUs: 0, endUs: 60000 } }).success,
  ).toBe(false);
  const input = structuredClone(document);
  input.tracks = [{ id: "a", kind: "audio", order: 0 }];
  input.clips = [
    {
      id: "quiet",
      trackId: "a",
      source: { kind: "silence" },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  ];
  const segment = [
    ...createCompiler(validateComposition(input, []), "audio-revision").audio({
      startUs: 100001,
      endUs: 200001,
    }),
  ][0]!;
  expect(compiledAudioSchema.parse(JSON.parse(JSON.stringify(segment)))).toEqual(segment);
  expect(
    compiledAudioSchema.safeParse({ ...segment, available: [{ start: 0, end: 9600 }] }).success,
  ).toBe(false);
  expect(compiledAudioSchema.safeParse({ ...segment, normalize: true }).success).toBe(false);
});

test("compiled availability distinguishes source gaps from unavailable ancestors", () => {
  const input = structuredClone(document);
  input.canvas.fps = { numerator: 10, denominator: 1 };
  input.tracks = ["parent", "attached", "direct"].map((id, order) => ({
    id,
    kind: "video",
    order,
  }));
  input.clips = [
    {
      id: "parent",
      trackId: "parent",
      assetId: "parent",
      streamId: "v",
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
    {
      id: "attached",
      trackId: "attached",
      assetId: "child",
      streamId: "v",
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "content", clipId: "parent", sourceRange: { startUs: 0, endUs: 1000000 } },
    },
    {
      id: "direct",
      trackId: "direct",
      assetId: "child",
      streamId: "v",
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  ];
  const media = [200000, 300000].map((gapEnd, index) => ({
    id: index === 0 ? "parent" : "child",
    streams: [
      {
        id: "v",
        kind: "video",
        width: 640,
        height: 480,
        bounds: { startUs: 0, endUs: 1000000 },
        available: [
          { startUs: 0, endUs: 100000 },
          { startUs: gapEnd, endUs: 1000000 },
        ],
      },
    ],
  }));
  const compiler = createCompiler(validateComposition(input, media), "provenance");
  expect(
    [...compiler.frames({ startUs: 100000, endUs: 400000 })].map((frame) =>
      frame.layers.map((layer) => [layer.clipId, layer.availability]),
    ),
  ).toEqual([
    [
      ["parent", "source-unavailable"],
      ["attached", "anchor-unavailable"],
      ["direct", "source-unavailable"],
    ],
    [
      ["parent", "available"],
      ["attached", "source-unavailable"],
      ["direct", "source-unavailable"],
    ],
    [
      ["parent", "available"],
      ["attached", "available"],
      ["direct", "available"],
    ],
  ]);
});

test("resampling context preserves pure splits but shrinks with the current selection", () => {
  const input = structuredClone(document);
  input.tracks = [{ id: "a", kind: "audio", order: 0 }];
  input.clips = [
    {
      id: "voice",
      trackId: "a",
      assetId: "asset",
      streamId: "audio",
      source: { kind: "range", range: { startUs: 500000, endUs: 1500000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  ];
  const media = [
    {
      id: "asset",
      streams: [
        {
          id: "audio",
          kind: "audio",
          bounds: { startUs: 0, endUs: 2000000 },
          available: [{ startUs: 0, endUs: 2000000 }],
        },
      ],
    },
  ];
  const split = applyBatch(
    input,
    [{ operation: "split", clipIds: ["voice"], atUs: 123457, scope: "selected" }],
    { assets: media, namespace: "context" },
  );
  const compiler = createCompiler(validateComposition(split.document, media), "split");
  expect(
    [...compiler.audio({ startUs: 0, endUs: 1000000 })].map((segment) =>
      segment.context.map((part) => part.source),
    ),
  ).toEqual([[{ startUs: 500000, endUs: 1500000 }], [{ startUs: 500000, endUs: 1500000 }]]);
  expect(
    [...compiler.audio({ startUs: 700001, endUs: 800001 })][0]!.context.map((part) => part.source),
  ).toEqual([{ startUs: 500000, endUs: 1500000 }]);
  const changedGain = applyBatch(
    split.document,
    [
      {
        operation: "processing.set",
        target: { kind: "clip", id: "voice" },
        steps: [{ enabled: true, processor: { type: "gain", gain: 0.25 } }],
      },
    ],
    { assets: media, namespace: "gain-context" },
  );
  expect(
    [
      ...createCompiler(validateComposition(changedGain.document, media), "gain").audio({
        startUs: 0,
        endUs: 1000000,
      }),
    ].map((segment) => segment.context.map((part) => part.source)),
  ).toEqual([[{ startUs: 500000, endUs: 1500000 }], [{ startUs: 500000, endUs: 1500000 }]]);
  const cut = applyBatch(
    input,
    [
      {
        operation: "remove",
        clipIds: ["voice"],
        ranges: [{ startUs: 200000, endUs: 300000 }],
        scope: "selected",
        ripple: "none",
      },
    ],
    { assets: media, namespace: "cut-context" },
  );
  expect(
    [
      ...createCompiler(validateComposition(cut.document, media), "cut").audio({
        startUs: 0,
        endUs: 1000000,
      }),
    ].map((segment) => segment.context.map((part) => part.source)),
  ).toEqual([[{ startUs: 500000, endUs: 700000 }], [{ startUs: 800000, endUs: 1500000 }]]);
  const trimmed = applyBatch(
    input,
    [
      {
        operation: "trim",
        clipId: "voice",
        range: { startUs: 200000, endUs: 1000000 },
        scope: "selected",
        ripple: "none",
      },
    ],
    { assets: media, namespace: "trim-context" },
  );
  expect(
    [
      ...createCompiler(validateComposition(trimmed.document, media), "trim").audio({
        startUs: 200000,
        endUs: 1000000,
      }),
    ][0]!.context.map((part) => part.source),
  ).toEqual([{ startUs: 700000, endUs: 1500000 }]);
});

test("resampling domains exclude source and ancestor holes and never borrow a parallel track", () => {
  const input = structuredClone(document);
  input.tracks = [
    { id: "parent", kind: "video", order: 0 },
    { id: "attached", kind: "audio", order: 0 },
    { id: "parallel", kind: "audio", order: 1 },
  ];
  input.clips = [
    {
      id: "parent",
      trackId: "parent",
      assetId: "parent",
      streamId: "s",
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
    {
      id: "attached",
      trackId: "attached",
      assetId: "audio",
      streamId: "s",
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "content", clipId: "parent", sourceRange: { startUs: 0, endUs: 1000000 } },
    },
    {
      id: "parallel",
      trackId: "parallel",
      assetId: "audio",
      streamId: "s",
      source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
    },
  ];
  const media = [
    {
      id: "parent",
      streams: [
        {
          id: "s",
          kind: "video",
          width: 640,
          height: 480,
          bounds: { startUs: 0, endUs: 1000000 },
          available: [
            { startUs: 0, endUs: 200000 },
            { startUs: 400000, endUs: 1000000 },
          ],
        },
      ],
    },
    {
      id: "audio",
      streams: [
        {
          id: "s",
          kind: "audio",
          bounds: { startUs: 0, endUs: 1000000 },
          available: [
            { startUs: 0, endUs: 300000 },
            { startUs: 500000, endUs: 1000000 },
          ],
        },
      ],
    },
  ];
  const compiler = createCompiler(validateComposition(input, media), "holes");
  expect(
    [...compiler.audio({ startUs: 0, endUs: 1000000 })].map((segment) => [
      segment.clipId,
      segment.context.map((part) => part.source),
    ]),
  ).toEqual([
    [
      "attached",
      [
        { startUs: 0, endUs: 200000 },
        { startUs: 500000, endUs: 1000000 },
      ],
    ],
    [
      "parallel",
      [
        { startUs: 0, endUs: 300000 },
        { startUs: 500000, endUs: 1000000 },
      ],
    ],
  ]);
  const late = [...compiler.audio({ startUs: 600001, endUs: 700001 })];
  expect(late.map((segment) => segment.context.map((part) => part.source))).toEqual([
    [{ startUs: 500000, endUs: 1000000 }],
    [{ startUs: 500000, endUs: 1000000 }],
  ]);
  Reflect.set(late[0]!.context[0]!.source, "startUs", 0);
  expect(
    [...compiler.audio({ startUs: 600001, endUs: 700001 })][0]!.context.map((part) => part.source),
  ).toEqual([{ startUs: 500000, endUs: 1000000 }]);
});

test("resampling runs break on source, clock, pitch or placement changes", () => {
  const media = ["one", "two"].map((id) => ({
    id,
    streams: ["a", "b"].map((id) => ({
      id,
      kind: "audio",
      bounds: { startUs: 0, endUs: 1000000 },
      available: [{ startUs: 0, endUs: 1000000 }],
    })),
  }));
  for (const variant of ["asset", "stream", "rate", "pitch", "source-gap", "project-gap"]) {
    const input = structuredClone(document);
    input.tracks = [{ id: "t", kind: "audio", order: 0 }];
    const sourceStart = variant === "source-gap" ? 200000 : 100000;
    const sourceEnd = variant === "rate" || variant === "source-gap" ? 300000 : 200000;
    const projectStart = variant === "project-gap" ? 200000 : 100000;
    input.clips = [
      {
        id: "left",
        trackId: "t",
        assetId: "one",
        streamId: "a",
        source: { kind: "range", range: { startUs: 0, endUs: 100000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 100000 } },
      },
      {
        id: "right",
        trackId: "t",
        assetId: variant === "asset" ? "two" : "one",
        streamId: variant === "stream" ? "b" : "a",
        source: { kind: "range", range: { startUs: sourceStart, endUs: sourceEnd } },
        placement: {
          kind: "project",
          range: { startUs: projectStart, endUs: projectStart + 100000 },
        },
        pitch: variant === "pitch" ? "follow" : "preserve",
      },
    ];
    expect(
      [
        ...createCompiler(validateComposition(input, media), variant).audio({
          startUs: 0,
          endUs: 400000,
        }),
      ].map((segment) => segment.context.map((part) => part.source)),
      variant,
    ).toEqual([[{ startUs: 0, endUs: 100000 }], [{ startUs: sourceStart, endUs: sourceEnd }]]);
  }
});

test("fractional sample offsets keep a full retained-run origin across splits and windows", () => {
  const assets = [
    {
      id: "asset",
      streams: [
        {
          id: "audio",
          kind: "audio" as const,
          bounds: { startUs: 0, endUs: 2000000 },
          available: [{ startUs: 0, endUs: 2000000 }],
        },
      ],
    },
  ];
  const input = structuredClone(document);
  input.tracks = [{ id: "a", kind: "audio", order: 0 }];
  input.clips = [
    {
      id: "voice",
      trackId: "a",
      assetId: "asset",
      streamId: "audio",
      source: { kind: "range", range: { startUs: 500001, endUs: 1500001 } },
      placement: { kind: "project", range: { startUs: 10001, endUs: 1010001 } },
    },
  ];
  const split = applyBatch(
    input,
    [{ operation: "split", clipIds: ["voice"], atUs: 123457, scope: "selected" }],
    { assets, namespace: "phase" },
  );
  const original = createCompiler(validateComposition(input, assets), "before");
  const compiler = createCompiler(validateComposition(split.document, assets), "after");
  for (const [rate, end] of [
    [48000, 48480],
    [44100, 44541],
  ] as const) {
    const context = [
      {
        source: { startUs: 500001, endUs: 1500001 },
        sampleRange: { start: rate === 48000 ? 480 : 441, end },
      },
    ];
    const full = [...compiler.audio({ startUs: 0, endUs: 1100000 }, rate)];
    expect(full.map((segment) => segment.context)).toEqual([context, context]);
    expect([...original.audio({ startUs: 0, endUs: 1100000 }, rate)][0]!.context).toEqual(context);
    const late = [...compiler.audio({ startUs: 700001, endUs: 800001 }, rate)][0]!;
    expect(late.context).toEqual(context);
    expect(late.sampleRange.start - late.context[0]!.sampleRange.start).toBe(
      rate === 48000 ? 33120 : 30429,
    );
    expect(compiledAudioSchema.parse(JSON.parse(JSON.stringify(late)))).toEqual(late);
    expect(
      compiledAudioSchema.safeParse({
        ...late,
        context: [{ ...context[0], sampleRange: { start: end, end: 0 } }],
      }).success,
    ).toBe(false);
  }
  const trimmed = applyBatch(
    input,
    [
      {
        operation: "trim",
        clipId: "voice",
        range: { startUs: 200001, endUs: 1010001 },
        scope: "selected",
        ripple: "none",
      },
    ],
    { assets, namespace: "trim-phase" },
  );
  const trimmedCompiler = createCompiler(validateComposition(trimmed.document, assets), "trimmed");
  const window = trimmedCompiler.window({
    range: { startUs: 700001, endUs: 800001 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const context = [
    { source: { startUs: 690001, endUs: 1500001 }, sampleRange: { start: 9600, end: 48480 } },
  ];
  expect([...window.audio()][0]!.context).toEqual(context);
  expect(window.manifest.sources[0]!.context).toEqual(context);
  expect(executionWindowManifestSchema.parse(JSON.parse(JSON.stringify(window.manifest)))).toEqual(
    window.manifest,
  );
});

test("processing includes only audio occurrences with requested output samples", () => {
  const input = structuredClone(document);
  input.tracks.push(
    { id: "short", kind: "audio", order: 0 },
    { id: "long", kind: "audio", order: 1 },
  );
  for (const [id, endUs] of [
    ["short", 10],
    ["long", 100],
  ] as const)
    input.clips.push({
      id,
      trackId: id,
      source: { kind: "silence" },
      placement: { kind: "project", range: { startUs: 0, endUs } },
    });
  const compiler = createCompiler(validateComposition(input, assets), "subsample");
  const request = {
    range: { startUs: 0, endUs: 40 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  };
  const window = compiler.window(request);
  expect(
    window.manifest.processing
      .filter((node) => node.mediaKind === "audio" && node.target.kind === "clip")
      .map((node) => node.target),
  ).toEqual([...window.audio()].map((part) => ({ kind: "clip", id: part.clipId })));
  expect([...window.audio()].map((part) => part.clipId)).toEqual(["long"]);
  expect([...window.frames()][0]!.layers.map((layer) => layer.clipId)).toEqual(["c"]);
  const zero = compiler.window({ ...request, range: { startUs: 0, endUs: 10 } });
  expect(zero.manifest.processing.filter((node) => node.mediaKind === "audio")).toEqual([]);
  expect([...zero.audio()]).toEqual([]);
  expect([...zero.frames()][0]!.layers.map((layer) => layer.clipId)).toEqual(["c"]);
  expect(() =>
    compiler.window({
      ...request,
      tap: { target: { kind: "clip", id: "short" }, point: { kind: "processed" } },
    }),
  ).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
});

test("execution window owns exact sample endpoints and readiness requires every bound implementation", () => {
  const compiler = createCompiler(validateComposition(document, assets), "sample-window");
  const window = compiler.window({
    range: { startUs: Number.MAX_SAFE_INTEGER - 20, endUs: Number.MAX_SAFE_INTEGER },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const endpoint = (us: number) => Number((BigInt(us) * 48000n) / 1000000n);
  expect(window.manifest.sampleRange).toEqual({
    start: endpoint(Number.MAX_SAFE_INTEGER - 20),
    end: endpoint(Number.MAX_SAFE_INTEGER),
  });
  const tiny = compiler.window({
    range: { startUs: 1, endUs: 2 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  expect(tiny.manifest.sampleRange).toEqual({ start: 0, end: 0 });
  const bound = {
    ...tiny.manifest,
    requirements: tiny.manifest.requirements.map((r) => ({
      ...r,
      implementationId: "tested-native",
    })),
  };
  expect(() => requireWindowReady(executionWindowManifestSchema.parse(bound))).not.toThrow();
  const partial = {
    ...bound,
    requirements: bound.requirements.map((r, i) => ({
      ...r,
      implementationId: i === 0 ? null : r.implementationId,
    })),
  };
  expect(() => requireWindowReady(partial)).toThrowError(
    expect.objectContaining({
      code: "NOT_READY",
      details: { requirements: [partial.requirements[0]] },
    }),
  );
});

test("picture inspection retains the globally visible frame without requiring unrelated retimed audio", () => {
  const input = structuredClone(document);
  input.tracks.push({ id: "a", kind: "audio", order: 1 });
  input.clips.push({
    id: "speech",
    trackId: "a",
    assetId: "sound",
    streamId: "audio",
    source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
    placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
  });
  input.processing.push({
    target: { kind: "output" },
    steps: [{ id: "gain", enabled: true, processor: { type: "gain", gain: 0.5 } }],
  });
  const compiler = createCompiler(
    validateComposition(input, [
      ...assets,
      {
        id: "sound",
        streams: [
          {
            id: "audio",
            kind: "audio",
            bounds: { startUs: 0, endUs: 2000000 },
            available: [{ startUs: 0, endUs: 2000000 }],
          },
        ],
      },
    ]),
    "picture",
  );
  const request = {
    range: { startUs: 50001, endUs: 50030 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  };
  const movie = compiler.window(request);
  expect(movie.manifest.requirements.some((requirement) => requirement.kind === "retime")).toBe(
    true,
  );
  const picture = compiler.videoWindow(request);
  expect([...picture.frames()]).toEqual([...movie.frames()]);
  expect([...picture.frames()][0]).toMatchObject({
    index: 1,
    sampleAtUs: 33366,
    visibleRange: { startUs: 50001, endUs: 50030 },
    layers: [{ clipId: "c", sourceUs: { numerator: 1600100, denominator: 3 } }],
  });
  expect(picture.manifest.sources.map((source) => source.clipId)).toEqual(["c"]);
  expect(picture.manifest.requirements).toEqual([
    { kind: "executor", mediaKind: "video", implementationId: null },
  ]);
  expect([...picture.audio()]).toEqual([]);
  expect(() =>
    compiler.videoWindow({
      ...request,
      tap: { target: { kind: "track", id: "a" }, point: { kind: "dry" } },
    }),
  ).toThrow("Video inspection requires a video target");
});

test("frame boundaries compare exact execution times while retaining integer labels", () => {
  const compiler = createCompiler(validateComposition(document, assets), "revision");
  expect(compiler.frameBoundary({ numerator: 66733, denominator: 2 })).toEqual({
    before: { index: 0, sampleAtUs: 0, visibleRange: { startUs: 0, endUs: 33366 } },
    after: { index: 1, sampleAtUs: 33366, visibleRange: { startUs: 33366, endUs: 66733 } },
  });
  expect(compiler.frameBoundary(33366)).toEqual({
    before: { index: 0, sampleAtUs: 0, visibleRange: { startUs: 0, endUs: 33366 } },
    after: { index: 1, sampleAtUs: 33366, visibleRange: { startUs: 33366, endUs: 66733 } },
  });
  expect(compiler.frameBoundary(0).before).toBeNull();
  expect(compiler.frameBoundary(1000000)).toEqual({
    before: { index: 29, sampleAtUs: 967633, visibleRange: { startUs: 967633, endUs: 1000000 } },
    after: null,
  });
  for (const boundary of [-1, 1000001, { numerator: 2000001, denominator: 2 }, Number.NaN])
    expect(() => compiler.frameBoundary(boundary)).toThrow(/within the project/);
});

test("boundary descriptors preserve full movie and demanded-window frame plans", () => {
  const compiler = createCompiler(validateComposition(document, assets), "revision");
  const full = [...compiler.frames({ startUs: 0, endUs: 1000000 })];
  const descriptor = ({ index, sampleAtUs, visibleRange }: (typeof full)[number]) => ({
    index,
    sampleAtUs,
    visibleRange,
  });
  for (let i = 0; i < full.length; i++) {
    const frame = full[i]!;
    expect(compiler.frameBoundary(frame.sampleAtUs)).toEqual({
      before: i ? descriptor(full[i - 1]!) : null,
      after: descriptor(frame),
    });
    const request = {
      range: frame.visibleRange,
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    };
    expect([...compiler.window(request).frames()]).toEqual([frame]);
    expect([...compiler.videoWindow(request).frames()]).toEqual([frame]);
  }
});

test("boundary selection does not invent pictures for a clip between global samples", () => {
  const input = structuredClone(document);
  input.clips.push({
    assetId: "asset",
    streamId: "video",
    id: "brief",
    trackId: "overlay",
    placement: { kind: "project", range: { startUs: 40000, endUs: 50000 } },
    source: { kind: "range", range: { startUs: 0, endUs: 10000 } },
  });
  input.tracks.push({ id: "overlay", kind: "video", order: 1 });
  const compiler = createCompiler(validateComposition(input, assets), "revision");
  expect(compiler.frameBoundary(40000)).toEqual(compiler.frameBoundary(50000));
  expect(compiler.frameBoundary(40000).after?.sampleAtUs).toBe(66733);
  expect(
    [...compiler.frames({ startUs: 0, endUs: 100000 })]
      .flatMap((f) => f.layers)
      .some((l) => l.clipId === "brief"),
  ).toBe(false);
});

test("empty projects and submicrosecond frame periods preserve compiler sampling", () => {
  const empty = createCompiler(validateComposition({ ...document, clips: [] }, assets), "empty");
  expect(empty.frameBoundary(0)).toEqual({ before: null, after: null });
  expect(() => empty.frameBoundary(1)).toThrow(/within the project/);
  const input = structuredClone(document);
  input.canvas.fps = { numerator: 2000000, denominator: 1 };
  const compiler = createCompiler(validateComposition(input, assets), "fast");
  const frames = [...compiler.frames({ startUs: 0, endUs: 2 })];
  expect(frames.map((f) => [f.index, f.sampleAtUs])).toEqual([
    [1, 0],
    [3, 1],
  ]);
  expect(compiler.frameBoundary({ numerator: 1, denominator: 4 })).toEqual({
    before: null,
    after: { index: 1, sampleAtUs: 0, visibleRange: { startUs: 0, endUs: 1 } },
  });
  expect(compiler.frameBoundary(1)).toEqual({
    before: { index: 1, sampleAtUs: 0, visibleRange: { startUs: 0, endUs: 1 } },
    after: { index: 3, sampleAtUs: 1, visibleRange: { startUs: 1, endUs: 2 } },
  });
});

test("terminal neighbors clip to the existing integer render duration", () => {
  const input = structuredClone(document);
  input.clips[0]!.placement = { kind: "project", range: { startUs: 0, endUs: 100100 } };
  const aligned = createCompiler(validateComposition(input, assets), "aligned");
  expect(aligned.frameBoundary(100100)).toEqual({
    before: { index: 2, sampleAtUs: 66733, visibleRange: { startUs: 66733, endUs: 100100 } },
    after: null,
  });
  input.clips[0]!.placement = {
    kind: "project",
    range: { startUs: 0, endUs: { numerator: 200201, denominator: 2 } },
  };
  const fractional = createCompiler(validateComposition(input, assets), "fractional");
  expect(fractional.frameBoundary({ numerator: 200201, denominator: 2 })).toEqual({
    before: { index: 3, sampleAtUs: 100100, visibleRange: { startUs: 100100, endUs: 100101 } },
    after: null,
  });
});

test("empty tap planning validates target, media kind and named step without a render range", () => {
  const input = structuredClone(document);
  input.clips = [];
  input.tracks.push({ id: "a", kind: "audio", order: 1 });
  input.processing = [
    {
      target: { kind: "output" },
      steps: [
        { id: "fade", enabled: true, processor: { type: "opacity", opacity: 0.5 } },
        { id: "hidden", enabled: true, processor: { type: "opacity", opacity: 0 } },
      ],
    },
  ];
  const compiler = createCompiler(validateComposition(input, assets), "empty-taps");
  expect(
    compiler.tapPlan(
      { target: { kind: "output" }, point: { kind: "after-step", stepId: "fade" } },
      "video",
    ),
  ).toEqual([
    {
      target: { kind: "output" },
      mediaKind: "output",
      inputs: [],
      steps: [{ id: "fade", enabled: true, processor: { type: "opacity", opacity: 0.5 } }],
    },
  ]);
  expect(
    compiler.tapPlan({ target: { kind: "track", id: "v" }, point: { kind: "dry" } }, "video"),
  ).toEqual([{ target: { kind: "track", id: "v" }, mediaKind: "video", inputs: [], steps: [] }]);
  expect(() =>
    compiler.tapPlan({ target: { kind: "track", id: "a" }, point: { kind: "processed" } }, "video"),
  ).toThrow("video target");
  expect(() =>
    compiler.tapPlan(
      { target: { kind: "output" }, point: { kind: "after-step", stepId: "missing" } },
      "video",
    ),
  ).toThrow("Unknown step");
});

test("matching CFR source identity uses exact frame time through splits and short ranges", () => {
  const input = structuredClone(document);
  input.canvas.fps = { numerator: 30, denominator: 1 };
  input.clips[0]!.source = { kind: "range", range: { startUs: 0, endUs: 1000000 } };
  const compiler = createCompiler(validateComposition(input, assets), "exact");
  const full = [...compiler.frames({ startUs: 0, endUs: 1000000 })];
  expect(full.slice(0, 4).map((frame) => frame.layers[0])).toMatchObject([
    { sourceUs: 0 },
    { sourceUs: { numerator: 100000, denominator: 3 } },
    { sourceUs: { numerator: 200000, denominator: 3 } },
    { sourceUs: 100000 },
  ]);
  const late = [...compiler.frames({ startUs: 999999, endUs: 1000000 })][0]!;
  expect(late).toMatchObject({
    index: 29,
    sampleAtUs: 966666,
    layers: [{ sourceUs: { numerator: 2900000, denominator: 3 } }],
  });
  expect(compiler.frameTime(late.index)).toEqual({ numerator: 2900000, denominator: 3 });
  const split = applyBatch(
    input,
    [{ operation: "split", clipIds: ["c"], atUs: 33333, scope: "selected" }],
    { assets, namespace: "exact-split" },
  );
  const splitCompiler = createCompiler(validateComposition(split.document, assets), "split");
  const identities = (frames: typeof full) =>
    frames.map((frame) => [
      frame.index,
      frame.sampleAtUs,
      frame.layers.map((layer) => (layer.kind === "video" ? layer.sourceUs : null)),
    ]);
  expect(identities([...splitCompiler.frames({ startUs: 0, endUs: 1000000 })])).toEqual(
    identities(full),
  );
  expect(identities([...splitCompiler.frames({ startUs: 50001, endUs: 50002 })])).toEqual(
    identities([full[1]!]),
  );
});

test("fractional clip and processor starts include the exact sampled instant", () => {
  const input = structuredClone(document);
  input.canvas.fps = { numerator: 30, denominator: 1 };
  const startUs = { numerator: 166666, denominator: 5 };
  const range = { startUs, endUs: 100000 };
  input.clips[0]!.source = { kind: "range", range };
  input.clips[0]!.placement = { kind: "project", range };
  input.processing = [
    {
      target: { kind: "clip", id: "c" },
      steps: [
        {
          id: "opacity",
          enabled: true,
          window: { kind: "project", range },
          processor: { type: "opacity", opacity: 0.5 },
        },
        {
          id: "scale",
          enabled: true,
          window: { kind: "project", range },
          processor: { type: "geometry", scale: { x: 2, y: 2 } },
        },
      ],
    },
  ];
  const compiler = createCompiler(validateComposition(input, assets), "fractional");
  const window = compiler.videoWindow({
    range: { startUs: 33333, endUs: 33334 },
    rendition: { sampleRate: 48000, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  expect(window.manifest.sources.map((source) => source.clipId)).toEqual(["c"]);
  const frame = [...window.frames()][0]!;
  expect(frame).toMatchObject({
    index: 1,
    sampleAtUs: 33333,
    layers: [
      { clipId: "c", sourceUs: { numerator: 100000, denominator: 3 }, availability: "available" },
    ],
  });
  const operations = frame.visual.flatMap((node) => node.operations);
  expect(operations).toContainEqual({ kind: "opacity", opacity: 0.5 });
  expect(operations).toContainEqual({ kind: "affine", matrix: [2, 0, 0, 2, -320, -240] });
  expect(compiler.frameBoundary(startUs).after?.index).toBe(1);
  expect([...compiler.frames({ startUs: 0, endUs: 1 })][0]!.layers).toEqual([]);
});

test("exact retimed source holes also exclude attached descendants", () => {
  const input = structuredClone(document);
  input.canvas.fps = { numerator: 30, denominator: 1 };
  input.tracks = [
    { id: "v", kind: "video", order: 0 },
    { id: "child", kind: "video", order: 1 },
  ];
  input.clips = [
    {
      id: "c",
      trackId: "v",
      assetId: "asset",
      streamId: "video",
      source: { kind: "range", range: { startUs: 0, endUs: 300000 } },
      placement: { kind: "project", range: { startUs: 0, endUs: 100000 } },
    },
    {
      id: "child",
      trackId: "child",
      assetId: "child",
      streamId: "video",
      source: { kind: "range", range: { startUs: 0, endUs: 300000 } },
      placement: { kind: "content", clipId: "c", sourceRange: { startUs: 0, endUs: 300000 } },
    },
  ];
  const media = [
    {
      ...assets[0]!,
      streams: [
        {
          ...assets[0]!.streams[0]!,
          available: [
            { startUs: 0, endUs: 100000 },
            { startUs: 200000, endUs: 2000000 },
          ],
        },
      ],
    },
    { ...assets[0]!, id: "child" },
  ];
  const compiler = createCompiler(validateComposition(input, media), "hole");
  expect([...compiler.frames({ startUs: 33333, endUs: 33334 })][0]!.layers).toMatchObject([
    { clipId: "c", sourceUs: 100000, availability: "source-unavailable" },
    { clipId: "child", sourceUs: 100000, availability: "anchor-unavailable" },
  ]);
  expect([...compiler.frames({ startUs: 66666, endUs: 66667 })][0]!.layers).toMatchObject([
    { clipId: "c", sourceUs: 200000, availability: "available" },
    { clipId: "child", sourceUs: 200000, availability: "available" },
  ]);
});
