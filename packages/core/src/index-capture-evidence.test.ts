import { expect, test } from "vitest";
import { indexCaptureEvidence } from "./index-capture-evidence.js";

test("index capture evidence asks the capture reader for the source selection alone", () => {
  const asked: unknown[] = [];
  const owners = {
    acquisitions: {
      get: () =>
        ({
          evidence: { ownerKind: "acquisition", ownerId: "a", sourceId: "s", generation: "g" },
          bindings: [{ streamId: "video", sourceToAssetOffsetUs: 1_000 }],
        }) as never,
    },
    evidence: { page: () => ({ samples: [], nextSequence: null }) } as never,
    capture: {
      marks: (selection: unknown) => {
        asked.push(selection);
        return [{ sourceUs: 5_000, kind: "pin", id: "pin-1" }] as never;
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
  const { moments } = indexCaptureEvidence(identity, owners);
  expect(asked).toEqual([{ assetId: "asset", streamId: "video", acquisitionId: "a" }]);
  expect(moments).toEqual([{ sourceUs: 6_000, kind: "pin", markId: "pin-1" }]);
});
