import { afterEach, expect, test } from "vitest";
import { projectEvidenceFixture } from "./project-evidence.fixture.js";

// The marks a person made during a take, as agents read them through timeline events and the
// capture reader.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = () => projectEvidenceFixture(cleanup);

test("timeline events expose marks with projected points and stable paging", async () => {
  const f = await fixture();
  const captured = await f.capture([
    {
      event: "geometry",
      data: {
        epoch: 1,
        hostUs: 1,
        sourceUs: 500,
        geometry: {
          outputWidth: 200,
          outputHeight: 100,
          contentScale: 2,
          scaleFactor: 1,
          contentRect: { x: 10, y: 20, width: 100, height: 50 },
          screenRect: { x: 100, y: 200, width: 50, height: 25 },
        },
      },
    },
    {
      event: "mark",
      data: {
        hostUs: 2,
        sourceUs: 600,
        epoch: 1,
        id: "stroke-1",
        kind: "stroke",
        points: [
          { hostUs: 2, globalX: 101, globalY: 202, x: 16, y: 28 },
          { hostUs: 3, globalX: 102, globalY: 203, x: 18, y: 30 },
        ],
      },
    },
    {
      event: "mark",
      data: {
        hostUs: 4,
        sourceUs: 700,
        epoch: 1,
        id: "pin-1",
        kind: "pin",
        pin: 1,
        points: [{ hostUs: 4, globalX: 103, globalY: 204, x: 16, y: 28 }],
      },
    },
    {
      event: "mark",
      data: {
        hostUs: 5,
        sourceUs: 800,
        epoch: 1,
        id: "undo-1",
        kind: "stroke",
        points: [],
        retracts: "stroke-1",
      },
    },
  ]);
  const selection = { assetId: f.asset.id, streamId: "video", acquisitionId: captured.id };
  const first = f.sourceEvents.events({ ...selection, limit: 1 });
  expect(first.page!.rows).toHaveLength(1);
  expect(first.page!.nextCursor).toBeTruthy();
  const rows = [...first.page!.rows];
  let cursor = first.page!.nextCursor;
  while (cursor) {
    const page = f.sourceEvents.events({ ...selection, limit: 1, cursor });
    rows.push(...page.page!.rows);
    cursor = page.page!.nextCursor;
  }
  const marks = rows.filter((row) => row.kind === "mark");
  expect(marks).toHaveLength(2);
  expect(marks[1]).toMatchObject({
    captureAtUs: 700,
    observation: { id: "pin-1", points: [{ hostUs: 4, x: 16, y: 28 }] },
  });
  const direct = f.captureRead.marks(selection);
  expect(direct).toHaveLength(2);
  // The mark reader answers in asset time, the clock its event row already reports.
  expect(direct[1]).toEqual(
    expect.objectContaining({
      assetUs: marks[1]!.sourceAtUs,
      id: "pin-1",
      points: [expect.objectContaining({ x: 16, y: 28 })],
    }),
  );
  expect(direct[1]).not.toHaveProperty("sourceUs");
  expect(marks[1]!.sourceAtUs).not.toBe(700);
  expect(f.sourceEvents.events({ assetId: f.asset.id, streamId: "video" })).toMatchObject({
    state: "unavailable",
    page: null,
  });
});
