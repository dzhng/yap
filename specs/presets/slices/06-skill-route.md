# 06 Skill route

**Unlocks:** an agent with only the consumer skill finds presets when the user names
a style, asks for a video "like X", asks how to shoot for a style, or asks to make a
preset.

**Seam:** one paragraph in `skills/yap/SKILL.md`: run `yap preset.list`, read the
matching preset with `preset.get` and follow its `instructions`; to make a new
style, `preset.create` and follow its `instructions`. A preset is the user's style
choice, not permission to edit beyond the request. No preset content goes into the
skill. Add the operations to `skills/yap/references/capability-catalog.md`.

**Proof:** one case in `evals/cases.json` ("make this look like a quiet craft launch
film" routes to `preset.get tactile-launch-film`); grade only that the preset was
read. `node --test evals/skills.test.mjs` stays green.

**Delegated:** wording, within one paragraph.
