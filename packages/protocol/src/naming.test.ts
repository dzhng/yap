import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as protocol from "./index.js";
import { keyViolation, valueNamingViolations } from "./naming.js";
import {
  idempotentOperations,
  operationNames,
  operationSchema,
  readOnlyOperations,
} from "./operations.js";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $defs?: Record<string, JsonSchema>;
};

const isNumber = (schema: JsonSchema) =>
  [schema.type].flat().some((type) => type === "number" || type === "integer");

/** Every naming violation in a JSON schema, as `path: reason`. */
function namingViolations(schema: JsonSchema, path: string): string[] {
  const found: string[] = [];
  const walk = (node: JsonSchema | undefined, at: string) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const here = `${at}.${key}`;
      const reason = keyViolation(key, isNumber(child), at.split(".").pop());
      if (reason) found.push(`${here}: ${reason}`);
      walk(child, here);
    }
    for (const child of [node.items].flat()) walk(child, `${at}[]`);
    if (typeof node.additionalProperties === "object") walk(node.additionalProperties, `${at}{}`);
    for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])])
      walk(branch, at);
    for (const [name, definition] of Object.entries(node.$defs ?? {}))
      walk(definition, `${path}#${name}`);
  };
  walk(schema, path);
  return found;
}

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
    const forms = branches(json(params));
    const carries = forms.map((form) => Object.hasOwn(form.properties ?? {}, "requestId"));
    if (readOnly.has(name) && idempotent.has(name)) return [`${name}: classified twice`];
    if (readOnly.has(name) || idempotent.has(name))
      return carries.some(Boolean) ? [`${name}: takes a requestId it cannot replay`] : [];
    return carries.every(Boolean) ? [] : [`${name}: changes something without a requestId`];
  });
}

// Shapes this lint does not own, each with the reason:
// - `@yap/composition` owns the edit document (edit operations, processing taps, text styles)
//   and export settings. Revisions and presets store them, and the catalog format does not
//   change in this spec, so renaming them is an edit-format change of its own.
// - The transport envelope's `id` correlates a request with its response; it names no record.
const composition = [
  /\.(tap\.)?target\.id$/,
  /^(edit\.apply|operationSchema\.params)\.operations\[\]\./,
  /\.cues\[\]\.style\./,
  /\.settings\.video\./,
];
const envelopes = new Set([
  "appMessageSchema",
  "controlMessageSchema",
  "controlResponseSchema",
  "deliveredResponseSchema",
  "requestSchema",
  "responseSchema",
  "wireRequestSchema",
  "wireResponseSchema",
]);
const owned = (violation: string) =>
  !composition.some((pattern) => pattern.test(violation.slice(0, violation.indexOf(":"))));

const catalog = operationSchema.options.map((option) => ({
  name: option.shape.operation.value as string,
  params: option.shape.params as z.ZodType,
}));
const exportedSchemas = Object.entries(protocol).filter(
  (entry): entry is [string, z.ZodType] =>
    entry[1] instanceof z.ZodType && !envelopes.has(entry[0]),
);

describe("identity and naming lint", () => {
  it("every operation parameter and exported record names identities and quantities", () => {
    expect(
      [
        ...catalog.flatMap(({ name, params }) => namingViolations(json(params), name)),
        ...exportedSchemas.flatMap(([name, schema]) => namingViolations(json(schema), name)),
      ]
        .filter(owned)
        .sort(),
    ).toEqual([]);
  });

  it("every operation is read-only, idempotent, or replays a requestId", () => {
    expect(requestViolations(catalog, readOnlyOperations, idempotentOperations)).toEqual([]);
    for (const name of [...readOnlyOperations, ...idempotentOperations])
      expect(operationNames.has(name), name).toBe(true);
  });

  it("a response value is held to the same rule outside composition-owned paths, and a key may leave out what its parent says", () => {
    expect(
      valueNamingViolations(
        {
          revision: { id: "r", document: { tracks: [{ id: "t" }] } },
          sizeBytes: 3,
          bytes: 3,
          sampleRange: { start: 0, end: 4 },
          range: { start: 0, end: 4 },
          rows: [{ id: "w", count: 2 }],
          snapshot: { settings: { video: { keyframeIntervalSeconds: 2 } } },
        },
        "op",
      ),
    ).toEqual(["op.range.end: quantity without a unit", "op.range.start: quantity without a unit"]);
  });

  it("removed aliases stay removed", () => {
    expect(operationNames.has("recording.latest")).toBe(false);
    expect(operationNames.has("inspect")).toBe(false);
    expect(operationNames.has("inspect.open")).toBe(true);
    expect(operationNames.has("recording.get")).toBe(true);
  });

  it("catches each planted violation", () => {
    const planted = json(
      z.object({
        id: z.string(),
        durationSeconds: z.number(),
        bytes: z.int(),
        startTime: z.number(),
        nested: z.array(z.object({ offset: z.int() })),
        either: z.union([
          z.object({ expires: z.number() }),
          z.object({ ids: z.array(z.string()) }),
        ]),
        fine: z.object({
          assetId: z.string(),
          durationUs: z.int(),
          sizeBytes: z.int(),
          atUs: z.int(),
        }),
      }),
    );
    expect(namingViolations(planted, "planted").sort()).toEqual(
      [
        "planted.durationSeconds: non-canonical unit",
        "planted.either.expires: quantity without a unit",
        "planted.nested[].offset: quantity without a unit",
        "planted.startTime: quantity without a unit",
      ].sort(),
    );
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
