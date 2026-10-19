# Menu-bar app

The native app owns recording controls and one [local service child](../service/README.md).
Ordinary launch prepares that service without starting capture or requesting
permission. Readiness and failure are visible; process identities and interpreter
paths remain diagnostics rather than product controls.

## Shared controls and explicit access

The capture popover, Settings and recording panels consume one controls state and dispatch
the same actions. A running take retains its selected inputs; changing a preference
cannot rewrite that selection. Countdown precedes the service start request, so
canceling it creates no take. Starting a take or its countdown closes the capture
panel, which hangs where the countdown and floating controls appear. Recorder-owned controls stay outside recorded media
and do not activate the app over the source being recorded. Opening the capture
panel from the menu bar activates its window, so its native glass and controls
are ready before the first content click.

## Show your agent

The global shortcuts are one catalog, [ShortcutBindings](Sources/YapControls/ShortcutBindings.swift),
shared by Settings, registration and the `shortcuts.get`/`shortcuts.set` app operations, so a key
means the same thing however it was set. Bindings are physical key codes, and they apply as soon as
they change. A set names only the actions it changes and keeps every other binding; one invalid
entry refuses the whole set. A key macOS refuses is reported by its action, never by its label. Start and paste are held for the app's lifetime; the in-take keys (undo a mark, cancel,
pause, restart) only while a take or countdown is live, so they take no characters away otherwise.
A hotkey start records the display under the pointer, whatever the menu has selected, and a
restart reuses the running take's own source; the menu's Start keeps the menu's source. The
countdown is off unless someone turns it on.

Marks are drawn and recorded without any new permission: ⇧ is read with the pointer, and clicks
come from a global mouse monitor, which needs no Accessibility. The recognizer and the journal
live in [native capture](../../helpers/mac/Sources/YapCapture/README.md); the app only draws what
it is told and hides that ink from every capture.

The floating take controls show a recording camera's live picture. Minimizing it
only hides the picture; the camera keeps recording. Settings and the floating
controls share that one preference.
No capture sees the floating controls by default. Settings can let screenshots and
screen sharing see them; they become visible to captures only after the running take
confirms it leaves this app's windows out, so they never enter Yap's own recording.
The ink and numbered pins a person draws during a screen take float over every display and
are never visible to any capture, whatever that setting says. They draw only the mark stream
the capture recognizes (the live stroke, recorded marks, undos) and classify nothing.
A screen take reserves a camera whenever camera access is granted, so the camera can be
turned on and off during the take; the menu's switch only decides how it starts. The menu's
switch and the floating controls' camera button send one action, which during a take is the
same `capture.setCamera` the CLI calls. Native's live report, never the start selection, says
whether the camera is on, and a camera that is off shows no picture, not even its last one.

Capture status describes current work, so an idle device does not establish how its
last take ended. Controls retain the started take's identity and resolve its
persisted outcome after it leaves status. A new interruption reveals the controls
with its native explanation; later polls retain that explanation without repeatedly
reopening a dismissed panel. A read failure does not establish deletion; confirmed
deletion releases the retained take.

Authorization is read from native capture and requested only through an explicit
action. Screen source controls remain disabled until access is granted and explain
which permission enables them; camera-only capture stays independent of screen access.
Permission denial remains actionable without choosing another device.
Accessibility is optional and only ever granted in System Settings: with it the paste shortcut
presses ⌘V in the front app, with Command alone whatever the person is still holding; without it
the prompt is copied and a non-activating notice says to press ⌘V. Every prompt copy, button or
shortcut, goes through one [paster](Sources/YapControls/Paster.swift), and its text comes from the
service's `recording.prompt`, so the app never writes a prompt of its own.
Camera and microphone discovery do not depend on screen authorization. Missing
screen access produces empty screen choices, while an actual discovery failure
retains the last-good catalog and reports the error. A camera choice preserves
its device identity and never silently substitutes a disconnected device.
Login registration is the system's answer, not a second locally cached preference.
The Settings window stays available while macOS presents a permission or privacy
pane, then refreshes its state and returns to the front when Yap
becomes active again.
A client-triggered service launch suppresses the ordinary launch window; a headless
check must not take focus or play audio.

## Lifetime and delayed answers

Quit closes the service control pipe, finalizes an owned take and joins shutdown.
Escalation targets that child alone under a bounded deadline. Pending calls settle
on terminal failure instead of waiting for a channel nobody serves. Control writes
are asynchronous and bounded so a non-reading peer cannot block every deadline.

Release updates use a separate lifetime contract. The [update coordinator](Sources/Yap/UpdateCoordinator.swift)
joins existing native intent with the service's atomic permit; waiting leaves
normal operations and preview renewals usable. The [Sparkle boundary](Sources/Yap/SparkleDriver.swift)
owns scheduling and preferences through the pinned SDK. Its acknowledged launch
exclusion permits clean service EOF, and observed clean exit permits replacement.
An authenticated check that finds no newer version completes normally; a fresh
check clears prior check errors and candidate facts. Released apps check hourly,
so a cycle that fails is retried within the hour.
Updater shutdown never finalizes capture or closes preview to manufacture idle; it
signals only a service that cannot take part. The update is how a broken service gets fixed, so no service
failure may hold it: a service that fails to start, cannot answer the permit
request or refuses it three cycles running is ended, and the update installs once
native work is idle. A release the app cannot confirm, or an installation that
stops after the service exited, restarts the service, which settles any permit it
held. Each restart answers one such event; none needs a quit and reopen.

The app answers its own operations (`update.*`, `skill.*`, `cli.*`, `login.*`) on
its [own socket](Sources/Yap/AppSocket.swift) beside the service's, with the
handlers Settings uses, so the command line keeps them while the service is down.
Updater relaunch preserves the selected home/defaults and suppresses launch Settings.

The [library controller](Sources/Yap/LibraryController.swift) presents
source facts and caller-created projects separately, with project pages ordered newest first.
Last-good observations survive
read errors; generations fence delayed replies after deletion, page changes or
service replacement. A recording becoming ready cannot silently create a composition.
Recordings come from `media.list`, so an imported video sits beside the takes with its
own badge. Every delete goes through one [confirmation](Sources/YapControls/DeleteConfirmation.swift)
and asks the service for a plain delete. When the service refuses with `IN_USE`, the
refusal's own list of projects becomes a second confirmation, and only an explicit yes
sends the cascade: the app never decides to delete a project on its own.

A [preview controller](Sources/Yap/PreviewController.swift) pins identity
and holds the renewable service lease; its presentation window owns platform
player events. Export choices pin revision and destination before sending, retaining
the exact request after a lost answer. Forgotten owners cannot be revived by late
chooser, status or publication replies.
The export observer also accepts caller-created caption deliveries and preserves
their existing status/actions. Caption creation requires an explicit placement
selection, so the app's destination chooser does not offer that request.

## Runtime resolution

The [build and release owner](../../scripts/README.md) distinguishes bundled and
host interpreters. The [resolver](Sources/Yap/NodeRuntime.swift) consumes
the bundle manifest and explicit overrides. An invalid override is reported rather
than silently selecting another interpreter. A movable bundle resolves its runtime
relative to itself.

The same bundle manifest names its FFmpeg distribution and pins the signed
receipt. The app passes that selected authority to its service; neither the
service nor an external agent searches Homebrew for a replacement tool.

Probes run off the main thread with bounded output and termination. One startup
deadline covers interpreter discovery and service readiness, preventing each
candidate from borrowing a fresh service-sized budget.

## Verification and native boundaries

The [package manifest](package.json) owns app compilation and controls checks.
Controller checks link SwiftPM-owned outputs within this checkout, exercising
protocol and generation fences without capture or save panels. Optional
[audio receipt inspection](tests/audio-export-controls.mjs) reuses the pure suite.
The [verification guide](../../packages/test-harness/README.md) separates these
claims from installed, physical and perceptual acceptance.

Capture, geometry and media behavior belong to the [native owner](../../helpers/mac/README.md).
Probe entry points use those same owners; they do not define a second recorder.
The checked-in icon is an input to the build. Its [packing tool](../../scripts/render-app-icon.swift)
fits the [artwork](AppIcon-artwork.png) to the macOS icon grid and shape; it runs
separately so building is not a drawing step. The capture header uses a transparent
cutout from the same artwork. The idle menu-bar mark derives its speech bubble
and eyes as a monochrome template; live recording, pause and warning indicators
remain distinguishable at menu-bar size.

## Update controls

Settings → General observes the release updater's effective availability,
automatic-update preference and status. **Check for Updates** checks immediately
and downloads an available compatible candidate; a one-shot request works with
automatic updates off without changing that preference. The button is disabled
while the SDK is busy or a restart is required. Completion, progress and failures
remain visible in Settings.

The UI and CLI use the same public updater operations and native SDK boundary.
Settings calls that boundary locally and the CLI reaches it on the app's own
socket, so both keep working when the child service fails or is closing.
Sparkle owns scheduling, preference persistence and staged-update cancellation;
the coordinator owns installation admission for both scheduled and one-shot
checks. Neither surface bypasses recording, service or launcher exclusion.
Updater inspection and preference cancellation remain accessible during service
admission because they acquire no media resources. Settings never writes another
update preference. Source and personal builds without release metadata show a
manual-update explanation.

## Agent setup and launch rules

Settings → **Set up my agents** is one preference for everything the app installs
into the home folder. The [home lifecycle](Sources/Yap/HomeLifecycle.swift) owns it:
at every launch (including the relaunch after an update) it writes `~/.local/bin/yap`
from the bundled launcher as fresh bytes, refreshes every global `yap` skill with the
bundled `skills` installer and the app's own Node, and adds a marked PATH block only
when no shell startup file already covers `~/.local/bin`. Turning it off removes the
command while it is unchanged, only Yap's PATH block, and the global skill. The row's status line reads
the disk; `cli.*` and `skill.*` operations carry the details for agents.

A [launch decision](Sources/Yap/LaunchDecision.swift) runs before anything starts:
an update relaunch always proceeds; a second release copy hands off to the running
one and quits; a release build outside `/Applications` or `~/Applications` offers to
[move itself](Sources/Yap/AppRelocator.swift) there. Builds without an update feed
are exempt from both rules, so `dist/` builds run in place beside an installed Yap.

The [offscreen settings renderer](tests/settings-view-shots.mjs) draws the production
view with synthetic owner facts and checks that the form still scrolls to General.
It proves presentation without a service or permission inspection. Actual updater
persistence, staged disarming and quiet relaunch belong to native coordination
and the installed-update gate.

## Capture and Library presentation

The [capture view](Sources/Yap/CaptureView.swift) consumes immutable
rendering facts and emits supplied intents. It holds no capture selection, service
state or recording clock. The controls owner admits those intents; the popover owns explicit dismissal
and leaves capture selection with the shared controls state. Enabling camera capture offers the
system's default camera when no device has been chosen; an existing choice never substitutes a
disconnected device. The capture panel requests a dark native appearance; menu-bar opening establishes
key-window focus. Status stays outside the scrolling controls.
The native popover frame owns the backdrop and arrow together; content adds no
outer panel or stroke. Library has one entry point in the capture header, and its
canonical controls action stays the same regardless of that placement.
The source chooser shows a picture of each display or window, taken only while the panel is open
and once per opening, so a closed panel captures nothing. A display's picture uses the same
[exclusion](../../helpers/mac/Sources/YapCapture/CaptureExclusion.swift) as a take of it, so it
shows what would be recorded rather than Yap's own panel. The window list, in the chooser and in
`capture.sources` alike, holds only the windows a person works in; the
[window rule](Sources/YapControls/WindowSource.swift) owns what that means, and takes Yap's own
windows from the same exclusion.
When a recording is available, the popover appends the latest library item below its transport
actions and routes Play and **Copy prompt** through the same controls actions, and the same label, as Library.

Run `node apps/macos/tests/capture-view-shots.mjs` from the repository root for
focused native interaction, applicability and scroll checks plus offscreen images.
`SHOTS` selects the output directory. `FIXTURE_LABEL=omit` makes this renderer and the Library one
leave out their "synthetic presentation fixture" label for site and video shots; by default it stays. The [fixture](tests/fixtures/capture-view.swift)
owns synthetic scenarios; its images and metadata record native size, appearance
and backing scale. This renderer never enumerates devices, inspects permissions,
starts capture or activates the app.

The [Library view](Sources/Yap/LibraryView.swift) consumes shared
saved-item facts from the controls presentation owners. Those owners retain title,
failure detail and action applicability; the view keeps only its session-local tab,
filter and scroll position. The paging owner explicitly clears the page filter.
Unavailable thumbnails use a source icon, so presentation never creates media jobs.
The [offscreen Library fixture](tests/library-view-shots.mjs) renders synthetic
observations without service reads or window activation; run it from the repository
root to inspect presentation with synthetic observations. The retained Library window
opens independently, closes without quitting, and preserves its session-local browsing
state. Closing the popover does not close Library. Item actions keep their explicit
identities during asynchronous refreshes; their existing controllers admit execution.
