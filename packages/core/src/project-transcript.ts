import {
  compare,
  toTime,
  fromTime,
  floor,
  ceil,
  type ExactRange,
  type SelectionRange,
  type SourceWindowOccurrence,
} from "@yap/composition";
import {
  SourceTranscriptRead,
  transcriptSearchTerms,
  type SourceTranscriptRow,
} from "./transcript-read.js";
import type { TranscriptMetadata, TranscriptRecords } from "./transcript.js";
import { foldWord } from "./word-kind.js";
import { mergeHeads, compareKey, type EvidenceKey } from "./evidence-merge.js";
import type { EvidenceManifest, EvidencePagePlan, EvidenceCheckpoint } from "./project-evidence.js";
import { sourceSelectionKey as selectionKey } from "./source-selection.js";
import {
  applySpeakerCorrections,
  attributeTranscriptWords,
  type SpeakerAttribution,
  type SpeakerCorrection,
} from "./speaker-attribution.js";
import type { SpeakerEvidenceMetadata, SpeakerEvidenceStore } from "./speaker-evidence.js";
const scanBudget = 128;
const range = (value: ExactRange): SelectionRange => ({
  startUs: toTime(value.start),
  endUs: toTime(value.end),
});
export type ProjectTranscriptRow = {
  clipId: string;
  assetId: string;
  streamId: string;
  acquisitionId?: string;
  trackId: string;
  trackRank: number;
  generation: string | null;
  sourceRange: SelectionRange;
  fragments: { source: SelectionRange; project: SelectionRange }[];
  partial: boolean;
} & (
  | (Omit<Extract<SourceTranscriptRow, { type: "word" }>, "sourceRange" | "partial"> & {
      speaker?: SpeakerAttribution;
    })
  | Omit<Extract<SourceTranscriptRow, { type: "gap" }>, "sourceRange" | "partial">
);

type ProjectTranscriptWord = Extract<ProjectTranscriptRow, { type: "word" }>;
export type ProjectTranscriptMatch = {
  trackId: string;
  trackRank: number;
  words: ProjectTranscriptWord[];
  projectRange: SelectionRange;
};
type MatchCandidate = { key: EvidenceKey; entry: ProjectTranscriptMatch };
type Candidate = { key: EvidenceKey; row: ProjectTranscriptRow };
export type TranscriptPosition = {
  clip: number;
  gap: number;
  cursor: unknown;
  done: boolean;
  pending: Candidate | null;
  head: Candidate | null;
  headKind: "source" | "gap" | null;
  suffix: { key: EvidenceKey; row: ProjectTranscriptWord }[];
  match: MatchCandidate | null;
};
export function initialTranscript(): TranscriptPosition {
  return {
    clip: 0,
    gap: 0,
    cursor: null,
    done: false,
    pending: null,
    head: null,
    headKind: null,
    suffix: [],
    match: null,
  };
}

export function mergeTranscript(
  manifest: EvidenceManifest,
  plan: EvidencePagePlan,
  state: EvidenceCheckpoint<TranscriptPosition>,
  limit: number,
  records: TranscriptRecords,
  speakerRecords?: Pick<SpeakerEvidenceStore, "intervalPage">,
  speakerLabels?: (metadata: SpeakerEvidenceMetadata) => ReadonlyMap<number, string>,
  speakerCorrections: readonly SpeakerCorrection[] = [],
) {
  const dependencies = new Map(
    manifest.dependencies.map((dependency) => [selectionKey(dependency.selection), dependency]),
  );
  let budget = scanBudget;
  const speakerTurns = new Map<string, { slot: number; sourceRange: SelectionRange }[]>();
  const turnsFor = (clip: SourceWindowOccurrence) => {
    const key = selectionKey(clip),
      cached = speakerTurns.get(key);
    if (cached) return cached;
    const dependency = dependencies.get(key),
      result: { slot: number; sourceRange: SelectionRange }[] = [];
    if (speakerRecords && dependency?.speaker) {
      for (const metadata of dependency.speaker.evidence) {
        let afterSequence = -1;
        for (;;) {
          const page = speakerRecords.intervalPage({
            identity: metadata,
            afterSequence,
            limit: 1000,
          });
          result.push(...page.intervals.map(({ slot, sourceRange }) => ({ slot, sourceRange })));
          if (page.nextSequence === null) break;
          afterSequence = page.nextSequence;
        }
      }
    }
    speakerTurns.set(key, result);
    return result;
  };
  const common = (clip: SourceWindowOccurrence, transcript: TranscriptMetadata | null) => ({
    clipId: clip.clipId,
    assetId: clip.assetId,
    streamId: clip.streamId,
    ...(clip.acquisitionId === undefined ? {} : { acquisitionId: clip.acquisitionId }),
    trackId: clip.trackId,
    trackRank: clip.trackRank,
    generation: transcript?.generation ?? null,
  });
  const candidate = (row: ProjectTranscriptRow, ordinal: number): Candidate => ({
    row,
    key: {
      projectStartUs: row.fragments[0]!.project.startUs,
      trackRank: row.trackRank,
      clipId: row.clipId,
      sourceOrdinal: ordinal,
      eventKind: row.type,
    },
  });
  const project = (
    clip: SourceWindowOccurrence,
    transcript: TranscriptMetadata,
    row: SourceTranscriptRow,
  ): Candidate | null => {
    const instant = row.type === "word" && row.instant;
    const point = instant ? plan.projection.point(clip.clipId, row.sourceRange.startUs) : null;
    const projected = instant ? null : plan.projection.clip(clip.clipId, row.sourceRange);
    const fragments = point
      ? [
          {
            source: { start: point.source, end: point.source },
            project: { start: point.project, end: point.project },
          },
        ]
      : projected?.fragments;
    if (
      !fragments?.some(({ project: fragment }) =>
        instant
          ? compare(fragment.start, fromTime(plan.query.range.startUs)) >= 0 &&
            compare(fragment.start, fromTime(plan.query.range.endUs)) < 0
          : compare(fragment.end, fromTime(plan.query.range.startUs)) > 0 &&
            compare(fragment.start, fromTime(plan.query.range.endUs)) < 0,
      )
    )
      return null;
    const dependency = dependencySpeaker(clip);
    const speaker =
      row.type === "word" && speakerRecords && dependency
        ? applySpeakerCorrections(
            attributeTranscriptWords(
              [{ id: row.id, sourceRange: row.sourceRange }],
              turnsFor(clip),
              speakerLabels ? { labels: speakerLabels(dependency.evidence[0]!) } : {},
            ),
            clip.clipId,
            speakerCorrections,
          )[0]!.speaker
        : undefined;
    return candidate(
      {
        ...row,
        ...common(clip, transcript),
        partial: projected?.completeness === "partial",
        fragments: fragments.map((fragment) => ({
          source: range(fragment.source),
          project: range(fragment.project),
        })),
        ...(speaker === undefined ? {} : { speaker }),
      },
      row.type === "word" ? row.ordinal : -1,
    );
  };
  const dependencySpeaker = (clip: SourceWindowOccurrence) => {
    const dependency = dependencies.get(selectionKey(clip));
    return dependency?.speaker?.evidence.length ? dependency.speaker : undefined;
  };
  const fill = (index: number): boolean => {
    const track = state.tracks[index]!,
      clips = manifest.tracks[index]!.clipIds;
    while (track.clip < clips.length) {
      const clip = plan.occurrence(clips[track.clip]!);
      const transcript = dependencies.get(selectionKey(clip))!.transcript;
      if (!track.pending && !track.done) {
        if (budget-- <= 0) return false;
        if (!transcript || !clip.fragments.length) track.done = true;
        else {
          const first = clip.fragments[0]!.source,
            last = clip.fragments.at(-1)!.source;
          const page = new SourceTranscriptRead(records, transcript).page({
            range: { startUs: floor(first.start), endUs: ceil(last.end) },
            ...(track.cursor === null ? {} : { cursor: track.cursor }),
            limit: 1,
          });
          track.cursor = page.nextCursor;
          track.done = page.nextCursor === null;
          const row = page.rows[0];
          if (row) track.pending = project(clip, transcript, row);
          if (!track.pending && !track.done) continue;
        }
      }
      const gap = clip.unavailable[track.gap];
      const gapCandidate = gap
        ? candidate(
            {
              ...common(clip, transcript),
              type: "gap",
              reason: "not_acquired",
              sourceRange: range(gap.source),
              partial: false,
              fragments: [{ source: range(gap.source), project: range(gap.project) }],
            },
            -1,
          )
        : null;
      if (gapCandidate || track.pending) {
        const gapFirst =
          gapCandidate && (!track.pending || compareKey(gapCandidate.key, track.pending.key) < 0);
        track.head = gapFirst ? gapCandidate : track.pending;
        track.headKind = gapFirst ? "gap" : "source";
        return true;
      }
      if (budget-- <= 0) return false;
      const nextClip = clips[track.clip + 1];
      if (nextClip && compare(clip.project.end, plan.occurrence(nextClip).project.start) !== 0)
        track.suffix = [];
      track.clip++;
      track.gap = 0;
      track.cursor = null;
      track.done = false;
      track.pending = null;
    }
    track.head = null;
    track.headKind = null;
    return true;
  };
  const terms =
    manifest.query.text === undefined ? null : transcriptSearchTerms(manifest.query.text);
  const consume = (track: TranscriptPosition) => {
    if (track.headKind === "gap") track.gap++;
    else track.pending = null;
    track.head = null;
    track.headKind = null;
  };
  const fillNext = (index: number): boolean => {
    if (!terms) return fill(index);
    const track = state.tracks[index]!;
    for (;;) {
      if (budget <= 0) return false;
      if (!fill(index)) return false;
      const head = track.head;
      if (!head) return true;
      budget--;
      consume(track);
      if (head.row.type !== "word" || head.row.partial) {
        track.suffix = [];
        continue;
      }
      track.suffix.push({ key: head.key, row: head.row });
      if (track.suffix.length > terms.length) track.suffix.shift();
      if (
        track.suffix.length !== terms.length ||
        track.suffix.some((value, i) => foldWord(value.row.text) !== terms[i])
      )
        continue;
      const words = track.suffix.map(({ row }) => row);
      track.match = {
        key: track.suffix[0]!.key,
        entry: {
          trackId: head.row.trackId,
          trackRank: head.row.trackRank,
          words,
          projectRange: {
            startUs: words[0]!.fragments[0]!.project.startUs,
            endUs: words
              .flatMap((word) => word.fragments.map((fragment) => fragment.project.endUs))
              .reduce((a, b) => (compare(fromTime(a), fromTime(b)) >= 0 ? a : b)),
          },
        },
      };
      return true;
    }
  };
  const key = (index: number) =>
    terms ? state.tracks[index]!.match?.key : state.tracks[index]!.head?.key;
  const rows: ProjectTranscriptRow[] = [];
  const entries: ProjectTranscriptMatch[] = [];
  mergeHeads(state, manifest.tracks, limit, fillNext, key, (index) => {
    const track = state.tracks[index]!;
    if (terms) {
      entries.push(track.match!.entry);
      track.match = null;
    } else {
      rows.push(track.head!.row);
      consume(track);
    }
  });
  return { rows, entries };
}
