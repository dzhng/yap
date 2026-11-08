# Header, hero and social preview art

`01-untangle-source.png` is the generated scene (`duet model -m openai/gpt-image-2.5-flare
--size 1536x1024 --background opaque`, prompt in `01-untangle-prompt.txt`, one of three middles
tried: headphones and a replay TV, untangling, taking notes). A person just yaps and circles a pin
on their laptop, Xiaohei untangles the rambling line by hand ("got it"), and the straight line ends
in a fixed screen and a great video, drawn large because they are the payoff.

It replaced a version where Xiaohei held a magnifying glass up to the line: the lens read as a
search, not as understanding what was meant.

`wordmark.png` is the "Yap" wordmark and tagline, cut from the earlier generated art. The scene
carries no wordmark, so the site hero, which sits under the same words as its headline, does not
repeat them.

[`compose.py`](compose.py) makes all three images (near white snapped to white, trimmed, quantized
with an octree so the orange, red and blue stay saturated):

- `.github/readme/hero.png`: the scene alone, for the site hero.
- `.github/readme/header.png`: the scene with the wordmark centred under it, for the README, where
  the art is the title.
- `apps/site/og.png` (1200×630): the same layout as the README header, with a wordmark large
  enough to read when a preview shrinks the card to a few hundred pixels.
