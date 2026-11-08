# M Messaging

**Contract unlocked:** D19 and D20 everywhere a person or agent first meets Yap.

**Done on this branch (2026-10-18), uncommitted:**
- `positioning.md`: new tagline, two directions, "Show your agent" leads with the loop, a
  "What it replaces or competes with" section (Scrawl, screenshot + annotate + dictation,
  Loom, Descript), honest "Today:" line, rewritten messaging rules.
- `README.md`: hero, opening order (Show your agent, Show people), asks, How it works. The
  Get-started prompt and Agent setup are untouched (the site build check
  `apps/site/build.mjs:36-47` and the evals depend on them).
- `apps/site/content.mjs` now owns the hero (it was hard-coded in `build.mjs:129`) and image
  alt text; a two-column "show your agent / show people" section (`build.mjs` `direction()`,
  `style.css` `.directions`); `llmsText` describes both directions and the pasted prompt;
  `build.test.mjs:56` expects the new title. Site tests 10/10, format check clean.
- Visual review: two unprimed critiques. Fixed: step titles now name the action with the key
  as a chip, chips are higher contrast, step text is body size, columns are equal. A 390 px
  headless capture looked cut off; a real browser at 390 px has no overflow (scroll width 390).
- User feedback: "show people" was too dense next to "show your agent". Both columns are now
  four numbered steps with one-line bodies (Start/Talk and draw/Finish/Paste and
  Record/Ask/Review/Export) and a one-line footnote; `direction()` renders only that shape.
  Third unprimed critique run; parallel titles and shorter bodies applied from it.
- User feedback: it's one product, so "show people" uses the same keys: Record `⌥⇧S`,
  Ask `⌥⇧V`. `positioning.md`'s messaging rules now say so.

**Done 2026-10-19:** `header.png` and `og.png` regenerated with the new line ([art](../assets/art/README.md)). On 2026-10-21 the scene was redrawn (Xiaohei untangles instead of using a magnifying glass) and the site hero lost its duplicate wordmark.
`launch-poster.jpg` is a frame of the launch film, which shows the site as it was then; it stays.

**Was remaining:** regenerate the images that draw the old tagline: `.github/readme/header.png`
(also the site hero art; it says "Just yap. Your agent makes it a great video." and "agent
edits"), `apps/site/og.png`, `apps/site/launch-poster.jpg`. Follow the house style in
`apps/site/README.md:17-22`. Then `screenshot-critique`, `compare-screenshots` against the
current art, `preview-shots`, non-blocking.

**Ships with the feature:** the copy describes the hotkey loop as available, so it merges when
slices 00–13 do, not before.
