---
name: storyboard
description: Before editing a long conversation (interview, podcast, talk, panel), build a storyboard site with Yap evidence so the human agrees on the story and the shot plan before any edit. It shows one row per chapter with every shot as framed by its virtual camera and a short summary, served locally and shown inline. Use when the user asks for a storyboard, "show me the chapters", "what's the story/structure", a shot plan or "how will you cut this", or before editing or splitting the edit of a recording longer than about ten minutes.
---

# Storyboard

A storyboard is the agreement before the edit: what story the conversation tells,
what stays, and how each moment is framed. You make every editorial choice in it
(chapters, calls, shots, summaries); Yap only supplies evidence. Face boxes,
transcripts and speaker observations are evidence, never permission to cut.
Nothing is edited until the human agrees. Then the [yap skill](../yap/SKILL.md)
carries the plan out.

Run helpers with the Node from `yap service.tools` (`"$yap_node" scripts/<helper>.mjs < request.json`);
each prints JSON and has `--help`. Run `yap` and the helpers that call it or bind a port outside
any agent sandbox. Request and output shapes are in [contract](references/contract.md).

## Workflow

1. **Resolve the source** with the yap skill: the asset, its video and audio streams,
   and whether it is one locked wide shot of two people. The virtual cameras below
   assume that; for anything else, still build the chapter rows, but show full frames
   and plan coverage yourself. Done when asset and stream IDs are saved in the task workspace.

2. **Gather evidence.**
   - Words: page `transcript.review` over the whole source and save every receipt.
     Word timing is the clock for every cut; paragraph timecodes drift 1-2 s.
   - Turns: who speaks when, as `[{startUs, speaker}]`. Build them from speaker
     evidence with names bound by the caller, or an imported speaker-labeled
     transcript; follow the speaker rules in the yap skill's
     [podcast reference](../yap/references/podcast-videos.md). Seat position is
     not voice identity.
   - Stills with faces: `scripts/sample-stills.mjs` over the whole source (2 s step).
     It saves every `frame.batch` receipt and resumes; a 40-minute 4K source takes
     about 5-15 minutes. Done when `stills.json` exists and its issues are read.

3. **Write the chapters.** Read the whole transcript, then cut where the topic changes
   (usually each host question). Give each a label (quote the guest's best phrase
   when there is one), a call (`keep`, `trim`, `cut` for setup, dead air and
   off-topic, `decide` when only the human can choose) and an optional note.
   Mark key lines in `keyLinesUs`. Done when chapters tile the recording and every
   one has a call.

4. **Plan the shots** with `scripts/plan-shots.mjs`, choosing a layout from
   [shot plan](references/shot-plan.md). The planner's rules are a default you apply
   and adjust; edit the plan JSON wherever your judgment differs. Done when every
   kept chapter has shots and `totals` matches the pacing you intend.

5. **Write a summary for every shot**: at most 9 words, specific (name the idea,
   example or number), from its `spoken` text. Write them yourself or delegate in
   batches to any model available; the transcript itself never goes on the page.

6. **Build, serve and show it.** Run `scripts/build-site.mjs`, then
   `scripts/serve-site.mjs SITE_DIR` in the background. Open the printed URL in your
   preview or browser tool and look at it. A path alone is not delivery. Read the
   returned `issues`. Done when the human can see the page inline and you've checked
   it against the rules below.

7. **Iterate** on feedback: edit chapters or plan, rebuild, reload. Agreement on the
   storyboard is the only done-condition of this skill. After it, plan the edit
   with the yap skill: per-shot crops are source pixels, top-left origin, ready for
   its geometry operations. Check the result with project frames from the edited revision.

Order governs presentation, never disclosure: if evidence early on changes a
decision the human is about to make (a missing speaker, a bad take), say so at once.

## Design rules

These are defaults; follow the human wherever they change them.

- One row per chapter, read top to bottom; shots run left to right in time.
  Never a uniform grid of frames: it hides the story.
- Light and quiet: black text on white, one muted accent per call. No dark theme,
  no colorful badges.
- Header: the title plus one line, `chapters · shots · minutes`. Nothing else.
- Under each frame: view, time and the short summary. Not the transcript.
- Each frame shows the shot as framed (its crop, in the crop's own aspect; a split
  shows both halves side by side), not the raw wide still.
- Cut chapters stay visible, dimmed.
