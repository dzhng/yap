import type { SpeakerEvidenceSource } from "@yap/core/speaker-evidence";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Catalog } from "@yap/core/catalog";
import { AssetStore } from "@yap/core/assets";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { Models } from "@yap/core/models";
import { JobQueue } from "@yap/core/jobs";
import { SpeakerEvidenceStore, assetSpeakerOwner } from "@yap/core/speaker-evidence";
import { SpeakerProcessing } from "@yap/core/speaker-processing";
import { selectSpeakerSource, type SpeakerSourceInput } from "@yap/core/source-speakers";

export function nativeOutput(
  lines = ["0.000 1.000 speaker_0", "0.500 2.000 speaker_1"],
  modelSha256 = "b".repeat(64),
  frames = 480_000,
) {
  const scoreCount = frames / 1280;
  const tensor = Buffer.alloc(scoreCount * 4 * 4);
  const scores = Array.from({ length: scoreCount }, (_, frame) =>
    Array.from({ length: 4 }, (_, slot) => {
      const value = ((frame % 4) + slot) / 8;
      tensor.writeFloatLE(value, (frame * 4 + slot) * 4);
      return value;
    }),
  );
  return {
    nativeReceipt: JSON.stringify({
      verified: false,
      encoding: "dtype/shape + base64 native tensor bytes",
      nativeSegmentLines: [lines],
      nativeTensors: [
        { shape: [1, scoreCount, 4], dtype: "<f4", bytesBase64: tensor.toString("base64") },
      ],
    }),
    report: JSON.stringify({
      nativeSegmentLines: lines,
      nativeProbabilities: scores,
      probabilityShape: [scoreCount, 4],
      sampleRate: 16000,
      sourceFrames: frames,
      frameSeconds: 0.08,
      modelSha256,
      pcmSha256: "c".repeat(64),
    }),
  };
}

export const speakerSource: SpeakerEvidenceSource = {
  streamId: "audio",
  acquisitionId: null,
  supportDigest: "support",
  channel: 1,
  originUs: -250000,
  durationUs: 40000000,
  observationRange: {
    startUs: { numerator: 125, denominator: 2 },
    endUs: { numerator: 60000125, denominator: 2 },
  },
  pcm: { sha256: "c".repeat(64), sampleRate: 16000, frames: 480000 },
  decoder: {
    recipe: "source-selected-span-avfoundation-f32-16k-v1",
    workerSha256: "d".repeat(64),
    osBuild: "fixture-macos",
  },
  engine: {
    modelId: "speaker-runtime-control",
    descriptorDigest: "1".repeat(64),
    modelDigest: "2".repeat(64),
    modelSha256: "b".repeat(64),
    runtimeDigest: "e".repeat(64),
    workerSha256: "f".repeat(64),
    recipe: "original30s",
  },
};

export async function publishControlledObservation(
  home: string,
  input: SpeakerSourceInput,
  lines?: string[],
) {
  const library = join(home, "library"),
    catalog = new Catalog(join(library, "catalog.sqlite"));
  const assets = new AssetStore(catalog, library),
    acquisitions = new AcquisitionStore(catalog),
    models = new Models(library),
    selected = selectSpeakerSource(assets, acquisitions, input),
    evidence = new SpeakerEvidenceStore(catalog, assetSpeakerOwner(assets, acquisitions)),
    jobs = new JobQueue({
      store: catalog,
      deferExecution: true,
      providers: { newId: randomUUID },
      targets: {
        pin: (target) =>
          target.kind === "project"
            ? { ...target, revisionId: target.revisionId ?? null }
            : { ...target, revisionId: null },
        isAvailable: () => true,
        isDeleting: () => false,
        isCapturing: () => false,
      },
      execute: async () => {
        throw new Error("Retained fixture cannot execute a model");
      },
    });
  try {
    const source = {
      ...speakerSource,
      streamId: input.streamId,
      channel: input.channel,
      observationRange: input.sourceRange,
      supportDigest: selected.supportDigest,
      originUs: selected.originUs,
      durationUs: selected.durationUs,
      engine: models.speaker(input.modelId).engine,
    };
    const identity = {
      owner: { kind: "asset" as const, assetId: input.assetId },
      sourceId: input.assetId,
      generation: "retained-control-g1",
      policy: "speaker-v1" as const,
    };
    const staged = evidence.stage(identity, source, nativeOutput(lines, source.engine.modelSha256));
    const processing = new SpeakerProcessing({
      assets,
      acquisitions,
      models,
      jobs,
      evidence,
      decoder: null,
      observe: async () => {
        throw new Error("Retained fixture cannot observe");
      },
    });
    const executionSource = Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== "pcm"),
    );
    catalog.transaction(() => {
      staged.publish();
      processing.adoptPublication(staged.metadata, {
        generation: 1,
        attemptId: identity.generation,
        input: JSON.stringify({ request: input, source: executionSource }),
      });
    });
    return staged.metadata;
  } finally {
    await jobs.close();
    catalog.close();
  }
}
