import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deliveredScenes, associateDeliveredScenes } from "./delivered-scenes.mjs";

describe("deliveredScenes request validation", () => {
  test("rejects a missing request with INVALID_REQUEST before creating a CLI", async () => {
    await expect(deliveredScenes()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("associateDeliveredScenes", () => {
  test("keeps observed transitions separate and matches only nearby authored video joins", () => {
    const report = associateDeliveredScenes({
      deliveredRows: [
        { kind: "scene", sourceAtUs: 0 },
        { kind: "scene", sourceAtUs: 1_000_000 },
        { kind: "scene", sourceAtUs: 1_500_000 },
      ],
      authoredRows: [
        { kind: "cut", mediaKind: "video", projectAtUs: 1_000_000, trackId: "screen" },
        { kind: "cut", mediaKind: "audio", projectAtUs: 1_500_000, trackId: "voice" },
      ],
      projectStartUs: 0,
      deliveredStartUs: 0,
      joinToleranceUs: 1,
    });

    expect(report).toEqual({
      observedTransitions: [
        { deliveredAtUs: 0, projectAtUs: 0, authoredJoins: [] },
        {
          deliveredAtUs: 1_000_000,
          projectAtUs: 1_000_000,
          authoredJoins: [
            { kind: "cut", mediaKind: "video", projectAtUs: 1_000_000, trackId: "screen" },
          ],
        },
        { deliveredAtUs: 1_500_000, projectAtUs: 1_500_000, authoredJoins: [] },
      ],
      unmatchedAuthoredJoins: [],
    });
  });

  test("reports authored joins with no delivered transition and preserves rational project clocks", () => {
    const report = associateDeliveredScenes({
      deliveredRows: [{ kind: "scene", sourceAtUs: 250_000 }],
      authoredRows: [
        {
          kind: "cut",
          mediaKind: "video",
          projectAtUs: { numerator: 3, denominator: 2 },
          trackId: "screen",
        },
        { kind: "cut", mediaKind: "video", projectAtUs: 3_000_000, trackId: "other" },
      ],
      projectStartUs: 1_000_000,
      deliveredStartUs: 0,
      joinToleranceUs: 10,
    });

    expect(report.observedTransitions[0]).toMatchObject({
      deliveredAtUs: 250_000,
      projectAtUs: 1_250_000,
    });
    expect(report.unmatchedAuthoredJoins).toEqual([
      {
        kind: "cut",
        mediaKind: "video",
        projectAtUs: { numerator: 3, denominator: 2 },
        trackId: "screen",
      },
      { kind: "cut", mediaKind: "video", projectAtUs: 3_000_000, trackId: "other" },
    ]);
  });

  test("pins the committed export bytes, imports them, and reads source scenes separately from authored cuts", async () => {
    const home = await mkdtemp("delivered-scenes-");
    try {
      const output = join(home, "export.mp4");
      await writeFile(output, Buffer.from("immutable export bytes"));
      const calls = [];
      const readPaths = [];
      const invoke = async (operation, params) => {
        calls.push([operation, params]);
        if (operation === "export.status")
          return {
            state: "committed",
            output,
            projectId: "project",
            snapshot: { revisionId: "revision" },
          };
        if (operation === "asset.import") return { jobId: "import-job" };
        if (operation === "job.get")
          return { state: "ready", published: { output: { assetId: "export-asset" } } };
        if (operation === "asset.get") return { streams: [{ id: "video", kind: "video" }] };
        if (operation === "revision.get") return { revision: { id: "revision" } };
        if (operation === "timeline.events" && params.assetId)
          return {
            state: "ready",
            coverage: { scenes: { state: "ready" } },
            rows: [{ kind: "scene", sourceAtUs: 1_000_000 }], nextCursor: null,
          };
        if (operation === "timeline.events")
          return {
            state: "ready",
            coverage: { cuts: { state: "ready" } },
            rows: [
              { kind: "cut", mediaKind: "video", projectAtUs: 1_000_000, trackId: "screen" },
            ],
            nextCursor: null,
          };
        throw new Error(`unexpected ${operation}`);
      };

      const report = await deliveredScenes(
        {
          projectId: "project",
          revisionId: "revision",
          exportId: "export",
          projectRange: { startUs: 0, endUs: 2_000_000 },
          deliveredRange: { startUs: 0, endUs: 2_000_000 },
          polls: 0,
        },
        invoke,
        {
          readFile: async (path) => {
            readPaths.push(path);
            return Buffer.from("immutable export bytes");
          },
        },
      );

      expect(report.export.file.sha256).toHaveLength(64);
      expect(readPaths).toEqual([output]);
      expect(report.export.immutable).toBe(true);
      expect(report.delivered.assetId).toBe("export-asset");
      expect(report.association.observedTransitions[0].authoredJoins).toHaveLength(1);
      expect(report.association.unmatchedAuthoredJoins).toEqual([]);
      expect(calls.map(([operation]) => operation)).toEqual([
        "export.status",
        "asset.import",
        "job.get",
        "asset.get",
        "timeline.events",
        "revision.get",
        "timeline.events",
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
