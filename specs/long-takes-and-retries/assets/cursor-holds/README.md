# Held cursor evidence

The synthetic conformance case in
[`cursor-render.test.ts`](../../../../apps/service/src/cursor-render.test.ts)
produces these native PNGs from production-written dense and change-only journals.
Both use the same generated movie, geometry and pointer position. The composition
compiler supplies source clocks for reordered clips; no user library or media is
an operand.

`dense/` is the every-tick reference; `sparse/` is change-only. The saved stills cover
a cut, a scene transition and reordered project clips whose source starts are
trimmed. `comparison/visual-parity-diff.json` and the paired images retain the pixel comparison.
All four pairs have identical PNG bytes and zero pixel differences. These images
prove equivalence at the selected moments, not continuous-motion quality or device
capture correctness.

The pointer's original observation clock stays intact. A trail may clip a held
position to the requested time window and extend that same position until the next
change; it never invents an intermediate position. Cut and scene reset floors still
clip trails; physical gaps continue to invalidate the pointer. Historical journals
and explicitly non-holding schema-4 journals retain their reset policy.

Raw-page prefixes are context: the sample preceding the requested start does not
consume the page's forward-progress allowance and never becomes its continuation
anchor. The active source reader and the portable evidence reader consume the same
journal sampling declaration.

Focused commands (repository root):

- `YAP_CURSOR_TESTS=1 helpers/mac/.build/debug/YapCaptureTests`: 22 cursor/header checks passed; ten still seconds consume 600 readings and write one sample.
- `YAP_MARK_RECOGNIZER_TESTS=1 helpers/mac/.build/debug/YapCaptureTests`: 12 checks passed.
- `node_modules/.bin/vitest run packages/core/src/trails.test.ts packages/core/src/evidence-pages.test.ts packages/core/src/evidence.test.ts packages/core/src/composition-pointer.test.ts --maxWorkers=2`: 87 passed; one unrelated opt-in long-stroke case skipped.
- `node_modules/.bin/vitest run apps/service/src/cursor-render.test.ts --maxWorkers=1`: both tests passed, including the public service round-trip.
- `node --test --test-name-pattern='historical normalized bytes' helpers/mac/Tests/source-evidence.test.mjs`: all four byte/receipt references passed after fetching just the missing journal LFS inputs.
- Core and service typechecks, focused lint and diff whitespace checks passed. The geometry probe passed Swift parsing; it was not run against the desktop.

The initial cut assertion failed with a visible dense pointer and a null sparse
pointer, then passed. The still-writer assertion failed with 600 written samples,
then passed with one. A pending reading stayed unwritten without another hardware
callback before the timer change; it now reaches the journal at the take-time
flush. Dropping the portable sampling declaration also failed the cut regression,
then passed when restored.

The independent Codex CLI code review was attempted with a read-only sandbox and
`--uncommitted`; it ended with `turn.failed` because the selected model was at
capacity, so it supplied no review verdict. Local shape, diff and documentation
review completed. The visual review is recorded in `critique.md`.
