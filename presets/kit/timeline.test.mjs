import { test } from "node:test";
import assert from "node:assert/strict";
import { timelineSvg } from "./timeline.mjs";

test("the strip draws one mark per cut and one band per section", () => {
  const svg = timelineSvg(
    { durationSeconds: 60, cuts: [5, 20, 41], loudness: { momentary: [{ t: 1, lufs: -20 }] }, picture: { samples: [{ t: 0, yavg: 100 }] } },
    { sections: [{ start: 0, end: 30, label: "cold <open>" }, { start: 30, end: 60, label: "body" }] },
  );
  assert.equal(svg.match(/class="cut"/g).length, 3);
  assert.equal(svg.match(/class="section"/g).length, 2);
  assert.ok(svg.includes("cold &lt;open&gt;"), "labels are escaped");
});

test("a band too narrow for its label is drawn without the label", () => {
  const svg = timelineSvg({ durationSeconds: 3600, cuts: [] }, { sections: [{ start: 0, end: 30, label: "teaser" }, { start: 30, end: 3600, label: "conversation" }] });
  assert.equal(svg.match(/class="section"/g).length, 2);
  assert.ok(!svg.includes(">teaser<") && svg.includes(">conversation<"));
});
