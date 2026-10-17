import { createHash } from "node:crypto";
import { z } from "zod";
import { compare, fromTime, selectionRangeSchema, type SelectionRange } from "@yap/composition";
import { CatalogError } from "./catalog.js";
import type {
  AlignmentEvidenceMetadata,
  AlignmentCapturedMetadata,
  AlignmentEvidenceStore,
} from "./alignment-evidence.js";

export const alignmentReadSchema = z.strictObject({
  view: z.enum(["words", "acoustic", "scores", "raw"]).optional(),
  sourceRange: selectionRangeSchema.optional(),
  thresholdRMS: z.number().finite().nonnegative().optional(),
  operand: z.enum(["nativeReceipt", "report", "correspondence"]).optional(),
  limit: z.int().min(1).max(1000).optional(),
  cursor: z.string().min(1).max(8192).optional(),
});
export type AlignmentReadInput = z.infer<typeof alignmentReadSchema>;
const cursorSchema = z.strictObject({
  generation: z.string().min(1),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  after: z.int().nonnegative(),
});
const intersects = (a: SelectionRange, b: SelectionRange) =>
  compare(fromTime(a.startUs), fromTime(b.endUs)) < 0 &&
  compare(fromTime(b.startUs), fromTime(a.endUs)) < 0;
/** Retained pages require neither an inference provider nor runtime bytes. */
export class SourceAlignmentRead {
  constructor(
    private readonly records: Pick<AlignmentEvidenceStore, "page" | "rawPage">,
    private readonly metadata: AlignmentEvidenceMetadata | AlignmentCapturedMetadata,
    private readonly context?: string,
  ) {}
  page(input: AlignmentReadInput) {
    const parsed = alignmentReadSchema.parse(input),
      view = parsed.view ?? "words",
      range = parsed.sourceRange ?? this.metadata.source.observationRange;
    if (view === "acoustic" && parsed.thresholdRMS === undefined)
      throw new CatalogError(
        "INVALID_PARAMS",
        "Acoustic classification requires an explicit thresholdRMS",
      );
    if (view !== "acoustic" && parsed.thresholdRMS !== undefined)
      throw new CatalogError("INVALID_PARAMS", "thresholdRMS only applies to acoustic cells");
    if (view !== "raw" && parsed.operand !== undefined)
      throw new CatalogError("INVALID_PARAMS", "operand only applies to raw reads");
    const operand = parsed.operand ?? "nativeReceipt";
    const queryDigest = createHash("sha256")
      .update(
        JSON.stringify({
          owner: this.metadata.owner,
          source: this.metadata.source,
          generation: this.metadata.generation,
          view,
          range,
          thresholdRMS: parsed.thresholdRMS ?? null,
          operand: view === "raw" ? operand : null,
          context: this.context ?? null,
        }),
      )
      .digest("hex");
    let after = view === "raw" ? 0 : -1;
    if (parsed.cursor) {
      let value: unknown;
      try {
        const bytes = Buffer.from(parsed.cursor, "base64url");
        if (bytes.toString("base64url") !== parsed.cursor) throw new Error();
        value = JSON.parse(bytes.toString());
      } catch {
        throw new CatalogError("INVALID_PARAMS", "Invalid alignment continuation");
      }
      const cursor = cursorSchema.parse(value);
      if (cursor.generation !== this.metadata.generation || cursor.queryDigest !== queryDigest)
        throw new CatalogError("ARTIFACT_CHANGED", "Alignment generation or query changed");
      after = cursor.after;
    }
    const cursor = (value: number | null) =>
      value === null
        ? null
        : Buffer.from(
            JSON.stringify({ generation: this.metadata.generation, queryDigest, after: value }),
          ).toString("base64url");
    if (view === "raw") {
      const raw = this.records.rawPage(this.metadata, operand, after);
      return {
        evidence: this.metadata,
        view,
        operand,
        encoding: "base64-original-utf8" as const,
        ...raw,
        nextCursor: cursor(raw.nextOffset),
      };
    }
    if (!("wordCount" in this.metadata))
      throw new CatalogError("NOT_READY", "Alignment evidence is not ready", {});
    const page = this.records.page(this.metadata, view, after, parsed.limit ?? 250);
    const rows = page.rows
      .filter((row) => {
        if (!parsed.sourceRange) return true;
        const observed = "timing" in row ? row.timing?.sourceRange : row.sourceRange;
        return !observed || intersects(observed, range);
      })
      .map((row) =>
        view === "acoustic" && "rms" in row
          ? {
              ...row,
              activity: row.rms >= parsed.thresholdRMS! ? ("active" as const) : ("quiet" as const),
              thresholdRMS: parsed.thresholdRMS,
              lexicalIdentity: "unknown" as const,
            }
          : row,
      );
    return {
      evidence: this.metadata,
      view,
      sourceRange: range,
      rows,
      acousticResolutionSamples: 160 as const,
      noiseFloorInterpretation: "unknown" as const,
      nextCursor: cursor(page.nextSequence),
    };
  }
}
