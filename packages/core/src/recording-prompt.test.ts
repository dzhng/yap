import { operationNames } from "@yap/protocol";
import { expect, test } from "vitest";
import type { CaptureMark } from "./capture-source-read.js";
import { CatalogError } from "./catalog.js";
import {
  recordingPromptFacts,
  renderRecordingPrompt,
  type RecordingPromptFacts,
  type RecordingPromptSources,
} from "./recording-prompt.js";

const identityTail = "Use the yap CLI (run `yap --help` or the yap skill if you're unsure).";
const none = { screen: false, camera: false, mic: false, system: false };
const facts = (value: Partial<RecordingPromptFacts>): RecordingPromptFacts => ({
  recordingId: "rec_8f3a21",
  durationUs: 72_000_000,
  captured: none,
  transcript: "none",
  marks: [],
  clicks: [],
  ...value,
});
const checkout = { app: "Chrome", title: "Checkout – shop.test" };
const namesNoOperation = (text: string) => {
  for (const name of operationNames) expect(text).not.toContain(name);
};

test("renders the approved screen, microphone and marks handoff exactly", () => {
  const text = renderRecordingPrompt(
    facts({
      display: { displayId: 1, width: 2560, height: 1440 },
      captured: { ...none, screen: true, mic: true },
      transcript: "pending",
      marks: [
        {
          pin: 1,
          timeUs: 15_000_000,
          kind: "pin",
          window: { app: "Safari", title: "Deploys – localhost:5173" },
        },
      ],
      clicks: [{ timeUs: 3_000_000, window: checkout }],
    }),
  );
  expect(text).toBe(
    [
      "I recorded my screen to show you something. Watch it with Yap and act on what I asked for.",
      `Recording: rec_8f3a21 (1:12, display 1, 2560×1440). ${identityTail}`,
      "Captured: screen, microphone (transcript is being prepared automatically). No camera, no system audio.",
      "I marked things while talking. Each mark is a moment I'm pointing at:",
      '#1 0:15 pin on Safari, "Deploys – localhost:5173"',
    ].join("\n"),
  );
  namesNoOperation(text);
});

test("renders the approved camera and microphone handoff", () => {
  expect(
    renderRecordingPrompt(
      facts({
        recordingId: "rec_camera",
        durationUs: 9_400_000,
        camera: { width: 1280, height: 720 },
        captured: { ...none, camera: true, mic: true },
        transcript: "ready",
      }),
    ),
  ).toBe(
    [
      "I recorded myself on camera. Watch it with Yap.",
      `Recording: rec_camera (0:09, camera, 1280×720). ${identityTail}`,
      "Captured: camera, microphone (transcript ready). No screen, no system audio.",
    ].join("\n"),
  );
});

test("renders the approved screen-only handoff with its clicks", () => {
  const text = renderRecordingPrompt(
    facts({
      recordingId: "rec_screen",
      durationUs: 11_000_000,
      display: { displayId: 2, width: 1920, height: 1080 },
      captured: { ...none, screen: true },
      clicks: [3, 7, 8, 9, 10, 11].map((seconds) => ({
        timeUs: seconds * 1_000_000,
        window: checkout,
      })),
    }),
  );
  expect(text).toBe(
    [
      "I recorded my screen without narration. Watch what happens with Yap.",
      `Recording: rec_screen (0:11, display 2, 1920×1080). ${identityTail}`,
      "Captured: screen only. No voice, so the frames and clicks are the whole story.",
      'I clicked 6 times: 0:03, 0:07, … (Chrome, "Checkout – shop.test").',
    ].join("\n"),
  );
  namesNoOperation(text);
});

test("narrated screen takes without marks list their clicks, and system audio is named", () => {
  expect(
    renderRecordingPrompt(
      facts({
        display: { displayId: 1, width: 2560, height: 1440 },
        captured: { ...none, screen: true, mic: true, system: true },
        clicks: [{ timeUs: 3_000_000, window: checkout }],
      }),
    ).split("\n"),
  ).toEqual([
    "I recorded my screen to show you something. Watch it with Yap and act on what I asked for.",
    `Recording: rec_8f3a21 (1:12, display 1, 2560×1440). ${identityTail}`,
    "Captured: screen, microphone, system audio. No camera.",
    'I clicked 1 time: 0:03 (Chrome, "Checkout – shop.test").',
  ]);
  expect(
    renderRecordingPrompt(
      facts({
        captured: { ...none, screen: true, system: true },
        clicks: [
          { timeUs: 3_000_000, window: checkout },
          { timeUs: 4_000_000, window: { app: "Safari", title: "Docs" } },
        ],
      }),
    ).split("\n"),
  ).toEqual([
    "I recorded my screen without narration. Watch what happens with Yap.",
    `Recording: rec_8f3a21 (1:12). ${identityTail}`,
    "Captured: screen, system audio. No camera, no microphone.",
    "I clicked 2 times: 0:03, 0:04.",
  ]);
});

test("marks without narration are not described as spoken, and strokes carry no pin number", () => {
  expect(
    renderRecordingPrompt(
      facts({
        captured: { ...none, screen: true },
        marks: [
          { timeUs: 2_000_000, kind: "stroke", window: checkout },
          { pin: 2, timeUs: 5_000_000, kind: "pin" },
        ],
      }),
    ).split("\n"),
  ).toEqual([
    "I recorded my screen without narration. Watch what happens with Yap.",
    `Recording: rec_8f3a21 (1:12). ${identityTail}`,
    "Captured: screen only. No voice, so the frames and marks are the whole story.",
    "I marked things on screen. Each mark is a moment I'm pointing at:",
    '0:02 stroke on Chrome, "Checkout – shop.test"',
    "#2 0:05 pin",
  ]);
});

test("voice-only and empty takes keep the same voice", () => {
  expect(renderRecordingPrompt(facts({ captured: { ...none, mic: true } })).split("\n")).toEqual([
    "I recorded my voice. Listen to it with Yap.",
    `Recording: rec_8f3a21 (1:12). ${identityTail}`,
    "Captured: microphone. No screen, no camera, no system audio.",
  ]);
  expect(renderRecordingPrompt(facts({})).split("\n")[0]).toBe(
    "I recorded something for you. Watch it with Yap.",
  );
});

// One screen take with narration: video, mic and system bindings on one acquisition.
function sources(
  options: {
    marks?: CaptureMark[];
    backlog?: boolean;
    status?: { state: string; retryable: boolean } | Error;
    published?: boolean;
  } = {},
): RecordingPromptSources {
  return {
    recordings: {
      latest: () => ({
        id: "rec_latest",
        sourceId: "source",
        sourceDurationUs: 4_000_000,
        camera: null,
      }),
      get: () => {
        throw new Error("an omitted id resolves the latest recording");
      },
      publishedSource: () => ({}),
    } as never,
    acquisitions: {
      captureIntent: () => ({ acquisitionId: "acq" }),
      ready: () => options.published ?? true,
      get: () => ({
        evidence: { receipt: { header: { source: { kind: "display", displayID: 3 } } } },
        bindings: [
          {
            assetId: "asset",
            streamId: "video",
            sourceRoles: ["video"],
            sourceToAssetOffsetUs: 500_000,
          },
          {
            assetId: "asset",
            streamId: "mic",
            sourceRoles: ["narration"],
            sourceToAssetOffsetUs: 0,
          },
        ],
      }),
    } as never,
    assets: {
      get: () => ({
        streams: [
          {
            id: "video",
            kind: "video",
            orientedWidth: 800,
            orientedHeight: 600,
            endUs: 4_500_000,
          },
          { id: "mic", kind: "audio", endUs: 4_500_000 },
        ],
      }),
    } as never,
    capture: {
      marks: () => options.marks ?? [],
    },
    backlog: { pending: () => options.backlog ?? false },
    transcripts: {
      sourceStatus: () => {
        if (options.status instanceof Error) throw options.status;
        return options.status ?? { state: "not_requested", retryable: false };
      },
    } as never,
  };
}
const mark = (
  value: Partial<CaptureMark> & Pick<CaptureMark, "kind" | "assetUs">,
): CaptureMark => ({
  hostUs: value.assetUs,
  epoch: 0,
  id: `${value.kind}-${value.assetUs}`,
  points: [],
  ...value,
});

test("facts read the take's display, the reader's active marks and clicks, all on the asset clock", async () => {
  const read = await recordingPromptFacts(
    sources({
      marks: [
        mark({ kind: "stroke", assetUs: 1_500_000 }),
        mark({
          kind: "pin",
          pin: 2,
          assetUs: 2_500_000,
          window: { app: "Safari", title: "Live", bounds: { x: 0, y: 0, width: 1, height: 1 } },
        }),
        mark({ kind: "click", assetUs: 3_500_000, window: { app: "Safari", title: "" } }),
      ],
    }),
  );
  expect(read).toEqual({
    recordingId: "rec_latest",
    // The bound stream's length, the clock its marks use; not the capture clock's 4 s.
    durationUs: 4_500_000,
    display: { displayId: 3, width: 800, height: 600 },
    captured: { screen: true, camera: false, mic: true, system: false },
    transcript: "none",
    marks: [
      { timeUs: 1_500_000, kind: "stroke" },
      { pin: 2, timeUs: 2_500_000, kind: "pin", window: { app: "Safari", title: "Live" } },
    ],
    clicks: [{ timeUs: 3_500_000, window: { app: "Safari" } }],
  });
});

test("the transcript is claimed only while the backlog owes it, a job runs it, or it is ready", async () => {
  const transcript = async (options: Parameters<typeof sources>[0]) =>
    (await recordingPromptFacts(sources(options))).transcript;
  expect(await transcript({ backlog: false })).toBe("none");
  expect(await transcript({ backlog: true })).toBe("pending");
  expect(await transcript({ backlog: true, status: { state: "queued", retryable: false } })).toBe(
    "pending",
  );
  expect(
    await transcript({ backlog: false, status: { state: "processing", retryable: false } }),
  ).toBe("pending");
  expect(await transcript({ backlog: false, status: { state: "ready", retryable: false } })).toBe(
    "ready",
  );
  expect(await transcript({ backlog: true, status: { state: "failed", retryable: false } })).toBe(
    "none",
  );
  expect(await transcript({ backlog: true, status: { state: "failed", retryable: true } })).toBe(
    "none",
  );
  expect(await transcript({ backlog: false, status: { state: "failed", retryable: true } })).toBe(
    "none",
  );
  expect(
    await transcript({
      backlog: true,
      status: new CatalogError("ASSET_DELETED", "source is gone"),
    }),
  ).toBe("none");
});

test("a take whose source has not been imported is refused, not described as empty", async () => {
  await expect(recordingPromptFacts(sources({ published: false }))).rejects.toMatchObject({
    code: "NOT_READY",
  });
});

test("a take still recording or never published carries the capture store's own refusal", async () => {
  for (const refusal of [
    new CatalogError("NOT_READY", "Capture source has not published"),
    new CatalogError("UNAVAILABLE", "Capture has no published source"),
  ]) {
    const unpublished = sources({ published: false });
    unpublished.recordings.publishedSource = () => {
      throw refusal;
    };
    await expect(recordingPromptFacts(unpublished)).rejects.toBe(refusal);
  }
});
