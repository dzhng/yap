# Presets

A preset is a skill-like bundle for one specific style of video. The user provides
raw footage and names a preset. The agent reads the preset through `yap` and edits
the footage into that style. A preset can also tell the agent what to ask the user
to shoot before recording ("shoot for this preset").

A preset is not part of the consumer [yap skill](../../skills/yap/SKILL.md). The
skill teaches how to use Yap. A preset teaches one style: grade, cut rhythm,
message structure, captions, framing and camera angles. Presets ship with the app
and can be downloaded from this repository without an app release.

## Next Agent Prompt

_Last updated 2026-10-16. Status: the plan is merged from three independent
drafts (fewest-slices, risk-first, seam-quality). The three presets are drafted in
repo `presets/` with full example references (see [study notes](study.md)); the
kit has 11 passing tests and the read operations are shipped._

Slices 00–06 are done and slice 07's export proof is done. Next: get footage for one
style from the user (see each preset's `## Shoot`), then run slice 07 part 2 for it. Record every
decision the spec left open in [choices.md](choices.md). Read [contracts](#contracts) and
[invariants](#invariants) first; they are the decisions you inherit. Each slice
names its seam, its proof and the freedoms it delegates.

Warnings:
- The user's library is catalog format 29 (`packages/core/src/catalog.ts:8`).
  Presets must not change `catalogFormat`, the project document or anything under
  `~/.yap/library`. Slice 03's wire test asserts it.
- `dzhng/yap` is public and every install downloads `presets/`. Shipped presets
  keep the source link plus any stills, short audio and short video excerpts that
  help. The only limit is GitHub's: each file under 100 MiB. Full reference
  videos stay local. See [references](#reference-videos).
- `preset.*` is unrelated to the encoder `settings.preset` and the voice profile
  `preset` on `voice.generate`. Say so in operation descriptions.
- A separate fix is pending for `transcript.transcribe` failing on MP4s whose audio
  runs past the video (see [study](study.md)). Until it lands, extract audio first.

TODO:
- [x] [00 Spike](slices/00-spike.md): the service resolves the bundled path from `runtime.json` (no Swift), `/usr/bin/trash` works (Put Back unverified), every Edit step maps to an `edit.apply` operation.
- [x] [01 Format](slices/01-format.md): `packages/core/src/preset-format.ts`, `scripts/presets-index.mjs --check`, `presets/index.json`, `kit/KIT.md`.
- [x] [02 Install and store](slices/02-store.md): `preset-install.ts` (streaming sha256 install, atomic swap, receipt, conflicts) and `preset-store.ts` (list, get, `local.json`).
- [x] [03 Read](slices/03-read.md): `preset.list`, `preset.get`, `instructions`, bundling.
- [x] [04 Refresh](slices/04-refresh.md): `preset-remote.ts` (commit-pinned GitHub fetch, streamed, timeouts), `preset-refresh.ts` (startup + daily, joined runs, state), `preset.update`.
- [x] [05 Create and delete](slices/05-create-delete.md): `preset-scaffold.ts`, `preset.create`/`preset.delete`, `authoring/instructions.md`, injectable Trash.
- [x] [06 Skill route](slices/06-skill-route.md): one paragraph in `skills/yap/SKILL.md`, a catalog section, and the `preset-style-routing` eval case.
- [ ] [07 Prove presets](slices/07-prove-presets.md): export proof done (LUT renders as designed; two Yap bugs and a kit bug found). The fresh-agent edit of each style waits for footage shot to that preset's `## Shoot`.

Update this section before ending your pass.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where do the reference videos live? | The full video stays local, in the example's `source/` folder. Shipped presets keep the source link plus excerpts, each file under 100 MiB (see references below). | First decision: links only, "don't make it too complicated". Then widened by the user to as many stills, audio and short videos as help. |
| How are presets named? | By the general style (`tactile-launch-film`, `on-location-conversation`, `studio-podcast`), never by the source. Each source is one entry under the preset's `examples/`. | User requirement: more videos of the same style become more examples in the same preset. |
| What can a preset contain? | Markdown, small JSON data and helper scripts. | User choice. Scripts are allowed because some styles need computed steps, such as a caption layout or a grade recipe. |
| How is a downloaded preset trusted? | Each file's sha256 must match the repo's `presets/index.json`, fetched over HTTPS from `github.com/dzhng/yap` and pinned to one commit. | User choice: checksummed. The commit pin gives one consistent snapshot. Authenticity rests on HTTPS and repo access, as with today's [pinned skill fetch](../../skills/yap/references/skill-lifecycle.md). An index signature is a named later option, not v1. |
| Compatibility or migrations? | None. The library and project formats don't change. | User requirement: the existing library keeps working. Presets have their own folder and their own version field. |
| Does a preset update itself? | Yes. The service refreshes presets from the repo at launch and once a day, the same way the app already checks for updates and admin notices. `preset.update` stays as a manual trigger. A failed refresh keeps the last good copy. | User requirement: "continuously auto-update it, just like how it continuously auto-updates the app itself". |
| What is in a preset folder? | Anything, as in a skill folder. `PRESET.md` is the entry point and links to its other files by relative path. | User requirement. A16z's cold open lives in its own `cold-open.md`; every preset ships a `look.cube` grade. |
| What does a preset operation return? | Explicit steps for the agent, not just documents. Each result carries `instructions`: ordered steps with real paths and commands. Documents are referenced by path for depth. | User: "the customer for all this is the agent… return instructions for the agent on how to use the guide… what's next basically", and asked for the literal field name `instructions`. |
| What are a preset's references? | The source videos the style was learned from (https URLs, or absolute paths to the user's own files), recorded in `PRESET.md`. `preset.create` doesn't fetch them; the agent downloads them into the preset's `examples/<slug>/source/`. Any preset can hold as many stills, audio clips and short video excerpts as help a future agent. The only limit is GitHub's hard one: each file under 100 MiB, so no Git LFS is needed. There is no per-preset cap. Full reference videos stay local (in `source/`, dropped when shipping). | User: "don't give yourself so much artificial limitation… don't include a 5 GB video but you can include as many stills and as many audio and also smaller videos as you want", then "as high as you can without needing LFS… no arbitrary limits". Caution, recorded once: shipped presets are public, so third-party excerpts should be short and demonstrate one technique (a text animation, a cut, a mix move); full music cues are the riskiest to republish. |
| Can a preset be deleted? | `preset.delete` removes local presets only, by moving them to the Trash. | User: "if we add a create then we should have a delete too". Official presets return on refresh, so deleting them would mislead. |
| How are presets created? | `preset.create` scaffolds a new preset from `presets/authoring/template/` and returns the authoring guide, [AUTHORING.md](../../presets/authoring/AUTHORING.md). The guide holds every rule the user set while the first three were made, the method, the reference set and the depth bar. We author the shipped presets the same way (dogfooding): `preset.create`, fill it in locally, try it with `preset.get`, then copy the finished folder into the repo's `presets/` and open a PR. Shipping is a Git change, not a Yap operation. | User requirement: "a preset command to actually create presets", carrying "all this feedback and instructions", with the isometric-motion skill copied in as the example of depth. |
| How deep is a preset? | As deep as [isometric-motion](../../presets/authoring/reference/isometric-motion/SKILL.md), copied into `presets/authoring/reference/` under its MIT license. Every example carries stills, storyboards, motion filmstrips, a measured profile, a section map and timeline, colour scopes, music analysis and speech pacing. | User requirement: "as many references as possible. Be creative." |
| Music? | Analysed with `kit/music.mjs` (tempo with a reliability flag, cuts on beat, bed level under speech, brightness), described in our words; the user always supplies licensed music. | User asked what the presets say about the examples' music. |
| User-authored local presets? | Every `preset.create` makes one. They live beside the official ones in `~/.yap/presets/<id>/` (so `../kit/` resolves) and are recorded as `local` in `~/.yap/presets/local.json`. A refresh never touches a local preset, and generated ids never collide with an official one. | User: "if you call `preset.create`, that would be a local preset"; "`preset.create` should be the one to generate the ID". |
| Who decides the edit? | The agent, following the preset the user chose. | Choosing a preset is an explicit user request for a style. Yap still makes no editorial decisions: preset operations only return text and files, and never edit a project. |

The three starting presets come from the user's examples:

| Preset id | First example | Shape |
| --- | --- | --- |
| `studio-podcast` | https://x.com/a16z/status/2110385202581197049 | ~59 min 720p interview podcast |
| `on-location-conversation` | https://x.com/ashebytes/status/2107522974568103969 | ~51 min 1080p conversation |
| `tactile-launch-film` | https://x.com/humansand/status/2098115046438215791 | 42 s 1080p launch/announcement film |

A preset reads like the isometric-motion skill: `PRESET.md` opens with **the
one idea that matters** and how the style fails, lists its examples with what
each one demonstrates, then gives `## Shoot`, `## Edit`, `## Check` and
`## Limits`. Each example folder has a README with the source link, the
measurements and a table of stills.

## Contracts

### Preset folder (repo `presets/<id>/`, the bundled copy and installed copies)

```
presets/
  index.json                generated, never hand-edited
  kit/                      shared tools every preset links as ../kit/ (measure, check, timeline, music, pacing, LUT)
  authoring/                AUTHORING.md, template/, reference/isometric-motion/ (what preset.create returns)
  <id>/
    PRESET.md               required entry point: frontmatter + body
    targets.json            measured ranges an export must land in, each with why
    look.cube, look.json    the grade and its intent
    shoot-plan.svg          a diagram for guiding the shoot
    examples/<name>/        one folder per reference video (below)
    …                       any other files, linked from PRESET.md by relative path
```

An example folder holds everything we could learn from one reference video,
modelled on the example-rich [isometric-motion skill](https://github.com/dzhng/skills/blob/main/skills/graphics/isometric-motion/SKILL.md):
`README.md` (link, measurements, stills table, what it teaches), ~10 named
stills, storyboards, `motion-*.jpg` filmstrips of text animation, `profile.json`
from `kit/measure.mjs`, a hand-labelled `sections.json`, `timeline.svg`,
vectorscope and waveform images, and for speech, `pacing-*.json` (numbers only).
Every example must pass its own preset's `targets.json`.

A preset folder works like a skill folder. `PRESET.md` links its other files with
relative Markdown links (`[cold-open.md](cold-open.md)`, `[look.cube](look.cube)`),
and the agent reads them from the installed folder. Typical files: extra detail
loaded on demand, a `look.cube` grade LUT plus the `look.json` it was built from,
and scripts run with the Node from `yap service.tools`. Every file is listed in the
index and checked on download. Preset files are plain Git objects, never LFS:
`raw.githubusercontent.com` serves an LFS pointer, not the bytes. Each file must be under
100 MiB, GitHub's push limit; there is no per-preset cap. A link to a file outside the folder fails
validation.

`PRESET.md` frontmatter:

```yaml
id: tactile-launch-film          # matches folder, [a-z0-9-]+
name: Humans& launch film
description: One line that tells an agent when to use this preset.
version: 1                    # positive integer, bumped on any file change
references:                   # style sources, links only
  - https://x.com/humansand/status/2098115046438215791
```

The body has two required sections: `## Shoot`, telling the agent what footage to
ask the user for, and `## Edit`, the procedure that turns that footage into the
style, written as Yap operations. Optional sections cover what the style needs,
for example `## Look`, `## Captions` and `## Check`.

`presets/index.json` lists every *package*: each preset, plus `kit` (entry
`kit/KIT.md`) and `authoring` (entry `authoring/AUTHORING.md`). Each one is
versioned and refreshes the same way:

```json
{ "format": 1,
  "packages": [{ "id": "studio-podcast", "kind": "preset", "name": "…", "description": "…",
                 "version": 1, "files": [{ "path": "PRESET.md", "bytes": 1234, "sha256": "…" }] },
               { "id": "kit", "kind": "kit", "version": 1, "files": [] }] }
```

### Operations (shared protocol, service-owned, CLI and MCP generated)

| Operation | Params | Returns |
| --- | --- | --- |
| `preset.list` | `{}` | The installed presets (id, name, description, version, source `bundled`, `downloaded` or `local`, references, id conflicts), the `refresh` state (checked at, commit, error, newer versions available) and `instructions`. Never touches the network. |
| `preset.get` | `{ id }` | The raw `PRESET.md` text, the absolute folder path, the kit folder path, the file list, and `instructions`: what to do with it now (follow `## Shoot` before recording, or `## Edit` on the user's footage, then `## Check`). |
| `preset.create` | `{ name, references? }` | Makes a new **local** preset and tells the agent what to do next. It generates the id from `name`, copies `authoring/template/` to `~/.yap/presets/<id>/`, records the references in `PRESET.md`, and records the preset as `local`. Returns `{ id, path, guidePath, kitPath, instructions }`. `instructions` is the ordered list of steps with every path and command filled in (see [slice 05](slices/05-create-delete.md)). |
| `preset.delete` | `{ id }` | Deletes a **local** preset: moves `~/.yap/presets/<id>/` to the macOS Trash (recoverable), and removes it from `local.json`. Bundled or downloaded presets are refused with `PRESET_NOT_LOCAL`, because they'd come back with the next refresh. Returns `{ id, trashedPaths }`. |
| `preset.update` | `{ id?: string }` | Runs the same refresh as the automatic one now, for the named preset or every preset. Returns the installed versions and the commit. |

Every successful preset result carries `instructions: string[]`. Refusal codes live in `packages/protocol/src/refusal-ledger.json`.

If the same id exists in both places, the higher `version` wins. A tie goes to
the bundled copy. A download that fails verification leaves the previous copy in
place and reports the mismatched path.

### Storage

- Bundled: `Yap.app/Contents/Resources/presets/`, copied from repo `presets/`
  (without `source/`) by `scripts/build-macos.mjs`. `apps/service/src/main.ts` resolves
  `presetsDirectory` from its `runtime.json`; `YAP_PRESETS_DIRECTORY` overrides it.
- Installed: the service reads only `~/.yap/presets/`, which mirrors the repo
  (`<id>/`, `kit/`, `authoring/`) so `../kit/` resolves for every preset, local
  ones included.
  - At startup one installer copies in the bundled packages whose version is
    higher than the installed one.
  - Refreshes go through the same installer.
  - `receipt.json` records each package's version, source (`bundled`,
    `downloaded`) and commit.
  - `local.json` lists local presets.
  - None of this is under `~/.yap/library`.
- Refresh: at startup and once a day, pinned to one commit, only higher versions,
  every file checked by sha256. A failed refresh keeps what is installed and
  records the error in `preset.list`'s `refresh` state.

## Invariants

- One owner per concept, each in `packages/core`:
  - `preset-format` owns the shape;
  - `preset-install` is the only writer of `~/.yap/presets/` and owns precedence;
  - `preset-store` is the only reader;
  - `preset-refresh` owns the schedule;
  - `preset-scaffold` owns ids and scaffolds;
  - `preset-instructions` owns the rendering of `instructions`;
  - `kit/check.mjs` is the one oracle for "does this match the style".

  The CLI and MCP get the operations from the schema; no adapter reads preset files.
- Reads never choose between copies; the installer already chose.
- Size: the validator enforces only GitHub's 100 MiB per-file limit. Large presets
  are allowed, so the refresh must stream to disk, never hold a file in memory,
  and report progress in `preset.list`'s refresh state.
- `catalogFormat`, the project document and every library table stay the same.
- Preset operations never create, edit or export a project.
- Committed preset text describes each style in our own words; it quotes no
  transcript or script. Reference media in a shipped preset is excerpts that each
  demonstrate something (stills, clips, audio), each file under 100 MiB.
- The download path follows the model-download pattern: verify in staging, then
  rename into place, so a reader never sees a half-installed preset.

## Reference videos

Each preset lists its source links. To add an example, follow the method in
[AUTHORING.md](../../presets/authoring/AUTHORING.md): download the video into the
example's `source/` folder, build the reference set with the kit, link the example
from `PRESET.md` and bump `version`. When shipping, drop `source/` and keep the
excerpts.

## Slice graph

```
00 spike ─► 01 format ─► 02 install+store ─► 03 read + bundling ─┬─► 04 refresh
                                                                 ├─► 05 create/delete
                                                                 ├─► 06 skill route
                                                                 └─► 07 prove presets (also needs 00)
```

01–06 are portable TypeScript checked with vitest and `node --test`. 07 is the
expensive one: a real edit of footage, judged against the examples with
compare-screenshots and screenshot-critique.

### How the plan was merged

Three drafts were written blind from the same brief:
- **A, fewest slices.** Three rungs: local catalog, refresh, proof.
- **B, risk first** (a different model family). A feasibility spike first.
- **C, seam quality.** Separate format, install/store, read, refresh and create modules.

Taken from each:
- **From B:** slice 00.
- **From C:** the module seams, the single installed tree, versioned kit and
  authoring packages, the `instructions` template, the error codes in the refusal
  ledger, and refresh being opt-in for tests.
- **From A:** the merge-base version check, choosing `/usr/bin/trash`, ids checked
  against the last index rather than the network, and local presets winning id
  conflicts.

All three independently found:
- the per-version install path breaking `../kit/`;
- the https-only rule contradicting local file references;
- the link rule contradicting `../kit/`.

All three are fixed.

Alternatives not taken:
- **A's three-rung ladder.** It merges format, store, read, create and the skill
  route into one review, which is too much for one verdict.
- **B's native Trash bridge.** `/usr/bin/trash` already ships on macOS 26.
- **A's two-place reading with precedence on every read.** The single installed
  tree owns precedence in one place.

## Known unknowns

- With no per-preset cap, a first refresh can download hundreds of megabytes. If
  that proves slow, fetch each preset's large media on first `preset.get` instead
  of at refresh, keeping `PRESET.md` and data files eager. Measure before adding it.

- Index authenticity beyond HTTPS: decide whether to add an Ed25519 index
  signature, reusing release signing. Revisit before third-party or user presets.
- How many style traits the current primitives can express. Color grading is
  covered: every preset ships a `look.cube` for `processing.set`, which Yap applies
  in linear sRGB (`packages/composition/src/lut.ts`), so cubes are built for linear
  input by [make-look-lut.mjs](../../presets/kit/make-look-lut.mjs). Kinetic word captions,
  glow text and end cards are not yet proven. Slice 05 records
  each gap as a capability gap. It does not change the product inside a preset
  slice.
- Which raw footage to use for the end-to-end checks: retained fixtures
  (`fixtures/launch-video`, `fixtures/screen-camera-timing`) or a new user shoot
  guided by the preset's `## Shoot` section.
