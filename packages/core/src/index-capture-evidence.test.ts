import { expect, test } from "vitest";
import { indexCaptureEvidence } from "./index-capture-evidence.js";

test("index capture evidence asks the capture reader for the source selection alone, in asset time", () => {
  const asked: unknown[] = [];
  const owners = {
    evidence: {
      page: () => ({ samples: [{ sourceUs: 5_000, x: 1, y: 2 }], nextSequence: null }),
    } as never,
    capture: {
      // The reader owns the capture-to-asset clock: marks arrive in asset time, and the
      // pointer path is shifted by the same offset the reader resolved.
      resolve: (selection: unknown) => {
        asked.push(selection);
        return {
          sourceToAssetOffsetUs: 1_000,
          evidence: { ownerKind: "acquisition", ownerId: "a", sourceId: "s", generation: "g" },
        } as never;
      },
      marks: (selection: unknown) => {
        asked.push(selection);
        return [{ assetUs: 6_000, kind: "pin", id: "pin-1" }] as never;
      },
    },
  };
  // An index identity carries scenes, policy and size; the strict selection parser refuses them.
  const identity = {
    assetId: "asset",
    streamId: "video",
    acquisitionId: "a",
    scenes: "scenes-1",
    selectionPolicy: "policy",
    implementationId: "impl",
    maxLongEdge: 640,
    generation: "1",
  };
  const { moments, pointerSamples } = indexCaptureEvidence(identity, owners);
  const selection = { assetId: "asset", streamId: "video", acquisitionId: "a" };
  expect(asked).toEqual([selection, selection]);
  expect(moments).toEqual([{ sourceUs: 6_000, kind: "pin", markId: "pin-1" }]);
  expect(pointerSamples).toEqual([{ sourceUs: 6_000, x: 1, y: 2 }]);
});
