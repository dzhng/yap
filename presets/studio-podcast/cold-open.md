# Teaser cold open

The cold open sells the episode in about a minute. It is the only designed,
fast-moving part of the show.

## Structure

1. **Pick the lines.** From the transcript, choose 5–8 lines of 3–10 seconds each
   that state a strong claim, a surprising number or a vivid image. Use the user's
   brief and topics list; `transcript.search` finds candidates. Order them so the
   teaser rises: context, then tension, then the boldest claim last.
2. **Hard cuts only.** No zoom, whip or flash transitions: the energy comes from the
   cut rate and the words, not from effects.
3. **Picture under each line.** Alternate between the speaker's single camera and a
   full-frame illustrative insert (a screenshot, a diagram, a product UI shot or a
   licensed clip the user supplied). Change the picture every 2–3 s, so one line
   usually spans 2–3 shots. Put screenshots, charts and diagrams on a pale card
   inset over a softly blurred, desaturated painted or architectural background,
   or on flat warm off-white (#F4F0E6). Never edge to edge, with a visible card edge or shadow; crop away browser chrome
   and cursors. A chart builds up while the line plays.
4. **Kinetic words.** For each line, highlight 1–4 key words as large captions
   timed exactly to their spoken words (use `text.seed` with the transcript word
   timings).
   - Font: a high-contrast condensed serif, white, with a soft outer glow so it
     reads on dark footage. Open choices close to the example: Didot Bold (ships with macOS), Playfair Display
     (caps) or Bodoni Moda in a condensed width; import with `asset.import`.
   - Size: 8–12% of frame height. Place it in the empty side of the frame, never
     over a face, and on a plain area: over a pale or busy background (curtains,
     windows) add a soft shadow or move the words.
   - Words build up one at a time on their spoken onsets, spread across the
     empty part of the frame like a sentence being laid out, then all clear
     together 6–10 frames after the phrase ends. A phrase is 1–4 words.
     Over dark B-roll, use one centred word at a time instead.
   - Colour: white for most words; one key word per phrase in gold with a
     metallic glow. See [motion-kinetic-words](examples/a16z-show/motion-kinetic-words.jpg).
   - Don't caption every line; this is emphasis, not subtitles.
   - Once in the teaser, an all-caps phrase in the same font can trail into the
     body ("coming up" style); write your own wording.
5. **Out.** End the teaser on the boldest line, cut to 0.5–1 s of black, then cut
   to the wide two-shot to start the conversation.

## Audio

Each line plays at full voice. Under the whole teaser, a low pulsing instrumental
bed (supplied by the user, or none) sits at about −28 LUFS and stops on the black
beat. The 2–4 frame cuts between lines may land on a breath, never in a word.

## Clips

Social clips reuse this treatment: one line or idea per clip, kinetic key words,
the speaker's single camera and one insert at most.
