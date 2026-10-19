# Verification tools

This package exercises product contracts, measures their output and holds
independent references for judging that output.
The [product boundary](../../README.md#product-boundary) applies to every fixture
journey: authored test operations are explicit inputs, not inferred edit intent.

## Find the right owner

The [package manifest](package.json) owns default discovery and named lab
entry points. The source owns arguments, prerequisites and case selection. Read
the selected runner before invoking it; some perform native rendering, model
preparation or inference, while a replay may only read existing files.

- [Editing and source verification](editing/README.md) covers source facts,
  independent references, public journeys and replays of retained evidence.
- [Speech evaluation](speech/protocol.md) explains how independent labels,
  model identity and word alignment constrain accuracy claims.
- [The launch-video replay checker](acceptance/launch-video-replay.mjs) counts
  product refusals and hand-rolled workarounds in an agent's session transcript,
  for comparing a replay against the recorded baseline.
- [Native transport checks](src/) exercise the worker protocol and client
  image boundary. The [protocol fixtures](../protocol/fixtures/) own the shared
  requests and expected responses.

Files alongside this README are lab measurements that cross those domains. The
[installed caller journey](personal-release.mjs) is deliberately separate from
scratch integration: it consumes a supplied edit plan through the installed CLI
and can operate on the person's library.

## Different kinds of proof

A fixture generator supplies repeatable input. An oracle states the expected
result independently of the mechanism being checked. An integration journey
exercises actual component boundaries, including failure and resource lifetime.
A measurement records cost under specified work and environment.

Follow a runner's imports to reuse its fixtures, transport and observers.
Keep an independent expectation independent: sharing setup is useful, sharing
the implementation's answer would hide the defect. Numerical identity,
perceptual quality, installed behavior and resource budgets are different claims.

## Reuse evidence before producing more

Locate the contract in the source, then follow its evidence references. The
[closed editing record](../../specs/done/agent-editing/README.md#retained-evidence-and-visual-standards)
owns retained results and acceptance limits;
[archived evidence](../../specs/done/agent-editing/assets/README.md) binds historical
results to the source revision that produced them. A saved pass does not certify
current behavior.

Choose the smallest existing check that can distinguish the suspected failure.
Generated output belongs in an explicitly selected evidence directory or owned
scratch, separate from executable source.

This package keeps only what something runs: a default test, a named lab entry
or an import from elsewhere. A one-off probe's result belongs with its evidence;
the probe itself is recoverable from the revision that evidence names.
