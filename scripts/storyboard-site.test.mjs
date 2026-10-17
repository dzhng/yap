import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../skills/storyboard/scripts/build-site.mjs";

const S = 1_000_000;
const source = { width: 3840, height: 2160 };

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "yap-storyboard-site-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stills = [];
  for (const seconds of [0, 2, 4, 6, 8, 10, 60, 62]) {
    const file = join(directory, `still-${seconds}.png`);
    await writeFile(file, `still ${seconds}`);
    stills.push({ atUs: seconds * S, file, width: 960, height: 540, faces: [] });
  }
  return { directory, stills: { source, stills } };
}

const board = {
  title: "Episode",
  host: "Lily",
  guest: "Lucy",
  source,
  chapters: [
    { startUs: 0, endUs: 4 * S, label: "Pre-roll", call: "cut", shots: [] },
    {
      startUs: 4 * S,
      endUs: 64 * S,
      label: "Intro",
      call: "keep",
      note: "Opens the episode",
      shots: [
        {
          startUs: 4 * S,
          endUs: 9 * S,
          view: "GUEST",
          crop: { x: 1440, y: 540, width: 1400, height: 1400 },
          summary: "Lucy introduces her robotics research",
          spoken: "Thank you for inviting me, I work on robot foundation models",
        },
        {
          startUs: 9 * S,
          endUs: 64 * S,
          view: "SPLIT",
          crops: [
            { x: 400, y: 600, width: 1240, height: 1395 },
            { x: 2200, y: 600, width: 1240, height: 1395 },
          ],
          summary: "Both laugh about the battery",
        },
      ],
    },
  ],
};

test("renders one row per chapter, a minimal header and summaries instead of the transcript", async (t) => {
  const { directory, stills } = await workspace(t);
  const out = join(directory, "site");
  const result = await buildSite({ storyboard: board, stills, out });
  const page = await readFile(join(out, "index.html"), "utf8");
  assert.deepEqual(
    [...page.matchAll(/<section class="row (\w+)">.*?<h3>(.*?)<\/h3>/g)].map((m) => [m[1], m[2]]),
    [
      ["cut", "Pre-roll"],
      ["keep", "Intro"],
    ],
  );
  assert.match(page, /<header><h1>Episode<\/h1><p>2 chapters · 2 shots · 1 min<\/p><\/header>/);
  assert.match(page, /Lucy introduces her robotics research/);
  assert.doesNotMatch(page, /robot foundation models/);
  assert.equal(result.shots, 2);
});

test("shows each shot as framed: square crops stay square and a split composes both halves", async (t) => {
  const { directory, stills } = await workspace(t);
  const out = join(directory, "site");
  await buildSite({ storyboard: board, stills, out });
  const page = await readFile(join(out, "index.html"), "utf8");
  const frames = [
    ...page.matchAll(/<div class=frame style="aspect-ratio:([\d.]+)\/1">(.*?)<\/figure>/g),
  ];
  assert.deepEqual(
    frames.map((m) => Number(m[1]).toFixed(3)),
    [(16 / 9).toFixed(3), "1.000", (16 / 9).toFixed(3)],
    "cut chapter full frame, square guest close, 8:9 + 8:9 split",
  );
  // The square crop at x=1440,y=540 of a 1400 px box: the still is 3840/1400 of the box wide.
  assert.match(frames[1][2], /style="width:274\.2857%;left:-102\.8571%;top:-38\.5714%"/);
  assert.equal([...frames[2][2].matchAll(/class=part/g)].length, 2);
  // Only the stills the page shows: the cut chapter's midpoint and each shot's opening beat.
  const shown = await Promise.all(
    (await readdir(join(out, "stills")))
      .sort()
      .map((name) => readFile(join(out, "stills", name), "utf8")),
  );
  assert.deepEqual(shown, ["still 2", "still 6", "still 10"]);
});

test("reports evidence gaps as issues without refusing the page", async (t) => {
  const { directory, stills } = await workspace(t);
  const sparse = { source, stills: stills.stills.filter((still) => still.atUs < 20 * S) };
  const untitled = structuredClone(board);
  delete untitled.chapters[1].shots[1].summary;
  untitled.chapters[1].shots[0].summary = "one two three four five six seven eight nine ten";
  untitled.chapters[1].shots.push({
    startUs: 50 * S,
    endUs: 64 * S,
    view: "WIDE",
    crop: { x: 0, y: 0, ...source },
    summary: "Far from any still",
  });
  const result = await buildSite({
    storyboard: untitled,
    stills: sparse,
    out: join(directory, "site"),
  });
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), [
    "still-distant",
    "summary-long",
    "summary-missing",
  ]);
  await assert.rejects(
    buildSite({
      storyboard: { ...board, chapters: [{ ...board.chapters[0], call: "drop" }] },
      stills,
      out: directory,
    }),
    { code: "INVALID_REQUEST" },
  );
});

test("serves the site on the IPv4 loopback and nothing outside it", async (t) => {
  const { directory, stills } = await workspace(t);
  const out = join(directory, "site");
  await buildSite({ storyboard: board, stills, out });
  await writeFile(join(directory, "secret.txt"), "outside");
  const { serveSite } = await import("../skills/storyboard/scripts/serve-site.mjs");
  const { server, url } = await serveSite(out);
  t.after(() => server.close());
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const index = await fetch(url);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await index.text(), /<h1>Episode<\/h1>/);
  assert.equal((await fetch(`${url}stills/s0002000000.png`)).status, 200);
  assert.equal((await fetch(`${url}..%2Fsecret.txt`)).status, 404);
});

test("stills from different batches with the same file name stay distinct", async (t) => {
  const { directory } = await workspace(t);
  const { mkdir } = await import("node:fs/promises");
  const stills = [];
  for (const [batch, seconds] of [
    ["batch-0001", 4],
    ["batch-0002", 20],
  ]) {
    await mkdir(join(directory, batch));
    const file = join(directory, batch, "01.png");
    await writeFile(file, `still ${seconds}`);
    stills.push({ atUs: seconds * S, file, width: 960, height: 540, faces: [] });
  }
  const out = join(directory, "site");
  const storyboard = {
    ...board,
    chapters: [
      {
        ...board.chapters[1],
        endUs: 30 * S,
        shots: [
          { ...board.chapters[1].shots[0], startUs: 4 * S, endUs: 8 * S },
          { ...board.chapters[1].shots[0], startUs: 19 * S, endUs: 30 * S },
        ],
      },
    ],
  };
  await buildSite({ storyboard, stills: { source, stills }, out });
  const page = await readFile(join(out, "index.html"), "utf8");
  const sources = [...page.matchAll(/src="(stills\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(sources).size, 2);
  const shown = await Promise.all(sources.map((src) => readFile(join(out, src), "utf8")));
  assert.deepEqual(shown, ["still 4", "still 20"]);
});
