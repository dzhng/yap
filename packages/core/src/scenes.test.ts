import { CatalogError } from "./catalog.js";
import { expect, test } from "vitest";
import {
  SourceSceneAnalysis,
  analyzeFrameScene,
  analyzeVisualSamples,
  compareVisualSamples,
  sceneSampleTimes,
  type VisualSample,
  type VisualSampler,
} from "./scenes.js";

function frame(
  at: number,
  paint: (x: number, y: number) => readonly number[] = () => [255, 255, 255],
): VisualSample {
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) pixels.set(paint(x, y), (y * 64 + x) * 3);
  return {
    requestedSourceUs: at,
    actualSourceUs: at,
    distanceUs: 0,
    width: 64,
    height: 64,
    rgbBase64: pixels.toString("base64"),
  };
}
const white = frame(0);
const rows = (shift: number) => (x: number, y: number) =>
  x >= 4 && x < 60 && (y + shift) % 8 === 3 && x % 7 < 5 ? [0, 0, 0] : [255, 255, 255];

test("spatial policy detects sparse widespread page scrolling and broad color replacement", () => {
  const scroll = compareVisualSamples(frame(0, rows(0)), frame(200_000, rows(1)));
  expect(scroll.changedPixelFraction).toBeLessThan(0.3);
  expect(scroll.changedCellFraction).toBeGreaterThan(0.8);
  expect(scroll.boundary).toBe(true);
  // These colors have approximately equal Rec.709 luminance but different RGB channels.
  const color = compareVisualSamples(
    frame(0, () => [255, 0, 0]),
    frame(200_000, () => [0, 76, 0]),
  );
  expect(color.changedPixelFraction).toBe(1);
  expect(color.boundary).toBe(true);
  expect(
    compareVisualSamples(
      white,
      frame(200_000, () => [20, 20, 20]),
    ).boundary,
  ).toBe(true);
});

test("static pixels, weak noise, local caret and compact button highlight do not reset", () => {
  const fixtures = [
    frame(200_000),
    frame(200_000, (x, y) => [245 + (x % 10), 245 + (y % 10), 250]),
    frame(200_000, (x, y) => (x === 20 && y >= 20 && y < 28 ? [0, 0, 0] : [255, 255, 255])),
    frame(200_000, (x, y) =>
      x >= 20 && x < 36 && y >= 20 && y < 28 ? [40, 100, 220] : [255, 255, 255],
    ),
  ];
  for (const current of fixtures) expect(compareVisualSamples(white, current).boundary).toBe(false);
});

test("distributed text reflow resets despite a mostly white raster", () => {
  const text = frame(0, (x, y) =>
    x >= 4 && x < 48 && y % 8 === 3 && x % 6 < 3 ? [0, 0, 0] : [255, 255, 255],
  );
  const reflow = frame(200_000, (x, y) =>
    x >= 8 && x < 60 && y % 8 === 3 && x % 6 < 3 ? [0, 0, 0] : [255, 255, 255],
  );
  // Mere narrow margin movement is deliberately not enough; wrapping into changed rows is broad.
  const wrapped = frame(200_000, (x, y) =>
    x >= 8 && x < 60 && (y + Math.floor(x / 12)) % 8 === 3 && x % 6 < 3
      ? [0, 0, 0]
      : [255, 255, 255],
  );
  expect(compareVisualSamples(text, reflow).boundary).toBe(false);
  expect(compareVisualSamples(text, wrapped).boundary).toBe(true);
});

test("source anchored grid includes predecessor and endpoint within native bounds", () => {
  expect(
    sceneSampleTimes({ startUs: 450_000, endUs: 850_000 }, { startUs: 0, endUs: 2_000_000 }),
  ).toEqual([400_000, 600_000, 800_000, 850_000]);
  expect(
    sceneSampleTimes({ startUs: 400_000, endUs: 600_000 }, { startUs: 350_000, endUs: 600_000 }),
  ).toEqual([350_000, 400_000, 599_999]);
  for (let offset = 0; offset < 200_000; offset += 997) {
    const times = sceneSampleTimes(
      { startUs: offset, endUs: offset + 10_000_000 },
      { startUs: 0, endUs: 20_000_000 },
    );
    expect(times.length).toBeLessThanOrEqual(52);
    expect(times.at(-1)! - times[0]!).toBeLessThanOrEqual(10_200_000);
    expect(new Set(times).size).toBe(times.length);
  }
});

test("invalid ranges fail before native work", async () => {
  let calls = 0;
  const sample: VisualSampler = async () => {
    calls++;
    throw new Error("must not run");
  };
  for (const range of [
    { startUs: 0, endUs: 10_000_001 },
    { startUs: -1, endUs: 3 },
    { startUs: 4, endUs: 4 },
  ]) {
    await expect(
      new SourceSceneAnalysis("fixture-recording", "/video", 20_000_000, sample).analyze(
        range,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RANGE" });
  }
  expect(calls).toBe(0);
});

test("held frames collapse comparisons without losing distances or covered request times", async () => {
  const result = await new SourceSceneAnalysis(
    "fixture-recording",
    "/video",
    2_000_000,
    async ({ atSourceUs }) => ({
      sourceWidth: 64,
      sourceHeight: 64,
      samples: atSourceUs.map((at) => ({ ...white, requestedSourceUs: at, distanceUs: at })),
    }),
  ).analyze({ startUs: 0, endUs: 600_000 }, new AbortController().signal);
  expect(result.comparisons).toEqual([]);
  expect(result.coverage.map((sample) => sample.distanceUs)).toEqual([
    0, 200_000, 400_000, 600_000,
  ]);
});

test("canonical comparisons use the actual later PTS", async () => {
  const result = await new SourceSceneAnalysis(
    "fixture-recording",
    "/video",
    1_000_000,
    async () => ({
      sourceWidth: 64,
      sourceHeight: 64,
      samples: [
        white,
        { ...frame(300_000, () => [0, 0, 0]), requestedSourceUs: 200_000, distanceUs: 100_000 },
      ],
    }),
  ).analyze({ startUs: 0, endUs: 200_000 }, new AbortController().signal);
  expect(result.comparisons[0]).toMatchObject({ actualSourceUs: 300_000, boundary: true });
  expect(result.coverage[1]?.distanceUs).toBe(100_000);
});

test("global chunk predecessor produces identical pair metrics to whole batch", () => {
  const samples = [white, frame(200_000), frame(400_000, rows(0)), frame(600_000, rows(1))];
  const first = analyzeVisualSamples(samples.slice(0, 2));
  const second = analyzeVisualSamples(samples.slice(2), first.lastSample);
  expect([...first.comparisons, ...second.comparisons]).toEqual(
    analyzeVisualSamples(samples).comparisons,
  );
});

test("invalid and inconsistent observation evidence fails explicitly", () => {
  for (const next of [
    { ...frame(200_000), actualSourceUs: -1 },
    { ...frame(200_000), distanceUs: 1 },
    { ...frame(200_000), width: 65 },
    { ...frame(200_000), rgbBase64: "bad" },
    { ...frame(200_000), rgbBase64: "!".repeat(16_384) },
    {
      ...frame(200_000),
      actualSourceUs: 0,
      distanceUs: 200_000,
      rgbBase64: frame(0, () => [0, 0, 0]).rgbBase64,
    },
  ])
    expect(() => analyzeVisualSamples([white, next])).toThrow();
  expect(() => analyzeVisualSamples([frame(200_000), white])).toThrow();
});

test("sampler cancellation and errors propagate, partial/escaped batches never become verified coverage", async () => {
  const request = {
    ownerId: "fixture-recording",
    source: "/video",
    kept: { startUs: 0, endUs: 1_000_000 },
    range: { startUs: 0, endUs: 200_000 },
  };
  const controller = new AbortController();
  const error = new Error("decode failed");
  await expect(
    new SourceSceneAnalysis(
      "fixture-recording",
      request.source,
      request.kept.endUs,
      async (_request, signal) => {
        expect(signal).toBe(controller.signal);
        throw error;
      },
    ).analyze(request.range, controller.signal),
  ).rejects.toBe(error);
  for (const samples of [[white], [white, frame(1_000_000)]]) {
    await expect(
      new SourceSceneAnalysis(
        "fixture-recording",
        request.source,
        request.kept.endUs,
        async () => ({
          sourceWidth: 64,
          sourceHeight: 64,
          samples,
        }),
      ).analyze(request.range, controller.signal),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  }
  await expect(
    new SourceSceneAnalysis(
      "fixture-recording",
      request.source,
      request.kept.endUs,
      async ({ atSourceUs }) => {
        controller.abort(error);
        return { sourceWidth: 64, sourceHeight: 64, samples: atSourceUs.map((at) => frame(at)) };
      },
    ).analyze(request.range, controller.signal),
  ).rejects.toBe(error);
});

test("frame scene analysis keeps requested-time coverage and compares a future frame to its past reference", async () => {
  const requests: Parameters<VisualSampler>[0][] = [];
  const sampler: VisualSampler = async (request) => {
    requests.push(request);
    return {
      sourceWidth: 64,
      sourceHeight: 64,
      samples: request.atSourceUs.map((requestedSourceUs) => {
        const actualSourceUs =
          request.kept.endUs <= 1_500_001 || requestedSourceUs <= 1_000_000 ? 0 : 2_000_000;
        return {
          ...frame(actualSourceUs, () => (actualSourceUs === 0 ? [0, 0, 0] : [255, 255, 255])),
          requestedSourceUs,
          distanceUs: Math.abs(actualSourceUs - requestedSourceUs),
        };
      }),
    };
  };
  const result = await analyzeFrameScene(
    {
      ownerId: "fixture-recording",
      source: "/fixture.mov",
      kept: { startUs: 0, endUs: 4_000_000 },
      requestedSourceUs: 1_500_000,
      trailUs: 2_000_000,
    },
    sampler,
    new AbortController().signal,
  );
  expect(result.range).toEqual({ startUs: 0, endUs: 1_500_000 });
  expect(result.lastSample.actualSourceUs).toBe(2_000_000);
  expect(result.reference.actualSourceUs).toBe(0);
  expect(result.futureComparison).toMatchObject({
    previousActualSourceUs: 0,
    actualSourceUs: 2_000_000,
    boundary: true,
  });
  expect(result.boundaries).toEqual([]);
  expect(requests.at(-1)?.kept).toEqual({ startUs: 0, endUs: 1_500_001 });
  expect(Math.max(...requests.flatMap((request) => request.atSourceUs))).toBe(1_500_000);
});

test("a request before the first retained frame after a cut uses that frame as its reference", async () => {
  // The cut left the span starting between frames: the first retained picture is at 800 ms.
  const sampler: VisualSampler = async (request) => {
    if (request.kept.endUs <= 800_000)
      throw new CatalogError("UNAVAILABLE", "No video sample inside the retained interval");
    return {
      sourceWidth: 64,
      sourceHeight: 64,
      samples: request.atSourceUs.map((requestedSourceUs) => ({
        ...frame(800_000),
        requestedSourceUs,
        distanceUs: 800_000 - requestedSourceUs,
      })),
    };
  };
  for (const requestedSourceUs of [770_000, 780_000]) {
    const result = await analyzeFrameScene(
      {
        ownerId: "fixture-recording",
        source: "/fixture.mov",
        kept: { startUs: 770_000, endUs: 4_000_000 },
        requestedSourceUs,
        trailUs: 2_000_000,
      },
      sampler,
      new AbortController().signal,
    );
    expect(result.reference.actualSourceUs).toBe(800_000);
    expect(result.futureComparison).toBeNull();
  }
});

test.each([0, 2_000_000, 10_000_000])(
  "long sparse gaps compare endpoints without advancing a %i-us trail",
  async (trailUs) => {
    const requested = 119_000_000;
    const queries: Parameters<VisualSampler>[0][] = [];
    const sampler: VisualSampler = async (query) => {
      queries.push(query);
      const actual = query.kept.endUs <= requested + 1 ? 0 : 120_000_000;
      return {
        sourceWidth: 64,
        sourceHeight: 64,
        samples: query.atSourceUs.map((at) => ({
          ...white,
          requestedSourceUs: at,
          actualSourceUs: actual,
          distanceUs: Math.abs(actual - at),
        })),
      };
    };
    const result = await analyzeFrameScene(
      {
        ownerId: "fixture-recording",
        source: "/sparse.mov",
        kept: { startUs: 0, endUs: 122_000_000 },
        requestedSourceUs: requested,
        trailUs,
      },
      sampler,
      new AbortController().signal,
    );
    expect(result.futureComparison).toMatchObject({
      previousActualSourceUs: 0,
      actualSourceUs: 120_000_000,
      boundary: false,
    });
    expect(result.range).toEqual({ startUs: requested - trailUs, endUs: requested });
    expect(result.reference.actualSourceUs).toBe(0);
    expect(queries).toHaveLength(2);
    expect(queries.flatMap((query) => query.atSourceUs).every((at) => at <= requested)).toBe(true);
    expect(queries[0]!.atSourceUs.length).toBeLessThanOrEqual(52);
    expect(queries[0]!.atSourceUs[0]).toBeGreaterThanOrEqual(requested - trailUs - 200_000);
  },
);

test("a held frame keeps requested-time coverage and needs no invented past reference", async () => {
  const result = await analyzeFrameScene(
    {
      ownerId: "fixture-recording",
      source: "/held.mov",
      kept: { startUs: 0, endUs: 4_000_000 },
      requestedSourceUs: 1_000_000,
      trailUs: 2_000_000,
    },
    async ({ atSourceUs }) => ({
      sourceWidth: 64,
      sourceHeight: 64,
      samples: atSourceUs.map((at) => ({
        ...white,
        requestedSourceUs: at,
        actualSourceUs: 0,
        distanceUs: at,
      })),
    }),
    new AbortController().signal,
  );
  expect(result.futureComparison).toBeNull();
  expect(result.range.endUs).toBe(1_000_000);
  expect(result.reference.actualSourceUs).toBe(0);
  expect(result.coverage.at(-1)?.requestedSourceUs).toBe(1_000_000);
});

test("missing future-frame reference remains an explicit failure inside the kept span", async () => {
  const refusal = new Error("No reference sample in the retained prefix");
  await expect(
    analyzeFrameScene(
      {
        ownerId: "fixture-recording",
        source: "/cut.mov",
        kept: { startUs: 1_100_000, endUs: 4_000_000 },
        requestedSourceUs: 1_500_000,
        trailUs: 2_000_000,
      },
      async ({ kept, atSourceUs }) => {
        if (kept.endUs === 1_500_001) {
          expect(kept.startUs).toBe(1_100_000);
          throw refusal;
        }
        return {
          sourceWidth: 64,
          sourceHeight: 64,
          samples: atSourceUs.map((at) => ({
            ...white,
            requestedSourceUs: at,
            actualSourceUs: 2_000_000,
            distanceUs: 2_000_000 - at,
          })),
        };
      },
      new AbortController().signal,
    ),
  ).rejects.toBe(refusal);
});

test("canonical runs preserve both sides of a chunk overlap and held source frames", async () => {
  const analysis = new SourceSceneAnalysis(
    "fixture-recording",
    "/video",
    22_000_000,
    async ({ atSourceUs }) => ({
      sourceWidth: 64,
      sourceHeight: 64,
      samples: atSourceUs.map((requestedSourceUs) => {
        const actualSourceUs = Math.floor(requestedSourceUs / 250_000) * 250_000;
        return {
          ...frame(actualSourceUs, () => [
            100 + Math.floor(actualSourceUs / 10_000_000) * 3,
            100,
            100,
          ]),
          requestedSourceUs,
          distanceUs: requestedSourceUs - actualSourceUs,
        };
      }),
    }),
  );
  const chunks = [];
  for (const [startUs, endUs] of [
    [0, 10_000_000],
    [10_000_000, 20_000_000],
    [20_000_000, 22_000_000],
  ])
    chunks.push(
      await analysis.analyze({ startUs: startUs!, endUs: endUs! }, new AbortController().signal),
    );
  expect(
    chunks
      .flatMap((chunk) => chunk.coverage)
      .filter((point) =>
        [9_800_000, 10_000_000, 19_800_000, 20_000_000].includes(point.requestedSourceUs),
      )
      .map((point) => [point.requestedSourceUs, point.actualSourceUs, point.stillnessRunStartUs]),
  ).toEqual([
    [9_800_000, 9_750_000, 0],
    [10_000_000, 10_000_000, 10_000_000],
    [9_800_000, 9_750_000, 0],
    [10_000_000, 10_000_000, 10_000_000],
    [19_800_000, 19_750_000, 10_000_000],
    [20_000_000, 20_000_000, 20_000_000],
    [19_800_000, 19_750_000, 10_000_000],
    [20_000_000, 20_000_000, 20_000_000],
  ]);
  expect(chunks.flatMap((chunk) => chunk.comparisons.filter((pair) => pair.boundary))).toEqual([]);
});
