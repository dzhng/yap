# Positioning

**Just yap. Your agent gets it.** Show your agent what you mean, and show people
what you made. You talk; your agent understands it, acts on it, and makes it
land.

The name is the input, and the product promises the opposite: you talk however
you talk, and the result is clear. Brand and command are **Yap** (`yap`);
the domain and package are **Just Yap** (`justyap`).

This is a communication tool, not a movie editor. It works in two directions of
equal weight:

- **Show your agent.** Press a key, talk, point and draw, press it again, and
  paste. Your agent gets the recording and knows what you meant.
- **Show people.** One rough take becomes a demo, an update, a podcast clip or a
  captioned vertical cut, and your agent does the editing.

The product is a tool *for* AI, not an AI. It has no built-in agent and makes
zero decisions; the user's agent (Claude Code, Codex, any harness) drives it. It
does run local models for evidence (transcription, speaker detection, voice
regeneration), so the honest claim is "no built-in agent", never "no AI".

Who it's for: people who work with coding agents and would rather show than type,
and prosumers who communicate with video and don't want to learn an editor. Not
professional filmmakers.

## 1. Show your agent instead of typing it out

A recording carries what typed instructions lose: what was on screen at the moment
you said "this".

The loop is four keys, all rebindable in Settings:

- **⌥⇧S** starts recording the display under your pointer, with no countdown,
  and finishes it.
- **Talk.** Every recording and import is transcribed automatically in the
  background.
- **Hold ⇧ and move** to draw on the screen. **⇧-click** drops a numbered pin;
  the click still reaches the app. **⌥⇧Z** undoes the last mark, **⌥⇧X**
  cancels the recording.
- **⌥⇧V** pastes a short prompt into your agent: the recording ID, what was
  captured (screen, camera, microphone), and your marks, pins and clicks with
  their times and the window each was on. The agent then explores the recording
  with the yap CLI and skill.

What it's for:

- Bug reports by video: narrate the bug, pin the broken element, and the agent
  finds the moment and the element you meant.
- "Watch me do it, then do it for me": one recording becomes the spec for automation.
- Design feedback spoken over a mockup, with drawn marks tied to what was visible
  as you spoke.
- Reviewing a pull request out loud while scrolling the diff.

No new permission is required. Accessibility is optional: with it, ⌥⇧V pastes
for you; without it, the prompt is copied and you paste it.

Today: transcript, frames and cursor events supply the evidence. The hotkey loop,
marks, pins and the pasted prompt are being built now and ship with this
messaging.

### What it replaces or competes with

- **[Scrawl](https://github.com/kitlangton/scrawl)** is the closest: the same
  record, talk, draw, pin and paste loop that inspired this one. Yap adds what
  happens after the paste: a full evidence and editing toolkit the agent can query (word-timed
  transcripts, frames, cursor and scene events, audio measurement), and the
  same recording can become polished output for people, driven by the agent.
- **A screenshot tool, an annotator and dictation** (for example CleanShot plus
  markup plus a dictation app) is the three-tool loop many people run today:
  capture a still, draw on it, dictate a description, paste all three. Yap is one
  key to start and one to paste, and the agent gets motion and timing, not a
  single frame.
- **Loom** records async video for people to watch. It isn't built for an agent
  to read, and polishing a Loom is still your job in its editor.
- **Descript** edits video through its transcript, but you operate the editor.
  Yap has no editor at all; your agent reads the evidence and makes the edit.

## 2. Show people: async messages that come out polished

The Loom use case, except you never touch the edit.

- A rough update comes back tight: fillers, false starts and dead air removed,
  captions added.
- Several attempts become one best version, sentence by sentence.
- A misspoken word is fixed in your own voice without re-recording.
- Long walkthroughs come back with chapters and a summary.

Today: all supported. Voice regeneration is for the speaker's own voice only.

## 3. Present yourself at your best

Help people come across well, not just finish a video.

- Rehearsal coach: practise a talk, pitch or interview, and get evidence on pace,
  filler rate, pauses, loudness and section timing. The agent gives the feedback;
  the tool only measures.
- Video introductions and cover letters built from your best takes.
- One master demo, cut per prospect.
- Clean audio, consistent loudness, camera picture-in-picture, zooms on what
  you're talking about.

Today: supported. Gaps: eye-contact correction, background blur or replacement,
and lighting/skin-tone correction, all common "make me look good" requests.

## 4. One recording, every format

Say it once; reach people wherever they are.

- Vertical, square and landscape cuts; audio-only versions.
- Podcast and talk episodes cut into captioned highlight clips, with show notes
  written by the agent from the transcript.
- Captions as SRT/VTT; the transcript rewritten by the agent as a post or release note.
- Translated subtitles: the agent translates, the tool exports.
- Stills and short GIFs of the moment that matters.

Today: mostly supported. Gap: dubbing into another language in your own voice.

## 5. Team communication that stays current

Video that doesn't rot.

- Onboarding walkthroughs patched by re-recording only the step that changed;
  edits are non-destructive revisions.
- Release and "what's new" videos assembled from per-feature clips.
- Meeting recaps cut down to the decisions.

Today: supported through ordinary capture, import and editing.

## What this means for messaging

- Headline everywhere: **Just yap. Your agent gets it.** Two sub-lines of equal
  weight follow it: **Show your agent** and **Show people**. Neither is a
  footnote to the other.
- It is one product, not two tools. The same keys start both directions: `⌥⇧S` to
  record, `⌥⇧V` to hand the recording to your agent. Only what you ask for differs.
- Lead "Show your agent" with the loop, not the toolkit: ⌥⇧S, talk and point,
  ⌥⇧S, ⌥⇧V. The evidence and editing toolkit is why the paste is worth more than
  a screenshot.
- Lead "Show people" with the outcome (your point lands, you come across well),
  not with editing features. Capture, import and editing are how it gets there.
- Keep "zero effort" central: one key to record, one sentence to the agent, no
  timeline, no setup.
- Keep originals-untouched and undo visible; they make handing the edit to an
  agent feel safe.
- Compare with alternatives by what they are, fairly: credit Scrawl as the
  origin of the loop, and don't claim features the alternatives lack unless it's
  checked.
