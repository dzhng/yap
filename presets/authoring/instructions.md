1. Read the authoring guide at {{guidePath}} and the scaffold at {{path}}/PRESET.md; name the style and write its one idea and two failure modes.
2. Download each reference into {{path}}/examples/<slug>/source/; a local preset may keep any media that helps, and source/ is dropped only when shipping to the repo.
3. Look first: make a contact sheet for each reference and write down its structure before measuring anything.
4. Measure: run {{kitPath}}/measure.mjs, {{kitPath}}/music.mjs and {{kitPath}}/pacing.mjs; use the output as evidence.
5. Capture: make stills, filmstrips, scopes and timelines with the kit.
6. Write {{path}}/PRESET.md from the template with References, Shoot, Music, Edit, Check and Limits, using Yap operations checked with yap --help.
7. Check every link and file, derive targets.json, run {{kitPath}}/check.mjs on every example, grade with look.json and look.cube, then ask a fresh critic to audit against {{guidePath}} before shipping.
