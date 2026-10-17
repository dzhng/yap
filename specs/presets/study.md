# Reference study (2026-10-16)

How the three drafts in repo `presets/` were derived. The reference videos were
downloaded to a local cache outside the repo (`yt-dlp <link>`) and measured with
ffmpeg scene detection, `signalstats`, `ebur128`, contact sheets, and Yap's own
`asset.import` and `transcript.transcribe`. Only measurements and our own
descriptions are recorded; no frames, transcripts or on-screen text are kept.

| | humans& launch | ashe conversation | a16z podcast |
| --- | --- | --- | --- |
| Length, raster | 42 s, 1920×1080 @ 24 | 51 min, 1920×1080 @ 29.97 | 59 min, 1280×720 @ 23.976 |
| Shots | 4 (scene cuts at ~3, 14, 18 s; the rest are dissolves) | ~22; location segments 3–18 min; cold open ~12 s of 2–4 s cuts; ~60 s montage at the end | ~196; 36 cuts in the first 100 s; body median ~9 s, holds up to ~4.5 min |
| Speech | none (music only) | lav dialogue from 0.8 s, over B-roll | three-camera, two mics |
| Loudness | −16.9 LUFS integrated, LRA 5.5 | −26.9 LUFS (5-min body window), LRA 8.9 | −23.9 LUFS (5-min body window), LRA 3.3 |
| Picture (contact-sheet signalstats) | bright: Y avg 146, warm, saturation 11 | faded: Y low 35, high 202, avg 116, saturation 7 | low-key: Y low 44, high 165, avg 89, warm, saturation 10 |
| Text | small serif headlines that build, top-left; serif end card | tracked-caps series title and bottom-left chapter labels; sign-off card | kinetic glowing serif key words in the teaser; corner brand mark; end card |

## Findings that change the plan

- **Grade LUTs work.** Each draft ships `look.cube`, generated from `look.json` by
  [make-look-lut.mjs](../../presets/kit/make-look-lut.mjs). Yap applies LUTs in linear sRGB
  with trilinear interpolation. On the `graham-picture.mov` fixture, simulating
  that path matched the display-space grade within about 0.4 luma levels.
- **Lighting can't be graded in.** On a bright fixture the a16z LUT gives a matte
  but still bright image. Low-key looks belong in `## Shoot`, and each preset
  states this limit.
- **Yap bug found:** `transcript.transcribe` on the humans& X download failed with
  `NATIVE_DECODE_FAILED` ("Audio conversion made no progress: short decoded
  coverage"). The audio track runs ~57 ms past the video. Extracting the audio to
  WAV with ffmpeg worked. Reference videos from X are a likely input for presets,
  so this needs its own fix and regression test outside this spec.
