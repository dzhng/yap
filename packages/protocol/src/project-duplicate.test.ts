import { expect, test } from "vitest";
import { operationSchema } from "./operations.js";

test("project.duplicate accepts request identity, source revision and optional title", () => {
  expect(
    operationSchema.parse({
      operation: "project.duplicate",
      params: {
        requestId: "duplicate",
        projectId: "source",
        revisionId: "revision",
        title: "Copy",
      },
    }),
  ).toEqual({
    operation: "project.duplicate",
    params: {
      requestId: "duplicate",
      projectId: "source",
      revisionId: "revision",
      title: "Copy",
    },
  });
});
