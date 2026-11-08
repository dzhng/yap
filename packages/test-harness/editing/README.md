# Editing verification

This directory checks source and editing primitives through authored fixtures,
independent references and replays of retained evidence. Start with the contract
that could have changed. Filenames name the subject; a runner's imports identify
its shared setup and observers. Case selection and invocation belong to that
source, not a second scenario catalog here.

## Source facts and project meaning

Source evidence distinguishes media occupancy, acquisition availability and
stream identity. A decoder holding a previous picture across a timestamp gap does
not prove that acquisition was available. Source selection checks therefore need
both byte identity and the evidence interval that authorizes those bytes.

Project checks ask how explicit edits map those sources into a revision. The
[composition owner](../../composition/README.md) defines that meaning; the harness
must not invent a second edit model. Passing one boundary (lowering, admission,
delivery, ownership) does not prove the others.

## Independent references

A reference states the expected result without importing the mechanism it judges.
[Blend arithmetic](blend-reference.mjs) and the [player picture reference](FrameColorReference.swift)
are examples: matched input, output time and color interpretation come first, so
encoding loss is not mistaken for a composition or color-management error.
[Learned routing](denoise-routing.mjs) checks that a processor's state domain
matches the requested graph, not just the delivered tap.

Audio checks separate source addresses, placement and gain from conversion and
encoding. Authored nonzero samples and distinguishable channels expose errors
that silence or a symmetric fixture would hide. Exact retained PCM and lossy
encoded output require different expectations.

## Public journeys

The [shared service fixture](source-evidence-fixture.mjs) owns real CLI/MCP
transport and process lifetime. Follow its consumers before writing another
startup, result receiver or shutdown loop. [Pause audio](pause-audio.mjs) uses it
to check native audio around authored ambience and pauses; it is the
`lab:pause-audio` entry, and its source owns the native worker and output arguments.

A held operation or crash is useful only when its timing isolates the failure
being claimed. Cancellation, stale replies and publication before/after a commit
protect different outcomes.

## Replays of retained evidence

Most runners here replay receipts frozen under `specs/done/**/assets` without
starting a service, rendering or loading a model. They check that the retained
bytes still match their recorded identities and keep known refusals executable;
each focused test also proves that a mutated receipt is refused. A replay is
structural evidence only. It cannot stand in for a fresh run of the behavior
the receipt describes.

The real-media corpus verifiers ([video](video-corpus.mjs), [behavior](corpus-behavior.mjs),
[controls](corpus-controls.mjs), [multicam](multicam-corpus.mjs)) certify retained
inputs and scope. A green coverage report does not promote synchronization,
speaker continuity, camera selection or editorial quality. Its
[authorized inputs](../../../fixtures/video-editing-feedback/README.md) keep
reduction fidelity distinct from current recognition and picture behavior.

[Speech timing](../speech/protocol.md) needs independent audible labels, and
[conditional alignment](../../../helpers/alignment/README.md) keeps a matching
forced path separate from proof that the word was spoken. These measurement
boundaries remain separate from caller edit intent.
