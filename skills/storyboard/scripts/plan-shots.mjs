import { writeFile } from "node:fs/promises";
import { failure, launchedAs, load, runJsonHelper, us } from "./storyboard-io.mjs";

const S = 1_000_000;
export const CALLS = ["keep", "trim", "cut", "decide"];
// Virtual cameras as a fraction of the source height; widths follow from the aspect. From a
// 3840x2160 source: 16:9 WIDE 3840x2160, TWO 2880x1620, GUEST/HOST 2400x1350, GUEST_TIGHT
// 1920x1080; 1:1 WIDE 2160, TWO 2000, GUEST/HOST 1640, GUEST_TIGHT 1380; a split half 1240x1395.
const HEIGHTS = {
  "16:9": { WIDE: 1, TWO: 0.75, GUEST: 0.625, GUEST_TIGHT: 0.5, HOST: 0.625 },
  "1:1": {
    WIDE: 1,
    TWO: 2000 / 2160,
    GUEST: 1640 / 2160,
    GUEST_TIGHT: 1380 / 2160,
    HOST: 1640 / 2160,
  },
};
const SPLIT_HALF = 1395 / 2160; // one 8:9 crop per person, each filling half of a 16:9 frame
const LAYOUTS = { multicam: "16:9", single: "1:1", split: "16:9" };
const EYE_IN_FACE = 0.4; // the eye line sits this far down a detected face box
// and this far down every crop (rule of thirds, with headroom). Square sits lower: a guest seated low in
// the frame otherwise forces a tight square crop whose hair touches the top edge.
const EYE_IN_CROP = { "16:9": 0.36, "1:1": 0.45 };
const ROTATION = ["GUEST", "WIDE", "GUEST_TIGHT", "GUEST", "TWO", "GUEST_TIGHT"];
const PHONE = "host looks down: guest";
const KEY_LINE = "key line";

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

function viewSizes(aspect, source, overrides = {}) {
  const heights = HEIGHTS[aspect];
  if (!heights) throw failure("INVALID_REQUEST", `aspect must be one of ${Object.keys(HEIGHTS)}`);
  const sizes = {};
  for (const [view, fraction] of Object.entries(heights)) {
    const height = Math.round(source.height * fraction);
    const width = aspect === "1:1" ? height : Math.round((height * 16) / 9);
    sizes[view] = { width: Math.min(width, source.width), height };
  }
  const half = Math.round(source.height * SPLIT_HALF);
  sizes.SPLIT = { width: Math.round((half * 8) / 9), height: half };
  return { ...sizes, ...overrides };
}

/** Per still: each person's face centre, eye line and face height, by the side of frame they sit on. */
function facesByRole(manifest, hostSide) {
  const { width } = manifest.source;
  return manifest.stills.map((still) => {
    const roles = {};
    for (const face of still.faces ?? []) {
      const cx = face.x + face.width / 2;
      const role = cx < width / 2 === (hostSide === "left") ? "host" : "guest";
      if (!roles[role] || face.height > roles[role].face)
        roles[role] = { cx, eye: face.y + EYE_IN_FACE * face.height, face: face.height };
    }
    return { atUs: us(still.atUs), ...roles };
  });
}

/** Words as {startUs, endUs, text}: given directly, or read from saved transcript.review/get receipts. */
async function loadWords(value) {
  const words = [];
  for (const entry of await load(value, "words")) {
    const item = typeof entry === "string" ? await load(entry, "words") : entry;
    const rows = (item.data ?? item).page?.rows;
    if (!rows) {
      words.push(item);
      continue;
    }
    for (const row of rows)
      if (row.type === "word" && row.sourceRange)
        words.push({
          startUs: us(row.sourceRange.startUs),
          endUs: us(row.sourceRange.endUs),
          text: row.text,
        });
  }
  return words;
}

/** Move a time that falls inside a word to the nearest silence between words within tolerance. */
function snapper(words) {
  const sorted = words
    .map((word) => ({ startUs: us(word.startUs), endUs: us(word.endUs) }))
    .sort((a, b) => a.startUs - b.startUs);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].startUs >= sorted[i - 1].endUs)
      gaps.push(Math.round((sorted[i - 1].endUs + sorted[i].startUs) / 2));
  return (time, toleranceUs) => {
    if (!sorted.some((word) => time > word.startUs && time < word.endUs)) return time;
    let best;
    for (const mid of gaps)
      if (
        Math.abs(mid - time) <= toleranceUs &&
        (best === undefined || Math.abs(mid - time) < Math.abs(best - time))
      )
        best = mid;
    return best ?? time;
  };
}

function speakerSpans(turns, a, b) {
  const spans = [];
  for (const [i, turn] of turns.entries()) {
    const end = i + 1 < turns.length ? turns[i + 1].startUs : b;
    const s = Math.max(turn.startUs, a);
    const e = Math.min(end, b);
    if (e <= s) continue;
    if (spans.at(-1)?.speaker === turn.speaker) spans.at(-1).endUs = e;
    else spans.push({ startUs: s, endUs: e, speaker: turn.speaker });
  }
  return spans;
}

function override(shots, s, e, view, why) {
  const out = [];
  for (const shot of shots) {
    if (shot.endUs <= s || shot.startUs >= e) {
      out.push(shot);
      continue;
    }
    if (shot.startUs < s) out.push({ ...shot, endUs: s });
    if (shot.endUs > e) out.push({ ...shot, startUs: e });
  }
  out.push({ startUs: s, endUs: e, view, why });
  out.sort((x, y) => x.startUs - y.startUs);
  shots.splice(0, shots.length, ...out);
}

const forced = (shot) => shot.why === PHONE || shot.why === KEY_LINE;

function mergeShort(shots, minUs) {
  const out = [];
  for (const shot of shots) {
    const last = out.at(-1);
    // Forced shots keep their identity so another layout can still honour them.
    const same = last?.view === shot.view && !forced(last) && !forced(shot);
    if (last && (shot.endUs - shot.startUs < minUs || same)) {
      last.endUs = shot.endUs;
      // A host phone check outranks whatever it was folded into.
      if (last.view !== shot.view && shot.why === PHONE)
        Object.assign(last, { view: shot.view, why: PHONE });
    } else out.push({ ...shot });
  }
  if (out.length > 1 && out[0].endUs - out[0].startUs < minUs) {
    out[1].startUs = out[0].startUs;
    out.shift();
  }
  return out;
}

/** The multicam view a shot takes in another layout; timing never changes. */
function restyle(shot, layout, openerRole) {
  if (layout === "single") {
    if (shot.why === "chapter opener") return openerRole === "guest" ? "GUEST" : "HOST";
    if (shot.view === "TWO" && shot.why.includes("question")) return "HOST";
    return shot.view === "WIDE" || shot.view === "TWO" ? "GUEST_TIGHT" : shot.view;
  }
  if (layout === "split") {
    if (shot.why === KEY_LINE || shot.why === PHONE)
      return shot.view === "GUEST_TIGHT" ? shot.view : "GUEST";
    return "SPLIT";
  }
  return shot.view;
}

/**
 * Plan virtual-camera shots for a two-person conversation filmed as one locked wide shot. The
 * rules are a recommended default; the caller owns every choice and can edit the result.
 */
export async function planShots(request) {
  const doc = await load(request.chapters, "chapters");
  const turns = (await load(request.turns, "turns"))
    .map((turn) => ({ startUs: us(turn.startUs), speaker: turn.speaker }))
    .sort((a, b) => a.startUs - b.startUs);
  const manifest = await load(request.stills, "stills");
  const words = request.words ? await loadWords(request.words) : [];
  const phoneChecks = request.phoneChecks ? await load(request.phoneChecks, "phoneChecks") : [];
  const { host, guest } = request;
  if (!host || !guest) throw failure("INVALID_REQUEST", "Supply host and guest speaker names");
  if (!turns.some((turn) => turn.speaker === guest))
    throw failure("INVALID_REQUEST", `No turn is attributed to the guest "${guest}"`);
  const layout = request.layout ?? "multicam";
  if (!LAYOUTS[layout])
    throw failure("INVALID_REQUEST", `layout must be one of ${Object.keys(LAYOUTS)}`);
  const aspect = request.aspect ?? LAYOUTS[layout];
  if (layout === "split" && aspect !== "16:9")
    throw failure("INVALID_REQUEST", "The split layout is 16:9");
  const source = manifest.source;
  const sizes = viewSizes(aspect, source, request.views);
  const eyeInCrop = EYE_IN_CROP[aspect];
  const minUs = request.minShotUs ?? 3 * S;
  const maxUs = request.maxShotUs ?? 12 * S;
  const longUs = request.longAnswerUs ?? 15 * S;
  const openerUs = request.openerUs ?? 5 * S;
  const keyLineUs = request.keyLineUs ?? 6 * S;
  const hostSide = request.hostSide ?? "left";
  const snap = snapper(words);
  for (const turn of turns) turn.startUs = snap(turn.startUs, 2 * S);

  const faces = facesByRole(manifest, hostSide);
  const whole = {};
  for (const role of ["host", "guest"]) {
    const seen = faces.filter((still) => still[role]);
    const side = (role === "host") === (hostSide === "left") ? 0.25 : 0.75;
    whole[role] = seen.length
      ? {
          cx: median(seen.map((still) => still[role].cx)),
          eye: median(seen.map((still) => still[role].eye)),
          face: median(seen.map((still) => still[role].face)),
        }
      : { cx: source.width * side, eye: source.height * 0.42, face: source.height * 0.2 };
  }
  // Every single-person crop scales with its face so both heads read the same size on screen.
  const referenceFace = whole.guest.face;
  const measured = (role, a, b) => {
    const seen = faces.filter((still) => still[role] && still.atUs >= a && still.atUs < b);
    if (!seen.length) return whole[role];
    return {
      cx: median(seen.map((still) => still[role].cx)),
      eye: median(seen.map((still) => still[role].eye)),
      face: median(seen.map((still) => still[role].face)),
    };
  };
  const place = (point, width, height) => ({
    x: Math.round(clamp(point.cx - width / 2, 0, source.width - width)),
    y: Math.round(clamp(point.eye - eyeInCrop * height, 0, source.height - height)),
    width,
    height,
  });
  // Shrink around the eye line rather than shift, so the eyes stay at the same height in frame.
  const single = (role, size, a, b) => {
    const point = measured(role, a, b);
    const k = point.face / referenceFace;
    const width = size.width * k;
    const height = size.height * k;
    const fit = Math.min(
      1,
      (source.height - point.eye) / ((1 - eyeInCrop) * height),
      point.eye / (eyeInCrop * height),
      point.cx / (width / 2),
      (source.width - point.cx) / (width / 2),
    );
    return place(point, Math.round(width * fit), Math.round(height * fit));
  };
  const framing = (view, a, b) => {
    if (view === "SPLIT") {
      const sides = hostSide === "left" ? ["host", "guest"] : ["guest", "host"];
      return { crops: sides.map((role) => single(role, sizes.SPLIT, a, b)) };
    }
    const size = sizes[view];
    if (view === "HOST") return { crop: single("host", size, a, b) };
    if (view === "GUEST" || view === "GUEST_TIGHT") return { crop: single("guest", size, a, b) };
    if (size.width >= source.width && size.height >= source.height)
      return { crop: { x: 0, y: 0, width: source.width, height: source.height } };
    const h = measured("host", a, b);
    const g = measured("guest", a, b);
    return {
      crop: place({ cx: (h.cx + g.cx) / 2, eye: Math.min(h.eye, g.eye) }, size.width, size.height),
    };
  };

  const totals = { shots: 0, cuts: 0, viewUs: {} };
  const chapters = doc.chapters.map((authored) => {
    if (!CALLS.includes(authored.call))
      throw failure("INVALID_REQUEST", `Chapter "${authored.label}" call must be one of ${CALLS}`);
    const a = snap(us(authored.startUs), 2 * S);
    const b = snap(us(authored.endUs), 2 * S);
    if (!(b > a)) throw failure("INVALID_REQUEST", `Chapter "${authored.label}" has no duration`);
    const chapter = { ...authored, startUs: a, endUs: b };
    if (a !== us(authored.startUs)) chapter.authoredStartUs = authored.startUs;
    if (b !== us(authored.endUs)) chapter.authoredEndUs = authored.endUs;
    if (authored.call === "cut") return { ...chapter, shots: [] };

    const shots = [];
    const add = (s, e, view, why) => {
      if (e - s <= 50_000) return;
      if (shots.at(-1)?.view === view) shots.at(-1).endUs = e;
      else shots.push({ startUs: s, endUs: e, view, why });
    };
    const openerEnd = Math.min(b, snap(a + openerUs, S));
    add(a, openerEnd, "WIDE", "chapter opener");
    for (const span of speakerSpans(turns, openerEnd, b)) {
      const { startUs: s, endUs: e } = span;
      if (span.speaker === guest) {
        if (e - s <= longUs) {
          add(s, e, "GUEST", "guest speaking");
          continue;
        }
        for (let t = s, k = 0; t < e - 50_000; k++) {
          const view = ROTATION[k % ROTATION.length];
          const duration =
            view === "WIDE" || view === "TWO" ? 5.5 * S : view === "GUEST" ? maxUs : 8 * S;
          let next = e - (t + duration) > minUs ? snap(Math.min(e, t + duration), S) : e;
          next = Math.max(next, Math.min(e, t + minUs));
          add(t, next, view, "long answer: vary angle");
          t = next;
        }
      } else if (e - s <= 12 * S) add(s, e, "HOST", "host question");
      else {
        const mid = snap(s + 7 * S, S);
        add(s, mid, "HOST", "host question");
        add(mid, e, "TWO", "long question: two-shot");
      }
    }
    for (const point of authored.keyLinesUs ?? []) {
      const p = us(point);
      if (p >= a && p < b) override(shots, p, Math.min(b, p + keyLineUs), "GUEST_TIGHT", KEY_LINE);
    }
    for (const check of phoneChecks) {
      const s = Math.max(a, us(check.startUs));
      const e = Math.min(b, us(check.endUs));
      if (e > s) override(shots, s, e, "GUEST", PHONE);
    }
    const opener = speakerSpans(turns, a, b)[0];
    const openerRole = opener?.speaker === guest ? "guest" : "host";
    let previous;
    const planned = mergeShort(shots, minUs).map((shot) => {
      const view = restyle(shot, layout, openerRole);
      const spoken = words
        .filter((word) => us(word.startUs) >= shot.startUs && us(word.startUs) < shot.endUs)
        .map((word) => word.text)
        .join(" ");
      const cut = view !== previous;
      previous = view;
      totals.viewUs[view] = (totals.viewUs[view] ?? 0) + shot.endUs - shot.startUs;
      totals.cuts += cut ? 1 : 0;
      return {
        ...shot,
        view,
        cut,
        ...framing(view, shot.startUs, shot.endUs),
        ...(spoken ? { spoken: spoken.slice(0, 600) } : {}),
      };
    });
    totals.shots += planned.length;
    return { ...chapter, shots: planned };
  });

  const { chapters: _authored, ...meta } = doc;
  return { ...meta, layout, aspect, source, host, guest, chapters, totals };
}

if (launchedAs(import.meta.url, "plan-shots.mjs"))
  await runJsonHelper(
    async (request) => {
      const plan = await planShots(request);
      if (!request.out) return plan;
      await writeFile(request.out, `${JSON.stringify(plan, null, 1)}\n`);
      return { out: request.out, ...plan.totals };
    },
    `Usage: node plan-shots.mjs < request.json
Plan virtual-camera shots for a two-person conversation filmed as one locked wide shot. Pure: reads
saved files, calls nothing. Request: chapters, turns, stills (each JSON or a path), host, guest,
optional words (word list or saved transcript.review receipts), phoneChecks, layout (multicam|single|split), aspect (16:9|1:1), hostSide
(left|right), views, minShotUs, maxShotUs, longAnswerUs, openerUs, keyLineUs, out. Prints the plan,
or a summary when out is set. Times are microseconds; crops are source pixels, top-left origin.`,
  );
