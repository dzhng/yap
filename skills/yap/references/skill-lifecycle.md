# Skill lifecycle

The installed app maintains the global yap skill itself (see
[App and CLI lifecycle operations](#app-and-cli-lifecycle-operations)); prefer
`skill.status` and `skill.install` over the manual steps below. Use the manual
steps for a project install, for comparison, or when the app reports a problem.

For a manual install, use the published `npx skills@1.7.0` installer. Check `node --version`,
`npm --version` and `npx --version`; Node/npm for this command are separate from
the app's bundled runtime. If missing, report this prerequisite and use the
user's existing runtime installation route. Do not build the app to obtain it.
Default to a whole-computer install. Honor an explicit project request. When
scope is unspecified and the current directory has project markers (for example
`.git`, `package.json` or `pyproject.toml`), ask “Install for this project or the
whole computer?” before writing. Do not infer project scope from a checkout.
Inspect the selected canonical folder and every agent's discovery path first.
When maintenance is enabled, Yap owns the global Yap skill and may replace an existing global Yap installation. Disable maintenance before making local customizations; inspection is read-only and never authorizes a refresh.

## Fetch one complete pinned folder

Stage upstream outside the installed folder. Resolve `main` once and save its
commit; use that exact commit for every file. With usable Git:

```sh
yap_stage=$(mktemp -d)
yap_commit=$(git ls-remote https://github.com/dzhng/yap.git refs/heads/main | awk '{print $1}')
test ${#yap_commit} -eq 40 || exit 1
git init "$yap_stage/repo"
git -C "$yap_stage/repo" remote add origin https://github.com/dzhng/yap.git
git -C "$yap_stage/repo" sparse-checkout init --no-cone
git -C "$yap_stage/repo" sparse-checkout set '/skills/yap/'
git -C "$yap_stage/repo" -c protocol.version=2 fetch --depth 1 --filter=blob:none origin "$yap_commit"
git -C "$yap_stage/repo" checkout --detach FETCH_HEAD
yap_source="$yap_stage/repo/skills/yap"
printf '%s\n' "$yap_commit" > "$yap_stage/source-commit.txt"
```

Without usable Git, use the same Node prerequisite to recursively fetch the GitHub
contents API. This resolves `main` once and binds every directory/file to its SHA:

```sh
yap_stage=$(mktemp -d)
export YAP_SKILL_STAGE="$yap_stage"
node --input-type=module <<'NODE' || exit 1
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const base = 'https://api.github.com/repos/dzhng/yap';
async function get(url, json = true) {
  const response = await fetch(url, { headers: { 'User-Agent': 'yap-skill-fetch' } });
  if (!response.ok) throw new Error(`Skill acquisition failed: HTTP ${response.status} ${url}`);
  return json ? response.json() : Buffer.from(await response.arrayBuffer());
}
const { sha } = await get(`${base}/commits/main`);
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid main commit identity');
const stage = process.env.YAP_SKILL_STAGE;
const prefix = 'skills/yap';
async function folder(path) {
  const entries = await get(`${base}/contents/${path}?ref=${sha}`);
  if (!Array.isArray(entries) || !entries.length) throw new Error(`Incomplete folder: ${path}`);
  for (const entry of entries) {
    if (entry.path !== `${path}/${entry.name}` || entry.name.includes('/') || entry.name === '..') throw new Error('Invalid source path');
    if (entry.type === 'dir') await folder(entry.path);
    else if (entry.type === 'file') {
      const destination = join(stage, 'yap', entry.path.slice(prefix.length + 1));
      await mkdir(join(destination, '..'), { recursive: true });
      await writeFile(destination, await get(`https://raw.githubusercontent.com/dzhng/yap/${sha}/${entry.path}`, false));
    } else throw new Error(`Unsupported source entry: ${entry.type}`);
  }
}
await folder(prefix);
await writeFile(join(stage, 'source-commit.txt'), `${sha}\n`);
console.log(`Complete skill staged at ${join(stage, 'yap')}; commit ${sha}`);
NODE
yap_source="$yap_stage/yap"
```

If neither route is available, report the acquisition blocker. Do not install
Xcode/Command Line Tools merely to download a skill or clone repository media.
For a supplied complete local snapshot, record its identity and skip acquisition.

## First whole-computer install (default)

Select the agents the user uses (`codex`, `claude-code` here). With the pinned
complete source folder above:

```sh
test ! -e "$HOME/.agents/skills/yap" && test ! -L "$HOME/.agents/skills/yap" || exit 1
test ! -e "$HOME/.codex/skills/yap" && test ! -L "$HOME/.codex/skills/yap" || exit 1
test ! -e "$HOME/.claude/skills/yap" && test ! -L "$HOME/.claude/skills/yap" || exit 1
npx --yes skills@1.7.0 add "$yap_source" --skill yap --agent codex claude-code --global --yes
test -d "$HOME/.agents/skills/yap" && test ! -L "$HOME/.agents/skills/yap" || exit 1
test -L "$HOME/.claude/skills/yap" || exit 1
test "$(cd "$HOME/.claude/skills/yap" && pwd -P)" = "$(cd "$HOME/.agents/skills/yap" && pwd -P)" || exit 1
diff -ru "$yap_source" "$HOME/.agents/skills/yap"
```

Codex discovers the global canonical `~/.agents/skills/yap` directly; Claude's
link must resolve there. A pre-existing `~/.codex/skills/yap` is also a Codex
installation. For an enabled Yap maintenance install, replace it through the
explicit whole-folder replacement transaction below so every harness resolves to
the same staged folder; do not leave a second conflicting copy. Verify references
and start a fresh session to confirm discovery. Local-folder sources have no
remote update tracking. For inspection or refresh below, use the selected global
paths rather than project paths; back up any existing agent-local discovery
entries too. An enabled Yap maintenance setting authorizes replacement of an existing global Yap install, including one that lacks a Yap receipt. Stage and verify the complete replacement before removing the prior folder; retain a rollback backup until verification succeeds.

## First project install

In the intended project, select the agents you use (`codex`, `claude-code` here).
Do not use `--copy`, `--global`, `skills check`, a dry-run flag, or a
custom manager command. Local folder sources have no remote tracking.

```sh
test ! -e .agents/skills/yap && test ! -L .agents/skills/yap || exit 1
test ! -e .claude/skills/yap && test ! -L .claude/skills/yap || exit 1
npx --yes skills@1.7.0 add "$yap_source" --skill yap --agent codex claude-code --yes
test -d .agents/skills/yap && test ! -L .agents/skills/yap || exit 1
test -L .claude/skills/yap || exit 1
test "$(cd .claude/skills/yap && pwd -P)" = "$(cd .agents/skills/yap && pwd -P)" || exit 1
diff -ru "$yap_source" .agents/skills/yap
```

Check every staged reference exists in the canonical folder. The installer can
fall back to copies; a claimed symlink is insufficient. Never link an entire
agent configuration directory. Start a fresh session in this project and verify
skill discovery before using the released-app installation procedure.

## Read-only comparison and surgical updates

For inspection, fetch the entire pinned folder, resolve the actual canonical
folder and record current file/link hashes and `skills-lock.json` before and
after. Run only a recursive textual diff:

```sh
diff -ru .agents/skills/yap "$yap_source"
```

Exit 1 means differences; exit greater than 1 means comparison failed. Account
for modified files, upstream additions, upstream removals and local extras, even
when SKILL.md itself is unchanged. Return the diff and source commit. Do not run
`add`/`update`, edit metadata or alter links for an inspection request.

For an explicit surgical request, apply only the requested hunks/files to the
resolved canonical folder. Preserve unrelated custom text and local extras;
deletions require the requested scope. Do not reinstall the entire folder. Show
the resulting diff and verify references, links and unrelated settings.

## Explicit whole-folder replacement

Only an explicit replacement request authorizes removal of local extras and
upstream-deleted files. Back up the entire old canonical folder, existing selected
discovery entries (preserving symlinks), and installer metadata before removing
anything. Keep unrelated configuration intact. For this two-agent project layout,
the following block saves those entries, replaces from the staged complete folder,
and restores them on a failed add or failed link/content verification. Avoid
concurrent skill-management writes during the transaction. If the canonical path
itself is a symlink, first inspect its owner and resolve the intended topology;
do not run this block against an unknown external target.

```sh
test -d .agents/skills/yap && test ! -L .agents/skills/yap || exit 1
yap_backup=$(mktemp -d)
for yap_entry in .agents/skills/yap .claude/skills/yap skills-lock.json; do
  if test -e "$yap_entry" || test -L "$yap_entry"; then
    mkdir -p "$yap_backup/$(dirname "$yap_entry")"
    cp -RP "$yap_entry" "$yap_backup/$yap_entry" || exit 1
  fi
done
rm -rf .agents/skills/yap .claude/skills/yap || {
  printf 'Cleanup failed; backup retained at %s\n' "$yap_backup" >&2
  exit 1
}
if npx --yes skills@1.7.0 add "$yap_source" --skill yap --agent codex claude-code --yes &&
   test -d .agents/skills/yap && test ! -L .agents/skills/yap &&
   test -L .claude/skills/yap &&
   test "$(cd .claude/skills/yap && pwd -P)" = "$(cd .agents/skills/yap && pwd -P)" &&
   diff -ru "$yap_source" .agents/skills/yap; then
  printf 'Replaced; backup retained at %s\n' "$yap_backup"
else
  rm -rf .agents/skills/yap .claude/skills/yap skills-lock.json || {
    printf 'Rollback cleanup failed; backup retained at %s\n' "$yap_backup" >&2
    exit 1
  }
  for yap_entry in .agents/skills/yap .claude/skills/yap skills-lock.json; do
    if test -e "$yap_backup/$yap_entry" || test -L "$yap_backup/$yap_entry"; then
      mkdir -p "$(dirname "$yap_entry")"
      cp -RP "$yap_backup/$yap_entry" "$yap_entry" || exit 1
    fi
  done
  diff -r "$yap_backup/.agents/skills/yap" .agents/skills/yap || exit 1
  if test -L "$yap_backup/.claude/skills/yap"; then
    test -L .claude/skills/yap &&
      test "$(readlink .claude/skills/yap)" = "$(readlink "$yap_backup/.claude/skills/yap")" || exit 1
  elif test -e "$yap_backup/.claude/skills/yap"; then
    diff -r "$yap_backup/.claude/skills/yap" .claude/skills/yap || exit 1
  fi
  if test -e "$yap_backup/skills-lock.json"; then
    cmp "$yap_backup/skills-lock.json" skills-lock.json || exit 1
  fi
  printf 'Replacement failed; prior entries restored from %s\n' "$yap_backup" >&2
  exit 1
fi
```

If filesystem access prevents cleanup or restoration, stop and report incomplete
recovery and the retained backup path; never claim that restoration succeeded.

Report the retained backup path, pinned source, resulting full-folder diff and
actual discovery link targets. Verify unrelated settings and other skills remain
unchanged. Retain the backup until the user decides it can be removed. A local
install's future refresh repeats this fetch/diff/explicit-update sequence. Yap's
app maintenance refreshes the global installation whenever maintenance is enabled,
replacing every global Yap skill it discovers (including symlinks and installs
without a Yap receipt) and discarding its temporary backup once the refresh
verifies; a failed refresh restores the backup. It never edits project-local
installs. Disabling maintenance removes the global paths Yap recorded plus any
global Yap skill discovered at that moment; without a Yap receipt it removes
nothing.


## App and CLI lifecycle operations

The same handlers are available through Settings and the public CLI:

- `skill.status` discovers the canonical folder and harness links and returns
  compact state plus diagnostic paths, source revision, ownership and errors.
- `skill.install` starts a durable operation that stages and verifies the complete
  current folder, then atomically replaces the global Yap skill.
  The app runs its bundled, pinned `skills@1.7.0` installer with its own Node, so
  no host Node, npm or network is needed. The installer discovers the supported
  harnesses rather than a hand-maintained path list. The app supplies its bundled
  `skills/yap` folder as the source; a new app release carries the latest skill.
- `skill.update` starts the same pinned replacement explicitly.
- `skill.uninstall` starts removal of the managed global installation; it does not
  touch project-local installs. The operations act whatever the Settings row says,
  but while **Set up my agents** is on the next launch installs the skill again, so
  turn the row off to keep it removed.

The protocol mutation response includes `state: "running"` and a `jobId`;
the CLI waits for the terminal state by default (use `--no-wait` for an immediate
acknowledgement). Other protocol clients poll `skill.status` for the terminal
state and any retained error or backup path.
The app reconciles at every launch (including the relaunch after an app update)
and when maintenance is re-enabled. There is no periodic background timer.
Maintenance is the Settings row **Set up my agents**, which covers both this skill
and the `yap` command (`cli.status`, `cli.install`, `cli.uninstall`). Its status
line summarizes both; read the WorkState lifecycle plus the separate
`installation` fact (`installed`, `missing`, `unmanaged`, `disabled` or
`needs_attention`) and diagnostics from `skill.status`.
