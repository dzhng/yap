import { createHash } from "node:crypto";
import { z } from "zod";
import { selectionRangeSchema, compare, fromTime, type SelectionRange } from "@yap/composition";
import { CatalogError } from "./catalog.js";
import type { SpeakerEvidenceMetadata, SpeakerEvidenceStore } from "./speaker-evidence.js";

const cursorSchema = z.strictObject({
  generation: z.string().min(1),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  afterSequence: z.int().nonnegative(),
});
export type SpeakerReadInput = {
  view?: "intervals" | "scores";
  sourceRange?: SelectionRange;
  limit?: number;
  cursor?: string;
};
/** Source pages expose complete native observations; range filtering never changes their identity. */
export class SourceSpeakerRead {
  constructor(
    private readonly records: Pick<SpeakerEvidenceStore, "intervalPage" | "scorePage">,
    private readonly metadata: SpeakerEvidenceMetadata,
    private readonly context?: string,
  ) {}
  page(input: SpeakerReadInput) {
    const view = input.view ?? "intervals";
    const range = selectionRangeSchema.parse(
      input.sourceRange ?? this.metadata.source.observationRange,
    );
    const sha = (value: unknown) =>
      createHash("sha256")
        .update(
          JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? Number(item) : item)),
        )
        .digest("hex");
    // The query is the caller's filter set; the evidence it read is the continuation's pin.
    const queryDigest = sha({ view, range }),
      evidenceDigest = sha({
        context: this.context ?? null,
        owner: this.metadata.owner,
        source: this.metadata.source,
      });
    let afterSequence: number | undefined;
    if (input.cursor !== undefined) {
      let value: unknown;
      try {
        const bytes = Buffer.from(input.cursor, "base64url");
        if (input.cursor.length > 8192 || bytes.toString("base64url") !== input.cursor)
          throw new Error();
        value = JSON.parse(bytes.toString());
      } catch {
        throw new CatalogError("INVALID_PARAMS", "Invalid speaker continuation");
      }
      const parsed = cursorSchema.safeParse(value);
      if (!parsed.success) throw new CatalogError("INVALID_PARAMS", "Invalid speaker continuation");
      if (parsed.data.queryDigest !== queryDigest)
        throw new CatalogError("INVALID_PARAMS", "Speaker continuation used another query");
      if (
        parsed.data.generation !== this.metadata.generation ||
        parsed.data.evidenceDigest !== evidenceDigest
      )
        throw new CatalogError("ARTIFACT_CHANGED", "Speaker observation changed");
      afterSequence = parsed.data.afterSequence;
    }
    const request = { identity: this.metadata, range, limit: input.limit ?? 250 };
    const page =
      view === "scores"
        ? this.records.scorePage({
            ...request,
            ...(afterSequence === undefined ? {} : { afterFrame: afterSequence }),
          })
        : this.records.intervalPage({
            ...request,
            ...(afterSequence === undefined ? {} : { afterSequence }),
          });
    const nextSequence = "nextFrame" in page ? page.nextFrame : page.nextSequence;
    const observed = this.metadata.source.observationRange;
    const coverage: {
      sourceRange: SelectionRange;
      state: "observed" | "unavailable";
      reason?: "unobserved";
    }[] = [{ sourceRange: observed, state: "observed" }];
    const earlier = (a: SelectionRange["startUs"], b: SelectionRange["startUs"]) =>
      compare(fromTime(a), fromTime(b)) < 0;
    if (earlier(range.startUs, observed.startUs))
      coverage.push({
        sourceRange: {
          startUs: range.startUs,
          endUs: earlier(range.endUs, observed.startUs) ? range.endUs : observed.startUs,
        },
        state: "unavailable",
        reason: "unobserved",
      });
    if (earlier(observed.endUs, range.endUs))
      coverage.push({
        sourceRange: {
          startUs: earlier(observed.endUs, range.startUs) ? range.startUs : observed.endUs,
          endUs: range.endUs,
        },
        state: "unavailable",
        reason: "unobserved",
      });
    return {
      evidence: page.metadata,
      view,
      sourceRange: range,
      coverage,
      rows: "scores" in page ? page.scores : page.intervals,
      nextCursor:
        nextSequence === null
          ? null
          : Buffer.from(
              JSON.stringify({
                generation: this.metadata.generation,
                evidenceDigest,
                queryDigest,
                afterSequence: nextSequence,
              }),
            ).toString("base64url"),
    };
  }
}
