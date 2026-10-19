# 12 Prompt operation

**Contract unlocked:** one public operation produces the handoff text; the app and CLI share it.

**Seam:**
- Core `recordingPromptFacts(recordingId) → { id, durationUs, display?, camera?, captured:
  { screen, camera, mic, system }, transcript: none | pending | ready, marks[], clicks[] }`,
  reading the acquisition, the slice 02 reader and the slice 10 backlog state (P5).
- Pure `renderRecordingPrompt(facts) → string`.
- Service operation `recording.prompt { recordingId? } → { text, facts }`; omitted id means the
  latest recording. Name to confirm with the user (README checkpoint). Projects: the same
  operation returns today's one-line ID handoff for a project id (P4).
- Delete `LibraryPresentation.agentPrompt` (`LibraryPresentation.swift:6-10`) and
  `copyAgentPrompt` (`RecordingControls.swift:785-789`); the Library's copy action calls the
  operation.

**Text (D2/D3′).** Describes what was captured and nothing else. No operation names, no
"start here". Approved lines (fake data):

- Screen + mic + marks: "I recorded my screen to show you something. Watch it with Yap and act
  on what I asked for." / "Recording: rec_8f3a21 (1:12, display 1, 2560×1440). Use the yap CLI
  (run `yap --help` or the yap skill if you're unsure)." / "Captured: screen, microphone
  (transcript is being prepared automatically). No camera, no system audio." / "I marked things
  while talking. Each mark is a moment I'm pointing at:" then one line per mark, e.g.
  "#1 0:15 pin on Safari, \"Deploys – localhost:5173\"".
- Camera + mic: "I recorded myself on camera. Watch it with Yap." / identity / contents.
- Screen only: "I recorded my screen without narration. Watch what happens with Yap." /
  identity / "Captured: screen only. No voice, so the frames and clicks are the whole story." /
  "I clicked 6 times: 0:03, 0:07, … (Chrome, \"Checkout – shop.test\")."

**Verify:** new `packages/core/src/recording-prompt.test.ts` with golden text for the three
cases and: no operation names in the text; no transcript claim when the backlog has nothing;
retracted marks absent; never waits (D12). `CapturePresentationTests.swift:141,205-207`
updated. Real check: the slice 04 recording's prompt, read by eye.

**Delegated:** wording of lines not listed above, in the same voice. Written for the user's
review (pinned in `recording-prompt.test.ts`):

- Identity of a camera take: "Recording: rec_camera (0:09, camera, 1280×720). …"; a screen take
  with no display ID (window or region without one) drops "display N".
- Ready transcript: "Captured: camera, microphone (transcript ready). No screen, no system audio."
- Narrated screen with system audio: "Captured: screen, microphone, system audio. No camera."
- Screen plus system audio, no mic: opener "I recorded my screen without narration. Watch what
  happens with Yap." and "Captured: screen, system audio. No camera, no microphone."
- One click: "I clicked 1 time: 0:03 (Chrome, \"Checkout – shop.test\")."; clicks in different
  windows name none: "I clicked 2 times: 0:03, 0:04."
- Marks without narration: "Captured: screen only. No voice, so the frames and marks are the
  whole story." / "I marked things on screen. Each mark is a moment I'm pointing at:"
- A stroke has no pin number: "0:02 stroke on Chrome, \"Checkout – shop.test\""; a pin keeps its
  journal number, so it matches the badge on screen: "#2 0:05 pin".
- Voice only: "I recorded my voice. Listen to it with Yap." / "Captured: microphone. No screen,
  no camera, no system audio."
- Nothing captured: "I recorded something for you. Watch it with Yap."
- Imported video (kept, now behind the operation): "I want you to use this imported video with
  this asset ID with the Yap CLI: <id>".

Settled while implementing: marks are listed when there are any, otherwise clicks (D2's
"marks/pins or clicks"); the click line shows the first two times then "…" as approved; mark and
click times are asset time (journal time plus the binding's offset). The operation takes exactly
one of `recordingId` (optional), `projectId` or `assetId`, so the app passes its `MediaTarget`
and nothing guesses an ID's kind. Copy agent prompt is disabled while the service is down.
