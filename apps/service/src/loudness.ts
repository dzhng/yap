import { CatalogError } from "@yap/core/catalog";
import type { LoudnessAnalyzer, LoudnessMeasurement } from "@yap/core/acoustic-inspection";
import { inspectFFmpegTools, type FFmpegInstallation } from "./ffmpeg-tools.js";
import { cliWorker, nativeResult } from "./worker.js";

/** FFmpeg's summary rounds to one decimal and uses -70/zero-threshold for an empty gate. */
export function parseLoudnessSummary(
  text: string,
  audio: { frames: number; sampleRate: number; truePeak: boolean },
  version: string,
): LoudnessMeasurement {
  const summaries = text.split("Summary:");
  if (summaries.length !== 2)
    throw new CatalogError("INVALID_NATIVE_RESPONSE", "Loudness summary is missing or ambiguous");
  const summary = summaries[1]!;
  const value = (pattern: RegExp, infinite = false) => {
    const match = pattern.exec(summary);
    if (!match) throw new CatalogError("INVALID_NATIVE_RESPONSE", "Loudness statistic is missing");
    const number = match[1]!;
    if (infinite && number === "-inf") return null;
    if (!/^-?\d+(?:\.\d+)?$/.test(number) || !Number.isFinite(Number(number)))
      throw new CatalogError("INVALID_NATIVE_RESPONSE", "Loudness statistic is invalid");
    return Number(number);
  };
  const integrated = value(/Integrated loudness:\s+I:\s+(\S+) LUFS/)!;
  const threshold = value(/Integrated loudness:\s+I:\s+\S+ LUFS\s+Threshold:\s+(\S+) LUFS/)!;
  const lra = value(/Loudness range:\s+LRA:\s+(\S+) LU/)!;
  const lraThreshold = value(/Loudness range:\s+LRA:\s+\S+ LU\s+Threshold:\s+(\S+) LUFS/)!;
  const lraLow = value(/LRA low:\s+(\S+) LUFS/)!;
  const lraHigh = value(/LRA high:\s+(\S+) LUFS/)!;
  if (lra < 0) throw new CatalogError("INVALID_NATIVE_RESPONSE", "Loudness range is negative");
  const integratedReason =
    audio.frames < Math.ceil(audio.sampleRate * 0.4)
      ? "insufficient-duration"
      : integrated === -70 && threshold === 0
        ? "below-gate"
        : null;
  const rangeReason =
    audio.frames < audio.sampleRate * 3
      ? "insufficient-duration"
      : lraThreshold === 0 && lra === 0 && lraLow === 0 && lraHigh === 0
        ? "below-gate"
        : null;
  return {
    integratedLufs: integratedReason ? null : integrated,
    loudnessRangeLu: rangeReason ? null : lra,
    samplePeakDbfs: value(/Sample peak:\s+Peak:\s+(\S+) dBFS/, true),
    truePeakDbtp: audio.truePeak ? value(/True peak:\s+Peak:\s+(\S+) dBFS/, true) : null,
    integratedReason,
    rangeReason,
    algorithm: "FFmpeg ebur128 BS.1770/R128; true-peak libswresample; one-decimal summary",
    version,
  };
}

/** Retained WAV is already selected/validated by the common audio inspection owner. */
export function ffmpegLoudnessAnalyzer(
  installation: FFmpegInstallation | undefined,
  ownerExecutable: string | undefined,
): LoudnessAnalyzer {
  return {
    implementationId: `ffmpeg-ebur128-v1:${installation?.receiptSha256 ?? "unavailable"}`,
    async measure({ source, audio, channelInterpretation, truePeak }, signal) {
      if (!ownerExecutable)
        throw new CatalogError("NOT_READY", "Native CLI lifetime owner is unavailable", {});
      const tools = await inspectFFmpegTools(installation, signal, ownerExecutable);
      if (!tools.available) throw new CatalogError(tools.code, tools.message, {});
      if (channelInterpretation === "dual-mono" && audio.channels !== 1)
        throw new CatalogError("INVALID_PARAMS", "Dual-mono interpretation requires mono PCM");
      const receipt = nativeResult(
        await cliWorker(
          {
            executable: tools.executables.ffmpeg.path,
            ownerExecutable,
            args: [
              "-nostdin",
              "-hide_banner",
              "-nostats",
              "-protocol_whitelist",
              "fd,pipe",
              "-format_whitelist",
              "wav",
              "-fd",
              "3",
              "-i",
              "fd:",
              "-map",
              "0:a:0",
              "-af",
              `ebur128=peak=${truePeak ? "sample+true" : "sample"}:framelog=quiet:dualmono=${channelInterpretation === "dual-mono" ? "true" : "false"}:panlaw=-3.010299956639812`,
              "-f",
              "null",
              "-",
            ],
            environment: { PATH: "/usr/bin:/bin" },
          },
          {
            descriptors: [source.fd],
            rewindDescriptors: [3],
            signal,
            timeoutMs: Math.max(30000, Math.ceil((audio.frames / audio.sampleRate) * 2000)),
            maxBytes: 65536,
          },
        ),
      ) as { stderr: string };
      return parseLoudnessSummary(receipt.stderr, { ...audio, truePeak }, tools.version);
    },
  };
}
