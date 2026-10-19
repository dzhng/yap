---
name: yap
description: Work with video for the user through the yap CLI — understand a recording they show you, or edit their footage end to end from a one-line prompt and optional inspiration into a finished, exported video. Use for launch/demo videos, podcasts, episode introductions, teasers and trailers; when the user shows you a recording (a bug, feedback, a walkthrough) to understand; wants a recording made, cut, tightened, captioned, reframed, cleaned up, restyled after a reference video or exported; for transcript/audio/frame inspection of their media; and on first-run setup, missing yap installation, skill installation/comparison or explicit refresh, and update-health questions.
---

# Yap

Users yap; you make it count. Video reaches you two ways. When the user shows
you a recording to explain something (a bug, design feedback, "watch me do
this"), read it as instructions: find what they said and what was on screen at
that moment, then act on that, without editing it. When they want something
worth sending to other people, you are the editor.

The user does not want to edit video. They record, then hand you a prompt —
"turn this into a tight 60-second demo with captions" — and maybe a reference
clip they like. You are the editor: turn that into a brief, make every editorial
decision it delegates, carry the decisions out with yap, check the result
yourself and deliver a finished file.

Yap makes zero editorial decisions. It supplies evidence (transcripts,
audio, waveforms, frames, events) and exact, non-destructive operations, so every
choice is yours and the user's originals stay intact. Choose treatments from the
user's intent and inspiration, not an assumed house style; defaults and presets
are starting settings, not requests to clean up every clip.

**Zero effort is the product.** A prompt like "make this good" delegates the
editorial judgment; it does not request a plan to approve. Decide unstated
choices from the brief, the inspiration and the material. Every edit is an
undoable revision, so a wrong guess costs the user one more sentence; a question
costs them the promise. Ask only when no reasonable reading of the request and
material settles a choice that would change the result materially, such as which
of several recordings they meant. When the user requests alternatives, keep
those alternatives open.

**Evidence requests include readiness.** Call the requested capability directly.
Do not call `model.prepare` as a preflight: status reads never download, and the
default transcript model is the only one Yap fetches on its own, reported as
`running`. If a call returns `MODEL_NOT_PREPARED` or
`unavailable:model_not_prepared`, read its details and explain to the user which
optional model/runtime is missing, what it is for, what will be downloaded and the
reported size or scope. Ask whether they want that download. Only after an explicit
yes, call `model.prepare`, poll `model.status` until it settles, and retry the
original capability with the same selection. `model.prepare` acquires and verifies
model/runtime files; it does not run transcription, alignment, speaker analysis or
voice generation. If the error does not include the details needed for that
question, report the exact error instead of guessing or downloading.

## Removing media and reclaiming space

1. Delete what the user named with `asset.delete`, `recording.delete`,
   `project.delete` or `model.remove`. Yap always keeps a transcription model:
   removing `parakeet` frees its space only until the next `transcript.review`
   prepares it again, so tell the user that before removing it.
2. An `IN_USE` refusal lists the projects using the item and the bytes each
   choice frees. Report those users and byte totals to the user. Use
   `cascade: true` or delete a project only when the user asked for it.
3. To free a clip that only a project's history holds:
   - use `edit.apply` to remove the clip;
   - use `project.duplicate` at the head revision;
   - check the copy with a preview or `revision.get`;
   - use `project.delete` on the original;
   - use `asset.delete` on the clip.
4. Package adoption can bring a deleted item back. Original files and committed
   exports are never touched.

## Installation

On first use, check `command -v yap`; if it is missing, try `~/.local/bin/yap`
(agents launched from the Dock may not read the shell profile that puts it on
PATH). Then run `yap capture.status --help`. When the command or app is missing and
the user asked for setup, follow [installation](references/installation.md): verify
Apple Silicon and macOS 26+, download and checksum the latest release, place
`Yap.app` in `/Applications` or `~/Applications`, and open it. The app installs the
command, this skill and the PATH line; you do not. Then verify with `cli.status`,
`skill.status` and `service.health` and report a short checklist. Linux/Docker
cannot run the native app; a portable JavaScript CLI bundle can independently run
schema/transport tests there with Node, without proving native readiness. Report
blocked launch or permissions accurately; help success alone is not service
readiness. Do not build from source as a consumer-install fallback.

If the current project has its own copy of this skill (`.claude/skills/yap`,
`.agents/skills/yap` or `.codex/skills/yap` under the project root), it may be stale
and can shadow the app-maintained global skill: tell the user and suggest deleting
it. Never delete it yourself.

When advertised, `yap service.tools` returns the selected app's bundled Node
path and verified media tools. Use that Node for the [consumer helpers](scripts/);
no separate Node installation is needed. Helpers use the installed CLI contracts.
Levels, loudness, waveforms and PCM are core operations (`audio.measure`,
`waveform.get`, `audio.get`), bounded to the range you ask for. For extra media
tasks outside core operations, use bundled FFmpeg through `yap ffmpeg`,
following [direct-tool checks](references/media-workflows.md#extra-media-tasks).

For skill installation, comparison or explicit refresh, read
[skill lifecycle](references/skill-lifecycle.md). The public lifecycle operations
are `skill.status`, `skill.install`, `skill.uninstall`, and `skill.update`, plus
`cli.status`, `cli.install` and `cli.uninstall` for the `yap` command; the
Settings row "Set up my agents" uses the same handlers. Install/update stages a complete pinned folder through the app's bundled `skills` installer,
letting it discover supported harnesses, and replaces every global Yap skill. With
**Set up my agents** on, every app launch does the same, so turn it off before
customizing the global skill. The CLI waits for install/update/uninstall to settle by default; use `--no-wait` for an immediate acknowledgement.
For the complete operation reference, read [capability catalog](references/capability-catalog.md).
An app update does not edit these files itself, but with maintenance enabled the relaunched app refreshes the global skill from the copy bundled in the new release.

For update-health questions, inspect the installed `service.health --help` and
actual reply. Discover advertised `update.status`, `update.check` and
`update.setEnabled` help before using them. When supported, an explicit
`update.check` checks immediately and downloads an available compatible update,
including with automatic updates off; it leaves that preference unchanged.
Follow `update.status` for the effective preference, progress and result. The app's
Settings → General → Check for Updates uses this same operation. An update check
returns before installation; existing CLI clients must finish before replacement.
Explain `queued` progress and the update `availability` fact (`disabled` or `unavailable`) literally;
queued work waiting for idle does not authorize stopping work, and disabled automatic updates
do not prove the service is unhealthy. Do not invent an updater command or kill,
cancel, close or stop work to obtain idle. Older releases may not advertise update
state; say so. Fixture health JSON is interpretation evidence, not native proof.
For manual bootstrap or a failed update, follow the update/recovery section in
[installation](references/installation.md). A disconnected or closing service is
unavailable; do not claim it reopened or retry writes blindly.

## Workflow

1. **Discover capabilities.** First ask internally: what tools, skills, models
   and asset libraries are available beyond the Yap skill and product? Read
   [capability discovery](references/capability-discovery.md); save the relevant
   inventory, installed CLI/service and loaded skill identities, readiness and
   provenance in the task workspace. Use useful available tools. Recommend
   missing external capabilities only when materially useful or required; do not
   install external tools/models or set up accounts by default. For Yap's own
   requested features, call the needed capability directly. Do not prepare a
   model in advance. If the call reports `MODEL_NOT_PREPARED`, follow the
   user-consent recovery above and record the model/runtime details and the
   user's decision. Done when the workflow's required capabilities have
   evidence-backed readiness or an explicit gap.

2. **Write the brief.** Save, in a task workspace, what the user asked for and
   your decision for every material choice they left open: audience, length,
   aspect, structure, pacing, what must stay, captions, music and treatments.
   For a launch video, podcast, episode introduction, teaser, tutorial, update or
   social clip, read [video use cases](references/video-use-cases.md)
   before choosing the structure and ending.
   An inspiration clip is a style target, not source material: import it as an
   ordinary asset and read its pacing, framing, caption style and structure with
   the same evidence operations you use on the recording. Use its media in the
   edit only when the user asks. Done when no material choice is left open.

   When a focused story shape is useful, select it with the installed
   `scripts/use-case-routing.mjs` helper (`launch`, `podcast` or `teaser`). It
   verifies the index link and records the installed reference hashes before
   media work; it performs no edits, installs or model preparation.

   For a clean-state reproduction checkpoint, use the installed
   `scripts/fresh-delivery-check.mjs` helper after producing two agent receipts:
   one from a clean managed root and one from a relocated root. It verifies the
   brief, source, selection, recipe and delivered-file identities, refuses source
   overwrite and replay mismatches, and records native, visual and audio review
   as explicitly unverified. It is an identity gate, not a substitute for
   rendered-media inspection or a human-QA request.

3. **Find the material.** Inspect the operation you need with
   `yap <operation> --help`. It returns its JSON description and parameter
   schema without launching the app. If you need to discover operation names,
   save `yap --help` to a file and select relevant entries; the full catalog
   is large. Use the installed CLI's schemas, even when this skill is newer than
   the release. Use advertised operations; do not assume proposed features exist.
   For JSON files, use `--params - < request.json`. Reserve `--output` for
   advertised media delivery; redirect stdout to save JSON metadata.

   Resolve the intended recording/project with discovery and inspect its state.
   Pin source identities and the actual editable revision. A source-only take
   supplies media facts; create a project explicitly when the task needs one.
   A stop can acknowledge `finalizing`; that is not media readiness. Follow
   returned `sourceAdmissions` and wait for the selected acquisition's job to be
   ready. Where independent publication is advertised, a ready source can be used
   while its sibling remains pending; publication alone is not completed admission.
   Pending primary publication does not block a ready camera acquisition.
   Never import a growing capture journal. Inspect a finalizing take's `finalizationError`;
   `capture.stop` explicitly retries failed recovery, while ordinary reads do not.
   Canceling recovery retains ambiguous media; use explicit library deletion to
   remove it. A completed take remains available even if it reports pending cleanup;
   use `recording.cleanup` on the settled recording to reclaim verified working
   files. Follow its job with `job.get`; explicitly retry retryable failures after
   the reported cause is resolved. A ready cleanup job may report retained roles:
   their media lacks sufficient proof for removal. Do not delete those files by
   hand or cancel a completed take to retry cleanup.

4. **Read the evidence.** Inspect transcript and visual evidence to locate the
   content the brief needs. Treat readiness as a bounded state machine:
   `unavailable:model_not_prepared` means read the model details, ask the user
   before downloading an optional model/runtime, then use `model.prepare` only
   after consent and retry; `running` means poll the same request; `failed` means
   diagnose the returned reason and use `job.retry` with the returned `jobId` after the cause
   is resolved. Follow returned pagination cursors, including empty pages with a
   next cursor. Preserve the transcript generation when using word identities. An
   opaque base64url cursor is operation- and filter-specific; pass it unchanged in
   the next request's `cursor` with every other parameter repeated (only `limit`
   may change), and read the collection plus `nextCursor` at the response top
   level. Another filter set is `INVALID_PARAMS`; `ARTIFACT_CHANGED` means the
   pinned evidence changed, so start a fresh traversal.
   empty transcript range does not prove silence, and an omitted filler does not
   prove the speaker did not say it.
   Before assembly, save a task-side selection sheet with asset/stream IDs,
   optional acquisition, exact source ranges, transcript generation and word
   ordinals. Add project/revision and occurrence clip IDs after placement.
   Keep these pins with the chosen wording and rationale; rounded display times
   cannot replace them in cuts or caption seeds.

   For the common "watch my recording and tell me what I meant" workflow, first
   check `yap --help` for the first-class `transcript.review` and `cursor.render`
   operations. When advertised, use `transcript.review` for a bounded,
   read-only transcript page and `cursor.render` for the same source or pinned
   project times with a visible pointer trail. `transcript.review` is the
   agent-friendly convenience call: it is the combination of
   `transcript.transcribe` and `transcript.get` for the selected bounded range.
   Call it directly instead of assembling those two calls yourself. If it reports `MODEL_NOT_PREPARED`, use the returned details to
   ask the user before downloading an optional model/runtime; do not make the
   agent discover `model.prepare` as a preflight. Pin the returned generation, revision,
   acquisition and continuation exactly as returned. It never invents words or
   edits a project. If it is absent, use the lower-level
   `transcript.transcribe`/`transcript.get` and `cursor.raw` plus `frame.get` path
   below. `model.prepare` is only the user-approved download and
   verification recovery described above.

   Use the same convenience-first rule for the other review helpers.
   `caption.propose` combines a bounded `transcript.get` with caption drafting
   and returns exact word pins; it never starts `transcript.transcribe`.
   `inspect.open` combines revision resolution, history and native preview
   opening. `cursor.render` combines `cursor.raw` evidence with `frame.get`
   delivery. `frame.batch` and `index.frames` batch repeated `frame.get` and
   `index.frame` reads; `index.get` handles scene/index preparation and the
   paged index read. `transcript.disfluency.get` and `transcript.search` are
   filtered/search transcript reads. The audio views (`audio.measure`, `waveform.get`,
   `spectrogram.get` and `audio.pause.get`) combine the selected `audio.get`
   signal with their measurement. `transcript.render.prepare` combines
   `audio.extract` with rendered-speech recognition. Use a lower-level operation only when you
   need control over one stage or the installed release does not advertise the
   convenience form.

5. **Edit.** Inspect uncertain cut boundaries using bounded audio excerpts and
   nearby frames. Choose narration, system audio, or mix intentionally. Transcript
   word times are estimates; protect adjacent speech. Use waveform or spectrogram
   analysis when available, but do not equate low amplitude with safe silence.
   Before shaping joins, pauses, replacement speech, mixes or audio/video timing,
   read [editorial checks](references/editorial-checks.md). Use its failure signs
   to choose and verify explicit edits; the suggested remedies are optional.

   Submit each edit against the inspected revision. Read the current schema for
   required identifiers and ranges. A cut accepts multiple ranges in one
   revision's playback coordinates; successive edits change those coordinates.
   After a stale-revision rejection, inspect the new state and recompute the edit
   instead of simply replacing the expected revision ID.

6. **Review it yourself.** Inspect the returned revision and request its audio,
   frames, or playable preview around changed joins. Poll the same pinned request
   without `--output` while work is queued or running; deliver once ready. A directory
   destination must not already exist, including when repeating an inspection.
   Check the returned job state and reason: `ok: true` and exit zero can report a
   failed job. Diagnose failures before an explicit supported retry. Compare the
   result against the brief and the inspiration; fix what falls short before
   delivering rather than handing the user a draft to critique.
   Investigate defects with available perception, rendered-excerpt transcription
   and signal/frame evidence; repair and recheck within a bounded budget. Keep
   each method's limits explicit. Deliver the best checked candidate with precise
   unresolved uncertainty; do not make human listening or watching a QA gate.
   A successful render alone does not establish a clean-sounding cut.

   `frame.get` intentionally returns a clean project still and does not add
   capture pointer overlays. When the question is what the user was pointing
   at, use the advertised `cursor.render` review operation; use `cursor.raw`
   when exact pointer coordinates and capture events are the evidence needed.

7. **Deliver.** Export the brief's revision and format only after checking the
   changes. Distinguish a pending export from a published artifact. Return the
   actual output path, a short account of the choices you made, any unresolved
   verification limits, and that any change is one more sentence away. Use
   history, undo, or restore for requested recovery; never modify source media or
   the database.

When feedback reveals a reusable editing or review lesson, fold it into the
editorial checks rather than appending a session diary. Keep clip-specific
preferences, accepted artifact identities and unresolved verdicts with the project.
Reuse earlier approvals only for what was actually judged; a changed render needs
verification of the changed behavior, not repetition of every passed comparison.

For capture, inspect `capture.sources` and `capture.status` for device identities
and existing permissions; discovery activates nothing. Use only selectors
advertised by the connected service's `capture.start`/`capture.restart` schemas.
Select a camera explicitly when the request needs it, without device fallback or
an automatic permission prompt. Capture publishes source facts and admission
outcomes; choose project layout and placement through explicit editing operations.
An agent-led recording can prepare the target browser/app, give the user a ready
cue, and invoke `capture.start` with the selected source when authorized. Use
`capture.pause`, `capture.resume` and `capture.stop` for requested control; await
finalization before treating the recording as ready media. A screen take's
companion camera can start off (`cameraAtStart`) and be turned on and off with
`capture.setCamera` only when asked; `capture.status` reports its live state. Off
time is a gap in the camera source, never a held picture. A refused turn-on leaves
the camera off and the take recording, and a camera never turned on is reported as
unavailable while the screen take still completes.

## Task references

For the complete public operation inventory and skill lifecycle contract, read [capability catalog](references/capability-catalog.md).

Before importing, transcribing, inspecting media, editing, rendering or exporting,
read the relevant sections of [media workflows](references/media-workflows.md).
That reference covers source/project clocks, processing and model readiness,
frames/audio/timeline evidence, captions, layout and published exports.
For format-specific structure and techniques, assembly, multi-take selection, caption design, animation, music or
publication choices, read [creative workflows](references/creative-workflows.md).
Read [video use cases](references/video-use-cases.md) for launch, podcast, teaser,
tutorial, update and social-clip shapes. Creative workflows covers compact transcript reading, decision sheets and creative techniques;
use [editorial checks](references/editorial-checks.md) for rendered-output review.
For optional MCP use, read [MCP delivery](references/mcp.md); CLI is the default.

**Presets.** When the user names a style, asks for a video "like" a kind they've
seen, or asks how to shoot for a style, run `yap preset.list`. Read the preset whose
description matches with `yap preset.get --params '{"presetId":"…"}'` and follow its
`instructions`. A preset is a mood the user chose, not a footage requirement: apply
it to whatever footage they gave and never reject it; give its Shoot advice only
when they ask what to film or have not recorded yet. It is also not permission to
edit beyond what they asked for. Presets are separate from this skill: never copy
their content here.

Never create a preset on your own. Call `preset.create`, then follow its
`instructions`, only after the user explicitly asks for a preset or says yes to
your offer. Do offer: when a project is finished and the user has steered its style
(a grade, cut rhythm, text treatment, music, framing or structure they chose or
corrected), offer once, in a sentence, to save that style as a preset they can
reuse on other footage, naming the choices it would capture. If they decline or
don't answer, drop it.

## Invocation and identity

- Pass structured parameters through stdin to avoid shell quoting problems:
  `yap edit.apply --params - < edit.json`. Build that file from the discovered
  schema and inspected identifiers, not guessed IDs.
- Save each attempt's request and raw JSON receipt together, including rejected
  attempts; do not overwrite them with a corrected request. Programmatically reuse
  their opaque IDs; do not retype them from memory. On `NOT_FOUND`, compare the
  submitted ID against the saved receipt before diagnosing lost service state.
- Parse the JSON envelope even on a nonzero exit. `--output` writes delivered
  media or JSON evidence to a file or directory according to the operation.
- Read `issues` on every result and on its published output before trusting it.
  Yap produces whatever output it can and lists there what fell short; only an
  empty list is clean. Deciding whether an issue matters is yours; when you
  report, keep what Yap flagged apart from your own observations. A refusal
  (`ok: false`) means no output could exist: a malformed request, a changed
  input, a resource bound or a missing prerequisite.
- Edit ranges are half-open in the expected revision and selected anchor domain.
  Media and text source/placement ranges accept exact reduced fractional
  microseconds; preserve returned endpoints instead of rounding. Point queries,
  holds and curve-key coordinates remain integer microseconds. Source and edited
  playback timestamps differ
  after cuts; use the reported mapping and retained fragments.
- For operations accepting `params.requestId`, reuse it with identical arguments
  when retrying an uncertain write. A new intended mutation or recomputed edit
  needs a new request ID. Export creation also keys replay on `requestId`; preserve
  it and its arguments on retries, then use the returned `exportId` for status.
  The CLI `--id` is a transport identifier, not the durable mutation identity.
