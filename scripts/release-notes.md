Yap is the macOS recording and agent-operated video toolkit. This release ships
`Yap.app`, the `yap` CLI and the `com.dzhng.yap` app identity. Install the app for
this identity; capture permissions must be granted to Yap separately.

## Unreleased

Settings has a "Reset All Shortcuts to Defaults" button, and `yap shortcuts.reset` does the
same. Recording a shortcut in Settings now ends as soon as you press one, and Escape leaves
the field; before, the field stayed waiting, Yap's shortcuts stayed off and Settings wrongly
said macOS had refused them.

## 0.1.65

Your agent can now change Yap's shortcuts by naming the keys: `yap shortcuts.set
--params '{"bindings":{"capture.startOrStop":"ctrl+cmd+r"}}'`. A key means the one your
keyboard layout types it with. `shortcuts.get` and `shortcuts.set` answer each action's
name, keys, label, when it applies and whether macOS took it; the raw key codes they used
to take and answer are gone. Your existing shortcuts are kept. Settings no longer accepts a
key without ⌃, ⌥ or ⌘ (except function keys), since that key would stop typing everywhere.

## 0.1.64

Fixes the service failing to start after updating to 0.1.62 or 0.1.63 on a Mac whose
speech model was already installed ("Service closed its control channel"). Your library
and recordings were never touched; this update installs itself and the service starts
again.

## 0.1.63

Automatic updates now cross a library upgrade. 0.1.62 converts libraries to a new format,
and 0.1.61 refused it with `UPDATE_INCOMPATIBLE`; this release updates 0.1.61 and 0.1.62
automatically and converts the library once on open.

## 0.1.62

Show your agent, in four keys. Press ⌥⇧S to record the display under your pointer, talk,
hold ⇧ and move to draw, ⇧-click to drop a numbered pin, and press ⌥⇧S again. ⌥⇧V pastes a
short prompt into your agent describing what you captured and where you pointed; allow
Accessibility in Settings and it pastes for you, otherwise it is copied. ⌥⇧Z undoes a mark,
⌥⇧X cancels and ⌥⇧P pauses. Shortcuts are recorded right in Settings and apply at once. The
countdown is now off unless you turn it on. Every recording and import is transcribed in the
background, without slowing anything you ask for.

For scripts and agents: new operations `recording.prompt`, `shortcuts.get` and
`shortcuts.set`. `timeline.events` lists a recording's marks, and screenshot indexes take a
frame at every mark, pin and click while adding fewer frames over long still stretches;
existing indexes rebuild on their next request. Recordings now carry capture journal
schema 3, which older Yap versions cannot open in packages.

This release also changes how results name things. A record calls its own identity `id`
(`asset.get {assetId}` answers `{id, …}`), a reference to another record is still
`<noun>Id`, and a reference that can point at several kinds is `{kind, id}`: job targets,
`IN_USE` details, `media.list` items and `capture.start`'s `source` (for example
`{kind: "display", id: 1}`). Deletes answer `{id, deleted, freedBytes}`. `job.get`,
`job.retry` and `job.cancel` answer with the job, and `asset.import`, `acquisition.import`
and `recording.cleanup` answer with the status of the work they started and its `jobId`.
Libraries and packages from 0.1.61 are converted once when opened; packages this version
exports cannot be opened by older versions.

## 0.1.61

The camera now stays off unless you turn it on. Since the camera switch arrived, every screen
recording quietly started the camera, with its light on and its picture in the floating
controls, even with the switch off. Now the switch alone decides: the camera menu only picks
which camera, and the "Camera off" choice is gone. A Mac with no camera or no microphone shows
that row as "No camera" or "No microphone", switched off, and records without it.

The floating controls are always hidden from screenshots and screen sharing, as they are from
Yap's own recordings; the Show Controls in Screenshots setting is gone. Clear controls choose
their look again whenever their window is redrawn, aimed at the clear capsule that sometimes
turned black.

## 0.1.60

You can now delete anything that takes up space, and see what it frees first. The
Library's Recordings tab also lists the videos you imported, and deleting a recording,
an imported video or a project asks once before anything goes. When a video is still
used by a project, Yap names the project and the space a delete would free, and deletes
the project too only if you say so. Downloaded models can be removed as well, and
storage now shows how much they take. A force-quit while recording a still screen no
longer loses the take.

For scripts and agents that call Yap, this release changes the interface. Every
identity is now `<noun>Id` and every quantity carries its unit (for example
`revisionId`, `sizeBytes`, `frameCount`). Every operation that changes something takes a
`requestId`, and repeating a request returns its first result. `recording.latest`,
`inspect` and the `*.retry` operations are gone (use `job.retry`), and asynchronous work
reports one set of states. New operations: `asset.delete`, `project.duplicate`,
`model.remove` and `media.list`. A delete refuses with `IN_USE`, naming the projects
that use the item; `cascade: true` deletes exactly what the refusal listed. Run
`yap <operation> --help` for the current schema; the bundled skill is already updated.

## 0.1.59

Clear recording controls are fully see-through again. The milky surface added in 0.1.58
looked dark on screen instead of frosted. The glowing red record and stop marks stay.

## 0.1.58

Starting a recording now closes the menu bar menu, so it no longer covers the countdown
and the floating controls. Clear recording controls have a faint milky surface that sets
them apart from what is behind them. The red record and stop marks glow, and on dark
controls the white marks glow too.

## 0.1.57

Scroll bars in the capture menu and the Library float over the content again while a
mouse is connected, instead of narrowing the menu and cutting off its right edge. Clear
recording controls now show their see-through glass on screen as soon as a take starts,
instead of staying dark until another look was chosen.

## 0.1.56

The floating recording controls now sit in macOS Liquid Glass. Settings > Recording >
Controls Glass chooses clear glass (the default), which lets what is behind the controls
show through, or light or dark frosted glass that stays easy to read on any background.
A new setting, Show Controls in Screenshots, lets screenshots and screen sharing see the
controls. It is off by default, and Yap's own recordings leave the controls out either way.

## 0.1.55

Agents no longer create presets on their own. When you finish a project whose
style you shaped (a grade, cut rhythm, captions, music or structure), your agent
offers once to save that style as a preset you can reuse on other footage, and
creates it only if you say yes. You can still ask for a preset at any time.

## 0.1.54

Adds presets: skill-like bundles that give an agent one mood of video (grade,
music, cut rhythm, pacing, text and framing) to carry onto whatever footage you
give it. Ask your agent for a style, or run `yap preset.list` and
`yap preset.get`. Three ship with the app (`tactile-launch-film`,
`on-location-conversation` and `studio-podcast`), and they refresh from the
repository at launch and once a day without an app update. `yap preset.create`
makes your own local preset from reference videos, and `yap preset.delete` moves a
local one to the Trash.

A colour LUT on the whole output now exports instead of failing with
"Unsupported audio processing step". Text with a background box no longer fails
its frame read with "Malformed picture receipt". Adding a processing step with an
invented `id` now explains that the id names an existing step.

## 0.1.53

Withdraws the 0.1.52 audio change. When an audio track's samples could not be
placed on its declared clock, 0.1.52 filled the missing time with silence and
reported it as recorded audio. Those reads fail again, as in 0.1.51. Audio that
genuinely ends early is still reported as unavailable, not as silence.

## 0.1.52

Transcription and shared audio inspection now tolerate AAC tracks whose final
decoded packet ends slightly short of the track's admitted duration, preserving
the requested output instead of failing the job.

The capture menu keeps its dark appearance after selecting a recording area and
shows the latest recording below the action buttons with Play and Copy agent prompt
actions. Screen recordings now include the pointer in the captured video.

## 0.1.51

Project previews now scale the complete authored canvas into their fast delivery
buffer, so reduced-resolution previews keep the same framing as the full export.

## 0.1.50

Project previews continue past the fast ten-second draft, preserve the full video frame,
and show progress while the full continuation is rendering. Projects in the Library are
now listed newest first.

## 0.1.49

Project previews now start with playable video and audio in a few seconds, then
continue rendering the same pinned revision in the background. The first preview
uses a faster draft raster while full-quality previews and exports remain available.

## 0.1.48

Closing a recording's window in the Library now stops its sound; before, the audio
kept playing after the window closed.

## 0.1.47

The Library and preview windows are redesigned. Library rows show what you need
(when a project was made, a recording's length and state, an export's file)
instead of identifiers; only items that need you stand out, in orange; click a
row to open it; and projects can be copied as an agent prompt. Previews are
titled by the project's name, with the revision you are watching clearly
selected and Export beside it.

## 0.1.46

You can screenshot and share the preview window again; it hides from capture only
while Yap is recording, so a take never records it. The dark bar across the top
of previews is gone: revision history and Export now sit above the video, only
when there is something to show, and previews open at 16:9. Clicking a recording
or project in the Library plays or previews it.

## 0.1.45

The Yap team can now show a message to specific versions, for when something has
gone wrong and you need to know what to do. It appears as a banner at the top of
the menu, at the top of Settings, and on the command line's stderr. Yap fetches it
from justyap.io at launch and hourly; if that fails, nothing else changes.

## 0.1.44

Hardens the 0.1.43 updater: quitting never restarts the service, a service that
fails on its own is never restarted more than its update needs, and the app's
own socket cuts off a caller that sends its request too slowly.

## 0.1.43

Updates can no longer get stuck. A service that fails, stops answering or keeps
refusing no longer holds an update back: the app ends it and installs once
nothing is recording, and restarts it if the update does not go ahead. A take
whose recovery failed no longer blocks updates, a stalled installation never
asks you to quit and reopen, and released apps retry every hour instead of
once a day.

The app answers its own operations (`update.*`, `skill.*`, `cli.*` and the
login item) on its own socket, so `yap update.check` and friends work even when
the service does not. `yap login.status` and `yap login.setEnabled` now work
from the command line. A `yap mcp` session holds the installation lock only
while a call runs, so an open agent no longer blocks updates; after an update
it exits so the agent starts the new version. `transcript.review` downloads the
default transcription model again when it is missing.

If your app is on 0.1.40 or 0.1.41, it cannot update itself: reinstall this
release once by hand. A `yap mcp` session started from 0.1.42 or earlier still
holds the lock until its agent restarts it.

## 0.1.42

Fixes Yap showing its service as unavailable, with an empty Library, in 0.1.40
and 0.1.41. A bundled skill helper read the app's control channel at startup,
so the service never finished starting. Recordings were never affected; they
appear again once the app updates. A new check starts the shipped service the
way the app does before a release can publish.

## 0.1.41

The bundled yap skill now checks the feed preview frame before delivering a
video meant for a feed such as X. Feeds preview from the first moments of
playback, so a fade-in from an empty background posts as a blank card; the skill
holds the intended preview frame briefly and verifies it in the delivered file.

## 0.1.40

The native review workflow now gives agents and people one pinned inspection
surface with revision history, bounded transcript and layout evidence, and
Downloads export. Convenience operations explain the lower-level work they
bundle: `transcript.review` combines transcription with transcript reading, and
`caption.propose` reads the selected project transcript internally before
drafting captions. Existing launch catalogs remain readable at format 29.

The release workflow now includes the bundled Yap skill in its sparse checkout,
so the signed app can package the same agent instructions used by local builds.

## 0.1.38

`package.adopt` and the skill now say to close a package once it's adopted.
An unclosed package keeps its staged copy in the library until Yap restarts.

## 0.1.37

Output by default: when an operation can produce a result, it does, and lists
anything that fell short as typed `issues` on that result instead of refusing.
Only an empty list is clean; the CLI's `--wait` line names how many issues a
ready output carries.

- **Long transcription.** A long recording transcribes in one request. Words at
  a window seam that the two windows disagreed on publish with
  `boundary-unresolved` instead of failing the whole transcript, and transcript
  reads now report the issues of the transcript they read.
- **Mastering.** Normalization and the limiter always publish their best result.
  A target the peak ceiling can't allow reports `normalization-target-unmet`
  with the loudest feasible target, so you can re-target in one step.
- **Ranges.** A placement or read that runs past its source or project is clamped
  to what exists and reported with `range-clamped`; one with no part inside
  still refuses.
- **More results publish with issues.** Font fallbacks draw with
  `font-substituted` or `glyph-missing`, stateful audio processing restarts
  after a gap in a recording with `support-gap`, and SRT exports keep markup
  with `srt-literal-markup`.
- **Clearer refusals.** A request that doesn't match its schema now names each
  rejected field. A refusal over missing source support lists the supported
  ranges to choose from.

Recordings and libraries from earlier versions keep working. Older transcripts
and prepared audio regenerate on their own where needed.

## 0.1.36

Opening Yap at macOS login is now an explicit, consent-based CLI operation. The
installer asks before enabling it; `login.status` and `login.setEnabled` expose
the same setting used by the app. The CLI continues to start Yap on demand when
the app is not already open.

## 0.1.35

The capture menu's window and display chooser matches the menu's dark look, shows
each source's picture at its own shape with its name beneath, and scrolls when there
are many windows. The window list shows only the app windows you work in, leaving out
the menu bar, status items, the Dock, other system surfaces and Yap's own windows.
`capture.sources` in the CLI and MCP reports the same shorter list.

## 0.1.34

Turn the camera off and back on while recording your screen, from the floating
controls, the menu, the CLI (`capture.setCamera`) or MCP. A take can start with the
camera off and turn it on later; the camera light stays off until then. Off time is
a real gap in the camera recording, never a frozen picture. Recordings made by
earlier versions keep working unchanged.

The floating controls show the camera as a rounded card you can minimize without
stopping the camera. Menu buttons show a pressed state while held. Source previews
in the capture menu now draw correctly and leave Yap's own windows out.

## 0.1.33

Yap starts faster with models installed. Startup no longer re-hashes every prepared
model runtime (several seconds warm, a minute or more cold for the speaker model);
a model whose receipt and runtime file list still match is ready at once, while
anything missing or changed is verified and repaired as before, and every run still
checks the runtime's bytes. A repair that fails now shows as failed in service
health. The first `yap` command after install gives the app a minute to start
instead of ten seconds; finding a running Yap still takes at most ten.

## 0.1.32

Exports into the same folder now queue instead of failing each other with
`PUBLICATION_BUSY`; that error is left for a publisher in another process. An
existing file Yap cannot read no longer refuses `export.create`; it is treated as a
file Yap did not write, so the export fails without touching it unless `overwrite`
is set.

## 0.1.31

`yap` commands answer immediately after Yap starts. Service health no longer
re-hashes every prepared model runtime on each call, which made commands wait up to
a minute once the speaker model was installed; full verification still runs at
preparation, on an explicit `model.status` and before every execution.

## 0.1.30

Opening a second copy of Yap now brings up the running one's Settings instead of
quitting silently, and a release never hands off to a development build. The Set up
my agents status line updates when the skill install finishes. The PATH check now
counts only the startup files a non-interactive login shell reads (`.zshenv` and
`.zprofile`; bash's login files), so agents running `zsh -lc` find `yap` by name.

## 0.1.29

The app now sets up your agents itself. On every launch, including the relaunch
after an update, it installs `~/.local/bin/yap` from its bundled launcher, refreshes
the yap skill with its bundled installer (no Node or npm needed), and adds a marked
PATH line when one is missing. Settings → Set up my agents turns this off. The
release ZIP has a fixed name, `Yap-macos-arm64.zip`, and contains only the app and
its receipt. Yap runs only from /Applications or ~/Applications, offers to move
itself when opened anywhere else, and allows one running copy at a time.

`yap <operation> --wait` without `--timeout-ms` is rejected immediately for every
operation except skill lifecycle commands, as documented. The speaker model now
prepares on a fresh install.

## 0.1.28

Capture shutdown now waits for native closure evidence before deleting retained
source bytes. Recovery validates native receipts at one shared boundary, keeps
ambiguous media retryable, and preserves journal diagnostics. App capture
operations are parity-checked against the shared protocol catalog, and warm
previews reuse the cached result for the same pinned revision.

## 0.1.27

Skill refreshes now use the bundled current Yap skill as the `npx skills` source, avoiding a full repository clone while preserving automatic discovery of every supported global harness. The canonical installation remains `~/.agents/skills/yap`, with discovered harness links verified after installation.

## 0.1.26

Skill maintenance now resolves the user-installed `npx` runtime from the app environment, including the documented Node installation under the home directory. Global Yap installation verification requires the canonical `~/.agents/skills/yap` folder and preserves discovered harness links.

## 0.1.25

Yap now maintains its account-level consumer skill through shared CLI and Settings operations. The Install skill preference defaults to enabled, discovers every supported global harness through `npx skills`, and safely stages, verifies, replaces and rolls back the global Yap skill. Disabling the preference removes the managed global installation so users can keep a customized skill.

The public `skill.status`, `skill.install`, `skill.update` and `skill.uninstall` operations report durable lifecycle state, ownership, discovered destinations and recovery diagnostics. Settings and the CLI use the same native handlers.

## 0.1.24

Transcript ingestion now normalizes fractional model timings at the native source
clock boundary, so tiny adjacent-word collisions do not fail an otherwise usable
recording. Diagnostics include the conflicting words and ranges when a malformed
payload still reaches ingestion.

The menu-bar item is compact again: it shows Yap's state icon only. The recording
overlay remains the place for elapsed time, so starting a take does not reserve a
large menu-bar slot or shift surrounding status items.

This release prepares the core transcription model in the background when Yap
starts, including after an app update. The CLI and `service.health` expose model
download state, byte progress and an estimated completion time so agents can wait
for readiness without discovering setup prerequisites themselves. Voice generation
and speaker diarization remain explicit downloads because they are secondary
capabilities with multi-gigabyte model/runtime footprints.

Recording library rows now focus on the two actions users need: play the recording
and copy an agent prompt containing its ID. Source IDs are no longer presented as
opaque details. The capture popover keeps its position when the menu-bar timer
appears, and its header actions use the tightened button sizing.

This release keeps Camera Only recordings alive when camera-session audio
timestamps carry a sub-frame synchronization residue. Continuous PCM stays on
one sample grid, while genuine full-frame overlaps remain rejected.

Fixes audio conversion that could interrupt Camera Only recording immediately after
countdown with `INVALID_AUDIO_FORMAT: Cannot create canonical PCM buffer.` Live PCM
callbacks can omit frame-duration metadata; conversion now derives the PCM frame
grid from the declared sample rate and preserves the timestamp and audio samples.

Recording controls retain a take's identity after it leaves capture status, resolve
its persisted outcome, and show the native interruption explanation. A new failure
reveals the panel without repeatedly reopening it on later polls. Confirmed deletion
releases retained controls, while transient read failures preserve their state.

Selected source tiles use their blue highlight without a redundant checkmark.
The dark recording panel, permission guidance, source defaults, area picker and
fixed status footer from the previous release remain available.

Synthetic live-buffer regression, decoded audio format checks and controls tests
passed. Live camera and microphone capture on physical devices remain unverified
on the development Mac, which has no camera or microphone input. Existing recordings
remain readable; no library migration is required for this update.

This release fixes Camera Only takes that could stop after several seconds with `AUDIO_OVERLAP: PCM classification overlaps admitted samples.` Audio admission now follows adjacent native callback timestamps, so small synchronization-clock residue cannot create invented one-frame gaps or overlaps. Genuine gaps, backward overlaps and pauses remain validated separately.

Recording action buttons now share aligned edges, equal spacing and consistent secondary-button sizing.

Synthetic live-buffer, clock, audio-format, controls and native build checks passed. Live camera and microphone capture on physical devices remain unverified on the development Mac, which has no camera or microphone input.

Check and download updates immediately from Settings → General → Check for Updates
or the public CLI `update.check` operation. Both use the same native updater;
`update.status` reports progress and `update.setEnabled` controls automatic updates.
A manual check works with automatic updates off without changing that preference.
Installation waits for recording, background work and CLI clients to finish.
Updates within the Yap identity preserve its library.

Bundled FFmpeg/ffprobe, audio dynamics and loudness measurement, SDR correction,
qualified HDR-to-SDR conversion, HEVC delivery, caption sidecars and agent review
helpers remain available. FFmpeg needs no separate installation. Optional speaker
observations require caller-supplied local inputs.

This version uses catalog format 26 and portable package format 4. Earlier formats
are refused; no migration or automatic deletion occurs. Apps on older catalog
formats cannot auto-update to this version. Install the app once with a fresh
library; it installs its own CLI launcher and skill.

A developer preview of the macOS recording and agent-operated editing primitives.
The toolkit makes zero editorial decisions and preserves source media.

Requires **Apple Silicon and macOS 26 or newer**. Node and FFmpeg are included; the core
transcription model prepares automatically while secondary model downloads remain explicit.
The ZIP includes the app and a receipt identifying the source commit and runtime.
The app installs the `yap` CLI and the yap skill on launch; they are the primary
agent interface.

This build uses a **stable self-signed release identity and is not notarized**. An agent
download (`curl`) is never blocked; after a browser download, use System Settings →
Privacy & Security → Open Anyway if macOS blocks the launch.
Managed Macs may prohibit that override. Capture permissions are granted separately
when you request recording.

Ask your agent to "Install Yap (the Mac app, which sets up the yap CLI and skill) by
following https://justyap.io/llms.txt", or follow
[agent setup](https://github.com/dzhng/yap#agent-setup). The skill's
[installation procedure](https://github.com/dzhng/yap/blob/main/skills/yap/references/installation.md)
owns checksum verification, the app's location, updates and readiness checks.
Installed releases check for authenticated app updates and wait for existing work and CLI/MCP processes to finish before replacing the bundle. Automatic checks can be disabled in Settings.
The relaunched app refreshes the CLI launcher and skill.
MCP clients can optionally use the same launcher with `mcp` as its argument.
See the [retained acceptance limits](https://github.com/dzhng/yap/blob/main/specs/done/agent-editing/release-closeout.md).
Third-party notices are included. The pretrained RNNoise model's license has not
been explicitly clarified upstream; its [existing provenance and limitation](https://github.com/dzhng/yap/blob/main/helpers/denoise/README.md)
remain recorded rather than implying a confirmed model-license grant.
Camera recording now shows a live preview above the floating transport controls,
using the same capture session as the recording. The preview is enabled by default
and can be hidden from Settings; screen-only recordings keep the compact controls.
Camera-only capture chooses the default available camera and no longer repeats a
redundant “Required” label after a camera is selected.

## 0.1.23

This release adds agent-first media evidence primitives: generation-pinned face
trajectories with explicit ambiguity and prediction refusal, fingerprinted
temporal correspondence receipts that never edit or synchronize a project, and
quality-gated long-form speaker continuity receipts that preserve refusal
metrics and anonymous identity boundaries. The public protocol, service, CLI and
MCP surfaces share the same strict contracts.

Live camera and microphone capture remain unverified on the development Mac,
which has no such devices.
