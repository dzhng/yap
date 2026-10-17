import { describe, expect, it } from "vitest";
import { filteredPage, pageCursor } from "./page-cursor.js";
import { expectPageTraversal } from "./page-traversal.fixture.js";

describe("pageCursor", () => {
  it("round trips a scoped position as opaque base64url", () => {
    const filters = { owner: "library" };
    const cursor = pageCursor.encode("asset.list", { sequence: 7 }, filters);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pageCursor.decode("asset.list", cursor, filters)).toEqual({ sequence: 7 });
  });

  it("rejects tampering and scope mismatches as INVALID_PARAMS", () => {
    const cursor = pageCursor.encode("asset.list", { sequence: 7 }, {});
    expect(() => pageCursor.decode("asset.list", `${cursor.slice(0, -1)}A`, {})).toThrow(
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
    expect(() => pageCursor.decode("project.list", cursor, {})).toThrow(
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
  });

  it("binds the filter set: another set is INVALID_PARAMS, key order and absent fields are not", () => {
    const filters = { projectId: "p", unfinishedOnly: true, range: { startUs: 0, endUs: 9 } };
    const cursor = pageCursor.encode("export.list", { rowid: 3 }, filters);
    expect(
      pageCursor.decode("export.list", cursor, {
        range: { endUs: 9, startUs: 0 },
        unfinishedOnly: true,
        projectId: "p",
        acquisitionId: undefined,
      }),
    ).toEqual({ rowid: 3 });
    for (const other of [
      { ...filters, projectId: "q" },
      { ...filters, range: { startUs: 0, endUs: 10 } },
      { projectId: "p", unfinishedOnly: true },
      { ...filters, text: "extra" },
    ])
      expect(() => pageCursor.decode("export.list", cursor, other)).toThrow(
        expect.objectContaining({ code: "INVALID_PARAMS" }),
      );
  });
});

describe("filteredPage", () => {
  // Two underlying pages; the reader keeps only the odd rows, as disfluency keeps fillers.
  const source = [
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9],
  ];
  const reads: unknown[] = [];
  const read = (position: unknown) => {
    reads.push(position);
    const index = position === undefined ? 0 : (position as number);
    return { rows: source[index]!, nextCursor: index + 1 < source.length ? index + 1 : null };
  };
  const keep = (row: number) => row % 2 === 1;
  const filters = { assetId: "a", range: { startUs: 0, endUs: 10 } };
  const page = (
    limit: number,
    cursor?: string,
    changed: Partial<typeof filters> = {},
    pin = "g1",
  ) =>
    filteredPage("transcript.disfluency.get", {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      filters: { ...filters, ...changed },
    }).read(pin, read, keep);

  it("follows kept rows across underlying pages without duplicates or skips", () => {
    // The whole first underlying page is kept rows 1, 3, 5; a limit-1000 read stops at its end.
    expect(page(1000)).toEqual({ rows: [1, 3, 5], nextCursor: expect.any(String) });
    const rows: number[] = [];
    let cursor: string | undefined;
    do {
      const next = page(2, cursor);
      expect(next.rows.length).toBeLessThanOrEqual(2);
      rows.push(...next.rows);
      cursor = next.nextCursor ?? undefined;
    } while (cursor);
    expect(rows).toEqual([1, 3, 5, 7, 9]);
  });

  it("conforms to the paging contract over one underlying page", () => {
    const single = (limit: number, cursor?: string) =>
      filteredPage("audio.pause.get", {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        filters,
      }).read("g1", () => ({ rows: ["a", "b", "c", "d"], nextCursor: null }));
    const { firstCursor } = expectPageTraversal<string>((limit, cursor) => {
      const next = single(limit, cursor);
      return { items: next.rows, nextCursor: next.nextCursor };
    });
    expect(() => single(1, "garbage")).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    expect(() => page(1, firstCursor)).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  });

  it("refuses other filters as INVALID_PARAMS before reading and a changed pin as ARTIFACT_CHANGED", () => {
    const first = page(1);
    reads.length = 0;
    for (const changed of [{ assetId: "b" }, { range: { startUs: 0, endUs: 11 } }])
      expect(() =>
        filteredPage("transcript.disfluency.get", {
          limit: 1,
          cursor: first.nextCursor!,
          filters: { ...filters, ...changed },
        }),
      ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
    expect(reads).toEqual([]);
    // Key order is not a filter difference.
    expect(
      filteredPage("transcript.disfluency.get", {
        limit: 1,
        cursor: first.nextCursor!,
        filters: { range: filters.range, assetId: filters.assetId },
      }).read("g1", read, keep).rows,
    ).toEqual([3]);
    expect(() => page(1, first.nextCursor!, {}, "g2")).toThrow(
      expect.objectContaining({ code: "ARTIFACT_CHANGED" }),
    );
    for (const position of [
      { pin: "g1", source: null, skip: -1 },
      { pin: "g1", source: null, skip: 1.5 },
      { pin: "g1", source: null, skip: 4 },
      { pin: "g1", source: null },
    ])
      expect(() =>
        page(1, pageCursor.encode("transcript.disfluency.get", position, filters)),
      ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  });
});
