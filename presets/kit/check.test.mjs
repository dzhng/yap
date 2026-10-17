import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProfile } from "./check.mjs";

const profile = {
  durationSeconds: 42,
  shots: { count: 5, medianSeconds: 7.5 },
  picture: { yavg: 120 },
  loudness: { integratedLufs: -16.4 },
};

test("every target reports its measured value and whether it is in range", () => {
  const rows = checkProfile(profile, {
    durationSeconds: { range: [35, 50], why: "a short film" },
    "shots.medianSeconds": { range: [4, 10] },
    "picture.yavg": { range: [130, 160], why: "bright window light" },
  });
  assert.deepEqual(
    rows.map(({ path, value, ok }) => [path, value, ok]),
    [["durationSeconds", 42, true], ["shots.medianSeconds", 7.5, true], ["picture.yavg", 120, false]],
  );
  assert.equal(rows[2].why, "bright window light");
});

test("a target the profile cannot answer fails instead of passing silently", () => {
  const [row] = checkProfile(profile, { "loudness.rangeLu": { range: [0, 4] } });
  assert.equal(row.ok, false);
  assert.equal(row.value, null);
});

test("form targets describe the reference but never fail; mood targets do", () => {
  const rows = checkProfile(profile, {
    durationSeconds: { range: [900, 4200], aspect: "form", why: "the reference runs 51 min" },
    "picture.yavg": { range: [130, 160], aspect: "mood", why: "bright window light" },
  });
  assert.deepEqual(rows.map(({ path, ok, verdict }) => [path, ok, verdict]), [
    ["durationSeconds", true, "note"],
    ["picture.yavg", false, "fail"],
  ]);
});
