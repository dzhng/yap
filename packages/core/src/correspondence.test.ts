import { expect, test } from "vitest";
import { admitCorrespondence, verifyCorrespondenceReceipt } from "./correspondence.js";
import { CatalogError } from "./catalog.js";

const endpoint = (assetId: string) => ({
  kind: "source" as const,
  assetId,
  streamId: "audio-1",
  channel: 0,
  sourceRange: { startUs: 0, endUs: 4_000_000 },
});
const measurement = {
  verdict: "accepted" as const,
  reason: "known delay control",
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

test("admission fingerprints the full source-bound receipt", () => {
  const receipt = admitCorrespondence({
    evidenceId: "e1",
    generation: "g1",
    left: endpoint("a"),
    right: endpoint("b"),
    measurement,
  });
  expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(verifyCorrespondenceReceipt(receipt)).toEqual(receipt);
  expect(() =>
    verifyCorrespondenceReceipt({ ...receipt, measurement: { ...measurement, coverage: 0.81 } }),
  ).toThrow(CatalogError);
});

test("accepted mapping rejects an unselected anchor or duplicate endpoint", () => {
  const firstAnchor = measurement.anchors[0]!;
  expect(() =>
    admitCorrespondence({
      evidenceId: "e1",
      generation: "g1",
      left: endpoint("a"),
      right: endpoint("a"),
      measurement,
    }),
  ).toThrow("distinct");
  expect(() =>
    admitCorrespondence({
      evidenceId: "e1",
      generation: "g1",
      left: endpoint("a"),
      right: endpoint("b"),
      measurement: { ...measurement, anchors: [{ ...firstAnchor, selected: null }] },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_INPUT_EVIDENCE", retryable: false }));
});
