import { expect, test } from "vitest";
import { operationSchema } from "./operations.js";
import { correspondenceMeasurementSchema, correspondenceReceiptSchema } from "./correspondence.js";

const endpoint = (assetId: string) => ({
  kind: "source" as const,
  assetId,
  streamId: "audio-1",
  channel: 0,
  sourceRange: { startUs: 0, endUs: 4_000_000 },
});
const measurement = {
  verdict: "accepted" as const,
  reason: "three unambiguous anchors",
  anchors: [
    {
      leftRange: { startUs: 0, endUs: 1_000_000 },
      rightRange: { startUs: 120_000, endUs: 1_120_000 },
      candidates: [
        {
          offsetUs: 120_000,
          residualUs: 1000,
          coverage: 1,
          driftPpm: 0,
          score: 0.9,
          selected: true,
        },
      ],
      selected: 0,
    },
  ],
  candidates: [
    { offsetUs: 120_000, residualUs: 1000, coverage: 1, driftPpm: 0, score: 0.9, selected: true },
  ],
  offsetUs: 120_000,
  residualUs: 1000,
  coverage: 1,
  driftPpm: 0,
  policy: {
    minimumCoverage: 0.8,
    maximumResidualUs: 10_000,
    maximumDriftPpm: 20,
    minimumAnchors: 1,
  },
};

test("correspondence operations admit source endpoints and strict evidence", () => {
  const parsed = operationSchema.parse({
    operation: "correspondence.prepare",
    params: {
      evidenceId: "e1",
      generation: "g1",
      left: endpoint("a"),
      right: endpoint("b"),
      measurement,
    },
  });
  expect(parsed.operation).toBe("correspondence.prepare");
  expect(correspondenceMeasurementSchema.safeParse(measurement).success).toBe(true);
  expect(
    operationSchema.safeParse({
      operation: "correspondence.get",
      params: { evidenceId: "e1", generation: "g1", extra: true },
    }).success,
  ).toBe(false);
});

test("accepted evidence requires a complete mapping and selected anchors", () => {
  expect(
    correspondenceMeasurementSchema.safeParse({ ...measurement, offsetUs: null }).success,
  ).toBe(false);
  expect(
    correspondenceReceiptSchema.safeParse({
      evidenceId: "e1",
      generation: "g1",
      recipe: "temporal-correspondence-v1",
      left: endpoint("a"),
      right: endpoint("b"),
      measurement,
      fingerprint: "0".repeat(64),
    }).success,
  ).toBe(true);
});
