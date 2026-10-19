import { expect, test } from "vitest";
import { inUseDetailsSchema } from "./in-use.js";

test("inUseDetailsSchema admits the shared refusal details", () => {
  expect(
    inUseDetailsSchema.parse({
      assetId: "asset-1",
      usedBy: [{ kind: "project", id: "project-1", title: "Demo", revisions: 2 }],
      acquisitions: [{ kind: "acquisition", id: "acquisition-1" }],
      derivedAssets: [{ kind: "asset", id: "derived-1" }],
      freesBytes: 10,
      cascadeFreesBytes: 20,
    }),
  ).toMatchObject({ assetId: "asset-1", freesBytes: 10 });
});
