import { isDeepStrictEqual } from "node:util";
import { readSync } from "node:fs";
import {
  add,
  subtract,
  multiply,
  compare,
  fromTime,
  toTime,
  sampleAt,
  createProjectCuts,
  type SelectionRange,
  type ProjectCutSide,
} from "@yap/composition";
import type { operationSchema } from "@yap/protocol";
import type { z } from "zod";
import { CatalogError } from "@yap/core/catalog";
import type { projectComposition } from "@yap/core/project-window";
import type { PreparedAudioStore } from "@yap/core/prepared-audio";
import type { AlignmentEvidenceStore } from "@yap/core/alignment-evidence";
import { SourceAlignmentRead } from "@yap/core/alignment-read";
import type { RenderedSpeech } from "@yap/core/rendered-speech";
import type { RetainedRead } from "@yap/core/files";
import { readAudioWave, waveformBuckets } from "@yap/core/audio-wave";
import { spectralWindows } from "@yap/core/audio-spectrum";

type Input = Extract<z.infer<typeof operationSchema>, { operation: "join.verify" }>["params"];

function publicSampleRange(range: { start: number; end: number }) {
  return { startSamples: range.start, endSamples: range.end };
}

function publicAudio(value: any): any {
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "bytes") result.sizeBytes = child;
    else if (key === "frames" || key === "fftFrames" || key === "hopFrames")
      result[
        key === "frames" ? "frameCount" : key === "fftFrames" ? "fftFrameCount" : "hopFrameCount"
      ] = child;
    else if (key === "dataOffset") result.dataOffsetBytes = child;
    else if (key === "dataBytes") result.dataSizeBytes = child;
    else if (key === "gridStart") result.gridStartSamples = child;
    else if (key === "center") result.centerSamples = child;
    else if (key === "sampleRange" && child && typeof child === "object")
      result.sampleRange = publicSampleRange(child as { start: number; end: number });
    else if ((key === "analysis" || key === "available") && child && typeof child === "object")
      result[key] = publicSampleRange(child as { start: number; end: number });
    else if (key === "readFrames") result.frameCount = child;
    else if (key === "start" && typeof child === "number") result.startSamples = child;
    else if (key === "end" && typeof child === "number") result.endSamples = child;
    else result[key] = Array.isArray(child) ? child.map(publicAudio) : publicAudio(child);
  }
  return result;
}

function coverage(requested: SelectionRange, observed: SelectionRange) {
  const start = fromTime(requested.startUs),
    end = fromTime(requested.endUs);
  const left = compare(start, fromTime(observed.startUs)) > 0 ? start : fromTime(observed.startUs);
  const right = compare(end, fromTime(observed.endUs)) < 0 ? end : fromTime(observed.endUs);
  if (compare(left, right) >= 0) return { observed: [], missing: [requested] };
  const missing: SelectionRange[] = [];
  if (compare(start, left) < 0) missing.push({ startUs: toTime(start), endUs: toTime(left) });
  if (compare(right, end) < 0) missing.push({ startUs: toTime(right), endUs: toTime(end) });
  return { observed: [{ startUs: toTime(left), endUs: toTime(right) }], missing };
}

/** Read-only composition of existing retained evidence; preparation remains with its owners. */
export async function verifyJoin(
  input: Input,
  owners: {
    composition: ReturnType<typeof projectComposition>;
    preparedAudio: PreparedAudioStore;
    alignments: AlignmentEvidenceStore;
    renderedSpeech: RenderedSpeech;
    signal: AbortSignal;
  },
) {
  const { composition } = owners;
  const prepared = owners.preparedAudio.resolve(composition, input.tap, input.preparedResourceId);
  if (!prepared)
    throw new CatalogError("PREREQUISITE_MISSING", "Prepared join-review tap is unavailable");
  const boundary = createProjectCuts(composition.model).boundary(input.boundary);
  if (boundary.mediaKind !== "audio")
    throw new CatalogError("INVALID_PARAMS", "Join speech review requires an audio track");
  const at = fromTime(boundary.projectAtUs),
    zero = fromTime(0);
  const terminal = composition.model.clips.reduce(
    (end, clip) => (compare(clip.range.end, end) > 0 ? clip.range.end : end),
    zero,
  );
  const contextStart = subtract(at, fromTime(input.context.beforeUs));
  const contextEnd = add(at, fromTime(input.context.afterUs));
  const projectRange = {
    startUs: toTime(compare(contextStart, zero) < 0 ? zero : contextStart),
    endUs: toTime(compare(contextEnd, terminal) > 0 ? terminal : contextEnd),
  };
  if (compare(fromTime(projectRange.startUs), fromTime(projectRange.endUs)) >= 0)
    throw new CatalogError("INVALID_PARAMS", "Join context does not overlap the project");
  const alignment = (assetId: string, generation: string, range: SelectionRange) => {
    const metadata = owners.alignments.metadata({
      owner: { kind: "asset", id: assetId },
      generation,
      policy: "alignment-v1",
    });
    const read = new SourceAlignmentRead(owners.alignments, metadata);
    const rows = (view: "words" | "acoustic") => {
      let cursor: string | undefined;
      const result: NonNullable<ReturnType<typeof read.page>["rows"]> = [];
      do {
        const page = read.page({
          view,
          sourceRange: range,
          limit: 1000,
          ...(view === "acoustic" ? { thresholdRMS: input.thresholdRMS } : {}),
          ...(cursor === undefined ? {} : { cursor }),
        });
        result.push(...page.rows!);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return result;
    };
    return {
      state: "observed" as const,
      metadata: publicAudio(metadata),
      requestedRange: range,
      coverage: coverage(range, metadata.source.observationRange),
      words: rows("words"),
      acoustic: rows("acoustic"),
      phoneticCompleteness: "unknown" as const,
    };
  };
  const source = (side: ProjectCutSide | null, generation?: string) => {
    if (!side || side.kind !== "range") {
      if (generation !== undefined)
        throw new CatalogError(
          "INVALID_PARAMS",
          "Source evidence has no media side at this boundary",
        );
      return { state: "not_applicable" as const };
    }
    const sourceAt = fromTime(side.sourceAtUs),
      rate = fromTime(side.rate);
    const start = subtract(sourceAt, multiply(fromTime(input.context.beforeUs), rate));
    const range = {
      startUs: toTime(compare(start, zero) < 0 ? zero : start),
      endUs: toTime(add(sourceAt, multiply(fromTime(input.context.afterUs), rate))),
    };
    if (generation === undefined) return { state: "missing" as const, requestedRange: range };
    const evidence = alignment(side.assetId, generation, range);
    if (
      evidence.metadata.source.streamId !== side.streamId ||
      evidence.metadata.source.acquisitionId !== (side.acquisitionId ?? null)
    )
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Source alignment does not match the boundary side",
      );
    return evidence;
  };
  const renderedAlignment =
    input.renderedAlignmentGeneration === undefined
      ? { state: "missing" as const, requestedRange: projectRange }
      : alignment(prepared.audio.assetId, input.renderedAlignmentGeneration, projectRange);
  const renderedRecognition = (() => {
    if (input.renderedSpeechGeneration === undefined)
      return { state: "missing" as const, requestedRange: projectRange };
    const read = owners.renderedSpeech.get({
      projectId: input.projectId,
      revisionId: input.revisionId,
      generation: input.renderedSpeechGeneration,
      limit: 1000,
    });
    const origin = read.pcm.origin.selection;
    if (origin.kind !== "project" || !isDeepStrictEqual(origin.tap, input.tap))
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Rendered recognition does not match the selected tap",
      );
    const rows = read.page.rows.filter((row) =>
      row.type === "word" && row.instant
        ? compare(fromTime(row.projectRange.startUs), fromTime(projectRange.startUs)) >= 0 &&
          compare(fromTime(row.projectRange.startUs), fromTime(projectRange.endUs)) < 0
        : compare(fromTime(row.projectRange.startUs), fromTime(projectRange.endUs)) < 0 &&
          compare(fromTime(row.projectRange.endUs), fromTime(projectRange.startUs)) > 0,
    );
    const observedText = rows
      .filter((row) => row.type === "word")
      .map((row) => row.text)
      .join(" ");
    return {
      state: "observed" as const,
      pcm: publicAudio(read.pcm),
      transcript: read.transcript,
      generation: read.generation,
      requestedRange: projectRange,
      coverage: coverage(projectRange, origin.range),
      rows,
      nextCursor: read.page.nextCursor,
      completePage: read.page.nextCursor === null,
      textComparison: {
        expectedText: input.expectedText,
        observedText,
        literalMatch: read.page.nextCursor === null ? observedText === input.expectedText : null,
        interpretation: "recognition_observation_not_phonetic_certification" as const,
      },
      phoneticCompleteness: "unknown" as const,
    };
  })();
  const audio = {
    bytes: prepared.audio.bytes,
    sampleRate: prepared.audio.sampleRate,
    channels: prepared.audio.channels,
    frames: prepared.audio.frames,
    sampleRange: prepared.audio.sampleRange,
  } as const;
  const sampleAtProject = (value: Parameters<typeof fromTime>[0]) => {
    return Math.max(
      prepared.audio.sampleRange.start,
      Math.min(prepared.audio.sampleRange.end, sampleAt(fromTime(value), audio.sampleRate)),
    );
  };
  const audioRange = {
    start: sampleAtProject(projectRange.startUs),
    end: sampleAtProject(projectRange.endUs),
  };
  if (audioRange.end <= audioRange.start)
    throw new CatalogError("INVALID_PARAMS", "Join context is shorter than one output sample");
  const unavailable = prepared.audio.unavailable.flatMap((entry) =>
    entry.ranges
      .filter((range) => range.start < audioRange.end && range.end > audioRange.start)
      .map((range) => ({ clipId: entry.clipId, range })),
  );
  if (unavailable.length)
    throw new CatalogError("NOT_READY", "Prepared join-review audio contains unavailable samples", {
      unavailable,
    });
  const preparedFile = owners.preparedAudio.open(prepared.resourceId, prepared.audio.sampleRange);
  const retained: RetainedRead = {
    bytes: prepared.audio.bytes,
    read(buffer, position) {
      if (!Number.isSafeInteger(position) || position < 0 || position > prepared.audio.bytes)
        throw new CatalogError("INVALID_EVIDENCE", "Invalid retained file read position");
      return readSync(
        preparedFile.fd,
        buffer,
        0,
        Math.min(buffer.length, prepared.audio.bytes - position),
        position,
      );
    },
    release: preparedFile.release,
  };
  try {
    const dimensions = readAudioWave(retained);
    const waveform = await waveformBuckets(
      retained,
      audio,
      { bucketFrames: Math.max(1, Math.floor(audio.sampleRate / 100)), sampleRange: audioRange },
      owners.signal,
    );
    const maximumColumns = Math.floor(262144 / (audio.channels * (256 / 2 + 1)));
    const spectrumHopFrames = Math.max(
      128,
      Math.ceil((audioRange.end - audioRange.start) / Math.max(1, maximumColumns - 1)),
    );
    const spectrum = await spectralWindows(
      retained,
      audio,
      { fftFrames: 256, hopFrames: spectrumHopFrames, sampleRange: audioRange },
      owners.signal,
    );
    const candidates = (input.candidateOffsetsUs ?? []).map((offsetUs) => {
      const candidateAt = add(at, fromTime(offsetUs));
      return compare(candidateAt, zero) < 0 || compare(candidateAt, terminal) > 0
        ? { offsetUs, state: "outside_project" as const }
        : {
            offsetUs,
            state: "observed" as const,
            boundary: createProjectCuts(composition.model).boundary({
              trackId: input.boundary.trackId,
              projectAtUs: toTime(candidateAt),
            }),
          };
    });
    return {
      projectId: input.projectId,
      revisionId: composition.revisionId,
      preparedResourceId: prepared.resourceId,
      tap: input.tap,
      boundary,
      context: input.context,
      projectRange,
      expectedText: input.expectedText,
      thresholdRMS: input.thresholdRMS,
      source: {
        before: source(boundary.before, input.sourceEvidence?.before),
        after: source(boundary.after, input.sourceEvidence?.after),
      },
      rendered: {
        prepared: publicAudio(prepared.audio),
        alignment: renderedAlignment,
        recognition: renderedRecognition,
      },
      audio: {
        dimensions: publicAudio(dimensions),
        waveform: publicAudio(waveform),
        spectrum: publicAudio({ ...spectrum, density: Array.from(spectrum.density) }),
        discontinuity: {
          state: "observed" as const,
          edgeRMS: publicAudio(waveform.buckets.slice(0, 2).concat(waveform.buckets.slice(-2))),
          interpretation: "energy_boundary_only" as const,
        },
        roomTone: { state: "unknown" as const, reason: "No room-tone classifier is retained" },
      },
      candidates,
      phoneticCompleteness: "unknown" as const,
    };
  } finally {
    retained.release();
  }
}
