Yap is the macOS recording and agent-operated video toolkit. This release ships
`Yap.app`, the `yap` CLI and the `com.dzhng.yap` app identity. Install the app for
this identity; capture permissions must be granted to Yap separately.

The capture menu keeps its dark appearance after selecting a recording area and
shows the latest recording below the action buttons with Play and Copy agent prompt
actions. Screen recordings now include the pointer in the captured video.

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
