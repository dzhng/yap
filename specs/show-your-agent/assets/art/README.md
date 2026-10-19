# Header and social preview art

`01-got-it-source.png` is the generated original (`duet model -m openai/gpt-image-2.5-flare
--size 1536x1024 --background opaque`, prompt in `01-got-it-prompt.txt`, one of three variants;
chosen for its in-palette blue check and Xiaohei reading the talk through the lens). It shows
the new line: a person just yaps and circles a pin on their laptop, Xiaohei gets it through a
magnifying glass ("got it"), and the straightened line ends in a fixed screen and a great video.

`.github/readme/header.png` (1800×600) and `apps/site/og.png` (1200×630) are made from it: near
white snapped to white, the drawing band and the wordmark block cut out and recomposed so the
wordmark sits under the outputs instead of floating far below, padded to each size, quantized to
24 colours.

The social card centres a much larger wordmark and tagline under the scene, so the brand and
the line still read when a preview shrinks the card to a few hundred pixels (an unprimed
critique found the corner wordmark unreadable at that size).

The label over Xiaohei was then edited from "gets it" to "got it" (an image edit of the same
source, everything else unchanged), and both crops were tightened to cut the empty space.
