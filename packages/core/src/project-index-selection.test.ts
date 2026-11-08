import { expect, test } from "vitest";
import {
  createCompiler,
  validateComposition,
  type Composition,
  type Asset,
  type ProcessingTap,
} from "@yap/composition";
import type { SourceSceneChunk } from "./source-scene-chunks.js";
import { selectProjectIndex } from "./project-index-selection.js";

const clip = (
  id: string,
  start: number,
  end: number,
  trackId = "v",
  acquisitionId?: string,
): Composition["clips"][number] => ({
  id,
  trackId,
  assetId: "asset",
  streamId: "video",
  ...(acquisitionId ? { acquisitionId } : {}),
  source: { kind: "range", range: { startUs: start, endUs: end } },
  placement: { kind: "project", range: { startUs: start, endUs: end } },
});
function fixture(clips: Composition["clips"] = [clip("c", 0, 12000000)]) {
  const document: Composition = {
    canvas: {
      width: 640,
      height: 480,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
    tracks: [
      { id: "v", kind: "video", order: 0 },
      { id: "overlay", kind: "video", order: 1 },
    ],
    groups: [],
    processing: [],
    syncGroups: [],
    clips,
  };
  const assets: {
    id: string;
    streams: Extract<Asset["streams"][number], { kind: "audio" | "video" }>[];
  }[] = [
    {
      id: "asset",
      streams: [
        {
          id: "video",
          kind: "video",
          width: 640,
          height: 480,
          bounds: { startUs: 0, endUs: 20000000 },
          available: [{ startUs: 0, endUs: 20000000 }],
        },
      ],
    },
  ];
  return { document, assets };
}
async function select(
  f = fixture(),
  scenes: Parameters<typeof selectProjectIndex>[0]["scenes"] = () => null,
  tap: ProcessingTap = { target: { kind: "output" }, point: { kind: "processed" } },
  signal?: AbortSignal,
  acquisitions: unknown[] = [],
) {
  const model = validateComposition(f.document, f.assets, acquisitions);
  const compiler = createCompiler(model, "revision");
  const processing = model.durationUs
    ? compiler.videoWindow({
        range: { startUs: 0, endUs: model.durationUs },
        rendition: { sampleRate: 48000, channels: 2 },
        tap,
      }).manifest.processing
    : [];
  return selectProjectIndex({ model, processing, tap, revisionId: "revision", scenes, signal });
}
test("project cadence and authored boundaries deduplicate images while retaining their reasons", async () => {
  const result = await select(fixture([clip("a", 0, 6000000), clip("b", 6000000, 12000000)]));
  expect(result.map((candidate) => candidate.sampleAtUs)).toEqual([0, 5966666, 6000000, 11966666]);
  expect(result.find((candidate) => candidate.sampleAtUs === 6000000)?.reasons).toEqual([
    { kind: "clip", clipId: "a", edge: "end", projectAtUs: 6000000, side: "after" },
    { kind: "availability", clipId: "a", edge: "end", projectAtUs: 6000000, side: "after" },
    { kind: "clip", clipId: "b", edge: "start", projectAtUs: 6000000, side: "after" },
    { kind: "availability", clipId: "b", edge: "start", projectAtUs: 6000000, side: "after" },
  ]);
  expect(result.map((candidate) => candidate.ordinal)).toEqual([0, 1, 2, 3]);
});

function sceneChunk(beforeAt = 200000, afterAt = 400000, changeAt = 350000): SourceSceneChunk {
  const clock = (start: number, end: number) => ({
    value: String(start),
    timescale: 1000000,
    endValue: String(end),
    endTimescale: 1000000,
  });
  const before = clock(0, changeAt),
    after = clock(changeAt, 1000000);
  return {
    policy: "fixture",
    assetId: "asset",
    streamId: "video",
    originUs: 0,
    durationUs: 20000000,
    sourceWidth: 1,
    sourceHeight: 1,
    range: { startUs: 0, endUs: 1000000 },
    coverage: [
      {
        requestedSourceUs: beforeAt,
        actualSourceUs: 0,
        status: "available",
        sample: before,
        width: 1,
        height: 1,
        continuousFromPrevious: false,
        stillnessRunStartUs: 0,
      },
      {
        requestedSourceUs: afterAt,
        actualSourceUs: changeAt,
        status: "available",
        sample: after,
        width: 1,
        height: 1,
        continuousFromPrevious: true,
        stillnessRunStartUs: afterAt,
      },
    ],
    comparisons: [
      {
        previous: before,
        current: after,
        actualSourceUs: changeAt,
        boundary: true,
        changedPixelFraction: 1,
        changedCellFraction: 1,
        meanAbsoluteChannelDifference: 1,
      },
    ],
  };
}
test("scene sides retain actual observations and choose old/new pictures directionally on a coarse clock", async () => {
  const f = fixture([clip("c", 0, 1000000)]);
  f.document.canvas.fps = { numerator: 3, denominator: 1 };
  const result = await select(f, () => ({ generation: "scenes-1", chunks: [sceneChunk()] }));
  const sides = result.flatMap((candidate) =>
    candidate.reasons
      .filter((r) => r.kind === "scene")
      .map((reason) => ({ sampleAtUs: candidate.sampleAtUs, reason })),
  );
  expect(sides).toMatchObject([
    {
      sampleAtUs: 0,
      reason: {
        side: "before",
        observedSourceUs: 200000,
        projectAtUs: 200000,
        generation: "scenes-1",
        clipId: "c",
      },
    },
    {
      sampleAtUs: 666666,
      reason: {
        side: "after",
        observedSourceUs: 400000,
        projectAtUs: 400000,
        generation: "scenes-1",
        clipId: "c",
      },
    },
  ]);
  expect(sides.map(({ sampleAtUs }) => (sampleAtUs < 350000 ? "old" : "new"))).toEqual([
    "old",
    "new",
  ]);
});

test("project moments select mark, pin and click reasons and merge with scene evidence", async () => {
  const f = fixture([clip("c", 0, 1_000_000, "v", "capture")]);
  f.document.canvas.fps = { numerator: 3, denominator: 1 };
  const result = await select(
    f,
    () => ({
      generation: "scenes-1",
      chunks: [sceneChunk(200_000, 400_000, 350_000)],
      moments: [
        { sourceUs: 400_000, kind: "mark", markId: "m" },
        { sourceUs: 700_000, kind: "pin", markId: "p" },
        { sourceUs: 900_000, kind: "click", markId: "c" },
      ],
    }),
    undefined,
    undefined,
    [
      {
        id: "capture",
        bindings: [
          { assetId: "asset", streamId: "video", available: [{ startUs: 0, endUs: 1_000_000 }] },
        ],
      },
    ],
  );
  expect(
    result.flatMap((candidate) =>
      candidate.reasons.filter(
        (reason) =>
          reason.kind === "mark" ||
          reason.kind === "pin" ||
          reason.kind === "click" ||
          reason.kind === "scene",
      ),
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "mark", markId: "m" }),
      expect.objectContaining({ kind: "pin", markId: "p" }),
      expect.objectContaining({ kind: "click", markId: "c" }),
    ]),
  );
  const sceneAndMark = result.filter((candidate) =>
    candidate.reasons.some((reason) => reason.kind === "scene" || reason.kind === "mark"),
  );
  expect(sceneAndMark).toHaveLength(2);
  expect(
    sceneAndMark.find((candidate) => candidate.reasons.some((reason) => reason.kind === "mark"))
      ?.reasons,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "mark", markId: "m" }),
      expect.objectContaining({ kind: "scene", side: "after" }),
    ]),
  );
});

// A long clip whose observed points carry the given stillness runs and no scene boundaries.
function coverageScan(points: [atUs: number, runUs: number][]) {
  const f = fixture([clip("c", 0, 60_000_000, "v", "capture")]);
  const stream = f.assets[0]!.streams[0]!;
  stream.bounds = { startUs: 0, endUs: 60_000_000 };
  stream.available = [{ startUs: 0, endUs: 60_000_000 }];
  const chunk: SourceSceneChunk = {
    ...sceneChunk(),
    durationUs: 60_000_000,
    range: { startUs: 0, endUs: 60_000_000 },
    comparisons: [],
    coverage: points.map(([at, run], index) => ({
      requestedSourceUs: at,
      actualSourceUs: at,
      status: "available",
      sample: {
        value: String(at),
        timescale: 1_000_000,
        endValue: String(at + 1),
        endTimescale: 1_000_000,
      },
      width: 1,
      height: 1,
      continuousFromPrevious: index > 0,
      stillnessRunStartUs: run,
    })),
  };
  const acquisitions = [
    {
      id: "capture",
      bindings: [
        { assetId: "asset", streamId: "video", available: [{ startUs: 0, endUs: 60_000_000 }] },
      ],
    },
  ];
  return { f, chunk, acquisitions };
}
const coverageAt = (result: Awaited<ReturnType<typeof selectProjectIndex>>) =>
  result.flatMap((candidate) =>
    candidate.reasons.flatMap((reason) => (reason.kind === "coverage" ? [reason.projectAtUs] : [])),
  );

test("project coverage waits thirty seconds after any chosen picture, a mark included", async () => {
  const { f, chunk, acquisitions } = coverageScan([
    [0, 0],
    [31_000_000, 31_000_000],
    [51_000_000, 51_000_000],
  ]);
  const result = await select(
    f,
    () => ({
      generation: "scenes",
      chunks: [chunk],
      moments: [{ sourceUs: 20_000_000, kind: "mark", markId: "m" }],
    }),
    undefined,
    undefined,
    acquisitions,
  );
  // 31 s is only 11 s after the mark; 51 s is 31 s after it.
  expect(coverageAt(result)).toEqual([51_000_000]);
});

test("project coverage compares the picture with the last chosen one, not the previous sample", async () => {
  const { f, chunk, acquisitions } = coverageScan([
    [0, 0],
    [10_000_000, 10_000_000],
    [39_000_000, 10_000_000],
    [40_000_000, 10_000_000],
  ]);
  const result = await select(
    f,
    () => ({ generation: "scenes", chunks: [chunk] }),
    undefined,
    undefined,
    acquisitions,
  );
  // The picture at 39 s matches the 10 s sample but not the first frame chosen at 0.
  expect(coverageAt(result)).toEqual([39_000_000]);
});

test("project moments are ignored when the clip has no acquisition authority", async () => {
  const f = fixture([clip("c", 0, 1_000_000)]);
  const result = await select(f, () => ({
    generation: "scenes-1",
    chunks: [sceneChunk()],
    moments: [{ sourceUs: 400_000, kind: "mark" as const, markId: "m" }],
  }));
  expect(result.flatMap((candidate) => candidate.reasons)).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "mark" })]),
  );
});
test("fractional retiming and repeated sources preserve each occurrence and exact projected observation", async () => {
  const f = fixture([clip("first", 0, 1000000), clip("again", 0, 1000000, "overlay")]);
  f.document.canvas.fps = { numerator: 30000, denominator: 1001 };
  f.document.clips[0]!.placement = { kind: "project", range: { startUs: 0, endUs: 500000 } };
  f.document.clips[1]!.placement = { kind: "project", range: { startUs: 1000000, endUs: 1333333 } };
  const readRanges: unknown[] = [];
  const result = await select(f, (occurrence, range) => {
    readRanges.push({ clipId: occurrence.clipId, range });
    return { generation: "scene", chunks: [sceneChunk(200001, 400003)] };
  });
  expect(readRanges).toEqual([
    { clipId: "first", range: { startUs: 0, endUs: 1000000 } },
    { clipId: "again", range: { startUs: 0, endUs: 1000000 } },
  ]);
  expect(
    result.flatMap((candidate) =>
      candidate.reasons
        .filter((r) => r.kind === "scene")
        .map((r) => [r.clipId, r.side, r.observedSourceUs, r.projectAtUs, candidate.sampleAtUs]),
    ),
  ).toEqual([
    ["first", "before", 200001, { numerator: 200001, denominator: 2 }, 66733],
    ["first", "after", 400003, { numerator: 400003, denominator: 2 }, 200200],
    ["again", "before", 200001, { numerator: 1066666933333, denominator: 1000000 }, 1034366],
    ["again", "after", 400003, { numerator: 1133334199999, denominator: 1000000 }, 1134466],
  ]);
});
test("selected taps keep overlapping layer reasons and exclude unrelated source reads", async () => {
  const f = fixture([clip("base", 0, 1000000), clip("presenter", 200000, 700000, "overlay")]);
  f.document.groups = [{ id: "presenter-group", kind: "video", order: 1 }];
  f.document.tracks[1]!.parentId = "presenter-group";
  const all = await select(f);
  expect(all.map((candidate) => candidate.sampleAtUs)).toEqual([
    0, 166666, 200000, 666666, 700000, 966666,
  ]);
  for (const target of [
    { kind: "clip", id: "presenter" },
    { kind: "track", id: "overlay" },
    { kind: "group", id: "presenter-group" },
  ] as const) {
    const reads: string[] = [];
    const rows = await select(
      f,
      (occurrence) => {
        reads.push(occurrence.clipId);
        return null;
      },
      { target, point: { kind: "dry" } },
    );
    expect(reads).toEqual(["presenter"]);
    expect(
      rows.flatMap((candidate) =>
        candidate.reasons.flatMap((reason) => ("clipId" in reason ? [reason.clipId] : [])),
      ),
    ).not.toContain("base");
    expect(rows.map((candidate) => candidate.sampleAtUs)).toEqual([
      0, 166666, 200000, 666666, 700000, 966666,
    ]);
  }
});
test("scene reads are bounded to inverse support fragments and quantized sides cannot cross their occurrence support", async () => {
  const f = fixture([clip("c", 0, 1000000)]);
  f.document.clips[0]!.source = { kind: "range", range: { startUs: 10000000, endUs: 11000000 } };
  f.assets[0]!.streams[0]!.available = [
    { startUs: 0, endUs: 10250000 },
    { startUs: 10750000, endUs: 20000000 },
  ];
  const reads: unknown[] = [];
  const result = await select(f, (_occurrence, range) => {
    reads.push(range);
    return null;
  });
  expect(reads).toEqual([
    { startUs: 10000000, endUs: 10250000 },
    { startUs: 10750000, endUs: 11000000 },
  ]);
  expect(result.map((candidate) => candidate.sampleAtUs)).toEqual([
    0, 233333, 266666, 733333, 766666, 966666,
  ]);
  const short = fixture([clip("short", 100000, 500000)]);
  short.document.canvas.fps = { numerator: 3, denominator: 1 };
  const suppressed = await select(short, () => ({ generation: "g", chunks: [sceneChunk()] }));
  expect(
    suppressed.flatMap((candidate) =>
      candidate.reasons.filter((reason) => reason.kind === "scene"),
    ),
  ).toEqual([]);
  expect(suppressed.map((candidate) => candidate.sampleAtUs)).toEqual([0, 333333]);
});
test("holds, empty projects and audio-only timelines need no scene dependency", async () => {
  const held = fixture([clip("hold", 100000, 1000000)]);
  held.document.clips[0]!.source = { kind: "hold", atUs: 500000 };
  const unexpectedRead = (): never => {
    throw new Error("No advancing video occurrence");
  };
  expect((await select(held, unexpectedRead)).map((candidate) => candidate.sampleAtUs)).toEqual([
    0, 66666, 100000, 966666,
  ]);
  expect(await select(fixture([]), unexpectedRead)).toEqual([]);
  const audio = fixture();
  audio.document.tracks[0]!.kind = "audio";
  audio.assets[0]!.streams[0] = {
    id: "video",
    kind: "audio",
    bounds: { startUs: 0, endUs: 20000000 },
    available: [{ startUs: 0, endUs: 20000000 }],
  };
  expect((await select(audio, unexpectedRead)).map((candidate) => candidate.sampleAtUs)).toEqual([
    0, 11966666,
  ]);
});
test("source stillness and overlapping chunk lookback neither suppress cadence nor duplicate scene reasons", async () => {
  const f = fixture();
  const chunk = sceneChunk();
  const repeated = structuredClone(chunk);
  repeated.coverage = [chunk.coverage[1]!];
  const result = await select(f, () => ({ generation: "scene", chunks: [chunk, repeated] }));
  expect(
    result
      .filter((candidate) => candidate.reasons.some((reason) => reason.kind === "coverage"))
      .map((candidate) => candidate.sampleAtUs),
  ).toEqual([]);
  expect(
    result
      .flatMap((candidate) => candidate.reasons.filter((reason) => reason.kind === "scene"))
      .map((reason) => [reason.side, reason.observedSourceUs]),
  ).toEqual([
    ["before", 200000],
    ["after", 400000],
  ]);
  const unchanged = structuredClone(chunk);
  unchanged.comparisons[0]!.boundary = false;
  const stillPoint = unchanged.coverage[1]!;
  if (stillPoint.status === "available") stillPoint.stillnessRunStartUs = 0;
  const still = await select(f, () => ({ generation: "still", chunks: [unchanged] }));
  expect(still.map((candidate) => candidate.sampleAtUs)).toEqual([0, 11966666]);
});

test("selection refuses oversized storyboards without returning a partial candidate list", async () => {
  const f = fixture([clip("c", 0, 12000000, "v", "capture")]);
  f.document.canvas.fps = { numerator: 1_000_000, denominator: 1 };
  const moments = Array.from({ length: 20_001 }, (_, i) => ({
    sourceUs: i * 500,
    kind: "click" as const,
    markId: `click-${i}`,
  }));
  await expect(
    select(f, () => ({ generation: "g", chunks: [], moments }), undefined, undefined, [
      {
        id: "capture",
        bindings: [
          { assetId: "asset", streamId: "video", available: [{ startUs: 0, endUs: 20_000_000 }] },
        ],
      },
    ]),
  ).rejects.toMatchObject({
    code: "LIMIT_EXCEEDED",
    details: {
      revisionId: "revision",
      limitKind: "maximumCandidates",
      maximum: 20000,
      observed: 20001,
    },
  });
});
test("cancellation yields during source observation work and closes the active iterator", async () => {
  const controller = new AbortController();
  let closed = false,
    reads = 0;
  async function* chunks() {
    try {
      const chunk = sceneChunk();
      for (;;) {
        reads++;
        yield chunk;
      }
    } finally {
      closed = true;
    }
  }
  const pending = select(
    fixture(),
    () => {
      setImmediate(() => controller.abort(new Error("cancel inspection")));
      return { generation: "g", chunks: chunks() };
    },
    { target: { kind: "output" }, point: { kind: "processed" } },
    controller.signal,
  );
  await expect(pending).rejects.toThrow("cancel inspection");
  expect(closed).toBe(true);
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThan(128);
});
test("a source reader that never advances hits a terminal work limit and releases its iterator", async () => {
  let closed = false;
  async function* chunks() {
    const chunk = { ...sceneChunk(), coverage: [], comparisons: [] };
    try {
      for (;;) yield chunk;
    } finally {
      closed = true;
    }
  }
  await expect(
    select(fixture(), () => ({ generation: "g", chunks: chunks() })),
  ).rejects.toMatchObject({
    code: "LIMIT_EXCEEDED",
    retryable: true,
    details: {
      revisionId: "revision",
      limitKind: "maximumWork",
      maximum: 1000000,
      observed: 1000001,
    },
  });
  expect(closed).toBe(true);
});

test("windowed opacity retains both neighboring pictures and respects the requested tap", async () => {
  const f = fixture();
  f.document.processing = [
    {
      target: { kind: "output" },
      steps: [
        {
          id: "brief-hide",
          enabled: true,
          processor: { type: "opacity", opacity: 0 },
          window: { kind: "project", range: { startUs: 201234, endUs: 299999 } },
        },
      ],
    },
  ];
  const result = await select(f);
  expect(result.map((value) => value.sampleAtUs)).toEqual([
    0, 200000, 233333, 266666, 300000, 11966666,
  ]);
  expect(
    result.flatMap((value) => value.reasons.filter((reason) => reason.kind === "processing")),
  ).toEqual([
    { kind: "processing", projectAtUs: 201234, side: "before" },
    { kind: "processing", projectAtUs: 201234, side: "after" },
    { kind: "processing", projectAtUs: 299999, side: "before" },
    { kind: "processing", projectAtUs: 299999, side: "after" },
  ]);
  const dry = await select(f, () => null, { target: { kind: "output" }, point: { kind: "dry" } });
  expect(dry.map((value) => value.sampleAtUs)).toEqual([0, 11966666]);
});

test("scene membership uses exact frame time when its label precedes a fractional clip start", async () => {
  const f = fixture([
    {
      id: "c",
      trackId: "v",
      assetId: "asset",
      streamId: "video",
      source: { kind: "range", range: { startUs: 1, endUs: 1000001 } },
      placement: {
        kind: "project",
        range: {
          startUs: { numerator: 166666, denominator: 5 },
          endUs: { numerator: 5166666, denominator: 5 },
        },
      },
    },
  ]);
  const result = await select(f, () => ({
    generation: "fractional",
    chunks: [sceneChunk(0, 1, 1)],
  }));
  const sides = result.flatMap((candidate) =>
    candidate.reasons
      .filter((reason) => reason.kind === "scene")
      .map((reason) => ({ index: candidate.index, sampleAtUs: candidate.sampleAtUs, reason })),
  );
  expect(sides).toMatchObject([
    {
      index: 1,
      sampleAtUs: 33333,
      reason: {
        kind: "scene",
        side: "after",
        clipId: "c",
        generation: "fractional",
        observedSourceUs: 1,
        projectAtUs: { numerator: 166666, denominator: 5 },
      },
    },
  ]);
});
