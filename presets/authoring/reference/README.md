# Reference: what "deep enough" looks like

[isometric-motion](isometric-motion/SKILL.md) is a skill for drawing isometric
explainer figures. It is not about video, and that's deliberate. It is here
because it shows the depth a preset should reach:

- one idea that matters, stated first, with the two ways it fails;
- complete examples, each one a working build you can open and copy;
- a walkthrough of how one example was designed, step by step;
- the real numbers kept in one model that every output reads from;
- a shared kit of tools;
- verification scripts that fail loudly, run to zero;
- tables that map a concept to a concrete thing, size tiers with time estimates,
  and craft rules in a short form with long-form references behind them.

Read its `SKILL.md`, then `references/walkthrough.md` and `references/verify.md`.
Then look at how a video preset translates each idea (see
[AUTHORING.md](../AUTHORING.md#how-the-reference-maps-onto-a-preset)).

Copied from `dzhng/skills` at commit `f6819cab7e0b43e59ed64551d136d65f65640e56`
(2026-10-15), under its MIT license (see `isometric-motion/LICENSE`; the skill
itself credits wheresryan22/anatomy). The examples' generated `.html` pages are
left out; each example's `build.mjs` regenerates them.
