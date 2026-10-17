# 06 Create and delete

**Unlocks:** any agent can make a new preset, for the user or for us, by asking
Yap. The rules, method and depth bar come back with the scaffold, so a fresh agent
inherits everything learned while making the first three.

**Seam:** two operations on the preset catalog owner.

`preset.create { name, references? }`:
1. Generates the id from `name`: lower-case ASCII, words joined by `-`, other
   characters dropped, at most 48 characters. If the id is taken by a local,
   bundled or remote-index preset, it appends `-2`, `-3`… until free. A name that
   yields no id is refused.
2. Checks each reference is an https URL or an absolute path to an existing local
   file, and records it. It doesn't fetch anything.
3. Copies `authoring/template/` to `~/.yap/presets/<id>/` through staging and a
   rename, fills `id`, `name` and `references`, and adds the id to
   `~/.yap/presets/local.json`.
4. Returns `{ id, path, guidePath, kitPath, instructions }`.

`instructions` is what the agent does now, in order, with paths filled in. It is built
from the guide's method so the two never disagree (one owner: the method lives in
`AUTHORING.md`, and the service renders it with this preset's paths). For a
preset with one URL reference, `instructions` reads:

1. Read `<guidePath>` sections "The one idea that matters" and "Rules". Open the
   closest shipped preset with `yap preset.get <id>` for depth.
2. Download each URL reference into `<path>/examples/<slug>/source/`
   (`yt-dlp -o '<path>/examples/<slug>/source/%(id)s.%(ext)s' <url>`); copy or link
   local files there too. Keep anything that helps a future agent: the video,
   short excerpts of key moments, the audio.
3. For each reference, make an example folder `<path>/examples/<slug>/` and build
   the reference set: `node <kitPath>/measure.mjs …`, stills, storyboards,
   filmstrips, scopes, `node <kitPath>/music.mjs …`, `pacing.mjs` for speech.
4. Write `<path>/PRESET.md` from its template sections, then `targets.json`,
   `look.json` and `look.cube` (`node <kitPath>/make-look-lut.mjs …`).
5. Run `node <kitPath>/check.mjs` on every example's profile until every line is `ok`.
6. Run `yap preset.get <id>` and read the result as a new agent would.
7. Tell the user what the preset captured and what it couldn't, then offer to
   use it on their footage.

`preset.delete { id }`:
1. Refuses an id that isn't in `local.json` (`PRESET_NOT_LOCAL` for bundled or
   downloaded presets, `PRESET_NOT_FOUND` otherwise).
2. Moves `~/.yap/presets/<id>/` to the macOS
   Trash, so a mistake can be undone in Finder, and removes the id from `local.json`.
3. Returns `{ id, trashedPaths, instructions }`. `instructions` says the preset is gone and that
   the user can restore it from the Trash.

Shipping one of ours is a Git change, not an operation: copy the finished folder
from `path` into the repo's `presets/`, run `node scripts/presets-index.mjs`, and
open a PR. Repo validation accepts only https references and refuses video and audio files
and anything over the size budget, because the repo is public and every install
downloads it; drop `source/` folders when copying.

**Run or see:** `yap preset.create --params '{"name":"Vertical explainer","references":["https://…"]}'`
returns `id: "vertical-explainer"` and its path. A second identical call returns
`vertical-explainer-2`. `yap preset.list` shows both as `local`.

**Proof (write tests first):**
- A name becomes the expected id; a taken id (local, bundled or remote) gets the
  next free suffix; a name with no usable characters is refused and nothing is written.
- The scaffold has the filled frontmatter and the template's sections, and
  `preset.list` and `preset.get` report it as `local`.
- A non-https reference is refused and nothing is written.
- An interrupted copy leaves no partial folder and no `local.json` entry.
- `instructions` names the real `path` and `kitPath`, and its steps follow
  the method in the installed `AUTHORING.md`.
- A local file reference is recorded, and `preset.create` itself copies nothing.
- `preset.delete` moves the folder to the Trash and drops the `local.json` entry;
  the id can then be generated again. It refuses bundled and downloaded presets.
- A refresh never removes or overwrites a local preset.

**Dogfood gate:** create a local preset of an existing style with a new reference
video, follow `AUTHORING.md` to a finished preset, and record where the guide fell
short. Fix the guide, not just the preset.

**Delegated:** the frontmatter templating, how `local.json` is written atomically,
how the Trash move is done (Finder's API or `NSFileManager.trashItem` through the
native helper), and error wording.
