# Four-quadrant map

Status: historical exploration record; the archived rationale owns current scope. This map is carried into the [canonical spec](README.md). Earlier chat outlines are superseded by that spec, especially the compatibility assumption.

## Known knowns

- The source is [/Users/server/videos/FEEDBACK.md](FEEDBACK.md), not the nonexistent ~/dev/videos. It contains agent-authored product/skill feedback and a separate chronological record of user direction. The entire file is retained verbatim.
- The [source provenance](assets/provenance.json) pins Yap, the videos repository, the feedback and the original Claude session. [Selected session records](assets/session-excerpts.json) support the [retro](retro.md).
- Agents make editorial decisions under the brief; Yap supplies evidence and executes explicit non-destructive operations. Existing [Core](../../../packages/core/README.md), [Composition](../../../packages/composition/README.md) and [Protocol](../../../packages/protocol/README.md) own meaning.
- The agent discovered and investigated speech-cut defects itself. The user did not serve as a required speech QA gate.
- User-authorized source footage can become compressed, committed fixtures. [Fixture conventions](../../../fixtures/README.md) preserve original bytes and clocks; derivatives remain distinct.
- The reports concern Screenrec v0.1.6 and its installed skill. Current async import, speaker evidence, helper help, transcript reads, audio measurement, alpha overlays and caption sidecars must be reconciled before claiming a capability is absent.
- The [use-case reference](../../../skills/yap/references/video-use-cases.md) already distinguishes launch, podcast, teaser and other story shapes. A complete provocative question can end a teaser before its answer.

## Known unknowns: decision ledger

Attribution matters: user choices are not agent guesses.

| Question | Decision | Closed by / reason |
| --- | --- | --- |
| First milestone scope | Complete trailer workflow: reliability, picture/audio QA, multicam, captions, transitions, grading and skill improvements. Build in small slices. | User: B, superseding reliability-only scope. |
| Human verification | Never require humans to check output. Agents investigate discrepancies and repair automatically. | User, reiterated after the speech-cut example. |
| Remaining uncertainty | Deliver the best checked candidate with specific uncertainty after available automated checks. Never use uncertainty to skip checking or claim a failed check passed. | User: B. |
| Creative tools | Yap provides shared primitives; the skill coordinates available image/music/SFX/advanced animation tools. No built-in generator or new authoring runtime. | User: A. |
| First editing step | Ask internally: what capabilities are available beyond Yap? Discover tools, skills, model readiness and asset libraries before choosing a workflow. | User, explicit addition. |
| Speaker labeling | Include stable anonymous speakers across mixed-recording windows, word/turn attribution and explicit name bindings, as well as per-person sources. | Latest user request plus code evidence: current recipe only supplies anonymous local slots for exactly 30 seconds. Slices 31–32 own the missing capability. |
| Missing tools | Use available capabilities. Recommend missing external tools only when materially useful or required by the requested result; no default external installation or account setup. Pinned models for first-class Yap features, including Parakeet, are prepared/downloaded as needed by default. | User: B with example of requested AI video. |
| Corpus size | Target approximately 250 MB committed derivatives; larger files use Git LFS. Fidelity must preserve the case. | User: B. |
| Delegate planning choices | Agent may answer choices following confirmed preferences; disclose question, answer and reason. Facts still require investigation. | User: A; planning only, not implementation. |
| Expected consumer/environment | External editing agent on the supported Mac, using public CLI/shared operations and discovered external capabilities. | Territory: root README and consumer skill. |
| Normalization misses | Keep explicitly requested postconditions strict; preflight and bounded solver correction, followed by explicit agent-authored treatment changes as needed. | Agent on user's behalf: reliability and truthful verification; no silent tolerance loosening. |
| Ownership | Extend shared owners; coordination lives in the skill/helpers. No duplicate renderer, job supervisor, transcript store or timeline. | Territory and agent on user's behalf: simpler reproducible workflows. |
| Compatibility | HARD CUTOVER. No backward compatibility, migrations, shims, aliases or dual readers. Existing managed data may reset when necessary. Original external videos and frozen evidence remain intact. | Latest explicit user instruction. Supersedes the earlier agent suggestion to preserve old project contracts. |
| Fixture reduction | Temporal excerpts and full-frame video downscaling; faithful decoded audio for speech/loudness; spatial crop only for a case that does not test framing. Certify against original evidence. | Agent on user's behalf: compact, representative real cases. |
| Acceptance basis | Existing semantics, independent controls, real defect receipts and reference-conditioned agent checks. No universal “beautiful” luma or fixed ASR padding threshold. | Agent on user's behalf: actual failure modes and delegated editorial judgment. |
| New model/provider choice | OPEN; resolved by the alignment replication slice, with pinned local runtime, footprint, mismatch behavior and licensing evidence. | Not a user preference; no model has been selected or acquired. |
| Sync estimator | OPEN; resolved by the sync replication slice on single-mic recordings, known offsets and drift controls. | Signal correlation alone failed in the original project. |
| Fixture encodings/ranges | OPEN; resolved by corpus certification, including current-case reproduction. | Compression may change ASR and color behavior. |
| Solver and visual fidelity tolerances | OPEN where existing contracts do not define them; owning replication slices must freeze the basis before production ports. | No fabricated thresholds. |

Confirmed preferences: complete workflow, autonomous agent QA, explicit uncertainty, capability discovery, existing tools by default, representative fixtures, and clean hard cutovers. Delegation covers matching reversible planning choices. Public-policy changes outside these preferences reopen the map.

## Unknown knowns

The user accepted this concrete workflow: discover capabilities → understand full exchanges/reference → assemble synced raw sources → finish sound/picture/captions → automatically verify and repair → deliver reproducibly.

- “Hollywood” means production quality, not letterboxing.
- A dark reference is adapted to the source, not copied as face-darkening or yellow walls.
- Metrics distinguish faces, walls, graphics and transitions; white tweet cards are not automatically overexposed footage.
- Source transcript times are estimates. Re-transcribing rendered context is useful and caught real defects; multiple evidence types address edge ambiguity.
- End-to-end delivery includes recipes and replayable edits, not just a playable file.
- One video collection repository holds project subfolders. User goals, automated QA and reproducibility have different records.
- The trailer's upbeat music, one/two emojis, inclusion of co-hosts and dialogue/master targets are fixture/project choices. The reusable skill derives treatments from each new brief.
- A teaser ending after a complete spicy question withholds the answer deliberately; a full highlight must preserve the answer and qualifications.

These observations change the skill and fixture acceptance, rather than becoming universal product defaults. They are grounded in FEEDBACK.md and the retained project README; the workflow sample was accepted by the user.

## Unknown unknowns: landmine cards

| Evidence | Why it bites | Disposition |
| --- | --- | --- |
| [Native merger](../../../helpers/mac/Sources/YapSpeech/WordTimingMerger.swift), [transcript admission](../../../packages/core/src/transcript.ts) | Native spoken spans are already clamped; zero-width promotion and non-overlap admission can still reject coincident words. A second blanket clamp could hide evidence or remove speech. | Decided: reproduce and retain raw intervals; replace the single admission policy and its consumers together. |
| [Transcript preparation](../../../packages/core/src/transcript-processing.ts) | A read range filters evidence; it does not bound inference or generation identity. | Decided: execution windows become explicit inputs and participate in identity. |
| [Speaker owner](../../../helpers/speaker/README.md) | Anonymous scores from one 30-second observation do not identify a person or link sessions. | Decided: broader mixed-recording labeling is in scope; 31 proves continuity, 32 owns labels/word views. No automatic cross-session identity. |
| [CLI artifact owner](../../../apps/cli/src/artifact-delivery.ts), [service dispatcher](../../../apps/service/src/project-service.ts) | Measurement exists but has no ordinary JSON delivery lease; consumer scripts reach internal cache paths. | Decided: use shared delivery, not direct cache access. |
| [Normalization admission](../../../packages/core/src/audio-measurement.ts) | Loosening tolerance or inserting a limiter after failed normalization does not satisfy the original request. | Decided: audio-only preflight and frozen bounded correction; output measurements retain meter identity. |
| [Export publication](../../../apps/service/src/exports.ts) | Re-export ownership is tied to an intent; replacing by name alone can overwrite changed/foreign files or defeat replay. | Decided: shared destination ownership, atomic same-directory replacement, explicit foreign overwrite. |
| [Composition clocks](../../../packages/composition/README.md) | 24fps endpoints are often fractional microseconds; rounding a remove changes later mappings. Existing sync groups mean linked edits, not source clocks. | Decided: exact remove and distinct declared angle relationships. |
| [Frozen picture scripts](assets/reference-workflow/scripts/qa-video.sh), [summary](assets/reference-workflow/scripts/qa-summarize.py) | 4fps sampling and skipped join frames do not inspect every frame. Largest-face selection and silent decode skips can miss defects. | Decided: retain these successes as a replication baseline; add explicit frame coverage, transition samples, detector failures and subject identity. |
| [Native color policy](../../../helpers/mac/Sources/YapFrames/VideoColorPolicy.swift), [picture reproduction](https://github.com/dzhng/yap/blob/4b4e708c/packages/test-harness/editing/output-quality-decode.swift) | Different pixel transforms/profiles make numerical comparisons misleading. “QuickTime-equivalent” needs a matched decoding recipe, not an asserted label. | OPEN until decode replication passes; production consumers share one interpretation. |
| [Frozen upstream research](assets/research/fluidaudio-models.txt) | Newer FluidAudio documentation lists Qwen forced alignment among evaluated, unsupported models; the repo pins an older SDK. | OPEN: local replication selects a provider. No promise or automatic download. |
| [Current helper](../../../skills/yap/scripts/compact-transcripts.mjs), [old session](assets/session-excerpts.json) | Help now exists; editing the current helper alone does not explain an old installed skill. | Decided: test current help/examples, record installed skill/CLI identities, document explicit refresh. |
| [Skill review advice](../../../skills/yap/references/editorial-checks.md) | Human-check advice contradicts the approved workflow. | Decided: replace with automated investigation/repair, preserving evidence limits honestly. |
| [QA snapshot](assets/reference-workflow/sota-graham-neubig-trailer/versions/06-balanced/notes/qa-v1.txt) | Bright graphics, dark artistic regions and source cropping cannot be classified from one global histogram. | Decided: declared masks/intent and before/after geometry evidence accompany metrics. |

Sweep coverage: named public schemas, native speech/picture/text owners, source evidence/job/publication owners, CLI delivery, skill helpers and the retained project QA scripts were read. This is a planning sweep of known seams, not a claim that every future changed file has been reviewed. Each slice must repeat discovery in its actual touched paths.

## Builder confirmations

Every OPEN item has an owning spike/slice in the spec. Before a production port, freeze inputs, implementation and reference output; record verdict and permitted differences. A failed experiment is retained and causes reslicing, never a fabricated pass.

The archived rationale supersedes the implementation pickup prompt.
