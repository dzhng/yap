import { JOURNAL_RECORD_BYTES } from "@yap/protocol";
import {
  compare,
  fromTime,
  round,
  floor,
  ceil,
  type TimeValue,
  type ProjectCut,
} from "@yap/composition";
import {
  initialSourceEvents,
  SourceEvents,
  sourceEventOrdinal,
  type SourceEventPosition,
  type SourceEventRow,
} from "./source-events.js";
import { compareKey, mergeHeads, type EvidenceKey } from "./evidence-merge.js";
import type { EvidenceManifest, EvidencePagePlan, EvidenceCheckpoint } from "./project-evidence.js";
import { sourceSelectionKey } from "./source-selection.js";
type ProjectSourceEventRow = SourceEventRow & {
  clipId: string;
  assetId: string;
  streamId: string;
  acquisitionId?: string;
  trackId: string;
  trackRank: number;
  generation: string;
  projectAtUs: TimeValue;
};
export type ProjectEventRow = ProjectSourceEventRow | ProjectCut;
type EventHead = { key: EvidenceKey; row: ProjectEventRow };
export type ProjectEventPosition = {
  clip: number;
  cut: number;
  source: SourceEventPosition;
  head: EventHead | null;
  deferred: EventHead | null;
};
export const initialProjectEvents = (): ProjectEventPosition => ({
  clip: 0,
  cut: 0,
  source: initialSourceEvents(),
  head: null,
  deferred: null,
});
export function mergeEvents(
  manifest: EvidenceManifest,
  plan: EvidencePagePlan,
  state: EvidenceCheckpoint<ProjectEventPosition>,
  limit: number,
  reader: SourceEvents,
) {
  const dependencies = new Map(
    manifest.dependencies.map((d) => [sourceSelectionKey(d.selection), d.capture!]),
  );
  const budget = { remaining: 128 };
  const next = (index: number): EventHead | null | undefined => {
    const position = state.tracks[index]!,
      ids = manifest.tracks[index]!.clipIds;
    if (manifest.tracks[index]!.cuts) {
      if (budget.remaining <= 0) return undefined;
      budget.remaining--;
      const row = plan.cuts[position.cut++];
      if (!row) return null;
      return {
        row,
        key: {
          projectStartUs: row.projectAtUs,
          trackRank: row.trackRank,
          clipId: (row.after ?? row.before)!.clipId,
          sourceOrdinal: -1,
          eventKind: "cut",
        },
      };
    }
    while (position.clip < ids.length) {
      if (budget.remaining <= 0) return undefined;
      const clip = plan.occurrence(ids[position.clip]!),
        context = dependencies.get(sourceSelectionKey(clip))!;
      // Dependency pins remain checked by the read owner. No source scan is needed when
      // neither source owner has published evidence; those clips cannot contribute a row.
      if (!context.evidence && !context.scene?.evidence) {
        position.clip++;
        position.source = initialSourceEvents();
        continue;
      }
      const row = clip.fragments.length
        ? reader.next(
            context,
            {
              startUs: floor(clip.fragments[0]!.source.start),
              endUs: ceil(clip.fragments.at(-1)!.source.end),
            },
            position.source,
            budget,
          )
        : null;
      if (row === undefined) return undefined;
      if (row === null) {
        budget.remaining--;
        position.clip++;
        position.source = initialSourceEvents();
        continue;
      }
      const ending = row.kind === "interruption";
      const mapped = ending
        ? plan.projection.endpoint(clip.clipId, row.sourceAtUs)
        : plan.projection.point(clip.clipId, row.sourceAtUs);
      if (
        !mapped ||
        (ending
          ? compare(mapped.project, fromTime(plan.query.range.startUs)) <= 0
          : compare(mapped.project, fromTime(plan.query.range.startUs)) < 0) ||
        (ending
          ? compare(mapped.project, fromTime(plan.query.range.endUs)) > 0
          : compare(mapped.project, fromTime(plan.query.range.endUs)) >= 0)
      )
        continue;
      const projectAtUs = round(mapped.project);
      return {
        key: {
          projectStartUs: projectAtUs,
          trackRank: clip.trackRank,
          clipId: clip.clipId,
          sourceOrdinal: sourceEventOrdinal(row),
          eventKind: row.kind,
        },
        row: {
          ...row,
          clipId: clip.clipId,
          assetId: clip.assetId,
          streamId: clip.streamId,
          ...(clip.acquisitionId === undefined ? {} : { acquisitionId: clip.acquisitionId }),
          trackId: clip.trackId,
          trackRank: clip.trackRank,
          generation:
            row.kind === "scene"
              ? context.scene!.evidence!.generation
              : context.evidence!.generation,
          projectAtUs,
        },
      };
    }
    return null;
  };
  const fill = (index: number): boolean => {
    const position = state.tracks[index]!;
    // A preceding endpoint can tie the next clip's opening observations. Retain one
    // head while reading that opening, so the established clip-ID ordering still wins.
    for (;;) {
      if (position.deferred && position.deferred.row.kind !== "interruption") {
        position.head = position.deferred;
        position.deferred = null;
        return true;
      }
      const candidate = next(index);
      if (candidate === undefined) return false;
      if (position.deferred) {
        if (!candidate || compareKey(position.deferred.key, candidate.key) <= 0) {
          position.head = position.deferred;
          position.deferred = candidate;
        } else {
          position.head = candidate;
        }
        return true;
      }
      if (candidate?.row.kind === "interruption") {
        position.deferred = candidate;
        continue;
      }
      position.head = candidate;
      return true;
    }
  };
  const rows: ProjectEventRow[] = [];
  let bytes = 0;
  mergeHeads(
    state,
    manifest.tracks,
    limit,
    fill,
    (index) => state.tracks[index]!.head?.key,
    (index) => {
      const row = state.tracks[index]!.head!.row;
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      rows.push(row);
      state.tracks[index]!.head = null;
    },
    // A page targets one derived maximum record, leaving the transport's envelope headroom.
    (index) =>
      !rows.length ||
      bytes + Buffer.byteLength(JSON.stringify(state.tracks[index]!.head!.row)) + 1 <=
        JOURNAL_RECORD_BYTES,
  );
  return rows;
}
