import assert from "node:assert/strict";
import test from "node:test";
import { planShots } from "../skills/storyboard/scripts/plan-shots.mjs";

const S = 1_000_000;
// One locked 3840x2160 two-shot: host face on the left, guest on the right, boxes in source pixels.
const stills = (from, to, step = 2) => ({
  source: { width: 3840, height: 2160 },
  stills: Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => ({
    atUs: (from + i * step) * S,
    faces: [
      { x: 1100, y: 800, width: 400, height: 400 },
      { x: 2400, y: 900, width: 400, height: 400 },
    ],
  })),
});
const base = { host: "Host", guest: "Guest", hostSide: "left" };

test("a guest answer after the wide opener is a guest close framed on the eye line", async () => {
  const plan = await planShots({
    ...base,
    stills: stills(0, 20),
    chapters: { title: "T", chapters: [{ startUs: 0, endUs: 12 * S, label: "A", call: "keep" }] },
    turns: [{ startUs: 0, endUs: 12 * S, speaker: "Guest" }],
  });
  const shots = plan.chapters[0].shots;
  assert.deepEqual(
    shots.map((shot) => [shot.view, shot.startUs, shot.endUs]),
    [
      ["WIDE", 0, 5 * S],
      ["GUEST", 5 * S, 12 * S],
    ],
  );
  assert.deepEqual(shots[0].crop, { x: 0, y: 0, width: 3840, height: 2160 });
  // Guest eye line = 900 + 0.4 * 400 = 1060 sits 36% down a 2400x1350 crop centred on x = 2600.
  assert.deepEqual(shots[1].crop, { x: 1400, y: 574, width: 2400, height: 1350 });
});

const closeUps = async (layout, hostFace) => {
  const plan = await planShots({
    ...base,
    layout,
    stills: {
      source: { width: 3840, height: 2160 },
      stills: [0, 4, 8, 12, 16, 20].map((t) => ({
        atUs: t * S,
        faces: [hostFace, { x: 2400, y: 900, width: 400, height: 400 }],
      })),
    },
    chapters: { chapters: [{ startUs: 0, endUs: 22 * S, label: "A", call: "keep" }] },
    turns: [
      { startUs: 0, speaker: "Host" },
      { startUs: 10 * S, speaker: "Guest" },
    ],
  });
  return Object.fromEntries(
    plan.chapters[0].shots
      .filter((shot) => shot.view === "HOST" || shot.view === "GUEST")
      .map((shot) => [shot.view, shot.crop]),
  );
};
const eyeShare = (face, crop) => (face.y + 0.4 * face.height - crop.y) / crop.height;
const guestFace = { x: 2400, y: 900, width: 400, height: 400 };
const EYE = { multicam: 0.36, single: 0.45 }; // square (single) frames the eyes lower to keep headroom

test("host and guest close-ups show heads the same size at the same eye height", async () => {
  const hostFace = { x: 1100, y: 800, width: 300, height: 300 };
  for (const layout of ["multicam", "single"]) {
    const crops = await closeUps(layout, hostFace);
    for (const [view, face] of [
      ["HOST", hostFace],
      ["GUEST", guestFace],
    ])
      assert.ok(Math.abs(eyeShare(face, crops[view]) - EYE[layout]) < 0.002, `${layout} ${view} eye line`);
    const ratio = hostFace.height / crops.HOST.height / (guestFace.height / crops.GUEST.height);
    assert.ok(Math.abs(ratio - 1) < 0.01, `${layout} head sizes match, ratio ${ratio}`);
  }
});

test("a close-up that would leave the frame shrinks around the eye line instead of shifting", async () => {
  // Low and near the left edge: shifting the crop back into frame would drop her eyes below the eye line.
  const hostFace = { x: 550, y: 1500, width: 300, height: 300 };
  for (const layout of ["multicam", "single"]) {
    const crop = (await closeUps(layout, hostFace)).HOST;
    assert.ok(Math.abs(eyeShare(hostFace, crop) - EYE[layout]) < 0.002, `${layout} eye line`);
    assert.ok(
      crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 3840 && crop.y + crop.height <= 2160,
    );
  }
});

const conversation = (layout, extra = {}) =>
  planShots({
    ...base,
    layout,
    stills: stills(0, 60),
    chapters: {
      chapters: [{ startUs: 0, endUs: 60 * S, label: "A", call: "keep", keyLinesUs: [40 * S] }],
    },
    turns: [
      { startUs: 0, speaker: "Host" },
      { startUs: 8 * S, speaker: "Guest" },
    ],
    phoneChecks: [{ startUs: 20 * S, endUs: 25 * S }],
    ...extra,
  });

test("the single layout shows one person at a time", async () => {
  const plan = await conversation("single");
  assert.equal(plan.aspect, "1:1");
  const views = plan.chapters[0].shots.map((shot) => shot.view);
  assert.equal(views[0], "HOST", "the chapter opens on the host asking");
  assert.deepEqual(
    views.filter((view) => view === "WIDE" || view === "TWO"),
    [],
  );
  for (const shot of plan.chapters[0].shots) assert.equal(shot.crop.width, shot.crop.height);
});

test("the split layout pairs both people side by side and goes full-frame guest for key lines and phone checks", async () => {
  const plan = await conversation("split");
  const shots = plan.chapters[0].shots;
  const split = shots.find((shot) => shot.view === "SPLIT");
  assert.equal(split.crop, undefined);
  const [left, right] = split.crops;
  assert.ok(
    left.x + left.width / 2 < 1920 && right.x + right.width / 2 > 1920,
    "host left, guest right",
  );
  for (const half of split.crops) assert.ok(Math.abs(half.width / half.height - 8 / 9) < 0.01);
  const at = (t) => shots.find((shot) => shot.startUs <= t * S && t * S < shot.endUs);
  assert.ok(["GUEST", "GUEST_TIGHT"].includes(at(22).view), "host phone check");
  assert.equal(at(42).view, "GUEST_TIGHT", "key line");
  for (const [i, shot] of shots.entries())
    assert.equal(shot.cut, i === 0 || shot.view !== shots[i - 1].view);
  await assert.rejects(conversation("split", { aspect: "1:1" }), { code: "INVALID_REQUEST" });
});

test("chapter edges and cut points land between words, keeping the authored edge beside the snapped one", async () => {
  // One word per second, each 0.8 s long, so any instant is within 1 s of a silence.
  const words = Array.from({ length: 60 }, (_, i) => ({
    startUs: i * S,
    endUs: i * S + 800_000,
    text: `w${i}`,
  }));
  const plan = await planShots({
    ...base,
    stills: stills(0, 60),
    words,
    chapters: {
      chapters: [
        { startUs: 0, endUs: 10_300_000, label: "A", call: "cut" },
        { startUs: 10_300_000, endUs: 59_500_000, label: "B", call: "keep" },
      ],
    },
    turns: [
      { startUs: 0, speaker: "Host" },
      { startUs: 21_400_000, speaker: "Guest" },
    ],
  });
  assert.equal(plan.chapters[0].startUs, 0, "a time outside every word stays put");
  const chapter = plan.chapters[1];
  assert.equal(chapter.startUs, 9_900_000);
  assert.equal(chapter.authoredStartUs, 10_300_000);
  const insideWord = (t) => words.some((word) => t > word.startUs && t < word.endUs);
  for (const shot of chapter.shots) {
    assert.ok(
      !insideWord(shot.startUs) && !insideWord(shot.endUs),
      `${shot.startUs}-${shot.endUs}`,
    );
  }
  assert.match(chapter.shots[0].spoken, /^w10 w11/);
});

test("refuses an unknown edit call", async () => {
  await assert.rejects(
    planShots({
      ...base,
      stills: stills(0, 10),
      chapters: { chapters: [{ startUs: 0, endUs: 5 * S, label: "A", call: "maybe" }] },
      turns: [{ startUs: 0, speaker: "Guest" }],
    }),
    { code: "INVALID_REQUEST" },
  );
});

test("reads word timing straight from saved transcript.review receipts", async () => {
  const receipt = (rows) => ({
    ok: true,
    data: { state: "ready", page: { rows, nextCursor: null } },
  });
  const row = (ordinal, text, startUs, endUs) => ({
    type: "word",
    ordinal,
    text,
    sourceRange: { startUs, endUs },
  });
  const plan = await planShots({
    ...base,
    stills: stills(0, 20),
    words: [
      receipt([row(0, "hello", 9_000_000, 9_800_000), { type: "gap" }]),
      receipt([row(1, "there", 10_400_000, 11_000_000)]),
    ],
    chapters: { chapters: [{ startUs: 0, endUs: 10_600_000, label: "A", call: "keep" }] },
    turns: [{ startUs: 0, speaker: "Guest" }],
  });
  assert.equal(plan.chapters[0].endUs, 10_100_000);
  assert.equal(plan.chapters[0].shots.at(-1).spoken, "hello");
});
