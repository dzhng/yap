# 15 Closeout

**Contract unlocked:** D18 is proven, and the feature is done.

- Run the full repository check once (root `package.json`), and fix every failure, pre-existing
  or not.
- Time the loop on the installed, signed app: `⌥⇧S` → talk and draw → `⌥⇧S` → `⌥⇧V`. Overhead
  beyond the talking must be under 2 s. Record the measurement and how it was taken.
- Fresh-agent acceptance: paste a real prompt into a fresh Claude Code and Codex session with
  the released skill; the agent must act on what was shown without a follow-up question.
  Record both transcripts in `../assets/acceptance/`.
- Then run `close-spec`.
