# Shot plan

A locked wide shot of two people becomes a multicam-style edit by cutting between
virtual cameras: crops of the one source, recentred per shot on the measured face.
Everything here is a recommended default for you to apply and adjust, not product
behaviour. `scripts/plan-shots.mjs` implements it; edit its output where your
judgment differs.

## Virtual cameras

Sizes from a 3840x2160 source (the planner scales them to the source height):

| View | 16:9 | 1:1 | Use |
| --- | --- | --- | --- |
| WIDE | 3840x2160 | 2160x2160 | chapter openers, breathers in long answers |
| TWO | 2880x1620 | 2000x2000 | long host questions, exchanges |
| GUEST | 2400x1350 | 1640x1640 | guest speaking, host on phone |
| GUEST_TIGHT | 1920x1080 | 1380x1380 | key lines, every other long-answer beat |
| HOST | 2400x1350 | 1640x1640 | host questions |
| SPLIT half | 1240x1395 (8:9) | - | one person per half of a 16:9 frame |

**Framing.** Frame by the eye line, not the top of the face box: eye line = face top
+ 0.4 x face height, placed 36% down a 16:9 crop (45% down a square one), head
centred. Close-ups framed on the face top made heads too big and touching the top
edge. Square sits lower because a guest seated low in a wide frame otherwise forces a
crop so tight that the hair touches the top.

**Equal heads.** Single-person crops scale with that person's measured face height
relative to the guest's, so host and guest heads read the same size on screen.

**Shrink, don't shift.** A crop that would leave the frame shrinks around the eye
line. Shifting it back into frame moved one person's eyes to 47% while the other
stayed at 36%; that mismatch shows at once when the two cut together. Near an edge
the head gets slightly larger; that is the lesser error.

## Editorial defaults

In priority order:

1. Host looks down at a phone or notes: cut to the guest.
2. A chapter opens wide for about 5 s.
3. Guest speaking: guest close. Answers longer than 15 s rotate guest close, wide,
   guest tight, guest close, two-shot, guest tight (each 3-12 s).
4. Host speaking: host close; questions longer than 12 s go host close, then two-shot.
5. Key lines: guest tight for about 6 s.
6. No shot shorter than 3 s; shorter ones fold into the previous shot.

Cut points snap to silences between words. Chapter edges snap too, with the authored
edge kept beside the snapped one. Picture-only view changes may fall mid-word in
principle (the audio is continuous), but landing them between words reads calmer.

## Layouts

- `multicam` (16:9 default, 1:1 allowed): the views above.
- `single` (1:1 default): one person on screen at a time. The host when asking, the
  guest close or tight when answering; no wide or two-shot. Chapters open on whoever
  speaks first. Suits square launch clips.
- `split` (16:9 only): host and guest side by side, each an 8:9 crop, in the seats
  they hold in the source, so they face each other; conversational, not
  confrontational. Key lines and host phone checks go full-frame guest.

A shot with `cut: false` repeats the previous view: it is a beat in the storyboard,
not an edit point.
