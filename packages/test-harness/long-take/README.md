# Long-take journal measurements

This lab measures deterministic synthetic evidence through the native journal writer and
read/export/publication owners, followed by core validation and catalog indexing. It never
opens capture hardware, uses a library home, or takes a recording as input. Fixed clock and
pointer inputs make generated journals reproducible; generated files are disposable.

Run `node packages/test-harness/long-take/probe.mjs --help` from the repository root.
The runner compiles only the native media/capture modules and the production evidence exporter
into the selected scratch output. Build core and its protocol/composition dependencies first.
The focused check is `node --test packages/test-harness/long-take/probe.test.mjs`.

Each stage is a separate process measured with macOS `/usr/bin/time -l`. Publication uses a
journal-only fixture: a missing-media refusal is recorded as a prerequisite, and size failures
remain failures. Export and downstream reads run independently of publication. A failed export
blocks downstream stages; the lab never fabricates receipts to get past a product bound.

Schema 3 writes all cursor ticks. The typical fixture changes coordinates at the change ratio measured on a real take;
worst-case motion changes every tick. The camera mapping is a **size model** of accepted
callbacks using production frame/rational encoders and a fixed callback envelope. It does not
exercise `CaptureClockIngress`, camera verification or movie encoding. The journal stages do
not consume this separate mapping; their costs cannot establish camera readiness.

The retained measurements and their limitations live in the spec's
[probe report](../../../specs/long-takes-and-retries/assets/probes/README.md).
