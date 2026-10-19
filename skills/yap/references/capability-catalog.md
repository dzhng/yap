# Capability catalog

The public CLI and optional MCP adapter expose the same operation catalog. The
protocol declaration is the source of schemas and help; inspect an installed
build before sending a request:

```sh
yap --help
yap <operation> --help
```

All paged operations use the same contract: send `limit` from 1 through 1000
(default 100) and pass the previous page's opaque base64url `nextCursor` as the
next request's `cursor`. Results put the collection and `nextCursor` at the top
level. Treat cursors as operation- and filter-specific values: repeat every other
parameter on a continuation (only `limit` may change). A malformed or foreign
cursor, or one reused with other filters, is an `INVALID_PARAMS` refusal;
`ARTIFACT_CHANGED` means the evidence it pinned was republished.

The catalog is grouped by the contract it owns. A name below is an advertised
operation, not permission to infer parameters or readiness. Use its current
help schema and preserve the returned JSON envelope.

## Projects, edits and revisions

`project.create`, `project.duplicate`, `project.delete`, `project.get`, `project.list`,
`inspect.open`, `caption.propose`, `layout.diagnostics`, `edit.apply`, `edit.undo`,
`edit.restore`, `speaker.correct`, `revision.get`, `revision.history`, `text.seed`,
`processing.get`, `output.capabilities`, and
`processing.capabilities` create, inspect and revise non-destructive projects.

`project.duplicate` copies one pinned project document into a new project with
an empty history; it is distinct from the clip-level `duplicate` edit operation.

## Inputs, assets and storage

`acquisition.import`, `acquisition.get`, `asset.import`, `asset.convert`,
`asset.get`, `asset.delete`, `asset.segments`, `asset.origins`, `asset.list`, `recording.get`,
`recording.list`, `media.list`, `recording.prompt`, `recording.delete`,
`recording.cleanup`, and `storage.usage` discover admitted media, retain
source identities, and reclaim only verified working files. `storage.usage` also
reports `modelBytes` for every regular file under the model directory, including
model cache and staging files.

`recording.delete` accepts `recordingId`, `requestId` and optional `cascade`. It
retires capture-origin copies with the recording. A project-held copy returns
`IN_USE` with the shared usage details; `cascade: true` also retires those projects.
Imports made from inside a recording folder are separate acquisitions and survive.

`recording.prompt` returns the handoff text the app's Copy agent prompt copies,
with the `facts` it was written from: what a recording captured, its marks or
clicks, and whether a transcript is being prepared. Omit `recordingId` for the
latest take; pass `projectId` or `assetId` for that item's one-line handoff.

## Packages and jobs

`package.open`, `package.status`, `package.adopt`, `package.close` manage
editable package lifetimes. Close a package when you're done with it, after
adopting or inspecting, to free its staged copy. `job.get`, `job.retry`, and `job.cancel` observe or
explicitly recover/cancel admitted background work. A read never retries a
failed job implicitly.

## Export and delivery

`export.create`, `export.list`, `export.status`, `job.retry`,
`export.recover`, `export.cancel`, and `export.abandon` publish or recover
video, audio, captions, and editable packages. `artifact.read`,
`artifact.renew`, and `artifact.close` consume large CLI/MCP deliveries.

## Evidence and indexing

`index.get`, `job.retry`, `index.coverage`, `index.frame`, `index.frames`,
`face.trajectory.get`, `correspondence.prepare`, `correspondence.get`,
`alignment.observe`, `alignment.get`, `cursor.render`, `job.retry`,
`speaker.continuity.prepare`,
`speaker.continuity.get`, `speaker.observe`, `speaker.get`, `speaker.bind`,
`join.verify`, `timeline.events`, and `cursor.raw` expose measured visual,
audio, timing, face, speaker, alignment and join evidence. Evidence is
information; it never authorizes an edit.

## Transcript, audio and visual processing

`transcript.review`, `transcript.render.prepare`, `job.retry`,
`transcript.render.get`, `transcript.transcribe`, `transcript.get`,
`transcript.import`, `transcript.disfluency.get`, `transcript.search`, and `job.retry` provide source/project text and
rendered speech evidence. `audio.extract`, `audio.prepare`, `audio.get`,
`audio.measure`, `audio.pause.get`, and `job.retry` provide retained or measured PCM.
`waveform.get`, `job.retry`, `spectrogram.get`, and `job.retry`
provide bounded signal views. `frame.get`, `frame.batch`, and `job.retry`
provide stills; `preview.get` and `job.retry` provide playable previews.
`voice.generate` creates a durable generated audio asset from an explicit
reference and text.

## Presets

`preset.list`, `preset.get`, `preset.update`, `preset.create` and `preset.delete`
read, refresh, scaffold and remove style presets: skill-like folders for one kind
of video, each with Any footage, Shoot, Edit and Check guidance and a measuring
kit. Every result carries `instructions` for the next step. Presets refresh from
the Yap repository at launch and daily. `preset.create` runs only when the user
asked for a preset or accepted an offer to save a finished project's style. Only
local presets can be deleted.

## Models and runtime

`model.list`, `model.status`, `model.prepare`, and `model.remove` discover, inspect,
prepare and remove registered local models. Call a requested feature directly; use `model.prepare`
only after a `MODEL_NOT_PREPARED` error has explained the optional download and
the user has approved it. `model.prepare` acquires and verifies model/runtime
files; it does not run inference. `service.health` reports readiness without
starting a capture; `service.tools` reports the selected app's verified Node and
media tools.

## Capture

`capture.sources`, `capture.start`, `capture.status`, `capture.pause`,
`capture.resume`, `capture.stop`, `capture.cancel`, and `capture.restart`
control explicit screen/audio/camera acquisition. `capture.setCamera` turns a
live screen take's companion camera on or off, any number of times, without
changing the take's lifecycle; the off time is a gap in the camera source.
`recording.*` operations remain the owner of retained recording discovery and
cleanup.

## App updates, the yap command and skill lifecycle

These operations belong to the app and are answered on its own socket, so they
work while the service is down. `update.status`, `update.check`, and
`update.setEnabled` expose the native app updater. `shortcuts.get` reads the
version-2 live global bindings and `shortcuts.set` applies and persists them
immediately. `login.status` reads macOS login-item state and `login.setEnabled`
registers or unregisters Yap after explicit user consent. `cli.status`, `cli.install`
and `cli.uninstall` expose the app-managed
`~/.local/bin/yap`: install writes the app's bundled launcher as fresh bytes and adds
a marked PATH line only when no startup file already covers `~/.local/bin`;
uninstall removes the command only while it is identical to the bundled one, and
only the marked line. They are synchronous and return `cli.status`.
`skill.status`, `skill.install`, `skill.uninstall`, and `skill.update`
expose the global Yap consumer-skill lifecycle. When maintenance (Settings → Set
up my agents) is enabled, install/update stages a complete pinned folder and lets
the app's bundled `skills` installer discover supported harnesses (including Codex and Claude), replacing any
existing global Yap skill, including symlinks and installs Yap did not make.
Disable maintenance before customizing the global skill; uninstall removes the
paths Yap recorded plus any global Yap skill discovered at that moment, and
removes nothing when Yap holds no receipt.

Mutation skill operations return a running status and jobId; poll
`skill.status` for terminal state and diagnostics. Settings shows one toggle and a
one-line summary for the command and skill; the CLI is the surface for state,
paths, source revision, discovery links, ownership and errors. Lifecycle reconciliation runs at every
app launch (including the relaunch after an app update), when maintenance is
re-enabled, and on an explicit `skill.update`; it does not use a periodic timer.

If an installed build does not advertise a name above, report the mismatch and
follow the available schema. Do not invent an operation or silently substitute
a different mutation.
