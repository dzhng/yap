# Local speech evaluation

The [speech experiment command](../../../scripts/speech-eval.mjs) owns preparation,
invocation and input handling. Its usage text distinguishes acquisition planning,
explicit downloads/builds, offline inference and evaluation. The
[engine adapter](engines.mjs) consumes the product's model identity rather than
maintaining an independent model choice.

## Evidence belongs to the audio

Reference labels and candidate output must identify the same original media and
clock. Keep complete independently labeled neighboring words: marking only fillers
cannot reveal ordinary-word omissions or a boundary that cuts into a neighbor.
Labels describe audible occurrences and explicit preservation targets, never
permission to edit. Synthetic inputs exercise mechanics but do not establish
human-speech fidelity.

Model output cannot supply its own independent reference. Keep raw results and
human-reviewed evidence separate. Missing labels or listening observations leave
the affected claim pending rather than turning unrelated primitive checks into a
request for more user recordings. The [scorer](evaluate.mjs) owns admissible result
formats and the distinction between failure, pending evidence and a pass.

## Interpret each measurement narrowly

Match repeated words as ordered occurrences. Text alignment takes precedence;
boundary distance only resolves equally good lexical matches. Missing words have
no invented boundary error, so retain matched and reference denominators alongside
timing summaries. A good percentile on the surviving words cannot conceal omitted
speech.

A literal filler vocabulary has contextual false positives. Freeze that vocabulary
before evaluating held-out audio, and distinguish detected fillers from words a
fixture explicitly requires to survive. Detection accuracy is information about
the model, not editorial intent or proof that returned cuts are safe.

A fresh CLI process measures startup as well as inference. It cannot certify warm
in-process behavior by relabeling the result. Resource claims need an equivalent
runtime, workload and measurement boundary; listening and preservation require
independent observations of the actual output.

## Runtime and redistribution boundaries

Bind results to the executed model and runtime, deny inference networking, and
use a fresh output directory so a failed invocation cannot reuse an old transcript.
An upstream success exit is insufficient if the promised word report is absent.
Model-loader directory conventions can trigger unintended acquisition; offline
mode must be established before loading, not after a retry starts.

The engine adapter and [product model owner](../../core/src/models.ts) own pinned
identities and license declarations. Preserve upstream notices and model attribution
when redistributing assets. Experiment measurements do not replace product worker,
managed preparation or installed acceptance proof.

[Feasibility scoring](feasibility/score.mjs) keeps independent corpus labels
separate from candidate operands. A registered speech engine and an experiment
provider have different authority: only a family-specific passed gate can justify
product preparation or execution. Failed/pending observations remain research.

## Retained timing admission

The [retained timing evidence](../../../specs/done/video-editing-feedback/assets/07-speech-timing/README.md)
separates exact preservation of native word operands from accuracy claims.
