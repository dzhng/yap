import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PresentationEvidence } from "./presentation-evidence.js";
import { observeVisualSamples } from "./scenes.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
const time = (value: number, timescale = 1_000_000) => ({ value: String(value), timescale });
const frame = (start: number, end: number, pts: number, shade: number, spanIndex = 0) => ({
  spanIndex,
  start: time(start),
  end: time(end),
  empty: false,
  sampleTime: time(pts),
  actualSourceUs: pts,
  width: 8,
  height: 8,
  rgbBase64: Buffer.alloc(8 * 8 * 3, shade).toString("base64"),
});
const revision = { spans: [{ startUs: 750_000, endUs: 1_250_000 }], durationUs: 500000 };
async function fixture(
  records: unknown[] = [
    frame(750_000, 1_000_000, 0, 0),
    frame(1_000_000, 1_250_000, 1_000_000, 255),
  ],
  pinned = revision,
) {
  const root = await mkdtemp(join(tmpdir(), "presentation-reader-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "support.jsonl");
  const body = [
    {
      version: 1,
      sourceWidth: 8,
      sourceHeight: 8,
      durationUs: pinned.durationUs,
      spanCount: pinned.spans.length,
    },
    ...records,
  ]
    .map((r) => JSON.stringify(r) + "\n")
    .join("");
  await writeFile(file, body);
  const receipt = {
    file,
    version: 1 as const,
    sourceWidth: 8,
    sourceHeight: 8,
    durationUs: pinned.durationUs,
    records: records.length,
    bytes: Buffer.byteLength(body),
  };
  return { file, receipt, body };
}
test("exact support accepts held PTS before a cut while still membership stays strict", async () => {
  const f = await fixture();
  const source = await PresentationEvidence.open(f.receipt, revision.spans, signal());
  cleanups.push(() => source.close());
  const cursor = source.cursor(signal());
  const { record: held } = await cursor.at(0, 750_000);
  expect(held.empty).toBe(false);
  if (held.empty) throw new Error("Expected held picture");
  expect(held.actualSourceUs).toBe(0);
  expect((await cursor.at(0, 1_000_000)).record.actualSourceUs).toBe(1_000_000);
  await expect(cursor.at(0, 1_250_000)).rejects.toMatchObject({ code: "INVALID_RANGE" });
  await expect(
    observeVisualSamples(
      {
        ownerId: "fixture",
        source: "/video.mov",
        kept: revision.spans[0]!,
        atSourceUs: [750_000],
      },
      async () => ({
        sourceWidth: 8,
        sourceHeight: 8,
        samples: [
          {
            requestedSourceUs: 750_000,
            actualSourceUs: 0,
            distanceUs: 750_000,
            width: 8,
            height: 8,
            rgbBase64: held.rgbBase64,
          },
        ],
      }),
      signal(),
    ),
  ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
});

test("fractional boundaries use exact integer arithmetic, including clock values beyond Number precision", async () => {
  for (const boundary of [
    { value: "1", timescale: 3 },
    { value: "9007199254740993", timescale: 1000000000 },
  ]) {
    const below = Number((BigInt(boundary.value) * 1000000n) / BigInt(boundary.timescale));
    const actual = Number(
      (BigInt(boundary.value) * 2000000n + BigInt(boundary.timescale)) /
        (2n * BigInt(boundary.timescale)),
    );
    const pinned = { spans: [{ startUs: 0, endUs: below + 2 }], durationUs: below + 2 };
    const f = await fixture(
      [
        { ...frame(0, 1, 0, 0), end: boundary },
        { ...frame(1, below + 2, actual, 255), start: boundary, sampleTime: boundary },
      ],
      pinned,
    );
    const source = await PresentationEvidence.open(f.receipt, pinned.spans, signal());
    cleanups.push(() => source.close());
    const cursor = source.cursor(signal());
    expect((await cursor.at(0, below)).record.actualSourceUs).toBe(0);
    expect((await cursor.at(0, below + 1)).record.actualSourceUs).toBe(actual);
  }
});

test("independent cursors progress monotonically and honor close, cancellation and mutation", async () => {
  const f = await fixture();
  const source = await PresentationEvidence.open(f.receipt, revision.spans, signal());
  cleanups.push(() => source.close());
  const lifetime = new AbortController(),
    current = source.cursor(lifetime.signal),
    prior = source.cursor(signal());
  expect((await current.at(0, 1_100_000)).record.actualSourceUs).toBe(1_000_000);
  expect((await prior.at(0, 800_000)).record.actualSourceUs).toBe(0);
  await expect(current.at(0, 800_000)).rejects.toMatchObject({ code: "INVALID_RANGE" });
  lifetime.abort();
  await expect(current.at(0, 1_200_000)).rejects.toMatchObject({ name: "AbortError" });
  await writeFile(f.file, f.body.replace('"actualSourceUs":0', '"actualSourceUs":1'));
  await expect(prior.at(0, 900_000)).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  await source.close();
  await expect(prior.at(0, 900_000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

test("admission rejects gaps, overlaps, false pictures and missing tail coverage", async () => {
  for (const records of [
    [frame(750_001, 1_250_000, 0, 0)],
    [frame(750_000, 1_000_001, 0, 0), frame(1_000_000, 1_250_000, 1_000_000, 255)],
    [frame(750_000, 1_000_000, 0, 0)],
    [frame(750_000, 1_250_000, 1_000_000, 0)],
    [{ ...frame(750_000, 1_250_000, 0, 0), rgbBase64: "bad" }],
  ]) {
    const f = await fixture(records);
    await expect(
      PresentationEvidence.open(f.receipt, revision.spans, signal()),
    ).rejects.toMatchObject({
      code: "INVALID_EVIDENCE",
    });
  }
  const f = await fixture();
  for (const body of [f.body.slice(0, -1), " ".repeat(65_536) + "\n"]) {
    await writeFile(f.file, body);
    await expect(
      PresentationEvidence.open(
        { ...f.receipt, bytes: Buffer.byteLength(body) },
        revision.spans,
        signal(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  }
});

test("retained spans skip deleted time while proving complete explicit empty support", async () => {
  const pinned = {
    spans: [
      { startUs: 0, endUs: 100_000 },
      { startUs: 2_000_000, endUs: 3_000_000 },
    ],
    durationUs: 1100000,
  };
  const f = await fixture(
    [
      frame(0, 100_000, 0, 0),
      { spanIndex: 1, start: time(2_000_000), end: time(3_000_000), empty: true },
    ],
    pinned,
  );
  const source = await PresentationEvidence.open(f.receipt, pinned.spans, signal());
  cleanups.push(() => source.close());
  const cursor = source.cursor(signal());
  await expect(cursor.at(0, 100_000)).rejects.toMatchObject({ code: "INVALID_RANGE" });
  expect(await cursor.at(1, 2_000_000)).toMatchObject({
    record: { empty: true, actualSourceUs: null },
  });
  await expect(cursor.at(0, 0)).rejects.toMatchObject({ code: "INVALID_RANGE" });
});

test("history cursor preserves exact physical-empty reset boundaries even when queries skip gaps", async () => {
  const pinned = { spans: [{ startUs: 0, endUs: 2_000_000 }], durationUs: 2_000_000 };
  const rows = [
    frame(0, 400_000, 0, 0),
    {
      spanIndex: 0,
      start: time(400_000),
      end: { value: "1200001", timescale: 3_000_000 },
      empty: true,
    },
    {
      ...frame(400_001, 2_000_000, 400_001, 255),
      start: { value: "1200001", timescale: 3_000_000 },
      sampleTime: { value: "1200001", timescale: 3_000_000 },
      actualSourceUs: 400_000,
    },
  ];
  const f = await fixture(rows, pinned);
  const source = await PresentationEvidence.open(f.receipt, pinned.spans, signal());
  cleanups.push(() => source.close());
  const direct = await source.cursor(signal()).at(0, 1_500_000);
  expect(direct.emptyThrough).toEqual({ value: "1200001", timescale: 3_000_000 });
  expect(direct.record).toMatchObject({ empty: false, actualSourceUs: 400_000 });
  const cursor = source.cursor(signal());
  expect(await cursor.at(0, 400_000)).toMatchObject({
    record: { empty: true },
    emptyThrough: null,
  });
  expect((await cursor.at(0, 400_001)).emptyThrough).toEqual(direct.emptyThrough);
  // Opening the whole source history, rather than a trimmed edit, retains that same reset context.
  expect((await source.cursor(signal()).at(0, 1_900_000)).emptyThrough).toEqual(
    direct.emptyThrough,
  );
});

test("presentation admission honors cancellation before accepting history", async () => {
  const f = await fixture();
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    PresentationEvidence.open(f.receipt, revision.spans, aborted.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("borrowed presentation descriptor keeps exact validation without reopening its receipt path", async () => {
  const f = await fixture();
  const descriptor = await open(f.receipt.file, "r");
  try {
    const source = await PresentationEvidence.fromDescriptor(
      { ...f.receipt, file: "/missing/receipt-path" },
      revision.spans,
      descriptor.fd,
      signal(),
    );
    expect((await source.cursor(signal()).at(0, 800_000)).record).toMatchObject({ empty: false });
    await source.close();
    expect((await descriptor.stat()).size).toBe(f.receipt.bytes);
    await expect(source.cursor(signal()).at(0, 800_000)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  } finally {
    await descriptor.close();
  }
});
