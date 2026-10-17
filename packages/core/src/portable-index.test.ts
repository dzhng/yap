import { omit } from "@yap/composition";
import { beforeEach, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { RetainedIndexRead } from "./index-read.js";
import type { PortableIndexRecord } from "./screenshot-index.js";
import { sourceIndexDomain, type SourceIndexRecords } from "./source-index.js";
import { selectSource } from "./source-selection.js";
import { fixture, add, cover, png } from "./retained-source-index.fixture.js";

let donor: Awaited<ReturnType<typeof fixture>>;
let receiver: Awaited<ReturnType<typeof fixture>>;
let metadata: Awaited<ReturnType<typeof donor.index.finish>>;
// Author the unchanged fixture under its own default hook deadline; this case owns relocation.
beforeEach(async () => {
  const count = 260,
    durationUs = count * 2_000_000;
  donor = await fixture(durationUs);
  receiver = await fixture(durationUs);
  donor.index.begin(donor.identity);
  for (let ordinal = 0; ordinal < count; ordinal++) {
    add(donor, ordinal, ordinal * 2_000_000);
    cover(donor, ordinal, ordinal * 2_000_000, ordinal * 2_000_000 + 1_000_000);
    cover(donor, ordinal, ordinal * 2_000_000 + 1_000_000, (ordinal + 1) * 2_000_000, "unproven");
  }
  metadata = await donor.index.finish(donor.identity);
});

test(
  "portable source images and filtered coverage survive library removal and relocation",
  { timeout: 15_000 },
  async () => {
    const first = donor.index.page({ identity: metadata, limit: 200 });
    const next = donor.index.page({
      identity: metadata,
      afterOrdinal: first.nextOrdinal!,
      limit: 200,
    });
    const expectedCoverage = Array.from({ length: 520 }, (_, sequence) => ({
      sequence,
      ordinal: Math.floor(sequence / 2),
      state: "available" as const,
      source: { startUs: sequence * 1_000_000, endUs: (sequence + 1) * 1_000_000 },
      equality: sequence % 2 ? ("unproven" as const) : ("sampled" as const),
    }));
    const entries = [...first.entries, ...next.entries];
    async function* records(): AsyncGenerator<PortableIndexRecord<SourceIndexRecords>> {
      for (const entry of entries)
        yield {
          kind: "entry",
          candidate: entry.candidate,
          frame: { ...entry.frame, file: `${entry.candidate.ordinal}.png` },
          source: donor.index.portableImage(metadata, entry.candidate.ordinal),
          sha256: createHash("sha256").update(png).digest("hex"),
        };
      for (const coverage of expectedCoverage)
        yield { kind: "coverage", coverage: omit(coverage, "sequence") };
    }
    const staged = await receiver.index.stagePortable(
      metadata,
      records(),
      new AbortController().signal,
      sourceIndexDomain(
        (s) => selectSource(receiver.assets, receiver.acquisitions, s),
        receiver.scenes,
        null,
      ),
    );
    receiver.catalog.transaction(() => staged.publish());
    await staged.close();
    donor.catalog.close();
    rmSync(donor.home, { recursive: true });
    receiver.catalog.close();
    const reopened = new (await import("./catalog.js")).Catalog(receiver.path);
    const index = receiver.reopenedIndex(reopened);
    const movedFirst = index.page({ identity: metadata, limit: 200 });
    const movedNext = index.page({
      identity: metadata,
      afterOrdinal: movedFirst.nextOrdinal!,
      limit: 200,
    });
    const withoutPaths = (values: typeof entries) =>
      values.map((entry) => {
        const frame: Partial<typeof entry.frame> = { ...entry.frame };
        delete frame.file;
        return { ...entry, frame };
      });
    expect(withoutPaths(movedFirst.entries)).toEqual(withoutPaths(first.entries));
    expect(withoutPaths(movedNext.entries)).toEqual(withoutPaths(next.entries));
    const allCoverage: ReturnType<typeof index.coveragePage>["coverage"] = [];
    let page = index.coveragePage({ identity: metadata, limit: 200 });
    for (;;) {
      allCoverage.push(...page.coverage);
      if (page.nextSequence === null) break;
      page = index.coveragePage({
        identity: metadata,
        afterSequence: page.nextSequence,
        limit: 200,
      });
    }
    expect(allCoverage).toEqual(expectedCoverage);
    for (const { frame } of [...movedFirst.entries, ...movedNext.entries]) {
      expect(frame.file.startsWith(receiver.home)).toBe(true);
      expect(readFileSync(frame.file)).toEqual(png);
    }
    expect(
      index.coveragePage({ identity: metadata, afterSequence: 254, limit: 200 }).coverage,
    ).toEqual(expectedCoverage.slice(255, 455));
    const filtered = index.coveragePage({ identity: metadata, candidateOrdinal: 259, limit: 1 });
    expect(filtered.coverage).toEqual([expectedCoverage[518]]);
    expect(
      index.coveragePage({
        identity: metadata,
        candidateOrdinal: 259,
        afterSequence: filtered.nextSequence!,
        limit: 1,
      }).coverage,
    ).toEqual([expectedCoverage[519]]);
    expect(() =>
      index.coveragePage({ identity: metadata, candidateOrdinal: 259, afterSequence: 0 }),
    ).toThrow("outside");
    expect(() => index.page({ identity: metadata, afterOrdinal: 999 })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() => index.page({ identity: { ...metadata, generation: "wrong" } })).toThrow(
      "identity",
    );
    const reference = {
      assetId: metadata.assetId,
      streamId: metadata.streamId,
      generation: metadata.generation,
    };
    const reader = new RetainedIndexRead(index, metadata, reference);
    const firstRead = reader.get({ limit: 1 });
    expect(firstRead.page.entries[0]!.reference).toEqual({ ...reference, ordinal: 0 });
    expect(firstRead.page.nextCursor).toEqual({ ...reference, afterOrdinal: 0 });
    expect(
      reader.get({ cursor: firstRead.page.nextCursor!, limit: 1 }).page.entries[0]!.candidate
        .ordinal,
    ).toBe(1);
    expect(() =>
      reader.get({ cursor: { ...firstRead.page.nextCursor!, streamId: "other" } }),
    ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    const coverage = reader.coverage({ candidateOrdinal: 1, limit: 1 });
    expect(coverage.nextCursor).toEqual({ ...reference, candidateOrdinal: 1, afterSequence: 2 });
    expect(
      reader.coverage({ candidateOrdinal: 1, cursor: coverage.nextCursor!, limit: 1 }).coverage[0],
    ).toMatchObject({ state: "available", equality: "unproven" });
    expect(() => reader.coverage({ candidateOrdinal: 0, cursor: coverage.nextCursor! })).toThrow(
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
    expect(() =>
      reader.coverage({
        candidateOrdinal: 1,
        cursor: { ...coverage.nextCursor!, streamId: "other" },
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    expect(reader.frame(1)).toMatchObject({
      ...reference,
      ordinal: 1,
      state: "ready",
      candidate: { ordinal: 1 },
      coverageCount: 2,
    });
    for (const absent of [260, 300]) {
      expect(() => reader.frame(absent)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(() => reader.openRead(absent)).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(() => reader.coverage({ candidateOrdinal: absent })).toThrow(
        expect.objectContaining({ code: "NOT_FOUND" }),
      );
    }
    expect(() => reader.frame(-1)).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    expect(() => reader.openRead(-1)).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    for (const wrong of [
      { ...reference, generation: "wrong" },
      { ...reference, streamId: "wrong" },
    ])
      expect(() => new RetainedIndexRead(index, metadata, wrong)).toThrow(
        expect.objectContaining({ code: "ARTIFACT_CHANGED" }),
      );
    Reflect.set(metadata.scenes, "generation", "changed after controller admission");
    expect(reader.get({ limit: 1 }).page.metadata.scenes.generation).toBe(
      donor.identity.scenes.generation,
    );
    const image = reader.openRead(259),
      bytes = Buffer.alloc(image.bytes);
    expect(image.read(bytes, 0)).toBe(png.length);
    expect(bytes).toEqual(png);
    image.release();
    expect(() => image.read(bytes, 0)).toThrow("released");
  },
);
