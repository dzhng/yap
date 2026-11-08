import { createHash } from "node:crypto";
import type { AlignmentEvidenceSource } from "./alignment-operands.js";
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
export const alignmentSource: AlignmentEvidenceSource = {
  streamId: "a1",
  acquisitionId: null,
  supportDigest: "support",
  channel: 0,
  originUs: 0,
  durationUs: 2000000,
  observationRange: { startUs: 0, endUs: 100000 },
  text: "Hi wrong Hi",
  pcm: { sha256: sha("pcm"), sampleRate: 16000, frameCount: 1600 },
  decoder: {
    recipe: "source-selected-span-avfoundation-f32-16k-v1",
    workerSha256: sha("native"),
    osBuild: "test",
  },
  engine: {
    modelId: "ctc",
    descriptorDigest: sha("descriptor"),
    modelDigest: sha("model"),
    modelSha256: sha("checkpoint"),
    runtimeDigest: sha("runtime"),
    workerSha256: sha("worker"),
    recipe: "nemo-auxiliary-ctc110-v1",
  },
};
export function alignmentOutput() {
  const vocabulary = Array.from({ length: 1024 }, () => "x");
  vocabulary[1] = "▁Hi";
  vocabulary[2] = "▁wrong";
  const matrix = Buffer.alloc(2 * 1025 * 4);
  for (let n = 0; n < 2050; n++) matrix.writeFloatLE(-5, n * 4);
  matrix.writeFloatLE(-0.25, 4);
  matrix.writeFloatLE(-0.5, (1025 + 1) * 4);
  const native = {
    pcmSha256: alignmentSource.pcm.sha256,
    modelSha256: alignmentSource.engine.modelSha256,
    sourceFrames: 1600,
    shape: [2, 1025],
    untrimmedShape: [1, 2, 1025],
    dtype: "<f4",
    bytesBase64: matrix.toString("base64"),
    blankId: 1024,
    vocabulary,
    text: alignmentSource.text,
    tokenIds: [1, 2, 1],
    frameSamples: 1280,
    sampleRate: 16000,
  };
  const report = {
    ...native,
    greedyTokens: [{ token: 1, startFrame: 0, endFrame: 2 }],
    candidate: {
      text: alignmentSource.text,
      ids: [1, 2, 1],
      status: "refused",
      reason: "insufficient cells",
      assignmentConfidence: null,
    },
    acoustic: {
      resolutionSamples: 160,
      cells: Array.from({ length: 10 }, (_, i) => ({
        startSample: i * 160,
        endSample: (i + 1) * 160,
        rms: i < 5 ? 0.01 : 0.2,
        peak: 0.3,
      })),
      observedLowerDecileRMS: 0.01,
      noiseFloorInterpretation: "unknown",
    },
  };
  const correspondence = {
    optimum: 1,
    left: [
      { indices: [0], omissionPossible: true },
      { indices: [], omissionPossible: true },
      { indices: [0], omissionPossible: true },
    ],
    right: [{ indices: [0, 2], omissionPossible: false }],
  };
  return {
    nativeReceipt: JSON.stringify(native),
    report: JSON.stringify(report),
    correspondence: JSON.stringify(correspondence),
  };
}
