# Builds, installation and releases

This directory owns build, installation, packaging and developer-lab entry points.
The [root manifest](../package.json) selects commands; each tool owns its arguments.
Build output belongs outside tracked source. A build verifies and assembles an
artifact; installation changes the selected app location; packaging creates a
portable distribution. One does not imply the others.

The installed C launcher must answer failures even when the app cannot be opened. Its
[build projection](launcher/verdicts.mjs) compiles the emitted codes' retry metadata from the
shared protocol ledger, so startup needs no second policy table or runtime file read.
The [consumer projection](consumer-verdicts.mjs) uses the same
[ledger projection](ledger-verdicts.mjs) for source-built launcher failures.

## Native prerequisites

Bun installs workspace dependencies and orchestrates build scripts; Node runs the
service and CLI, and Swift builds the native boundary. Run bun install before a
checkout build. The [Node pin](../.node-version) and root manifest own tool versions.

The [app builder](build-macos.mjs) composes the workspace and native outputs,
and bundles the repository's [presets](../presets/README.md) without their local
`source/` folders. The [preset index](presets-index.mjs) regenerates and checks
`presets/index.json`, which every install refreshes against.
Manifests pin toolchains and dependencies. Native compilation explicitly selects
SwiftPM’s native build system: controls checks link its modules/object map, and
native runners consume its debug executable layout. A different build engine
requires migrating those consumers together. The [denoiser owner](../helpers/denoise/README.md)
explains its verified build input; the [FFmpeg owner](../helpers/ffmpeg/README.md)
prepares the pinned LGPL executable and shared-library distribution. Speech and voice model readiness is explicit
runtime work, not permission to download models during ordinary execution.

Prepare the FFmpeg distribution before an app build. Build and release staging
share its signing-and-receipt owner; already signed tool resources remain byte-exact
when the enclosing app is signed and are still verified. Copying a receipt from
unsigned bytes cannot describe the signed package. Matching sources and notices travel with the tools. The FFmpeg owner's pinned
provenance is also the release-input manifest for its runtime and private build
dependencies; do not mirror those versions in the Node input manifest. Ordinary
release consumers require neither FFmpeg nor pkgconf from the host.

Personal source builds may record a host interpreter. Tagged packages include
an interpreter resolved relative to the app, so moving the package cannot retain
a builder's machine path. [Runtime resolution](../apps/macos/README.md#runtime-resolution)
owns probing and failure behavior.

## Versioned GitHub releases

Local release packaging reads signing inputs from the ignored `.release-signing/` directory when
the corresponding environment variables are unset. Put these mode-0600 files there:

| File                            | Contents                                                     |
| ------------------------------- | ------------------------------------------------------------ |
| `release-identity.p12`          | Base64-encoded PKCS#12 signing identity                      |
| `release-identity-password.txt` | Password for that identity                                   |
| `sparkle-private-key.txt`       | Base64-encoded 32-byte Sparkle private seed                  |
| `public.json`                   | JSON with `sha1`, `certificateSha256` and `sparklePublicKey` |

The optional `release-identity.crt` is retained as a local backup but is not read by packaging.
CI remains environment-only. Never commit this directory or copy its contents into release
artifacts.

The [app manifest](../apps/macos/package.json) owns the product release version.
Native app metadata, CLI/MCP reporting, service runtime metadata and the release
receipt all derive from it. Bundling embeds the version into the CLI and service,
so an installed artifact reports its own build without needing the checkout.
Update the manifest, commit the source, and push an annotated tag whose name is v
followed by that version. Push the source branch as well. Never move a published tag or silently replace
its assets; a correction receives a new version.

On an available Apple Silicon release machine, build, package and publish locally
before pushing the version tag. Run `node scripts/release.mjs prepare`,
`node scripts/release.mjs package vX.Y.Z`, `node scripts/release-smoke.mjs` and
`node scripts/release-media-smoke.mjs`; `releaseSigningInputs()` reads the
ignored `.release-signing/` folder automatically. Generate the GitHub body with
`node scripts/release-notes.mjs vX.Y.Z > dist/release/NOTES.md`, then publish
through `node scripts/release-publish.mjs dist/release vX.Y.Z REVISION`.
Only after the local package and smoke gates pass should the annotated tag be
pushed. The tag workflow is manual fallback infrastructure for an unavailable
local release machine or an explicit request; it is not the normal build path.

The [tag workflow](../.github/workflows/release.yml) is a manual fallback. It
validates version agreement, prepares pinned inputs, builds on macOS, checks the
relocated package and publishes only verified assets. It is deliberately not
triggered by a tag push, because the normal release is built and published from
the local signed package. Its manual run takes an explicit version tag validated
by the same release owner; published assets remain immutable.
An unpublished release must come from the tag's exact source. Rebuilding a
published release checks repaired tooling without changing delivered bytes.
Relocation smoke checks CLI version agreement and loads schema help and the native
worker from the exact signed archives; it does not launch the production host or external
launcher, whose preferences and lock belong to the real account. Host/service and
updater lifetime proof uses an isolated signed fixture identity. The workflow owns
triggers and permissions. Normal version tags, including `v0.*`,
publish stable; suffixed tags publish prerelease. The [publication owner](release-publish.mjs)
uploads the complete draft before publishing, verifies receipts, and leaves
published releases untouched. GitHub selects the latest stable release by its
semantic-version policy, so publishing a delayed older draft cannot force the
update feed backward. Prereleases do not become latest.

A separate [relocated media check](release-media-smoke.mjs) runs the packaged service and JavaScript CLI
in a scratch library, without the production app or external launcher. It reuses
the retained delivery fixture, including exact audio landmarks and export replay;
complete media receipts remain in ignored release output.
[Focused CI](../.github/workflows/release-checks.yml) checks release contracts on
relevant source changes without starting capture or model inference.

The [release tool](release.mjs) owns validation, explicit preparation and packaging.
[Release inputs](release-inputs.json), the repository's Node version and denoiser
provenance bind acquired bytes. Package receipts bind source and runtime identity;
checksums bind delivered bytes. The install kit and app-only update ZIP contain
the same finalized signed app; the kit's checksums remain scoped to the kit and
receipt, while Sparkle authenticates the update ZIP and finalized feed.
The kit keeps one fixed name across versions, so
`releases/latest/download/Yap-macos-arm64.zip` always fetches the newest one; the
tag lives in its receipt. Publication, smoke checks, evals and the installation
procedure find the kit as the ZIP that `SHA256SUMS` names, which also covers
older releases with versioned kit names.
The [signing owner](release-signing.mjs) requires externally supplied durable
credentials and public fingerprints, imports the identity into an ephemeral
keychain, authorizes headless signing only within that keychain, and signs nested
code before its enclosing bundles. The temporary keychain stays appended to the
account search list during signing because `codesign --keychain` still uses that
list for certificate-chain lookup; cleanup removes only the owned entry.
A signing failure identifies the owned target
and bounded tool error after removing the current keychain’s private inputs;
security and OpenSSL diagnostics stay suppressed. Secret material
never belongs in the app, release directory, receipt or logs. The
[custody handoff](../specs/done/auto-update/assets/signing-custody.md) owns backup and CI
credential transfer; a missing input fails rather than creating another identity.
The [protected engine](sparkle/README.md) owns framework preparation; an explicit
framework override must match its pinned build receipt. Source builds link the
same SDK but have no feed or public update key. Only release packaging enables
updates and derives compatibility metadata from core. The fixed
[launcher](launcher/main.c) holds shared kernel exclusion before any bundled code
read and until the CLI process ends. It names the lock's descriptor and path to
Node, because a `yap mcp` session lives as long as its agent: the session releases
the lock once started (its code is loaded by then) and takes it again for each
call, and it exits after a call that finds a newer version installed. Its lock follows the passwd account home,
matching Sparkle even when `HOME`
selects another default app location. The account lock persists across bundle
replacement; neither launcher nor updater may unlink it. Neither is a notarization
claim. The
[recipient guide](release-notes.md) is the cumulative project-facing history
and links to [agent setup](../README.md#agent-setup). The release publisher uses
`release-notes.mjs` to extract only the selected version section for a GitHub
release body, so historical entries do not repeat in every release. The consumer skill's
[installation procedure](../skills/yap/references/installation.md) owns
executable release-install commands and readiness checks.

The released launcher also dispatches direct media-tool invocations under that
same exclusion, without entering Node or the service. Tool arguments, streams and
exit status pass through unchanged. Raw discovered executable paths remain useful
inventory evidence; executing them directly bypasses the launcher's update protection.
Direct tool output is outside managed export identity and publication.
Release apps carry the signed launcher at `Contents/Resources/bin/yap`, and the kit
holds only the app and its receipt. The app writes `~/.local/bin/yap` from that
copy at every launch, so an automatic update refreshes the command with its app.
Every build also carries the pinned `skills` installer
([bundled here](skills-installer.mjs)), which the app runs with its own Node.
The launcher finds the app at `$YAP_APP`, then `~/Applications/Yap.app`, then
`/Applications/Yap.app`.

When a published release misbehaves, tell the people running it with an
[admin notice](../apps/site/README.md#admin-notices) targeted at its version, then
publish a corrected version; never move the broken release's tag.

## Personal source installation

The [installer](install-personal.mjs) owns app and launcher destinations and
refuses to replace a running app. Installation preserves the built bundle’s
identity and signature. macOS capture permissions follow code identity, so local
[signing setup](signing-identity.mjs) matters when repeatedly replacing that build.
A signing identity is not notarization or permission to start capture.

## Developer labs

The [installed update runner](installed-update-lab/README.md) proves assembled
app/CLI replacement and library preservation using uniquely owned signed fixtures.
Its controlled local feed is separate from published GitHub artifact readiness.

Probe and measurement scripts exercise selected platform or product boundaries.
The [verification guide](../packages/test-harness/README.md) explains their evidence
roles and how to choose a focused existing runner. Read the selected tool's inputs
and state ownership before running a lab against a real installation.

The [updater boundary lab](update-lab.mjs) reproduces pinned Sparkle behavior in
uniquely identified scratch bundles. Its suite includes an expected defect
reproduction; a passing lab suite does not approve the engine. The
[active updater proof](../specs/done/auto-update/README.md#evidence-and-limits)
records acceptance separately from observed behavior.

The [protected Sparkle input](sparkle/README.md) owns the pinned source patch
and source-build requirements. The [native guard suite](update-guard.test.mjs)
requires an explicitly built framework and protects the install/cancellation
contract. Public fixture retention binds exact signed bytes while private keys
are always deleted; these native boundary results are separate from installed
product acceptance.

The [launcher lifetime lab](launcher-lab.mjs) is a disposable concurrency proof,
not an installer. It shows why selecting Node and then reading a mutable app path
needs exclusion for as long as a CLI process reads the app; an idle MCP session
reads nothing, so it holds the lock only while a call runs.
Its lock wrapper is research input until the updater's post-exit installation
owner is proved; a passing lab is not installed-update acceptance.

The [scratch signing lab](signing-lab.mjs) proves certificate-anchored app and
nested signatures, encrypted identity restoration and relocation with explicitly
selected framework/Node inputs. It creates and deletes only scratch keys; it
changes no certificate trust and performs no permission checks. The
[release signing checkpoint](../specs/done/auto-update/README.md#evidence-and-limits)
keeps the scratch recipe separate from owner-approved
[production credential custody](../specs/done/auto-update/assets/signing-custody.md).
