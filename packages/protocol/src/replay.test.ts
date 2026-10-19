import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  idempotentOperations,
  operationNames,
  operationSchema,
  readOnlyOperations,
} from "./operations.js";

type JsonSchema = {
  properties?: Record<string, unknown>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;

/** Branches a params schema can take; each must carry its own request identity. */
const branches = (schema: JsonSchema): JsonSchema[] =>
  schema.anyOf ?? schema.oneOf ?? (schema.allOf ? schema.allOf.flatMap(branches) : [schema]);

function requestViolations(
  operations: readonly { name: string; params: z.ZodType }[],
  readOnly: ReadonlySet<string>,
  idempotent: ReadonlySet<string>,
): string[] {
  return operations.flatMap(({ name, params }) => {
    const carries = branches(json(params)).map((form) =>
      Object.hasOwn(form.properties ?? {}, "requestId"),
    );
    if (readOnly.has(name) && idempotent.has(name)) return [`${name}: classified twice`];
    if (readOnly.has(name) || idempotent.has(name))
      return carries.some(Boolean) ? [`${name}: takes a requestId it cannot replay`] : [];
    return carries.every(Boolean) ? [] : [`${name}: changes something without a requestId`];
  });
}

const catalog = operationSchema.options.map((option) => ({
  name: option.shape.operation.value as string,
  params: option.shape.params as z.ZodType,
}));

describe("request replay", () => {
  it("every operation is read-only, idempotent, or replays a requestId", () => {
    expect(requestViolations(catalog, readOnlyOperations, idempotentOperations)).toEqual([]);
    for (const name of [...readOnlyOperations, ...idempotentOperations])
      expect(operationNames.has(name), name).toBe(true);
  });

  it("catches each misclassified operation", () => {
    const write = z.object({ projectId: z.string() });
    const replayed = write.extend({ requestId: z.string() });
    expect(
      requestViolations(
        [
          { name: "thing.create", params: write },
          { name: "thing.half", params: z.union([replayed, write]) },
          { name: "thing.get", params: replayed },
          { name: "thing.cancel", params: write },
          { name: "thing.both", params: write },
          { name: "thing.update", params: replayed },
        ],
        new Set(["thing.get", "thing.both"]),
        new Set(["thing.cancel", "thing.both"]),
      ).sort(),
    ).toEqual([
      "thing.both: classified twice",
      "thing.create: changes something without a requestId",
      "thing.get: takes a requestId it cannot replay",
      "thing.half: changes something without a requestId",
    ]);
  });
});
