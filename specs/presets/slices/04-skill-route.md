# 04 Skill route

**Unlocks:** an agent that has only the consumer skill finds presets when the user
names a style, asks for a video "like X", or asks how to shoot for a style.

**Seam:** one short paragraph in `skills/yap/SKILL.md`. Run `yap preset.list`,
pick the preset the user named or clearly described, read it with `preset.get`,
and follow its `## Shoot` or `## Edit` section. Treat the preset as the user's
style choice, not as permission to edit beyond the request. No preset content goes
into the skill; the user explicitly doesn't want the reference skill polluted.

Also update `capability-catalog.md` if it lists operations by area.

**Proof:** the existing skill tests (`evals/skills.test.mjs`, `skill-issues.test.ts`)
stay green. Add one eval case to `evals/cases.json`: "make this look like the
humans& launch video" routes to `preset.get tactile-launch-film`. Grade only that the
preset was read; the edit quality belongs to slice 05.

**Delegated:** wording, within one paragraph.
