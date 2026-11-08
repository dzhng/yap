# Automatic app and CLI updates

Shipped in [v0.1.3](https://github.com/dzhng/screen-recorder/releases/tag/v0.1.3).
The installed app checks for authenticated updates and replaces its bundle only
when existing work permits it. The executable CLI, Node, service and workers live
inside that bundle and update together. The external launcher stays stable.
Skills change only through an explicit caller request.

The [decision map](discovery.md) preserves the requirements and rejected options.
The [consolidated choices](choices.md) records decisions made during implementation.
The original build ladder is retained in release-source commit `4387da97` rather
than maintained as an unfinished plan.

## Why this boundary exists

An agent can keep a CLI or MCP process alive while the app looks idle. Replacing
files beneath that process can mix old and new runtime bytes. The
[launcher](../../../scripts/launcher/main.c) therefore acquires shared kernel
exclusion before reading bundled code and keeps it until the process ends.
The updater needs exclusive ownership of that same account-owned lock. It lives
outside the replaced bundle and is never unlinked to manufacture availability.
Its location follows the account home, not an arbitrary `HOME` environment value.

Sparkle owns scheduling, download, authentication, replacement and preferences.
Its public API allowed staged installation on ordinary quit and could not retain
our launch lock through replacement. Those observations ruled out an ordinary
SDK delegate or an app-only lock. The narrowly pinned
[protected Sparkle patch](../../../scripts/sparkle/README.md) requires explicit
installation authorization and holds the lock inside the installer. It transfers
the actual locked kernel object to the app; a reopened pathname or expiring lease
cannot replace that protection.

The [native coordinator](../../../apps/macos/Sources/ScreenRecorder/UpdateCoordinator.swift)
joins native intent, a service-owned permit and acknowledged launch exclusion.
Waiting for existing work does not cancel it or prevent ordinary operations. A blocked preparation
reopens admission and waits for existing owners to report progress. Unknown
acknowledgements remain fenced; the app cannot invent permission to continue.
Only held exclusion permits service-pipe EOF, and clean child exit precedes final
SDK authorization. The app alone owns its updater-initiated quit.

Ordinary user quit retains its capture-finalization behavior and does not install
a staged update. A post-EOF failure cannot reopen the departed service or start a
competing successor; recovery is explicit quit/reopen or reinstall. Closing an old
MCP process removes a blocker but does not create an immediate retry scheduler:
Sparkle owns the next update cycle. There is no updater daemon, forced idle,
automatic postlaunch rollback, or public updater command family.

## Independent ownership

The [service admission owner](../../../apps/service/README.md#update-admission)
uses existing work/resource owners and accepted transport lifetimes. The
[shared protocol](../../../packages/protocol/src/update.ts) carries private
coordination and the projection exposed by `service.health`; disabled or
unavailable updates do not make an otherwise ready service unhealthy.

The [Sparkle adapter](../../../apps/macos/Sources/ScreenRecorder/SparkleDriver.swift)
is the preference owner. Settings writes through it, so opt-out persists across
restart. Before final authorization, opt-out disarms staged installation. After
clean service exit and the final authorization request, a preference change
applies to the successor; it cannot retract that request while awaiting its reply.

[Release packaging](../../../scripts/README.md#versioned-github-releases) signs the
complete app with a durable self-signed identity, authenticates both feed and
archive, and derives compatibility from core's catalog format. An installed app
accepts only a feed item declaring its own library's format, so the feed lists the
update once per format the candidate opens, newest first, each limited by
`sparkle:minimumUpdateVersion` to apps at least as new as that format. Sparkle offers
each app the first item it qualifies for, so a format bump updates automatically and a
downgrade never does. Through 0.1.62 the feed declared only the written format, which
stranded 0.1.61 on the first bump.
Source builds keep manual updating. Stable signing is not notarization.
[Key custody](assets/signing-custody.md) separates the signing identity from the
update-authentication key and records the approved backup/CI handoff.

The [consumer lifecycle guide](../../../skills/screenrec/references/skill-lifecycle.md)
uses the real pinned upstream skills installer, a complete commit-pinned folder,
canonical `.agents` storage and actual discovery symlinks. Inspection, surgical
changes and whole-folder replacement have different explicit scopes. App updates
never overwrite customized skills or download speech models.

## Evidence and limits

The [published artifacts](assets/publication.json) bind tag `v0.1.3` to source
`4387da97` and exact locally verified bytes delivered by GitHub's latest stable
HTTPS links. Evidence/docs followups do not move that tag. Hosted signing, packaging and
relocation smoke subsequently passed; the publisher left the original assets
unchanged. The
[final package comparison](assets/final-release-parity.json) binds unchanged
compiled app/worker/Node/launcher text and exact CLI/service bundles to the earlier
installed payload; separate archive smoke verifies final nested signatures and
identical app trees in the install kit and app-only update.

[Installed acceptance](assets/installed-acceptance.json) covers real SDK replacement
behind an old MCP lifetime, quiet successor launch, complete populated-library
preservation, and manual recovery after a deliberately broken successor. These
runs use owned identity/feed/defaults/lock substitutions and the same executable
sources with older A metadata. They do not establish arbitrary-version migration
or live Settings interaction; production setter persistence and staged cancellation
have their own native/SDK proof.

The [agent matrix](assets/final-agent-matrix.json) has 44 successful fresh trials:
eleven distinct cases, two agents, two repetitions. It proves portable agent/skill
behavior in Docker, not native capture or media quality.
[Published-source onboarding](assets/published-onboarding.json) separately verifies
both documented live fetch routes, the real installer, complete references,
canonical storage, resolving Claude symlink and preservation of unrelated settings.

[Repository checks](assets/final-repository-checks.json) retain the complete attempted
run and affected followups. Build, types, formatting, portable/helper and updater
checks passed; lint retains existing warnings. Of 88 app Node checks, 65 passed
across scoped runs and 23 capture-permission/derived countdown failures remain
recorded for the current source-app identity. The user explicitly accepted prior
permission continuity and prohibited repeating it. The full suite is not reported
as green. Original failures and raw receipts remain retained, with no weakened
capture assertions or new permission setup.

[Protected engine](assets/protected-engine-proof.json),
[signing boundary](assets/signing-boundary.json) and
[launcher lifetime](assets/launcher-lifetime-proof.json) retain their own source,
inputs and failure limits. Historical reproduction scripts and reports belong to
the revisions recorded by their receipts; observations do not become wider claims
merely because the feature shipped.

## Visual provenance

[Settings evidence](assets/update-settings/README.md) retains the real pre-change
light/dark Settings window as the baseline and production-view candidate renders.
It records before/after comparison, lower-form framing and independent unprimed
critique. These images establish presentation; they do not substitute for updater
preference or staged-cancellation tests.
