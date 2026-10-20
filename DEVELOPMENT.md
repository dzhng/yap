# Development principles

This document records the decisions that shape Yap's public contracts. It is
for people changing Yap, not for agents using the product. The consumer
[Yap skill](skills/yap/SKILL.md) is a separate customer-facing document: it
teaches external agents how to operate Yap through its public CLI and MCP
surfaces. It is not a second copy of repository development policy.

## Product boundary

Yap is an agent toolkit, not a UI editor or an opinionated house style. It
provides recordings, evidence, media operations and non-destructive revisions.
The caller chooses what the content should become. Detection is information;
it never grants permission to edit.

Every capability has one public operation meaning across the app, CLI and MCP
adapters. Keep the operation contract in the shared protocol and the domain
meaning in its existing owner. Do not create an adapter-specific interpretation
or a second media/editing engine.

## Explicit intent and reversible defaults

An explicit agent request chooses the policy. If the requested operation is
reversible and admitted by its contract, perform it without adding another
confirmation step. Reversibility is the safety mechanism: the caller can
inspect, undo or restore the result.

Do not silently add alignment, cleanup, correction, optimization or other
cleverness to supplied input. Defaults should preserve what the caller supplied;
additional analysis or transformation should be an explicit option. Be clever
when the agent delegates judgment. Be direct when the agent specifies the
operation.

Preserve the original input, provenance and uncertainty beside derived results.
Failures must leave the prior working state intact. A compound reversible action
should publish as one atomic revision with one replay identity and one undo step.

For example, imported transcript timing is trusted by default. An agent can
explicitly request audio alignment when it wants measured word boundaries, but
Yap should not re-align a transcript merely because it can.

## Evidence and edits

Evidence may be gathered automatically; edits never are. Every recording and import is
transcribed in the background as soon as the speech model is ready, because the transcript
is the first thing every agent reads, and that work never blocks or delays a request
someone made. Nothing automatic ever changes a project or source media.

Read operations return evidence and do not mutate projects. Edit operations carry
explicit intent, pin the revision they apply to and retain enough history to
inspect, undo or restore the result. Candidate detectors for fillers, pauses or
quality issues remain evidence until the caller requests an edit.

Source media remains byte-for-byte intact. Derived media, transcript alignment,
voice generation and processing retain their source and implementation identity
so an agent can explain what happened and choose another revision.

## Limits come from requirements

A take can run for 12 hours, and a ⇧ stroke for 5 minutes. Those are the only limits the
product sets. Every other bound (bytes per line or file, rows, samples, pages, deadlines) is
derived from them: what that data grows at, times the requirement, times a stated margin.
Write the derivation next to the constant. A bound you can't derive is made up; delete it.
Readers stream, so a bound tells corrupt input from valid input; it never caps what a valid
take can hold, and corrupt input fails with a clear error, never a hang.

## Documentation ownership

The root README explains Yap to humans: what it is, why it exists and how to get
started. It should stay a concise product and market document. This file holds
the development rationale that would otherwise make the README grow into an
architecture manual.

`AGENTS.md` routes repository work and points here. `skills/yap/SKILL.md` defines
how customer agents use the installed product. Package and feature READMEs own
their local contracts; the code and protocol schemas remain the source of truth
for exact behavior.

When a user reports a bug in a released app, the exact installed project and
reported framing are the acceptance target. Preserve that project document and
a representative frame when practical, reproduce through the public operation,
and record the installed app, service and native implementation versions. A
source checkout or synthetic fixture can supplement this evidence but cannot
replace it.

For a visual or media bug, the user's exact project and reported framing own the
fixture. Synthetic scenes are supplemental. If the original media is too large
to check in, retain the exact project document and a representative frame with
its source time and dimensions. Compare the old and new output through the same
public operation, and make the regression fail once against the old behavior
before accepting the fix.

A fix is shipped only after the tagged package is built, published and the
installed runtime reports that tag. A pushed source commit is not the latest
installed version while the app still reports an older release. Verify the
published release assets and then check the installed app version, CLI version,
service health and the exact user project again.
