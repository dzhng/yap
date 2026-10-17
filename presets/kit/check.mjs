#!/usr/bin/env node
// Compares a measured profile (measure.mjs) with a preset's targets.json and prints one row per target.
//   node check.mjs <profile.json> <targets.json>     exits 1 when any mood target is out of range or unmeasured
// targets.json: { "<dot.path>": { "range": [min, max], "aspect": "mood" | "form", "why": "what this protects" } }
// A preset is a mood that fits any footage. "mood" targets (grade, loudness, cut rhythm) must pass.
// "form" targets (length, shot count, longest take) describe the reference and depend on the
// footage the user gave, so they are reported as notes and never fail. Unmarked targets are mood.
import { readFileSync } from "node:fs";

const at = (object, path) => path.split(".").reduce((v, key) => (v == null ? v : v[key]), object);

export function checkProfile(profile, targets) {
  return Object.entries(targets)
    .filter(([path]) => !path.startsWith("$"))
    .map(([path, { range: [min, max], aspect = "mood", why }]) => {
      const raw = at(profile, path);
      const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      const inRange = value != null && value >= min && value <= max;
      const verdict = aspect === "form" ? "note" : inRange ? "ok" : "fail";
      return { path, value, min, max, aspect, ok: verdict !== "fail", verdict, why };
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [profilePath, targetsPath] = process.argv.slice(2);
  if (!profilePath || !targetsPath) {
    console.error("usage: check.mjs <profile.json> <targets.json>");
    process.exit(2);
  }
  const rows = checkProfile(JSON.parse(readFileSync(profilePath, "utf8")), JSON.parse(readFileSync(targetsPath, "utf8")));
  for (const r of rows)
    console.log(`${{ ok: "ok  ", fail: "FAIL", note: "note" }[r.verdict]} ${r.path} = ${r.value ?? "unmeasured"} (${r.verdict === "note" ? "reference" : "want"} ${r.min}–${r.max})${r.why ? `  ${r.why}` : ""}`);
  process.exit(rows.every((r) => r.ok) ? 0 : 1);
}
