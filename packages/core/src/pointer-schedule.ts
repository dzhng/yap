import { evidenceRecordingId } from "./evidence.js";
import { createHash, randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CatalogError } from "./catalog.js";
import type { EvidenceIdentity, SourceTrailRead } from "./evidence.js";
import type { SourceEvidenceReader } from "./evidence-read.js";
import { PresentationEvidence } from "./presentation-evidence.js";
import { PresentationPointerHistory } from "./presentation-pointer-history.js";
import { scenePolicy } from "./scenes.js";
import { trailPolicy, type CursorPoint } from "./trails.js";
import type { PresentationTime } from "./presentation-time.js";

type ScheduleInput = {
  revisionId: string;
  presentation: PresentationEvidence;
  evidence: SourceTrailRead & Pick<SourceEvidenceReader, "exportRecords">;
  identity: EvidenceIdentity;
  output: string;
};
export type PointerState = { spanIndex: number; at: PresentationTime; pointer: CursorPoint | null };

/** Caller binds the evidence/receipt to one pinned source in its private render attempt.
 * Matching dimensions and spans alone cannot authenticate source identity. */
export async function writePointerSchedule(input: ScheduleInput, signal: AbortSignal) {
  if (!isAbsolute(input.output))
    throw new CatalogError("INVALID_RANGE", "Pointer schedule requires an absolute output");
  signal.throwIfAborted();
  const staging = join(dirname(input.output), `.pointer-schedule-${randomUUID()}`);
  const file = await open(staging, "wx", 0o600);
  let bytes = 0,
    records = 0,
    events = 0;
  const hash = createHash("sha256");
  async function append(value: unknown) {
    signal.throwIfAborted();
    const data = Buffer.from(JSON.stringify(value) + "\n");
    if (data.length > 65_536)
      throw new CatalogError("LIMIT_EXCEEDED", "Pointer schedule exceeds its byte budget");
    await file.writeFile(data);
    hash.update(data);
    bytes += data.length;
  }
  try {
    const source = input.presentation;
    const header = {
      version: 1,
      recordingId: evidenceRecordingId(input.identity),
      sourceId: input.identity.sourceId,
      sourceGeneration: input.identity.generation,
      revisionId: input.revisionId,
      sourceWidth: source.receipt.sourceWidth,
      sourceHeight: source.receipt.sourceHeight,
      durationUs: source.receipt.durationUs,
      spanCount: source.spans.length,
      trailPolicy: trailPolicy.id,
      scenePolicy: scenePolicy.id,
    };
    await append(header);
    const history = new PresentationPointerHistory(input, signal);
    for await (const state of pointerStates(history)) {
      await append(state);
      records++;
    }
    events = history.events;
    await file.sync();
    signal.throwIfAborted();
    try {
      await link(staging, input.output);
    } catch {
      throw new CatalogError(
        "INVALID_OUTPUT",
        "Cannot publish pointer schedule to an occupied destination",
      );
    }
    return { ...header, file: input.output, bytes, records, events, sha256: hash.digest("hex") };
  } finally {
    try {
      await file.close();
    } finally {
      await rm(staging, { force: true });
    }
  }
}

async function* pointerStates(history: PresentationPointerHistory): AsyncGenerator<PointerState> {
  let previousPointer: CursorPoint | null = null,
    previousSpan = -1;
  try {
    for (;;) {
      const state = await history.next();
      if (!state) break;
      const nextPointer =
        state.inspection.kind === "empty" ? null : state.inspection.plan.overlay.pointer;
      const same =
        nextPointer === null
          ? previousPointer === null
          : previousPointer !== null &&
            nextPointer.x === previousPointer.x &&
            nextPointer.y === previousPointer.y;
      if (state.record.spanIndex !== previousSpan || !same) {
        yield { spanIndex: state.record.spanIndex, at: state.at, pointer: nextPointer };
        previousPointer = nextPointer;
        previousSpan = state.record.spanIndex;
      }
    }
  } finally {
    await history.close();
  }
}
