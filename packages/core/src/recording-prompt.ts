import type { captureDeviceSchema } from "@yap/protocol";
import type { z } from "zod";
import type { AcquisitionStore } from "./acquisitions.js";
import type { CapturePublishedSource } from "./capture-publication.js";
import { isSettled, type CaptureStore } from "./capture-store.js";
import type { TranscriptBacklog, TranscriptBacklogSelection } from "./transcript-backlog.js";
import type { TranscriptProcessing } from "./transcript-processing.js";
import { CatalogError } from "./catalog.js";

export type RecordingPromptFacts = {
  recordingId: string;
  live: boolean;
  durationUs?: number;
  captured: {
    screen: boolean | undefined;
    camera: boolean | undefined;
    mic: boolean | undefined;
    system: boolean | undefined;
  };
  kind?: NonNullable<CapturePublishedSource["take"]>["kind"];
  marks?: CapturePublishedSource["marks"];
  transcript: "none" | "pending" | "ready";
};
export type RecordingPromptSources = {
  recordings: Pick<CaptureStore, "get" | "latest">;
  acquisitions: Pick<AcquisitionStore, "captureIntent" | "get" | "ready">;
  status?: (() => Promise<{ device: z.infer<typeof captureDeviceSchema> }>) | undefined;
  backlog: Pick<TranscriptBacklog, "pending">;
  transcripts: Pick<TranscriptProcessing, "sourceStatus">;
  autoTranscribe: boolean;
};
const clock = (microseconds: number) => {
  const seconds = Math.max(0, Math.floor(microseconds / 1_000_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function openingLine({ screen, camera, mic }: RecordingPromptFacts["captured"]): string {
  if (screen && mic)
    return "I recorded my screen to show you something. Watch it with Yap and act on what I asked for.";
  if (screen) return "I recorded my screen without narration. Watch what happens with Yap.";
  if (camera) return "I recorded myself on camera. Watch it with Yap.";
  if (screen === false && camera === false && mic)
    return "I recorded my voice. Listen to it with Yap.";
  return "I recorded something for you. Watch it with Yap.";
}

/** Describe the take without enumerating its evidence or directing an edit. */
export function renderRecordingPrompt(facts: RecordingPromptFacts): string {
  const captured = Object.entries({
    screen: facts.captured.screen,
    camera: facts.captured.camera,
    microphone: facts.captured.mic,
    "system audio": facts.captured.system,
  });
  const identity = [
    ...(facts.live
      ? ["still recording"]
      : facts.durationUs === undefined
        ? []
        : [clock(facts.durationUs)]),
    ...captured.filter(([, present]) => present).map(([name]) => name),
    ...captured.filter(([, present]) => present === false).map(([name]) => `no ${name}`),
  ];
  const marks = facts.marks;
  const action =
    marks?.pins && marks.strokes
      ? "left numbered pins and drew on screen"
      : marks?.pins
        ? "left numbered pins"
        : marks?.strokes
          ? "drew on screen"
          : undefined;
  return [
    openingLine(facts.captured),
    `Recording: ${facts.recordingId} (${identity.join(", ")}).`,
    ...(action
      ? [
          `I ${action}${facts.captured.mic ? " while talking" : ""}. Each one is a moment I'm pointing at.`,
        ]
      : []),
    ...(facts.transcript === "pending"
      ? ["The transcript is being prepared automatically."]
      : facts.transcript === "ready"
        ? ["The transcript is ready."]
        : []),
    "Use the yap skill to work with this recording (or run `yap --help`).",
  ].join("\n");
}

/** Projects and imported videos keep their one-line ID handoff behind the same operation (P4). */
export function handoffPrompt(kind: "project" | "asset", id: string): string {
  return kind === "project"
    ? `I want you to use this project with this ID with the Yap CLI: ${id}`
    : `I want you to use this imported video with this asset ID with the Yap CLI: ${id}`;
}

/** A failed attempt promises no automatic retry, even if an explicit retry could succeed. */
function transcriptState(sources: RecordingPromptSources, selection: TranscriptBacklogSelection) {
  try {
    const status = sources.transcripts.sourceStatus(selection);
    if (status.state === "ready") return "ready";
    if (status.state === "queued" || status.state === "processing") return "pending";
    if (
      ["failed", "canceled"].includes(status.state) ||
      (status.state === "unavailable" && !status.retryable)
    )
      return "none";
    return sources.backlog.pending(selection) ? "pending" : "none";
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    return "none";
  }
}

/** Capture owns take facts before and after import; only transcript readiness needs an acquisition. */
export async function recordingPromptFacts(
  sources: RecordingPromptSources,
  recordingId?: string,
): Promise<RecordingPromptFacts> {
  const recording =
    recordingId === undefined ? sources.recordings.latest() : sources.recordings.get(recordingId);
  if (!recording) throw new CatalogError("NOT_FOUND", "Recording does not exist");
  if (recording.state === "canceled")
    throw new CatalogError("UNAVAILABLE", "Capture was discarded");
  const primary = recording.publication?.primary;
  const summary = primary?.state === "published" ? primary.source : undefined;
  const camera = recording.publication?.camera;
  const live = !isSettled(recording.state) && !recording.publication?.inputsClosed;
  let device: z.infer<typeof captureDeviceSchema> | undefined;
  if (live && sources.status) {
    try {
      const status = await sources.status();
      if (status.device.recordingId === recording.id) device = status.device;
    } catch (error) {
      // A disconnected capture controller cannot make an existing take's prompt unavailable.
      if (!(error instanceof CatalogError)) throw error;
    }
  }
  const kind = summary?.take?.kind ?? device?.selection?.source.kind;
  const captured = summary
    ? {
        screen: summary.take?.kind === undefined ? undefined : summary.take.kind !== "camera",
        camera:
          summary.take?.kind === "camera" || camera?.state === "published"
            ? true
            : summary.take?.kind === undefined
              ? undefined
              : false,
        mic: summary.members["narration.mov"] !== undefined,
        system: summary.members["system.mov"] !== undefined,
      }
    : {
        screen: device?.selection ? device.selection.source.kind !== "camera" : undefined,
        camera:
          camera?.state === "published" ||
          device?.selection?.source.kind === "camera" ||
          device?.camera?.state === "on"
            ? true
            : device?.selection
              ? false
              : undefined,
        mic: device?.selection?.microphone,
        system: device?.selection?.systemAudio,
      };
  let transcript: RecordingPromptFacts["transcript"] = "none";
  if (captured.mic && sources.autoTranscribe) {
    transcript = "pending";
    try {
      const intent = sources.acquisitions.captureIntent(recording.sourceId);
      if (intent && sources.acquisitions.ready(intent.acquisitionId)) {
        const acquisition = sources.acquisitions.get(intent.acquisitionId);
        const narration = acquisition.bindings.find((binding) =>
          binding.sourceRoles.includes("narration"),
        );
        transcript = narration
          ? transcriptState(sources, {
              assetId: narration.assetId,
              streamId: narration.streamId,
              acquisitionId: acquisition.id,
            })
          : "none";
      }
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      transcript = "none";
    }
  }
  const durationUs = summary?.sourceDurationUs ?? recording.sourceDurationUs ?? undefined;
  return {
    recordingId: recording.id,
    live,
    ...(!live && durationUs !== undefined ? { durationUs } : {}),
    captured,
    ...(kind === "region" ? { kind: "area" as const } : kind ? { kind } : {}),
    ...(summary?.marks ? { marks: summary.marks } : {}),
    transcript,
  };
}
