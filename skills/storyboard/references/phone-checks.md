# Host phone checks

When the host looks down at a phone or notes mid-conversation, the edit should be
on the guest. Finding those moments is optional evidence that you gather with
an external vision model of your choosing. Yap does not detect gaze, and a
detection never cuts anything by itself.

## What failed

Per-face head pitch and eye openness (Apple Vision landmarks) could not separate
"looking down" from "facing the guest" for a host seen in three-quarter profile at
interview distance: the pose angles and eye outlines barely moved. Expect the same
from any landmark or pose signal at that resolution and angle; do not tune a
threshold on it.

## What worked

Ask a vision model to judge many small head crops at once:

1. Crop the host's head region from the sampled stills (the face box from
   `stills.json`, padded down to include the hands and lap), one crop per second.
2. Tile about 30 crops into one labeled grid image and ask which tile numbers show
   the host looking down at a phone, paper or lap; brief blinks facing forward are
   not down. Answer as JSON tile numbers.
3. Merge hits closer than 2 s, drop runs shorter than 1.5 s and pad each by 0.5 s.
4. Spot-check a few ranges against the stills before trusting them, and keep the
   per-second labels so a rerun only asks about unlabeled seconds.

Save the ranges as `[{startUs, endUs}]` and pass them to the planner as `phoneChecks`.
