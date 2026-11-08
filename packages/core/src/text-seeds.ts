import {
  compare,
  fromTime,
  toTime,
  resolvePlacement,
  placementForRange,
  isMediaClip,
  type TextSeed,
  type TextSeedCue,
  type ValidatedComposition,
} from "@yap/composition";
import { CatalogError } from "./catalog.js";
import { TranscriptStore, transcriptGenerationResource } from "./transcript.js";
import type { ResourceReference } from "./references.js";

type AnyClip = ValidatedComposition["document"]["clips"][number];
type Seed = Omit<TextSeed, "words"> & { words: readonly TextSeed["words"][number][] };
type Document = { clips: readonly AnyClip[] };
function invalid(message: string): never {
  throw new CatalogError("INVALID_EDIT", message);
}
const key = (seed: Seed) => JSON.stringify(seed);
export const textSeeds = (document: Document): Seed[] =>
  document.clips.flatMap((clip) =>
    clip.source.kind === "text" && "seed" in clip && clip.seed ? [clip.seed] : [],
  );

export function textSeedResources(document: Document): ResourceReference[] {
  const ids = new Set(
    textSeeds(document).map((seed) =>
      transcriptGenerationResource({
        owner: { kind: "asset", id: seed.source.assetId },
        generation: seed.generation,
      }),
    ),
  );
  return [...ids].map((id) => ({ kind: "transcript-generation", id }));
}

/** A pin an existing revision already holds is historical evidence; a new pin needs a current generation. */
function words(seed: Seed, records: TranscriptStore, historical: boolean) {
  const identity = {
    owner: { kind: "asset" as const, id: seed.source.assetId },
    generation: seed.generation,
  };
  const metadata = records.retainedGeneration(identity, { historical });
  if (
    metadata.source.kind !== "asset" ||
    metadata.source.streamId !== seed.source.streamId ||
    metadata.source.acquisitionId !== seed.source.acquisitionId
  )
    invalid("Text seed source differs from its retained transcript generation");
  const selected = seed.words.map((pin) => {
    const found = records.wordRecords(metadata, {
      lower: { key: [pin.sourceRange.startUs, pin.ordinal], inclusive: true },
      upper: { key: [pin.sourceRange.startUs, pin.ordinal], inclusive: true },
      limit: 1,
    })[0];
    if (!found || found.endUs !== pin.sourceRange.endUs)
      invalid("Text seed word pin differs from its retained transcript generation");
    return found;
  });
  for (let i = 1; i < selected.length; i++) {
    const a = selected[i - 1]!,
      b = selected[i]!;
    if (a.startUs > b.startUs || (a.startUs === b.startUs && a.ordinal >= b.ordinal))
      invalid("Text seed words must be distinct and ordered by source time and ordinal");
  }
  return {
    selected,
    resource: {
      kind: "transcript-generation",
      id: transcriptGenerationResource(identity),
    } satisfies ResourceReference,
  };
}
function origin(seed: Seed, clips: readonly AnyClip[]) {
  for (const clip of clips) {
    if (
      !isMediaClip(clip) ||
      clip.id !== seed.occurrenceClipId ||
      clip.source.kind !== "range" ||
      clip.assetId !== seed.source.assetId ||
      clip.streamId !== seed.source.streamId ||
      clip.acquisitionId !== seed.source.acquisitionId
    )
      continue;
    const source = clip.source;
    if (
      seed.words.every(
        (word) =>
          compare(fromTime(word.sourceRange.startUs), fromTime(source.range.endUs)) < 0 &&
          (word.sourceRange.startUs === word.sourceRange.endUs
            ? compare(fromTime(word.sourceRange.startUs), fromTime(source.range.startUs)) >= 0
            : compare(fromTime(word.sourceRange.endUs), fromTime(source.range.startUs)) > 0),
      )
    )
      return { ...clip, source };
  }
  return invalid("Text seed origin or word support differs from its selected occurrence");
}

/**
 * New origins need a pre-edit occurrence; inherited origins may outlive that clip. Adopted
 * history was seeded from a current generation when authored, so its words may be stale now.
 */
export function validateTextSeeds(
  document: Document,
  records: TranscriptStore,
  evidence?: { origins: readonly AnyClip[]; inherited: readonly Seed[]; adopted?: boolean },
): ResourceReference[] {
  const inherited = new Set(evidence?.inherited.map(key));
  const unique = new Map(textSeeds(document).map((seed) => [key(seed), seed]));
  const resources = new Map<string, ResourceReference>();
  for (const [identity, seed] of unique) {
    const pinned = !evidence || inherited.has(identity);
    if (!pinned) origin(seed, evidence.origins);
    const checked = words(seed, records, pinned || evidence.adopted === true);
    resources.set(checked.resource.id, checked.resource);
  }
  return [...resources.values()];
}

export function seedTextOperations(
  model: ValidatedComposition,
  cues: readonly TextSeedCue[],
  records: TranscriptStore,
) {
  return cues.map((cue) => {
    const seed: TextSeed = {
      kind: "transcript",
      source: cue.source,
      generation: cue.generation,
      occurrenceClipId: cue.occurrenceClipId,
      words: cue.words,
    };
    const clip = origin(seed, model.document.clips);
    const selected = words(seed, records, false).selected;
    const start = fromTime(selected[0]!.startUs),
      end = fromTime(Math.max(...selected.map((word) => word.endUs)));
    if (selected.every((word) => word.instant))
      invalid(
        "Instant observations require caller-authored text duration; transcript timing supplies no dwell",
      );
    const parentStart = fromTime(clip.source.range.startUs),
      parentEnd = fromTime(clip.source.range.endUs);
    const sourceRange = {
      startUs: toTime(compare(start, parentStart) < 0 ? parentStart : start),
      endUs: toTime(compare(end, parentEnd) > 0 ? parentEnd : end),
    };
    const placement = { kind: "content" as const, clipId: clip.id, sourceRange };
    const resolved = resolvePlacement(model, placement);
    let utf16Offset = 0;
    const timedWords = cue.style.highlight
      ? selected.map((word, index) => {
          const start = utf16Offset;
          utf16Offset += word.text.length;
          const range = [start, utf16Offset] as [number, number];
          if (index < selected.length - 1) utf16Offset += cue.separator.length;
          return { range, sourceRange: { startUs: word.startUs, endUs: word.endUs } };
        })
      : undefined;
    const source = {
      kind: "text" as const,
      text: selected.map((word) => word.text).join(cue.separator),
      ...(timedWords === undefined ? {} : { timedWords }),
      ...cue.style,
    };
    const anchor =
      cue.anchor === "content"
        ? placement
        : cue.anchor === "project"
          ? {
              kind: "project" as const,
              range: { startUs: toTime(resolved.range.start), endUs: toTime(resolved.range.end) },
            }
          : placementForRange(
              {
                id: "seed",
                trackId: cue.trackId,
                source,
                placement: {
                  kind: "clip",
                  clipId: clip.id,
                  start: { numerator: 0, denominator: 1 },
                  end: { numerator: 1, denominator: 1 },
                },
              },
              resolved.range,
              model.clips.find((value) => value.clip.id === clip.id)!,
            );
    return {
      operation: "place" as const,
      ...(cue.label ? { label: cue.label } : {}),
      clip: { trackId: cue.trackId, source, seed, placement: anchor },
    };
  });
}
