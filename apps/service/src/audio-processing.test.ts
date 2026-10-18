import {
  applyBatch,
  createCompiler,
  validateComposition,
  type ProcessingStep,
  resolveOutputSettings,
} from "@yap/composition";
import { constants, readSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { readAudioWave } from "@yap/core/audio-wave";
import {
  audioProcessingEvidenceSchema,
  audioProcessingIssues,
  normalizationTolerance,
  selectNormalizationAttempt,
} from "@yap/core/audio-measurement";
import { checkProjectAudioResult } from "@yap/core/audio-inspection";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { callLocal } from "@yap/client";
import { setTimeout as delay } from "node:timers/promises";
import { startProjectService } from "./project-service.js";
import { test, expect, vi } from "vitest";
import {
  projectAudioRenderer,
  projectMovieRenderer,
  nativeAudioCapabilities,
} from "./project-render.js";
import { ffmpegLoudnessAnalyzer } from "./loudness.js";
import * as loudnessModule from "./loudness.js";
import { audioProcessingRuntime } from "./audio-processing.js";
import { mediaWorker } from "./worker.js";
const installation = process.env.YAP_FFMPEG_DIRECTORY;
const native = process.env.YAP_NATIVE;
const acceptanceEvidence = process.env.YAP_AUDIO_ACCEPTANCE_EVIDENCE;
function wave(frames: number, sample?: (frame: number) => [number, number]) {
  const b = Buffer.alloc(44 + frames * 8);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(384000, 28);
  b.writeUInt16LE(8, 32);
  b.writeUInt16LE(32, 34);
  b.write("data", 36);
  b.writeUInt32LE(frames * 8, 40);
  for (let i = 0; i < frames; i++) {
    const [left, right] = sample?.(i) ?? [0.8 * Math.sin(i * 0.17), 0.3 * Math.cos(i * 0.21)];
    b.writeFloatLE(left, 44 + i * 8);
    b.writeFloatLE(right, 48 + i * 8);
  }
  return b;
}
async function fixture(
  steps: ProcessingStep[],
  durationUs = 1000000,
  detector = false,
  clipProcessing = false,
) {
  const dir = await mkdtemp(join(tmpdir(), "typed-audio-"));
  const path = join(dir, "source.wav");
  await writeFile(path, wave((durationUs * 48000) / 1000000));
  const asset = {
    id: "a".repeat(64),
    streams: [
      {
        id: "track:1",
        kind: "audio" as const,
        channels: 2,
        sampleRate: 48000,
        bounds: { startUs: 0, endUs: durationUs },
        available: [{ startUs: 0, endUs: durationUs }],
      },
    ],
  };
  const document = {
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
    tracks: [
      { id: "audio", kind: "audio" as const, order: 0 },
      ...(detector ? [{ id: "detector", kind: "audio" as const, order: 1 }] : []),
    ],
    groups: [],
    syncGroups: [],
    clips: [
      {
        id: "clip",
        trackId: "audio",
        assetId: asset.id,
        streamId: "track:1",
        source: { kind: "range" as const, range: { startUs: 0, endUs: durationUs } },
        placement: { kind: "project" as const, range: { startUs: 0, endUs: durationUs } },
      },
      ...(detector
        ? [
            {
              id: "silent",
              trackId: "detector",
              source: { kind: "silence" as const },
              placement: { kind: "project" as const, range: { startUs: 0, endUs: durationUs } },
            },
          ]
        : []),
    ],
    processing: [
      {
        target: clipProcessing
          ? { kind: "clip" as const, id: "clip" }
          : { kind: "output" as const },
        steps,
      },
    ],
  };
  const worker = mediaWorker({ YAP_NATIVE: native });
  const capabilities = await nativeAudioCapabilities(worker);
  const runtime = await audioProcessingRuntime(
    {
      directory: installation!,
      receiptSha256:
        process.env.YAP_FFMPEG_RECEIPT ??
        "27350ff2f953bbd4d6ca8bfe0f6808b99b9752192657d289146b50319099f66a",
    },
    native,
    capabilities.statePreparation,
    new AbortController().signal,
  );
  const renderer = projectAudioRenderer(
    worker,
    join(dir, "render"),
    capabilities,
    new AbortController().signal,
    runtime,
  );
  const render = async (startUs: number, endUs: number, label: string, doc: unknown = document) => {
    const compiled = createCompiler(validateComposition(doc, [asset]), "revision").audioWindow({
      range: { startUs, endUs },
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const window = {
      ...compiled,
      manifest: {
        ...compiled.manifest,
        requirements: compiled.manifest.requirements.map((r) => ({
          ...r,
          implementationId:
            r.kind === "processor"
              ? (runtime?.processors[r.processor.type] ?? capabilities.rnnoise ?? null)
              : r.kind === "retime"
                ? (capabilities.retime ?? null)
                : r.implementationId,
        })),
      },
    };
    const output = join(dir, label + ".wav");
    await mkdir(join(dir, "render"), { recursive: true, mode: 0o700 });
    const receipt = await renderer.render(
      { window, assets: [{ assetId: asset.id, streamId: "track:1", path, originUs: 0 }], output },
      new AbortController().signal,
    );
    const file = await open(output);
    try {
      const bytes = await readFile(output);
      const audio = readAudioWave({
        bytes: bytes.length,
        read: (b, p) => readSync(file.fd, b, 0, b.length, p),
      });
      return {
        receipt,
        bytes: bytes.subarray(audio.dataOffset, audio.dataOffset + audio.dataBytes),
        // What a prepared or inspected publication of this receipt carries.
        issues: audioProcessingIssues(
          checkProjectAudioResult(receipt, window, output).processingEvidence ?? [],
        ),
      };
    } finally {
      await file.close();
    }
  };
  return { dir, document, asset, render, worker, capabilities, runtime };
}
const limiter = {
  id: "limit",
  enabled: true,
  processor: { type: "limiter" as const, ceilingDbfs: -6, lookaheadMs: 5, releaseMs: 50 },
};
const real = test.runIf(Boolean(native && installation));
/** The real meter over a published WAV, so a test checks the PCM itself and not only its evidence. */
async function measureWave(
  path: string,
  analyzer: typeof ffmpegLoudnessAnalyzer = ffmpegLoudnessAnalyzer,
) {
  const source = await open(path);
  try {
    const bytes = Number((await source.stat()).size);
    const audio = readAudioWave({
      bytes,
      read: (buffer, position) => readSync(source.fd, buffer, 0, buffer.length, position),
    });
    return await analyzer(
      { directory: installation!, receiptSha256: receiptSha256() },
      native,
    ).measure(
      { source: { fd: source.fd, bytes }, audio, channelInterpretation: "native", truePeak: true },
      new AbortController().signal,
    );
  } finally {
    await source.close();
  }
}
function receiptSha256() {
  return (
    process.env.YAP_FFMPEG_RECEIPT ??
    "27350ff2f953bbd4d6ca8bfe0f6808b99b9752192657d289146b50319099f66a"
  );
}
function normalizationOf(receipt: unknown) {
  return audioProcessingEvidenceSchema
    .array()
    .parse((receipt as { processingEvidence: unknown[] }).processingEvidence)
    .find((item) => item.normalization)!.normalization!;
}
function peakyDialogue(frame: number, peakLimited = false): [number, number] {
  const t = frame / 48000,
    phase = t % 0.6;
  const speech =
    (peakLimited ? 0.016 : 0.07) *
    (0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * t * 0.7))) *
    (Math.sin(2 * Math.PI * 211 * t) + 0.25 * Math.sin(2 * Math.PI * 733 * t));
  const kick =
    (peakLimited ? 0.65 : 0.4) *
    Math.sin(2 * Math.PI * (48 + 110 * Math.exp(-phase * 32)) * phase) *
    Math.exp(-phase * 15);
  const crash =
    (peakLimited ? 0.18 : 0.08) *
    (Math.sin(2 * Math.PI * 4017 * phase) + 0.4 * Math.sin(2 * Math.PI * 7031 * phase)) *
    Math.exp(-phase * 65) *
    Math.min(1, phase / 0.001);
  const taper = Math.min(1, t / 0.1, (12 - t - 1 / 48000) / 0.1);
  return [taper * (speech + kick + crash), taper * (0.7 * speech + kick + 0.65 * crash)];
}
real(
  "bounded dynamic mastering meets the peaky dialogue target without changing requested constraints",
  async () => {
    const normalization: ProcessingStep = {
      id: "normalize",
      enabled: true,
      processor: {
        type: "normalization",
        mode: "dynamic",
        targetIntegratedLufs: -14.5,
        truePeakCeilingDbtp: 0,
        maxLoudnessRangeLu: 7,
      },
    };
    const f = await fixture([normalization], 12000000);
    let passed = false;
    try {
      const source = wave(576000, peakyDialogue);
      await writeFile(join(f.dir, "source.wav"), source);
      const full = await f.render(0, 12000000, "mastered");
      expect(full.receipt).toMatchObject({
        frames: 576000,
        processingEvidence: [
          {
            recipe: normalization.processor,
            normalization: {
              after: {
                integratedLufs: expect.any(Number),
                loudnessRangeLu: expect.any(Number),
                truePeakDbtp: expect.any(Number),
              },
            },
          },
        ],
      });
      const evidence = audioProcessingEvidenceSchema
        .array()
        .parse(
          (full.receipt as { processingEvidence: unknown[] }).processingEvidence,
        )[0]!.normalization!;
      expect(Math.abs(evidence.after.integratedLufs! + 14.5)).toBeLessThanOrEqual(
        normalizationTolerance.integratedAbsoluteLu,
      );
      expect(evidence.after.truePeakDbtp!).toBeLessThanOrEqual(
        normalizationTolerance.meterSpecificTruePeakExcessDb,
      );
      expect(evidence.after.loudnessRangeLu!).toBeLessThanOrEqual(
        7 + normalizationTolerance.rangeMaximumExcessLu,
      );
      expect(evidence.attempts.at(-1)!.after).toEqual(evidence.after);
      expect(evidence.attempts.length).toBeGreaterThan(1);
      expect(await readFile(join(f.dir, "source.wav"))).toEqual(source);
      if (acceptanceEvidence) {
        const retained = join(acceptanceEvidence, "mastering");
        await mkdir(retained, { recursive: true });
        await copyFile(join(f.dir, "source.wav"), join(retained, "source.wav"));
        await copyFile(join(f.dir, "mastered.wav"), join(retained, "mastered.wav"));
        await writeFile(
          join(retained, "evidence.json"),
          JSON.stringify(
            {
              requested: normalization.processor,
              evidence,
              frames: 576000,
              sourceSha256: createHash("sha256").update(source).digest("hex"),
              outputSha256: createHash("sha256")
                .update(await readFile(join(f.dir, "mastered.wav")))
                .digest("hex"),
            },
            null,
            2,
          ),
        );
      }
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified peaky mastering operands retained: ${f.dir}\n`);
    }
  },
  30000,
);
real(
  "dynamic mastering publishes its best candidate with an issue when the meter stalls",
  async () => {
    // Controlled scanner output proves progress/lifetime; the peaky case proves actual accuracy.
    const actualAnalyzer = loudnessModule.ffmpegLoudnessAnalyzer;
    const spy = vi.spyOn(loudnessModule, "ffmpegLoudnessAnalyzer").mockImplementation((...args) => {
      const actual = actualAnalyzer(...args);
      return {
        ...actual,
        async measure(...operands) {
          const measured = await actual.measure(...operands);
          return { ...measured, integratedLufs: -14.9, loudnessRangeLu: 1, truePeakDbtp: 0 };
        },
      };
    });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(
        [
          {
            id: "normalize",
            enabled: true,
            processor: {
              type: "normalization",
              mode: "dynamic",
              targetIntegratedLufs: -14.5,
              truePeakCeilingDbtp: 0,
              maxLoudnessRangeLu: 7,
            },
          },
        ],
        12000000,
      );
      await writeFile(join(f.dir, "source.wav"), wave(576000, peakyDialogue));
      const stalled = await f.render(0, 12000000, "stalled");
      expect(normalizationOf(stalled.receipt)).toMatchObject({
        selectedAttempt: 0,
        attempts: [{ after: { integratedLufs: -14.9 } }, { after: { integratedLufs: -14.9 } }],
      });
      expect(stalled.issues).toEqual([
        {
          code: "normalization-target-unmet",
          message: expect.any(String),
          evidence: {
            mode: "dynamic",
            domainIndex: 0,
            missed: [
              {
                target: "integrated-loudness",
                requested: -14.5,
                achieved: -14.9,
                excess: expect.closeTo(0.4, 9),
              },
            ],
            attempts: 2,
            selectedAttempt: 0,
            stopReason: "no-progress",
          },
        },
      ]);
      expect(stalled.bytes.length).toBe(576000 * 8);
    } finally {
      spy.mockRestore();
      if (f) await rm(f.dir, { recursive: true, force: true });
    }
  },
  30000,
);
real(
  "dynamic mastering retains an admitted candidate when interior correction regresses",
  async () => {
    const actualAnalyzer = loudnessModule.ffmpegLoudnessAnalyzer;
    let ordinal = 0;
    const spy = vi.spyOn(loudnessModule, "ffmpegLoudnessAnalyzer").mockImplementation((...args) => {
      const actual = actualAnalyzer(...args);
      return {
        ...actual,
        async measure(...operands) {
          const measured = await actual.measure(...operands);
          return {
            ...measured,
            integratedLufs: [-22.3, -14.65, -15][ordinal++]!,
            loudnessRangeLu: 1,
            truePeakDbtp: 0,
          };
        },
      };
    });
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(
        [
          {
            id: "normalize",
            enabled: true,
            processor: {
              type: "normalization",
              mode: "dynamic",
              targetIntegratedLufs: -14.5,
              truePeakCeilingDbtp: 0,
              maxLoudnessRangeLu: 7,
            },
          },
        ],
        12000000,
      );
      await writeFile(join(f.dir, "source.wav"), wave(576000, peakyDialogue));
      const output = await f.render(0, 12000000, "retained-candidate");
      expect(output.receipt).toMatchObject({
        processingEvidence: [
          {
            normalization: {
              selectedAttempt: 0,
              after: { integratedLufs: -14.65 },
              attempts: [{ after: { integratedLufs: -14.65 } }, { after: { integratedLufs: -15 } }],
            },
          },
        ],
      });
      expect(output.bytes.length).toBe(576000 * 8);
      expect(output.issues).toEqual([]);
    } finally {
      spy.mockRestore();
      if (f) await rm(f.dir, { recursive: true, force: true });
    }
  },
  30000,
);
real(
  "peak-limited dynamic mastering publishes its best bounded correction with an issue",
  async () => {
    const f = await fixture(
      [
        {
          id: "normalize",
          enabled: true,
          processor: {
            type: "normalization",
            mode: "dynamic",
            targetIntegratedLufs: -14.5,
            truePeakCeilingDbtp: 0,
            maxLoudnessRangeLu: 7,
          },
        },
      ],
      12000000,
    );
    try {
      const source = wave(576000, (i) => peakyDialogue(i, true));
      await writeFile(join(f.dir, "source.wav"), source);
      const limited = await f.render(0, 12000000, "peak-limited");
      const evidence = normalizationOf(limited.receipt);
      expect(evidence.attempts).toHaveLength(3);
      expect(evidence.selectedAttempt).toBe(
        selectNormalizationAttempt(
          {
            type: "normalization",
            mode: "dynamic",
            targetIntegratedLufs: -14.5,
            truePeakCeilingDbtp: 0,
            maxLoudnessRangeLu: 7,
          },
          evidence.attempts,
        ),
      );
      expect(limited.issues).toEqual([
        {
          code: "normalization-target-unmet",
          message: expect.any(String),
          evidence: {
            mode: "dynamic",
            domainIndex: 0,
            missed: expect.arrayContaining([
              expect.objectContaining({
                target: "integrated-loudness",
                achieved: evidence.after.integratedLufs,
              }),
            ]),
            attempts: 3,
            selectedAttempt: evidence.selectedAttempt,
            stopReason: "budget-exhausted",
          },
        },
      ]);
      // The published PCM is the selected candidate, as the meter reads it.
      expect(await measureWave(join(f.dir, "peak-limited.wav"))).toEqual(evidence.after);
      expect(await readFile(join(f.dir, "source.wav"))).toEqual(source);
      if (acceptanceEvidence) {
        const retained = join(acceptanceEvidence, "peak-limited");
        await mkdir(retained, { recursive: true });
        await writeFile(
          join(retained, "issues.json"),
          JSON.stringify({ evidence, issues: limited.issues }, null, 2),
        );
      }
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  },
  30000,
);
real(
  "bundled limiter renders the full state domain before an exact late crop",
  async () => {
    const f = await fixture([limiter]);
    let passed = false;
    try {
      const full = await f.render(0, 1000000, "full"),
        excerpt = await f.render(800000, 900000, "excerpt");
      expect(excerpt.receipt).toMatchObject({
        frames: 4800,
        processingEvidence: [
          { domainIndex: 0, sampleRange: { start: 0, end: 48000 }, recipe: { type: "limiter" } },
        ],
      });
      expect(excerpt.bytes.equals(full.bytes.subarray(38400 * 8, 43200 * 8))).toBe(true);
      let peak = 0;
      for (let at = 0; at < full.bytes.length; at += 4)
        peak = Math.max(peak, Math.abs(full.bytes.readFloatLE(at)));
      expect(peak).toBeLessThanOrEqual(10 ** (-6 / 20) + 1e-6);
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);
real(
  "compressor makeup is an explicit post-compression gain and bypass remains dry",
  async () => {
    const base = {
      id: "compress",
      enabled: true,
      processor: {
        type: "compressor" as const,
        thresholdDbfs: -12,
        ratio: 4,
        kneeDb: 3,
        attackMs: 5,
        releaseMs: 50,
        detector: { kind: "input" as const },
      },
    };
    const f = await fixture([base]);
    try {
      const control = await f.render(0, 1000000, "unity");
      const boostedDocument = {
        ...f.document,
        processing: [
          {
            target: { kind: "output" as const },
            steps: [{ ...base, processor: { ...base.processor, makeupGainDb: 6 } }],
          },
        ],
      };
      const boosted = await f.render(0, 1000000, "makeup", boostedDocument);
      let delta = 0;
      for (let at = 0; at < control.bytes.length; at += 4)
        delta = Math.max(
          delta,
          Math.abs(boosted.bytes.readFloatLE(at) - control.bytes.readFloatLE(at) * 10 ** (6 / 20)),
        );
      expect(delta).toBeLessThanOrEqual(1e-6);
      expect(boosted.receipt).toMatchObject({
        processingEvidence: [{ recipe: { type: "compressor", makeupGainDb: 6 } }],
      });
      const bypass = await f.render(0, 1000000, "bypassed", {
        ...boostedDocument,
        processing: [
          {
            ...boostedDocument.processing[0],
            steps: [{ ...boostedDocument.processing[0]!.steps[0]!, enabled: false }],
          },
        ],
      });
      expect(bypass.bytes.equals(wave(48000).subarray(44))).toBe(true);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  },
  30000,
);
real(
  "a declared silent sidechain leaves signed stereo program unchanged",
  async () => {
    const f = await fixture(
      [
        {
          id: "compress",
          enabled: true,
          processor: {
            type: "compressor",
            thresholdDbfs: -20,
            ratio: 4,
            kneeDb: 3,
            attackMs: 5,
            releaseMs: 50,
            detector: {
              kind: "tap",
              tap: { target: { kind: "track", id: "detector" }, point: { kind: "processed" } },
            },
          },
        },
      ],
      1000000,
      true,
    );
    let passed = false;
    try {
      const result = await f.render(0, 1000000, "sidechain");
      const original = wave(48000).subarray(44);
      let delta = 0;
      for (let at = 0; at < original.length; at += 4)
        delta = Math.max(delta, Math.abs(result.bytes.readFloatLE(at) - original.readFloatLE(at)));
      expect(delta).toBeLessThanOrEqual(1e-6);
      expect(result.receipt).toMatchObject({
        processingEvidence: [{ recipe: { type: "compressor" } }],
      });
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);
real(
  "RNNoise and FF recipes compose across a shared split and late window",
  async () => {
    const f = await fixture(
      [
        { id: "first-noise", enabled: true, processor: { type: "rnnoise" } },
        limiter,
        { id: "last-noise", enabled: true, processor: { type: "rnnoise" } },
      ],
      1000000,
      false,
      true,
    );
    let passed = false;
    try {
      const full = await f.render(0, 1000000, "full"),
        excerpt = await f.render(800000, 900000, "excerpt");
      expect(excerpt.bytes.equals(full.bytes.subarray(38400 * 8, 43200 * 8))).toBe(true);
      const split = applyBatch(
        f.document,
        [{ operation: "split", clipIds: ["clip"], atUs: 500000, scope: "selected" }],
        { assets: [f.asset], namespace: "split" },
      );
      const splitOutput = await f.render(0, 1000000, "split", split.document);
      expect(splitOutput.bytes.equals(full.bytes)).toBe(true);
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);
real(
  "a source gap splits RNNoise and limiter state: the run after it matches a program that starts there",
  async () => {
    const f = await fixture(
      [{ id: "noise", enabled: true, processor: { type: "rnnoise" } }, limiter],
      1000000,
    );
    let passed = false;
    try {
      f.asset.streams[0]!.available = [
        { startUs: 0, endUs: 250000 },
        { startUs: 500000, endUs: 1000000 },
      ];
      const gapped = await f.render(0, 1000000, "gapped");
      // The gap stays unavailable, never silence handed to a processor as input.
      expect(gapped.receipt).toMatchObject({
        unavailable: [{ clipId: "clip", ranges: [{ start: 12000, end: 24000 }] }],
      });
      const clip = f.document.clips[0]!;
      const late = {
        ...f.document,
        clips: [
          {
            ...clip,
            source: { kind: "range" as const, range: { startUs: 500000, endUs: 1000000 } },
            placement: { kind: "project" as const, range: { startUs: 500000, endUs: 1000000 } },
          },
        ],
      };
      const fresh = await f.render(0, 1000000, "fresh", late);
      // State restarts at the gap: nothing learned before it reaches the run after it.
      expect(gapped.bytes.subarray(24000 * 8).equals(fresh.bytes.subarray(24000 * 8))).toBe(true);
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);
real(
  "gain-only and dynamic normalization retain complete measurements; infeasible gain lets the ceiling win",
  async () => {
    for (const mode of ["gain-only", "dynamic"] as const) {
      const f = await fixture(
        [
          {
            id: "normalize",
            enabled: true,
            processor: {
              type: "normalization",
              mode,
              targetIntegratedLufs: -20,
              truePeakCeilingDbtp: -2,
              maxLoudnessRangeLu: 7,
            },
          },
        ],
        8000000,
      );
      let passed = false;
      try {
        const result = await f.render(7000000, 7100000, "normalized");
        expect(result.receipt).toMatchObject({
          frames: 4800,
          processingEvidence: [
            {
              recipe: { type: "normalization", mode },
              sampleRange: { start: 0, end: 384000 },
              normalization: { after: { integratedLufs: expect.closeTo(-20, 1) } },
            },
          ],
        });
        if (mode === "gain-only") {
          const impossible = structuredClone(f.document);
          impossible.processing[0]!.steps[0]!.processor = {
            type: "normalization",
            mode,
            targetIntegratedLufs: -5,
            truePeakCeilingDbtp: -9,
            maxLoudnessRangeLu: 7,
          };
          const limited = await f.render(0, 8000000, "ceiling", impossible);
          const { before, after } = normalizationOf(limited.receipt);
          expect(limited.issues).toEqual([
            {
              code: "normalization-target-unmet",
              message: expect.any(String),
              evidence: {
                mode: "gain-only",
                domainIndex: 0,
                missed: [
                  {
                    target: "integrated-loudness",
                    requested: -5,
                    achieved: after.integratedLufs,
                    excess: Math.abs(after.integratedLufs! + 5),
                  },
                ],
                requestedGainDb: -5 - before.integratedLufs!,
                gainDb: -9 - before.truePeakDbtp!,
                peakToLoudnessDb: before.truePeakDbtp! - before.integratedLufs!,
                maximumFeasibleTargetLufs: -9 - before.truePeakDbtp! + before.integratedLufs!,
              },
            },
          ]);
          // The ceiling won: the published PCM meets the peak ceiling and misses loudness.
          const published = await measureWave(join(f.dir, "ceiling.wav"));
          expect(published).toEqual(after);
          expect(published.truePeakDbtp!).toBeLessThanOrEqual(
            -9 + normalizationTolerance.meterSpecificTruePeakExcessDb,
          );
          expect(published.integratedLufs!).toBeLessThan(-5 - 1);
        }
        passed = true;
      } finally {
        if (passed) await rm(f.dir, { recursive: true, force: true });
        else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
      }
    }
  },
  30000,
);

real(
  "dynamic normalization publishes a stepped whole-domain LRA miss to excerpts with its issue",
  async () => {
    const f = await fixture(
      [
        {
          id: "normalize",
          enabled: true,
          processor: {
            type: "normalization",
            mode: "dynamic",
            targetIntegratedLufs: -18,
            truePeakCeilingDbtp: -1,
            maxLoudnessRangeLu: 7,
          },
        },
      ],
      12000000,
    );
    let passed = false;
    try {
      await writeFile(
        join(f.dir, "source.wav"),
        wave(48000 * 12, (i) => {
          const amp = i < 48000 * 4 ? 0.05 : i < 48000 * 8 ? 0.15 : 0.03;
          const taper = Math.min(1, i / (48000 * 0.05), (48000 * 12 - 1 - i) / (48000 * 0.05));
          const v =
            amp *
            taper *
            (Math.sin((2 * Math.PI * 997 * i) / 48000) +
              0.2 * Math.sin((2 * Math.PI * 233 * i) / 48000));
          return [v, v];
        }),
      );
      const full = await f.render(0, 12000000, "full");
      const excerpt = await f.render(11000000, 11100000, "excerpt");
      const { after } = normalizationOf(full.receipt);
      expect(after.loudnessRangeLu!).toBeGreaterThan(
        7 + normalizationTolerance.rangeMaximumExcessLu,
      );
      expect(await measureWave(join(f.dir, "full.wav"))).toEqual(after);
      // A ranged read treats the whole domain, so it carries the same issue as the full read.
      expect(excerpt.issues).toEqual(full.issues);
      expect(excerpt.issues).toMatchObject([
        {
          code: "normalization-target-unmet",
          evidence: {
            mode: "dynamic",
            missed: expect.arrayContaining([
              {
                target: "loudness-range",
                requested: 7,
                achieved: after.loudnessRangeLu,
                excess: expect.closeTo(after.loudnessRangeLu! - 7, 9),
              },
            ]),
          },
        },
      ]);
      expect(excerpt.bytes.equals(full.bytes.subarray(528000 * 8, 532800 * 8))).toBe(true);
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);

real(
  "an unmeasurable complete signal passes through normalization at unity with an issue",
  async () => {
    const f = await fixture(
      [
        {
          id: "normalize",
          enabled: true,
          processor: {
            type: "normalization",
            mode: "gain-only",
            targetIntegratedLufs: -20,
            truePeakCeilingDbtp: -2,
            maxLoudnessRangeLu: 7,
          },
        },
      ],
      8000000,
    );
    let passed = false;
    try {
      await writeFile(
        join(f.dir, "source.wav"),
        wave(384000, () => [0, 0]),
      );
      const silent = await f.render(0, 8000000, "unity");
      expect(silent.issues).toEqual([
        {
          code: "normalization-unmeasurable",
          message: expect.any(String),
          evidence: { domainIndex: 0, measurement: "integrated-loudness", reason: "below-gate" },
        },
      ]);
      expect(silent.bytes.equals(wave(384000, () => [0, 0]).subarray(44))).toBe(true);
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);

real(
  "program and detector source holes split complete recipe context before a late crop",
  async () => {
    const cases: ProcessingStep[][] = [
      [limiter],
      [
        {
          id: "normalize",
          enabled: true,
          processor: {
            type: "normalization",
            mode: "gain-only",
            targetIntegratedLufs: -20,
            truePeakCeilingDbtp: -2,
            maxLoudnessRangeLu: 7,
          },
        },
      ],
      [
        {
          id: "compress",
          enabled: true,
          processor: {
            type: "compressor",
            thresholdDbfs: -20,
            ratio: 4,
            kneeDb: 3,
            attackMs: 5,
            releaseMs: 50,
            detector: {
              kind: "tap",
              tap: { target: { kind: "track", id: "detector" }, point: { kind: "dry" } },
            },
          },
        },
      ],
    ];
    for (const steps of cases) {
      const external = steps[0]!.processor.type === "compressor";
      const f = await fixture(steps, 8000000, external);
      let passed = false;
      try {
        const original = await readFile(join(f.dir, "source.wav"));
        f.asset.streams[0]!.available = [
          { startUs: 0, endUs: 1000000 },
          { startUs: 2000000, endUs: 8000000 },
        ];
        const document = external
          ? {
              ...f.document,
              clips: [
                {
                  id: "clip",
                  trackId: "audio",
                  source: { kind: "silence" },
                  placement: { kind: "project", range: { startUs: 0, endUs: 8000000 } },
                },
                { ...f.document.clips[0]!, id: "source-detector", trackId: "detector" },
              ],
            }
          : f.document;
        // The crop's whole domain is the run after the hole; nothing before the hole is learned.
        const cropped = await f.render(7000000, 7100000, "split-hole", document);
        expect(
          audioProcessingEvidenceSchema
            .array()
            .parse((cropped.receipt as { processingEvidence: unknown[] }).processingEvidence)
            .map((item) => item.sampleRange),
        ).toEqual([{ start: 96000, end: 384000 }]);
        expect(await readFile(join(f.dir, "source.wav"))).toEqual(original);
        passed = true;
      } finally {
        if (passed) await rm(f.dir, { recursive: true, force: true });
        else process.stderr.write(`Unverified source-hole operands retained: ${f.dir}\n`);
      }
    }
  },
  30000,
);

real(
  "retimed repeated recipe domains preserve split and late-crop PCM",
  async () => {
    for (const mode of ["gain-only", "dynamic"] as const) {
      const f = await fixture(
        [
          {
            id: "normalize",
            enabled: true,
            processor: {
              type: "normalization",
              mode,
              targetIntegratedLufs: -20,
              truePeakCeilingDbtp: -2,
              maxLoudnessRangeLu: 7,
            },
          },
          limiter,
          {
            id: "compress",
            enabled: true,
            processor: {
              type: "compressor",
              thresholdDbfs: -24,
              ratio: 4,
              kneeDb: 3,
              attackMs: 5,
              releaseMs: 50,
              detector: { kind: "input" },
            },
          },
        ],
        8000000,
        false,
        true,
      );
      let passed = false;
      try {
        const original = await readFile(join(f.dir, "source.wav"));
        const retimed = applyBatch(
          f.document,
          [{ operation: "retime", clipIds: ["clip"], durationUs: 12000000, ripple: "none" }],
          { assets: [f.asset], namespace: "retime" },
        ).document;
        const repeated = {
          ...retimed,
          clips: [
            ...retimed.clips,
            {
              ...structuredClone(retimed.clips[0]!),
              id: "repeat",
              placement: { kind: "project", range: { startUs: 12000000, endUs: 24000000 } },
            },
          ],
          processing: [
            ...retimed.processing,
            {
              ...structuredClone(retimed.processing[0]!),
              target: { kind: "clip", id: "repeat" },
              steps: retimed.processing[0]!.steps.map((step) => ({
                ...step,
                id: `repeat-${step.id}`,
              })),
            },
          ],
        };
        const split = applyBatch(
          repeated,
          [
            { operation: "split", clipIds: ["clip"], atUs: 6000000, scope: "selected" },
            { operation: "split", clipIds: ["repeat"], atUs: 18000000, scope: "selected" },
          ],
          { assets: [f.asset], namespace: "split" },
        ).document;
        const full = await f.render(0, 24000000, "repeated", repeated);
        const partitioned = await f.render(0, 24000000, "split", split);
        const late = await f.render(11000000, 11100000, "late", repeated);
        const maximumDelta = (a: Buffer, b: Buffer) => {
          expect(a.length).toBe(b.length);
          let delta = 0;
          for (let at = 0; at < a.length; at += 4)
            delta = Math.max(delta, Math.abs(a.readFloatLE(at) - b.readFloatLE(at)));
          return delta;
        };
        expect(full.receipt).toMatchObject({
          frames: 1152000,
          processingEvidence: [
            { recipe: { type: "normalization" }, sampleRange: { start: 0, end: 576000 } },
            { recipe: { type: "limiter" }, sampleRange: { start: 0, end: 576000 } },
            { recipe: { type: "compressor" }, sampleRange: { start: 0, end: 576000 } },
            { recipe: { type: "normalization" }, sampleRange: { start: 576000, end: 1152000 } },
            { recipe: { type: "limiter" }, sampleRange: { start: 576000, end: 1152000 } },
            { recipe: { type: "compressor" }, sampleRange: { start: 576000, end: 1152000 } },
          ],
        });
        expect(maximumDelta(partitioned.bytes, full.bytes)).toBeLessThanOrEqual(1e-6);
        expect(
          maximumDelta(late.bytes, full.bytes.subarray(528000 * 8, 532800 * 8)),
        ).toBeLessThanOrEqual(1e-6);
        expect(
          maximumDelta(full.bytes.subarray(0, 576000 * 8), full.bytes.subarray(576000 * 8)),
        ).toBeLessThanOrEqual(1e-6);
        expect(await readFile(join(f.dir, "source.wav"))).toEqual(original);
        passed = true;
      } finally {
        if (passed) await rm(f.dir, { recursive: true, force: true });
        else process.stderr.write(`Unverified retimed operands retained: ${f.dir}\n`);
      }
    }
  },
  60000,
);

real(
  "movie mux consumes the same held limited domain",
  async () => {
    const f = await fixture([limiter]);
    let passed = false;
    try {
      const model = validateComposition(f.document, [f.asset]);
      const window = createCompiler(model, "revision").window({
        range: { startUs: 0, endUs: 1000000 },
        rendition: { sampleRate: 48000, channels: 2 },
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
      });
      const renderer = projectMovieRenderer(
        f.worker,
        join(f.dir, "render"),
        undefined,
        f.capabilities,
        new AbortController().signal,
        {},
        f.runtime,
      );
      const output = join(f.dir, "movie.mp4");
      const movie = await renderer.render(
        {
          model,
          window,
          assets: [
            {
              assetId: f.asset.id,
              streamId: "track:1",
              path: join(f.dir, "source.wav"),
              originUs: 0,
            },
          ],
          fonts: [],
          luts: [],
          maxLongEdge: null,
          output,
          settings: resolveOutputSettings(),
        },
        new AbortController().signal,
      );
      expect(movie).toMatchObject({
        file: output,
        frameCount: 30,
        audio: {
          frames: 48000,
          sampleRate: 48000,
          channels: 2,
          processingEvidence: [
            { recipe: { type: "limiter" }, sampleRange: { start: 0, end: 48000 } },
          ],
        },
      });
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);

real(
  "a movie with an impossible gain target renders ceiling-limited audio whose evidence carries the issue",
  async () => {
    const f = await fixture(
      [
        {
          id: "normalize",
          enabled: true,
          processor: {
            type: "normalization",
            mode: "gain-only",
            targetIntegratedLufs: -5,
            truePeakCeilingDbtp: -9,
            maxLoudnessRangeLu: 7,
          },
        },
      ],
      8000000,
    );
    let passed = false;
    try {
      const model = validateComposition(f.document, [f.asset]);
      const compiled = createCompiler(model, "revision").window({
        range: { startUs: 0, endUs: 8000000 },
        rendition: { sampleRate: 48000, channels: 2 },
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
      });
      const window = {
        ...compiled,
        manifest: {
          ...compiled.manifest,
          requirements: compiled.manifest.requirements.map((r) => ({
            ...r,
            implementationId:
              r.kind === "processor"
                ? (f.runtime!.processors[r.processor.type] ?? null)
                : r.kind === "executor"
                  ? "preflight-movie"
                  : r.implementationId,
          })),
        },
      };
      const renderer = projectMovieRenderer(
        f.worker,
        join(f.dir, "render"),
        undefined,
        f.capabilities,
        new AbortController().signal,
        {},
        f.runtime,
      );
      const output = join(f.dir, "delivered.mp4");
      const movie = await renderer.render(
        {
          model,
          window,
          assets: [
            {
              assetId: f.asset.id,
              streamId: "track:1",
              path: join(f.dir, "source.wav"),
              originUs: 0,
            },
          ],
          fonts: [],
          luts: [],
          maxLongEdge: null,
          output,
          settings: resolveOutputSettings(),
        },
        new AbortController().signal,
      );
      expect(movie).toMatchObject({ file: output, audio: { frames: 384000 } });
      expect(
        audioProcessingIssues(
          audioProcessingEvidenceSchema.array().parse(movie.audio!.processingEvidence),
        ),
      ).toMatchObject([
        {
          code: "normalization-target-unmet",
          evidence: {
            mode: "gain-only",
            missed: [{ target: "integrated-loudness", requested: -5 }],
          },
        },
      ]);
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified movie operands retained: ${f.dir}\n`);
    }
  },
  30000,
);
real(
  "a movie export with an unmet loudness target commits, and its status and prepared audio carry the issue",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "unmet-export-")));
    let service: Awaited<ReturnType<typeof startProjectService>> | undefined;
    let passed = false;
    try {
      const path = join(home, "source.wav");
      await writeFile(path, wave(384000));
      service = await startProjectService({
        home,
        nativeExecutable: native!,
        worker: mediaWorker({ YAP_NATIVE: native }),
        ffmpeg: { directory: installation!, receiptSha256: receiptSha256() },
      });
      const call = async <T>(operation: string, params: Record<string, unknown>) => {
        const result = await callLocal(service!.socketPath, { id: "unmet", operation, params });
        if (!result.ok) throw Error(JSON.stringify(result));
        return result.data as T;
      };
      const settled = async <T extends { state: string }>(
        read: () => Promise<T>,
        done: (value: T) => boolean,
      ) => {
        const deadline = performance.now() + 20000;
        for (;;) {
          const value = await read();
          if (done(value)) return value;
          if (
            ["failed", "canceled", "unavailable", "conflicted"].includes(value.state) ||
            performance.now() > deadline
          )
            throw Error(JSON.stringify(value));
          await delay(10);
        }
      };
      const imported = await call<{ jobId: string }>("asset.import", { requestId: "source", path });
      const importedJob = await settled(
        () =>
          call<{ state: string; published: { output: { assetId: string } } | null }>("job.get", {
            jobId: imported.jobId,
          }),
        (value) => value.state === "ready",
      );
      const created = await call<{ project: { projectId: string }; revision: { id: string } }>(
        "project.create",
        {
          requestId: "project",
          canvas: {
            width: 16,
            height: 16,
            fps: { numerator: 30, denominator: 1 },
            background: "#000000ff",
          },
        },
      );
      const edited = await call<{ revision: { id: string } }>("edit.apply", {
        projectId: created.project.projectId,
        expectedRevisionId: created.revision.id,
        requestId: "media",
        operations: [
          { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
          {
            operation: "place",
            clip: {
              trackId: { label: "audio" },
              assetId: importedJob.published!.output.assetId,
              streamId: "track:1",
              source: { kind: "range", range: { startUs: 0, endUs: 8000000 } },
              placement: { kind: "project", range: { startUs: 0, endUs: 8000000 } },
            },
          },
          {
            operation: "processing.set",
            target: { kind: "output" },
            steps: [
              {
                processor: {
                  type: "normalization",
                  mode: "gain-only",
                  targetIntegratedLufs: -5,
                  truePeakCeilingDbtp: -9,
                  maxLoudnessRangeLu: 7,
                },
              },
            ],
          },
        ],
      });
      const selection = { projectId: created.project.projectId, revisionId: edited.revision.id };
      const exportId = randomUUID();
      await call("export.create", {
        ...selection,
        requestId: exportId,
        kind: "video",
        directory: home,
        leaf: "delivered.mp4",
      });
      const committed = await settled(
        () => call<{ state: string; jobId: string }>("export.status", { exportId }),
        (value) => value.state === "ready",
      );
      // The receipt commits before the export job publishes the issues it carries.
      await settled(
        () => call<{ state: string }>("job.get", { jobId: committed.jobId }),
        (value) => value.state === "ready",
      );
      const exported = await call<{ issues: { code: string; evidence: unknown }[] }>(
        "export.status",
        { exportId },
      );
      expect(exported.issues).toMatchObject([
        {
          code: "normalization-target-unmet",
          evidence: {
            mode: "gain-only",
            missed: [{ target: "integrated-loudness", requested: -5 }],
          },
        },
      ]);
      expect((await readFile(join(home, "delivered.mp4"))).length).toBeGreaterThan(0);
      type Prepared = {
        state: string;
        jobId: string;
        published: { issues: unknown[] } | null;
      };
      const pending = await call<Prepared>("audio.prepare", selection);
      const prepared = await settled(
        () => call<Prepared>("audio.prepare", selection),
        (value) => value.state === "ready" && value.jobId === pending.jobId,
      );
      expect(prepared.published!.issues).toEqual(exported.issues);
      passed = true;
    } finally {
      await service?.close();
      if (passed) await rm(home, { recursive: true, force: true });
      else process.stderr.write(`Unverified export operands retained: ${home}\n`);
    }
  },
  60000,
);
real.each([
  { mode: "gain-only" as const, target: -6, peak: -1, duration: 8000000, peaky: false },
  { mode: "dynamic" as const, target: -14.5, peak: 0, duration: 12000000, peaky: true },
])(
  "AAC $mode delivery retains separately measured decoded peak evidence",
  async ({ mode, target, peak, duration, peaky }) => {
    const normalization: ProcessingStep = {
      id: "normalize",
      enabled: true,
      processor: {
        type: "normalization",
        mode,
        targetIntegratedLufs: target,
        truePeakCeilingDbtp: peak,
        maxLoudnessRangeLu: 7,
      },
    };
    const steps = peaky ? [normalization] : [normalization, limiter];
    const f = await fixture(steps, duration);
    let passed = false;
    try {
      if (peaky) await writeFile(join(f.dir, "source.wav"), wave(576000, peakyDialogue));
      const pcm = await f.render(0, duration, "prepared");
      const model = validateComposition(f.document, [f.asset]);
      const window = createCompiler(model, "revision").window({
        range: { startUs: 0, endUs: duration },
        rendition: { sampleRate: 48000, channels: 2 },
        tap: { target: { kind: "output" }, point: { kind: "processed" } },
      });
      const settings = resolveOutputSettings();
      const output = join(f.dir, "delivery.mp4");
      const movie = await projectMovieRenderer(
        f.worker,
        join(f.dir, "render"),
        undefined,
        f.capabilities,
        new AbortController().signal,
        {},
        f.runtime,
      ).render(
        {
          model,
          window,
          assets: [
            {
              assetId: f.asset.id,
              streamId: "track:1",
              path: join(f.dir, "source.wav"),
              originUs: 0,
            },
          ],
          fonts: [],
          luts: [],
          maxLongEdge: null,
          output,
          settings,
        },
        new AbortController().signal,
      );
      const probed = await f.worker("media.probe", { path: output });
      if (!probed.ok) throw new Error(JSON.stringify(probed));
      const stream = (probed.data as { streams: { kind: string; id: string }[] }).streams.find(
        (stream) => stream.kind === "audio",
      )!;
      const decoded = join(f.dir, "decoded.wav");
      const range = { startUs: 0, endUs: duration };
      const decode = await f.worker("media.sourceAudio", {
        source: { source: output, streamId: stream.id, sourceOffsetUs: 0, available: [range] },
        range,
        output: decoded,
      });
      if (!decode.ok) throw new Error(JSON.stringify(decode));
      const measure = async (path: string) => {
        const source = await open(path);
        try {
          const bytes = Number((await source.stat()).size);
          const audio = readAudioWave({
            bytes,
            read: (buffer, position) => readSync(source.fd, buffer, 0, buffer.length, position),
          });
          return {
            audio,
            measured: await ffmpegLoudnessAnalyzer(f.runtime!.installation, native).measure(
              {
                source: { fd: source.fd, bytes },
                audio,
                channelInterpretation: "native",
                truePeak: true,
              },
              new AbortController().signal,
            ),
          };
        } finally {
          await source.close();
        }
      };
      const prepared = await measure(join(f.dir, "prepared.wav"));
      const delivered = await measure(decoded);
      const evidence = {
        settings,
        sourceSha256: createHash("sha256")
          .update(await readFile(join(f.dir, "source.wav")))
          .digest("hex"),
        requested: steps.map((step) => step.processor),
        prepared: prepared.measured,
        encodedDecoded: delivered.measured,
        movie: movie.audio,
        decodedFrames: delivered.audio.frames,
      };
      await writeFile(join(f.dir, "encoded-evidence.json"), JSON.stringify(evidence, null, 2));
      if (acceptanceEvidence) {
        const retained = join(acceptanceEvidence, `encoded-${mode}`);
        await mkdir(retained, { recursive: true });
        for (const filename of [
          "source.wav",
          "prepared.wav",
          "delivery.mp4",
          "decoded.wav",
          "encoded-evidence.json",
        ])
          await copyFile(join(f.dir, filename), join(retained, filename));
      }
      expect(settings.audio.codec).toBe("aac");
      expect(delivered.audio.frames).toBe((duration * 48000) / 1000000);
      expect(delivered.measured.truePeakDbtp).toEqual(expect.any(Number));
      expect(prepared.measured.truePeakDbtp).toEqual(expect.any(Number));
      expect((await readFile(decoded)).equals(await readFile(join(f.dir, "prepared.wav")))).toBe(
        false,
      );
      expect(pcm.receipt).toMatchObject({
        processingEvidence: steps.map((step) => ({ recipe: step.processor })),
      });
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified encoded operands retained: ${f.dir}\n`);
    }
  },
  30000,
);

real(
  "a sub-sample state domain contributes no processed PCM or measurement",
  async () => {
    const f = await fixture([limiter]);
    let passed = false;
    try {
      const document = {
        ...f.document,
        clips: [
          {
            id: "short",
            trackId: "audio",
            source: { kind: "silence" },
            placement: { kind: "project", range: { startUs: 0, endUs: 1 } },
          },
          {
            id: "long",
            trackId: "audio",
            source: { kind: "silence" },
            placement: { kind: "project", range: { startUs: 1, endUs: 1000000 } },
          },
        ],
        processing: [{ target: { kind: "clip", id: "short" }, steps: [limiter] }],
      };
      const result = await f.render(0, 1000000, "zero-domain", document);
      expect(result.bytes.equals(Buffer.alloc(48000 * 8))).toBe(true);
      expect(result.receipt).not.toHaveProperty("processingEvidence");
      passed = true;
    } finally {
      if (passed) await rm(f.dir, { recursive: true, force: true });
      else process.stderr.write(`Unverified audio operands retained: ${f.dir}\n`);
    }
  },
  30000,
);
real(
  "public prepared processing binds runtime caches and survives excerpt/package adoption",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "public-typed-audio-")));
    let service: Awaited<ReturnType<typeof startProjectService>> | undefined;
    let passed = false;
    let requireRetainedMix = false,
      retainedMovieCalls = 0;
    const nativeWorker = mediaWorker({ YAP_NATIVE: native });
    const worker: typeof nativeWorker = async (operation, params, options) => {
      if (requireRetainedMix) {
        if (
          operation === "media.prepareCompositionAudioDomain" ||
          operation === "media.mixCompositionAudio"
        )
          throw new Error("Prepared movie unexpectedly rerendered audio");
        if (operation === "media.renderCompositionMovie") {
          expect(params).toMatchObject({ audio: { retained: { descriptor: 3 } } });
          retainedMovieCalls++;
        }
      }
      return nativeWorker(operation, params, options);
    };
    try {
      const path = join(home, "source.wav");
      await writeFile(path, wave(384000));
      service = await startProjectService({
        home,
        nativeExecutable: native!,
        worker,
        ffmpeg: {
          directory: installation!,
          receiptSha256:
            process.env.YAP_FFMPEG_RECEIPT ??
            "27350ff2f953bbd4d6ca8bfe0f6808b99b9752192657d289146b50319099f66a",
        },
      });
      const call = async <T>(operation: string, params: Record<string, unknown>) => {
        const result = await callLocal(service!.socketPath, {
          id: "typed-audio",
          operation,
          params,
        });
        if (!result.ok) throw Error(JSON.stringify(result));
        return result.data as T;
      };
      const job = async (jobId: string) => {
        const deadline = performance.now() + 10000;
        for (;;) {
          const result = await call<{
            state: string;
            published: { output: unknown } | null;
            errorCode: string | null;
            errorMessage: string | null;
          }>("job.get", { jobId });
          if (result.state === "ready") return result;
          if (
            ["failed", "canceled", "unavailable"].includes(result.state) ||
            performance.now() > deadline
          )
            throw Error(JSON.stringify(result));
          await delay(10);
        }
      };
      const imported = await call<{ jobId: string }>("asset.import", { requestId: "source", path });
      const importedJob = await job(imported.jobId);
      const assetId = (importedJob.published!.output as { assetId: string }).assetId;
      const created = await call<{ project: { projectId: string }; revision: { id: string } }>(
        "project.create",
        {
          requestId: "project",
          canvas: {
            width: 16,
            height: 16,
            fps: { numerator: 30, denominator: 1 },
            background: "#000000ff",
          },
        },
      );
      const edited = await call<{ revision: { id: string } }>("edit.apply", {
        projectId: created.project.projectId,
        expectedRevisionId: created.revision.id,
        requestId: "media",
        operations: [
          { operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" },
          {
            operation: "place",
            clip: {
              trackId: { label: "audio" },
              assetId,
              streamId: "track:1",
              source: { kind: "range", range: { startUs: 0, endUs: 8000000 } },
              placement: { kind: "project", range: { startUs: 0, endUs: 8000000 } },
            },
          },
          {
            operation: "processing.set",
            target: { kind: "output" },
            steps: [
              {
                enabled: true,
                processor: {
                  type: "normalization",
                  mode: "gain-only",
                  targetIntegratedLufs: -20,
                  truePeakCeilingDbtp: -2,
                  maxLoudnessRangeLu: 7,
                },
              },
              { enabled: true, processor: limiter.processor },
              {
                enabled: true,
                processor: {
                  type: "compressor",
                  thresholdDbfs: -25,
                  ratio: 2,
                  kneeDb: 3,
                  attackMs: 5,
                  releaseMs: 50,
                  detector: { kind: "input" },
                },
              },
            ],
          },
        ],
      });
      const selection = { projectId: created.project.projectId, revisionId: edited.revision.id };
      type Prepared = {
        state: string;
        jobId: string;
        published: null | { output: { resourceId: string; processingEvidence: unknown[] } };
      };
      const drySelection = {
        ...selection,
        tap: { target: { kind: "output" }, point: { kind: "dry" } },
      };
      const dryPending = await call<Prepared>("audio.prepare", drySelection);
      await job(dryPending.jobId);
      const dryReady = await call<Prepared>("audio.prepare", drySelection);
      expect(dryReady.state).toBe("ready");
      expect(dryReady.published!.output.processingEvidence ?? []).toEqual([]);
      const cachedInput = { ...selection, range: { startUs: 7000000, endUs: 7100000 } };
      const originalCache = await call<{ jobId: string }>("audio.get", cachedInput);
      await job(originalCache.jobId);
      await service.close();
      const replaced = join(home, "replacement-tools");
      const receipt = JSON.parse(await readFile(join(installation!, "receipt.json"), "utf8")) as {
        files: Record<string, string>;
      };
      for (const relative of Object.keys(receipt.files)) {
        const target = join(replaced, relative);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(installation!, relative), target, constants.COPYFILE_FICLONE);
      }
      const receiptBytes = JSON.stringify({ ...receipt, fixtureGeneration: "replacement" });
      await writeFile(join(replaced, "receipt.json"), receiptBytes);
      service = await startProjectService({
        home,
        nativeExecutable: native!,
        worker,
        ffmpeg: {
          directory: replaced,
          receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
        },
      });
      const replacementCache = await call<{ jobId: string }>("audio.get", cachedInput);
      expect(replacementCache.jobId).not.toBe(originalCache.jobId);
      await job(replacementCache.jobId);
      const pending = await call<Prepared>("audio.prepare", selection);
      await job(pending.jobId);
      const ready = await call<Prepared>("audio.prepare", selection);
      expect(ready.published!.output.resourceId).not.toBe(dryReady.published!.output.resourceId);
      expect(ready).toMatchObject({
        state: "ready",
        jobId: pending.jobId,
        published: {
          output: {
            processingEvidence: [
              {
                recipe: { type: "normalization" },
                sampleRange: { start: 0, end: 384000 },
                normalization: {
                  before: { integratedLufs: expect.any(Number) },
                  after: { integratedLufs: expect.closeTo(-20, 1) },
                },
              },
              { recipe: { type: "limiter" }, sampleRange: { start: 0, end: 384000 } },
              { recipe: { type: "compressor" }, sampleRange: { start: 0, end: 384000 } },
            ],
          },
        },
      });
      const excerpt = await call<{ jobId: string; state: string }>("audio.get", {
        ...selection,
        range: { startUs: 7000000, endUs: 7100000 },
      });
      const excerptJob = await job(excerpt.jobId);
      expect(excerptJob.published?.output).toMatchObject({
        frames: 4800,
        sampleRange: { start: 336000, end: 340800 },
        processingEvidence: ready.published!.output.processingEvidence,
      });
      requireRetainedMix = true;
      const movieExportId = randomUUID();
      await call("export.create", {
        ...selection,
        requestId: movieExportId,
        kind: "video",
        directory: home,
        leaf: "prepared.mp4",
      });
      const movieDeadline = performance.now() + 10000;
      for (;;) {
        const status = await call<{ state: string }>("export.status", { exportId: movieExportId });
        if (status.state === "ready") break;
        if (
          ["failed", "unavailable", "canceled", "conflicted"].includes(status.state) ||
          performance.now() > movieDeadline
        )
          throw Error(JSON.stringify(status));
        await delay(10);
      }
      expect(retainedMovieCalls).toBe(1);
      expect((await readFile(join(home, "prepared.mp4"))).length).toBeGreaterThan(0);
      requireRetainedMix = false;
      const exportId = randomUUID();
      await call("export.create", {
        ...selection,
        requestId: exportId,
        kind: "processed-package",
        directory: home,
        leaf: "prepared.zip",
      });
      const exportDeadline = performance.now() + 10000;
      for (;;) {
        const status = await call<{ state: string; output: string | null }>("export.status", {
          exportId,
        });
        if (status.state === "ready") break;
        if (
          ["failed", "unavailable", "canceled"].includes(status.state) ||
          performance.now() > exportDeadline
        )
          throw Error(JSON.stringify(status));
        await delay(10);
      }
      const admission = await call<{ id: string }>("package.open", {
        path: join(home, "prepared.zip"),
      });
      let packageHandle: string | undefined;
      const packageDeadline = performance.now() + 10000;
      for (;;) {
        const status = await call<{ state: string; packageHandle?: string }>("package.status", {
          admissionId: admission.id,
        });
        if (status.state === "ready") {
          packageHandle = status.packageHandle;
          break;
        }
        if (
          ["failed", "unavailable", "canceled"].includes(status.state) ||
          performance.now() > packageDeadline
        )
          throw Error(JSON.stringify(status));
        await delay(10);
      }
      const adoptedDeadline = performance.now() + 10000;
      let adopted: { projectId: string; revisionId: string } | undefined;
      for (;;) {
        const status = await call<{
          state: string;
          published: { output: { projectId: string; revisionId: string } } | null;
        }>("package.adopt", { packageHandle, requestId: "adopt" });
        if (status.state === "ready") {
          adopted = status.published!.output;
          break;
        }
        if (
          ["failed", "unavailable", "canceled"].includes(status.state) ||
          performance.now() > adoptedDeadline
        )
          throw Error(JSON.stringify(status));
        await delay(10);
      }
      await call("package.close", { admissionId: admission.id });
      const adoptedAudio = await call<Prepared>("audio.prepare", adopted!);
      expect(adoptedAudio).toMatchObject({
        state: "ready",
        published: { output: { processingEvidence: ready.published!.output.processingEvidence } },
      });
      passed = true;
    } finally {
      await service?.close();
      if (passed) await rm(home, { recursive: true, force: true });
      else process.stderr.write(`Unverified public audio operands retained: ${home}\n`);
    }
  },
  30000,
);

real(
  "descriptor exhaustion fails an actual preparation job and drains before reuse",
  async () => {
    for (const limit of [64, 256]) {
      const home = await realpath(await mkdtemp(join(tmpdir(), "audio-fd-pressure-")));
      let passed = false;
      try {
        const child = spawn(
          "/bin/sh",
          [
            "-c",
            `ulimit -n ${limit}\nexec "$@"`,
            "audio-pressure",
            process.execPath,
            fileURLToPath(new URL("../fixtures/audio-descriptor-pressure.mjs", import.meta.url)),
          ],
          {
            env: {
              ...process.env,
              YAP_PRESSURE_HOME: home,
              YAP_PRESSURE_EXPECT_FAILURE: limit === 64 ? "1" : "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const exit = await new Promise<number | null>((resolve, reject) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
          child.once("error", reject);
          child.once("close", (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
        await writeFile(join(home, "child-stdout.json"), stdout);
        await writeFile(join(home, "child-stderr.log"), stderr);
        expect(exit, stderr).toBe(0);
        const report = JSON.parse(stdout);
        if (acceptanceEvidence) {
          await mkdir(acceptanceEvidence, { recursive: true });
          await writeFile(
            join(acceptanceEvidence, `descriptors-${limit}.json`),
            JSON.stringify(report, null, 2),
          );
        }
        expect(report.failed).toMatchObject({
          state: limit === 64 ? "failed" : "ready",
          ...(limit === 64 ? { published: null } : {}),
        });
        expect(report.recovered).toMatchObject({ state: "ready" });
        expect(report.completedPrefixes).toBeGreaterThan(0);
        if (limit === 256) expect(report.maximumHeld).toBe(80);
        passed = true;
      } finally {
        if (passed) await rm(home, { recursive: true, force: true });
        else process.stderr.write(`Unverified descriptor operands retained: ${home}\n`);
      }
    }
  },
  60000,
);

/**
 * A 0.1.33 library keeps its failed, non-retryable prepared-audio job for the normalization identity
 * it shipped. Jobs are keyed by input, so that failure answers every later request until the
 * normalization implementation id changes. Normalization now publishes its best result instead of
 * refusing, and its id was bumped, so the old failure no longer answers.
 */
test("a failed 0.1.33 normalization job re-runs after an identity bump", async () => {
  const { Catalog, CatalogError } = await import("@yap/core/catalog");
  const { AssetStore } = await import("@yap/core/assets");
  const { AcquisitionStore } = await import("@yap/core/acquisitions");
  const { TranscriptStore } = await import("@yap/core/transcript");
  const { assetTranscriptOwner } = await import("@yap/core/transcript-processing");
  const { ProjectStore } = await import("@yap/core/projects");
  const { JobQueue } = await import("@yap/core/jobs");
  const { PreparedAudioStore } = await import("@yap/core/prepared-audio");
  const { processorImplementations } = await import("./audio-processing.js");
  const receipt = "c".repeat(64),
    preparation = "native-audio-state-domains-v1";
  const shipped = `bounded-offset-normalization:${receipt}:${preparation}`;
  const home = await realpath(await mkdtemp(join(tmpdir(), "normalization-identity-")));
  let refuse = true,
    renders = 0;
  const library = async (processors: Record<string, string>) => {
    const catalog = new Catalog(join(home, "catalog.sqlite"));
    const assets = new AssetStore(catalog, home);
    await assets.recover();
    const acquisitions = new AcquisitionStore(catalog);
    const projects = new ProjectStore(
      catalog,
      assets,
      new TranscriptStore(catalog, home, assetTranscriptOwner(assets, acquisitions)),
      acquisitions,
    );
    let prepared!: InstanceType<typeof PreparedAudioStore>;
    const jobs = new JobQueue({
      store: catalog,
      providers: { newId: randomUUID },
      targets: {
        pin: (target) => {
          if (target.kind !== "project") throw new Error("Prepared audio pins a project revision");
          return target;
        },
        isAvailable: () => true,
        isDeleting: () => false,
        isCapturing: () => false,
      },
      execute: (execution) => prepared.execute(execution),
    });
    const probe = async (path: string) => {
      const frames = ((await readFile(path)).length - 44) / 8;
      const endUs = Math.ceil((frames / 48000) * 1000000);
      return {
        originUs: 0,
        streams: [
          {
            id: "track:1",
            kind: "audio" as const,
            codec: "pcm_f32le",
            decodable: true,
            startUs: 0,
            endUs,
            segments: [{ startUs: 0, endUs, empty: false }],
            sampleRate: 48000,
            channels: 2,
          },
        ],
      };
    };
    prepared = new PreparedAudioStore({
      catalog,
      assets,
      projects,
      jobs,
      probe,
      staging: join(home, "staging", "prepared-audio"),
      renderer: {
        implementationId: "native-window",
        processors,
        validateAudio: async () => {},
        render: async () => {
          renders++;
          if (refuse)
            throw new CatalogError("NORMALIZATION_NOT_FEASIBLE", "0.1.33 refused this target");
          throw new CatalogError("NOT_READY", "This scratch catalog only observes re-execution");
        },
      },
    });
    await prepared.recover();
    return { catalog, assets, projects, jobs, prepared, probe };
  };
  const old = await library({ normalization: shipped });
  const source = join(home, "source.wav");
  await writeFile(source, wave(48000));
  const asset = await old.assets.import(source, { kind: "import" }, old.probe);
  const created = old.projects.create({
    requestId: "create",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const revision = old.projects.apply(projectId, {
    requestId: "edit",
    expectedRevisionId: created.revision.id,
    operations: [
      { operation: "track.add", label: "track", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "track" },
          assetId: asset.id,
          streamId: "track:1",
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            processor: {
              type: "normalization",
              mode: "gain-only",
              targetIntegratedLufs: -20,
              truePeakCeilingDbtp: -2,
              maxLoudnessRangeLu: 7,
            },
          },
        ],
      },
    ],
  }).revision;
  const input = { projectId, revisionId: revision.id };
  await old.prepared.request(input);
  await old.jobs.idle();
  const failed = await old.prepared.request(input);
  expect(failed).toMatchObject({ state: "failed", retryable: false });
  await old.jobs.close();
  old.catalog.close();
  refuse = false;
  const current = await library(processorImplementations(receipt, preparation));
  try {
    const before = renders;
    const status = await current.prepared.request(input);
    await current.jobs.idle();
    expect(status.jobId).not.toBe(failed.jobId);
    expect(renders).toBe(before + 1);
  } finally {
    await current.jobs.close();
    current.catalog.close();
    await rm(home, { recursive: true, force: true });
  }
});
