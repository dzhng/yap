import { timeUs } from "@yap/composition";
import type { AcquisitionStore } from "./acquisitions.js";
import type { AssetStore } from "./assets.js";
import type { CaptureMark, CaptureSourceRead } from "./capture-source-read.js";
import type { CaptureStore } from "./capture-store.js";
import type { TranscriptBacklog, TranscriptBacklogSelection } from "./transcript-backlog.js";
import type { TranscriptProcessing } from "./transcript-processing.js";
import { CatalogError } from "./catalog.js";

/** What a take captured, as evidence the handoff text describes; times are asset microseconds. */
export type RecordingPromptFacts = {
  recordingId: string;
  durationUs: number;
  display?: { displayId?: number; width: number; height: number };
  camera?: { width: number; height: number };
  captured: { screen: boolean; camera: boolean; mic: boolean; system: boolean };
  transcript: "none" | "pending" | "ready";
  marks: RecordingPromptMark[];
  clicks: RecordingPromptClick[];
};
export type RecordingPromptWindow = { app: string; title?: string };
export type RecordingPromptMark = {
  pin?: number;
  timeUs: number;
  kind: "stroke" | "pin";
  window?: RecordingPromptWindow;
};
export type RecordingPromptClick = { timeUs: number; window?: RecordingPromptWindow };

export type RecordingPromptSources = {
  recordings: Pick<CaptureStore, "get" | "latest" | "publishedSource">;
  acquisitions: Pick<AcquisitionStore, "captureIntent" | "get" | "ready">;
  assets: Pick<AssetStore, "get">;
  capture: Pick<CaptureSourceRead, "marks">;
  backlog: Pick<TranscriptBacklog, "pending">;
  transcripts: Pick<TranscriptProcessing, "sourceStatus">;
};

const clock = (microseconds: number) => {
  const seconds = Math.max(0, Math.floor(microseconds / 1_000_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const place = (window: RecordingPromptWindow | undefined) =>
  window && (window.title ? `${window.app}, "${window.title}"` : window.app);

function openingLine({ screen, camera, mic }: RecordingPromptFacts["captured"]): string {
  if (screen && mic)
    return "I recorded my screen to show you something. Watch it with Yap and act on what I asked for.";
  if (screen) return "I recorded my screen without narration. Watch what happens with Yap.";
  if (camera) return "I recorded myself on camera. Watch it with Yap.";
  if (mic) return "I recorded my voice. Listen to it with Yap.";
  return "I recorded something for you. Watch it with Yap.";
}

function identityLine(facts: RecordingPromptFacts): string {
  const picture = facts.display
    ? [
        facts.display.displayId === undefined ? [] : [`display ${facts.display.displayId}`],
        `${facts.display.width}×${facts.display.height}`,
      ]
    : facts.camera
      ? ["camera", `${facts.camera.width}×${facts.camera.height}`]
      : [];
  return `Recording: ${facts.recordingId} (${[clock(facts.durationUs), ...picture.flat()].join(", ")}). Use the yap CLI (run \`yap --help\` or the yap skill if you're unsure).`;
}

function capturedLine(facts: RecordingPromptFacts): string {
  const { screen, camera, mic, system } = facts.captured;
  if (screen && !camera && !mic && !system)
    return `Captured: screen only. No voice, so the frames and ${facts.marks.length ? "marks" : "clicks"} are the whole story.`;
  const transcript = {
    none: "",
    pending: " (transcript is being prepared automatically)",
    ready: " (transcript ready)",
  }[facts.transcript];
  const kinds = [
    ["screen", screen],
    ["camera", camera],
    [`microphone${transcript}`, mic],
    ["system audio", system],
  ] as const;
  const present = kinds.filter(([, captured]) => captured).map(([name]) => name);
  const absent = kinds.filter(([, captured]) => !captured).map(([name]) => `no ${name}`);
  if (absent[0]) absent[0] = `N${absent[0].slice(1)}`;
  return `Captured: ${present.join(", ")}.${absent.length ? ` ${absent.join(", ")}.` : ""}`;
}

function evidenceLines(facts: RecordingPromptFacts): string[] {
  if (facts.marks.length)
    return [
      `I marked things ${facts.captured.mic ? "while talking" : "on screen"}. Each mark is a moment I'm pointing at:`,
      ...facts.marks.map((mark) =>
        [
          mark.pin === undefined ? [] : [`#${mark.pin}`],
          clock(mark.timeUs),
          mark.kind,
          mark.window ? [`on ${place(mark.window)}`] : [],
        ]
          .flat()
          .join(" "),
      ),
    ];
  const { clicks } = facts;
  if (!clicks.length) return [];
  const times = clicks.slice(0, 2).map((click) => clock(click.timeUs));
  if (clicks.length > 2) times.push("…");
  // A window is named only when every click landed in the same one.
  const windows = new Set(clicks.map((click) => place(click.window)));
  const [window] = windows;
  const where = windows.size === 1 && window ? ` (${window})` : "";
  return [
    `I clicked ${clicks.length} time${clicks.length === 1 ? "" : "s"}: ${times.join(", ")}${where}.`,
  ];
}

/** The handoff text: what was captured and nothing else. It names no operations (D2/D3′). */
export function renderRecordingPrompt(facts: RecordingPromptFacts): string {
  return [
    openingLine(facts.captured),
    identityLine(facts),
    capturedLine(facts),
    ...evidenceLines(facts),
  ].join("\n");
}

/** Projects and imported videos keep their one-line ID handoff behind the same operation (P4). */
export function handoffPrompt(kind: "project" | "asset", id: string): string {
  return kind === "project"
    ? `I want you to use this project with this ID with the Yap CLI: ${id}`
    : `I want you to use this imported video with this asset ID with the Yap CLI: ${id}`;
}

function promptWindow(mark: CaptureMark): RecordingPromptWindow | undefined {
  const app = mark.window?.app;
  const title = mark.window?.title;
  if (typeof app !== "string" || !app) return undefined;
  return typeof title === "string" && title ? { app, title } : { app };
}

/** The P5 claim: a transcript is pending only while the backlog or a job will still deliver it. */
function transcriptState(sources: RecordingPromptSources, selection: TranscriptBacklogSelection) {
  let status: ReturnType<TranscriptProcessing["sourceStatus"]> | undefined;
  try {
    status = sources.transcripts.sourceStatus(selection);
  } catch (error) {
    // A source transcription can no longer read promises nothing.
    if (!(error instanceof CatalogError)) throw error;
    return "none";
  }
  if (status.state === "ready") return "ready";
  if (status.state === "queued" || status.state === "processing") return "pending";
  const terminal =
    ["failed", "canceled", "unavailable"].includes(status.state) && !status.retryable;
  return sources.backlog.pending(selection) && !terminal ? "pending" : "none";
}

/** Read a take's acquisition, active marks and transcript state; nothing here waits for recognition (D12). */
export async function recordingPromptFacts(
  sources: RecordingPromptSources,
  recordingId?: string,
): Promise<RecordingPromptFacts> {
  const recording =
    recordingId === undefined ? sources.recordings.latest() : sources.recordings.get(recordingId);
  if (!recording) throw new CatalogError("NOT_FOUND", "Recording does not exist");
  const acquisitionOf = (sourceId: string) => {
    const intent = sources.acquisitions.captureIntent(sourceId);
    return intent && sources.acquisitions.ready(intent.acquisitionId)
      ? sources.acquisitions.get(intent.acquisitionId)
      : null;
  };
  const primary = acquisitionOf(recording.sourceId);
  if (!primary) {
    // A take still recording or importing has nothing to describe yet, and an older take is not
    // what was asked for. The capture store owns why: it refuses a take still capturing (NOT_READY)
    // or one that settled without a source (UNAVAILABLE). A source it has published is still being
    // imported here, which is NOT_READY too.
    sources.recordings.publishedSource(recording.id, recording.sourceId);
    throw new CatalogError("NOT_READY", "Recording has not finished importing", {
      recordingId: recording.id,
    });
  }
  const companion = recording.camera ? acquisitionOf(recording.camera.sourceId) : null;
  const bound = (acquisition: typeof companion, role: "video" | "narration" | "system") => {
    const binding = acquisition?.bindings.find((value) => value.sourceRoles.includes(role));
    return acquisition && binding
      ? {
          selection: {
            assetId: binding.assetId,
            streamId: binding.streamId,
            acquisitionId: acquisition.id,
          },
          stream: sources.assets
            .get(binding.assetId)
            .streams.find((value) => value.id === binding.streamId),
        }
      : null;
  };
  const header = primary.evidence.receipt.header;
  const source = (header?.source ?? {}) as { kind?: unknown; displayID?: unknown };
  const primaryIsCamera = source.kind === "camera";
  const video = bound(primary, "video");
  const narration = bound(primary, "narration");
  const cameraVideo = primaryIsCamera ? video : bound(companion, "video");
  const screen = primaryIsCamera ? null : video;
  const size = (stream: NonNullable<typeof video>["stream"]) =>
    stream?.kind === "video" && stream.orientedWidth && stream.orientedHeight
      ? { width: stream.orientedWidth, height: stream.orientedHeight }
      : undefined;
  const display = screen && size(screen.stream);
  const camera = cameraVideo && size(cameraVideo.stream);

  const marks: RecordingPromptMark[] = [];
  const clicks: RecordingPromptClick[] = [];
  if (screen) {
    for (const mark of sources.capture.marks(screen.selection)) {
      const window = promptWindow(mark);
      const timeUs = mark.assetUs;
      if (mark.kind === "click") clicks.push({ timeUs, ...(window ? { window } : {}) });
      else
        marks.push({
          ...(mark.pin === undefined ? {} : { pin: mark.pin }),
          timeUs,
          kind: mark.kind,
          ...(window ? { window } : {}),
        });
    }
  }
  // The bound stream's length, so the duration and the marks read one clock.
  const end = (video ?? narration)?.stream?.endUs ?? 0;
  return {
    recordingId: recording.id,
    durationUs: timeUs(end),
    ...(display
      ? {
          display: {
            ...(typeof source.displayID === "number" ? { displayId: source.displayID } : {}),
            ...display,
          },
        }
      : {}),
    ...(camera ? { camera } : {}),
    captured: {
      screen: !!screen,
      camera: !!cameraVideo,
      mic: !!narration,
      system: !!bound(primary, "system"),
    },
    transcript: narration ? transcriptState(sources, narration.selection) : "none",
    marks,
    clicks,
  };
}
