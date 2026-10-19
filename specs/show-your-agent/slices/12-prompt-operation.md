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

**Delegated:** wording of lines not listed above (screen + clicks + mic, system audio), in the
same voice. Record them here for the user's review.
