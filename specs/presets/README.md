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

_Last updated 2026-10-16. Status: the three presets are drafted in repo
`presets/` from a study of the references (see [study notes](study.md)); no
operation code exists yet, and the presets haven't been proven on raw footage._

Start at [slice 01](slices/01-format.md). Read [contracts](#contracts) and
[invariants](#invariants) first. They are the decisions you inherit. Each slice
file names its seam, its proof and the freedoms it delegates to you.

Warnings:
- The user's library on their Mac is catalog format 29 (`packages/core/src/catalog.ts:8`).
  Presets must not change `catalogFormat`, the project document or anything under
  `~/.yap/library`. Treat a catalog format change as a spec violation.
- `dzhng/yap` is public. Commit the reference X link plus a small set of
  downscaled stills and storyboards per example (`examples/<name>/`), never the
  video, audio or transcripts. See [references](#reference-videos).
- `preset.*` is a different concept from the encoder `settings.preset`
  (`packages/composition/src/output-settings.ts`). Keep that distinction in
  operation descriptions.

TODO:
- [ ] [01 Format](slices/01-format.md): preset folder layout, manifest, index generator and validator.
- [ ] [02 Read operations](slices/02-read.md): `preset.list` and `preset.get` over bundled presets.
- [ ] [03 Download](slices/03-download.md): `preset.update`, with verified, atomic installs from the repo.
- [ ] [04 Skill route](slices/04-skill-route.md): one routing paragraph in the consumer skill.
- [ ] [06 Create and delete](slices/06-create.md): `preset.create {name, references?}` generates the id, scaffolds a local preset and returns explicit next steps; `preset.delete {id}` trashes a local preset.
- [ ] [05 Presets](slices/05-presets.md): drafts of `tactile-launch-film`, `on-location-conversation` and `studio-podcast` exist with full example references and a tested kit (`node --test presets/kit/*.test.mjs`); prove each on raw footage.

Update this section before ending your pass.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where do the reference videos live? | Only their X links are committed, in each preset's manifest. Each example also keeps ~10 downscaled stills (960 px JPEG) named by what they show, plus storyboards and measurements. | The repo is public, and two references are full hour-long episodes by other creators. The user asked to keep the video simple (a link), and to capture reference images from each example, following the example-rich [isometric-motion skill](https://github.com/dzhng/skills/blob/main/skills/graphics/isometric-motion/SKILL.md). |
| How are presets named? | By the general style (`tactile-launch-film`, `on-location-conversation`, `studio-podcast`), never by the source. Each source is one entry under the preset's `examples/`. | User requirement: more videos of the same style become more examples in the same preset. |
| What can a preset contain? | Markdown, small JSON data and helper scripts. | User choice. Scripts are allowed because some styles need computed steps, such as a caption layout or a grade recipe. |
| How is a downloaded preset trusted? | Each file's sha256 must match the repo's `presets/index.json`, fetched over HTTPS from `github.com/dzhng/yap` and pinned to one commit. | User choice: checksummed. The commit pin gives one consistent snapshot. Authenticity rests on HTTPS and repo access, as with today's [pinned skill fetch](../../skills/yap/references/skill-lifecycle.md). An index signature is a named later option, not v1. |
| Compatibility or migrations? | None. The library and project formats don't change. | User requirement: the existing library keeps working. Presets have their own folder and their own version field. |
| Does a preset update itself? | Yes. The service refreshes presets from the repo at launch and once a day, the same way the app already checks for updates and admin notices. `preset.update` stays as a manual trigger. A failed refresh keeps the last good copy. | User requirement: "continuously auto-update it, just like how it continuously auto-updates the app itself". |
| What is in a preset folder? | Anything, as in a skill folder. `PRESET.md` is the entry point and links to its other files by relative path. | User requirement. A16z's cold open lives in its own `cold-open.md`; every preset ships a `look.cube` grade. |
| What does a preset operation return? | Explicit steps for the agent, not just documents. Each result carries `instructions`: ordered steps with real paths and commands. Documents are referenced by path for depth. | User: "the customer for all this is the agent… return instructions for the agent on how to use the guide… what's next basically", and asked for the literal field name `instructions`. |
| What are a preset's references? | The source videos the style was learned from: https URLs, or absolute paths to the user's own files, recorded in `PRESET.md`. `preset.create` doesn't fetch them; the agent downloads them into the preset (a local preset may keep any media that helps: the reference videos, excerpts, audio, stills). Shipped presets, which live in this public repo and are downloaded by every install, keep links plus small stills and analysis only. | The user wants as many references as possible; the only real limits are republishing other creators' media in a public repo and the size of every install's download. Neither applies to a local preset. |
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
`raw.githubusercontent.com` serves an LFS pointer, not the bytes. Keep each
preset under about 2 MB, so stills stay small JPEGs. A link to a file outside the folder fails
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

`presets/index.json` (one schema version for the index itself):

```json
{ "format": 1,
  "presets": [{ "id": "…", "name": "…", "description": "…", "version": 1,
                "files": [{ "path": "PRESET.md", "bytes": 1234, "sha256": "…" }] }] }
```

### Operations (shared protocol, service-owned, CLI and MCP generated)

| Operation | Params | Returns |
| --- | --- | --- |
| `preset.list` | `{ remote?: boolean }` | The installed presets (id, name, description, version, source `bundled` or `downloaded`, references). With `remote: true` it also returns the repo index's ids and versions and whether each is newer. |
| `preset.get` | `{ id }` | The raw `PRESET.md` text, the absolute folder path, the kit folder path, the file list, and `instructions`: what to do with it now (follow `## Shoot` before recording, or `## Edit` on the user's footage, then `## Check`). |
| `preset.create` | `{ name, references? }` | Makes a new **local** preset and tells the agent what to do next. It generates the id from `name`, copies `authoring/template/` to `~/.yap/presets/<id>/`, records the references in `PRESET.md`, and records the preset as `local`. Returns `{ id, path, guidePath, kitPath, instructions }`. `instructions` is the ordered list of steps with every path and command filled in (see [slice 06](slices/06-create.md)). |
| `preset.delete` | `{ id }` | Deletes a **local** preset: moves `~/.yap/presets/<id>/` to the macOS Trash (recoverable), and removes it from `local.json`. Bundled or downloaded presets are refused with `PRESET_NOT_LOCAL`, because they'd come back with the next refresh. Returns `{ id, trashedPaths }`. |
| `preset.update` | `{ id?: string }` | Runs the same refresh as the automatic one now, for the named preset or every preset. Returns the installed versions and the commit. |

`preset.list` also reports the refresh state: last checked, last commit, and the
last error if any.

If the same id exists in both places, the higher `version` wins. A tie goes to
the bundled copy. A download that fails verification leaves the previous copy in
place and reports the mismatched path.

### Storage

- Bundled: `Yap.app/Contents/Resources/presets/`, copied from repo `presets/` by
  `scripts/build-macos.mjs`, next to the skill. The service gets the path through
  an option or environment variable, the same way it gets `YAP_FFMPEG_DIRECTORY`.
- Downloaded: `~/.yap/presets/<id>/` and `~/.yap/presets/kit/`, mirroring the repo
  so `../kit/` resolves, plus `~/.yap/presets/receipt.json` (commit, time, per-file
  sha256). Each folder is replaced whole by a rename from staging. This is outside
  `~/.yap/library`. The kit carries its own `version` in the index and refreshes
  like a preset.
- Refresh: the service checks at startup and once a day. It compares the remote index
  with the installed versions and downloads only presets whose version is higher.
  Offline or failed checks are silent apart from `preset.list`'s refresh state.

## Invariants

- One owner: a preset catalog module in the service owns discovery, precedence,
  reading and installing. The CLI and MCP get the operations from the schema; no
  adapter reads preset files itself.
- `catalogFormat`, the project document and every library table stay the same.
- Preset operations never create, edit or export a project.
- Committed preset text describes each style in our own words. It quotes no
  transcript or script from the references. Reference media is limited to small
  stills and storyboards in `examples/`; no video or audio.
- The download path follows the model-download pattern: verify in staging, then
  rename into place, so a reader never sees a half-installed preset.

## Reference videos

Each preset lists its X links. To study a new example, download the video locally
(`yt-dlp <link>`) into a directory outside the repo, then measure it (see
[study](study.md) for the method). Add an `examples/<name>/` folder with a README,
~10 named stills and storyboards, link it from `PRESET.md`'s examples list, and
bump `version`. Never commit the video or audio.

## Slice graph

```
01 format ─► 02 read ─► 03 download
     │           ├────► 04 skill route
     │           └────► 06 create (authoring guide + template already exist)
     └──────────────────► 05 presets (needs 02 for the end-to-end eval)
```

01–04 are portable TypeScript and can be checked with vitest. 05 is the
expensive one: its proof is a real edit of raw footage, judged against the
reference with [compare-screenshots](../../.agents/skills/compare-screenshots/SKILL.md)
and [screenshot-critique](../../.agents/skills/screenshot-critique/SKILL.md).

## Known unknowns

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
