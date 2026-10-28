import { copyFile, link, mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { CALLS } from "./plan-shots.mjs";
import { failure, launchedAs, load, runJsonHelper, us } from "./storyboard-io.mjs";

const S = 1_000_000;
// One muted accent per edit call; everything else is black on white.
const ACCENT = { keep: "#2f6f4f", trim: "#9a6b16", cut: "#a33a3a", decide: "#2f5f8f" };
const SUMMARY_WORDS = 9;
const CSS = `
body{margin:0;background:#fff;color:#1a1a1a;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
header{position:sticky;top:0;z-index:5;background:#fffffff2;padding:18px 32px 14px;border-bottom:1px solid #e6e6e6}
header h1{margin:0;font-size:19px;font-weight:600}header p{margin:3px 0 0;color:#888;font-size:13px}
.row{display:flex;gap:24px;padding:20px 32px;border-bottom:1px solid #eee}
.row.cut{opacity:.4}.row.cut img{filter:grayscale(1)}
.meta{flex:0 0 210px}.num{font-size:13px;color:#999;font-variant-numeric:tabular-nums}
.meta h3{margin:2px 0 4px;font-size:15px;font-weight:600}
.tc{color:#999;font-size:12px;font-variant-numeric:tabular-nums;margin-bottom:8px}
.call{display:inline-block;padding:0 7px;border:1px solid;border-radius:3px;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.note{color:#666;font-size:12px;margin:8px 0 0}
.strip{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;align-items:flex-start}
figure{margin:0;flex:0 0 200px;width:200px}
.frame{position:relative;overflow:hidden;width:100%;border-radius:3px;background:#f2f2f2;display:flex}
.frame .part{position:relative;overflow:hidden;flex-basis:0}
.frame img{position:absolute;max-width:none;height:auto;display:block}
figcaption{margin-top:6px}.v{font-size:11px;color:#555;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.t{float:right;font-size:11px;color:#aaa;font-variant-numeric:tabular-nums}
figcaption p{margin:3px 0 0;font-size:12.5px;color:#333}
`;

const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clock = (value) => {
  const total = Math.floor(us(value) / S);
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(total / 3600);
  return `${h ? `${h}:` : ""}${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};
const pct = (value) => `${Number((value * 100).toFixed(4))}%`;

/** A crop shown exactly as framed: the whole still, scaled and offset inside a box of the crop's aspect. */
function framed(src, crop, source) {
  const style = [
    `width:${pct(source.width / crop.width)}`,
    `left:${pct(-crop.x / crop.width)}`,
    `top:${pct(-crop.y / crop.height)}`,
  ].join(";");
  return {
    width: crop.width,
    height: crop.height,
    html: `<img loading=lazy alt="" src="${escape(src)}" style="${style}">`,
  };
}

function frameBox(src, shot, source) {
  const crops = shot.crops ?? [shot.crop ?? { x: 0, y: 0, ...source }];
  const parts = crops.map((crop) => framed(src, crop, source));
  // Side-by-side crops share one height, so the box is their summed width over that height.
  const width = parts.reduce((sum, part) => sum + part.width / part.height, 0);
  const inner = parts
    .map(
      (part) => `<div class=part style="flex-grow:${part.width / part.height}">${part.html}</div>`,
    )
    .join("");
  return `<div class=frame style="aspect-ratio:${Number(width.toFixed(6))}/1">${inner}</div>`;
}

function viewLabel(view, host, guest) {
  return (
    {
      WIDE: "Wide",
      TWO: "Two-shot",
      SPLIT: "Split",
      GUEST: `${guest} close`,
      GUEST_TIGHT: `${guest} tight`,
      HOST: `${host} close`,
    }[view] ?? view
  );
}

/** Each still gets a site name from its source time: batch folders reuse the same file names. */
async function place(still, directory) {
  const name = `s${String(Math.round(still.atUs)).padStart(10, "0")}${extname(still.file)}`;
  const target = join(directory, name);
  try {
    await stat(target);
  } catch {
    // A hard link costs nothing and keeps media out of the site's own bytes; copy across volumes.
    await link(still.file, target).catch(() => copyFile(still.file, target));
  }
  return `stills/${name}`;
}

/** Render the storyboard: one row per chapter, every shot shown as framed with a short summary. */
export async function buildSite(request) {
  const board = await load(request.storyboard, "storyboard");
  const manifest = await load(request.stills, "stills");
  if (!request.out) throw failure("INVALID_REQUEST", "Supply out, the site directory");
  const stills = manifest.stills
    .filter((still) => typeof still.file === "string")
    .map((still) => ({ ...still, atUs: us(still.atUs) }))
    .sort((a, b) => a.atUs - b.atUs);
  if (!stills.length)
    throw failure("INVALID_REQUEST", "The stills manifest has no delivered files");
  const source = board.source ?? manifest.source;
  const host = board.host ?? "Host";
  const guest = board.guest ?? "Guest";
  const directory = join(request.out, "stills");
  await mkdir(directory, { recursive: true });
  const issues = [];
  const missing = [];
  const long = [];
  const nearest = (time) => {
    let best = stills[0];
    for (const still of stills)
      if (Math.abs(still.atUs - time) < Math.abs(best.atUs - time)) best = still;
    if (Math.abs(best.atUs - time) > 2 * S)
      issues.push({
        code: "still-distant",
        message: `The nearest still is ${((best.atUs - time) / S).toFixed(1)} s from ${clock(time)}`,
        evidence: { atUs: time, stillAtUs: best.atUs },
      });
    return best;
  };

  let keptUs = 0;
  let shotCount = 0;
  const rows = [];
  for (const [index, chapter] of board.chapters.entries()) {
    if (!CALLS.includes(chapter.call))
      throw failure("INVALID_REQUEST", `Chapter "${chapter.label}" call must be one of ${CALLS}`);
    const a = us(chapter.startUs);
    const b = us(chapter.endUs);
    if (chapter.call !== "cut") keptUs += b - a;
    const shots = chapter.shots?.length
      ? chapter.shots
      : [{ startUs: (a + b) / 2, endUs: (a + b) / 2, view: "", placeholder: true }];
    shotCount += chapter.shots?.length ?? 0;
    const cells = [];
    for (const shot of shots) {
      const s = us(shot.startUs);
      const e = us(shot.endUs);
      const still = nearest(shot.placeholder ? s : s + Math.min(1.5 * S, (e - s) / 2));
      const src = await place(still, directory);
      const summary = shot.summary ?? "";
      if (!shot.placeholder && !summary) missing.push(s);
      if (summary.split(/\s+/).filter(Boolean).length > SUMMARY_WORDS) long.push(s);
      const caption = shot.placeholder
        ? ""
        : `<figcaption><span class=v>${escape(viewLabel(shot.view, host, guest))}</span>` +
          `<span class=t>${clock(s)} · ${Math.round((e - s) / S)}s</span>` +
          `<p>${escape(summary)}</p></figcaption>`;
      cells.push(`<figure>${frameBox(src, shot, source)}${caption}</figure>`);
    }
    const accent = ACCENT[chapter.call];
    const note = chapter.note ? `<p class=note>${escape(chapter.note)}</p>` : "";
    rows.push(
      `<section class="row ${chapter.call}"><div class=meta>` +
        `<div class=num>${String(index + 1).padStart(2, "0")}</div><h3>${escape(chapter.label)}</h3>` +
        `<div class=tc>${clock(a)} - ${clock(b)}</div>` +
        `<span class=call style="color:${accent};border-color:${accent}">${chapter.call}</span>${note}` +
        `</div><div class=strip>${cells.join("")}</div></section>`,
    );
  }
  if (missing.length)
    issues.push({
      code: "summary-missing",
      message: `${missing.length} shots have no summary`,
      evidence: { startUs: missing },
    });
  if (long.length)
    issues.push({
      code: "summary-long",
      message: `${long.length} summaries exceed ${SUMMARY_WORDS} words`,
      evidence: { startUs: long },
    });

  const title = board.title ?? "Storyboard";
  const minutes = Math.round(keptUs / (60 * S));
  const line = `${board.chapters.length} chapters · ${shotCount} shots · ${minutes} min`;
  const page =
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">` +
    `<title>${escape(title)}</title><style>${CSS}</style>` +
    `<header><h1>${escape(title)}</h1><p>${line}</p></header>${rows.join("")}\n`;
  const index = join(request.out, "index.html");
  await writeFile(index, page);
  return { index, chapters: board.chapters.length, shots: shotCount, minutes, issues };
}

if (launchedAs(import.meta.url, "build-site.mjs"))
  await runJsonHelper(
    buildSite,
    `Usage: node build-site.mjs < request.json
Write a storyboard site: one row per chapter, each shot shown as framed with its summary. Request:
storyboard (plan-shots output with summaries), stills (sample-stills manifest), each JSON or a
path, and out (site directory). Stills are hard-linked into out/stills. Prints index path, counts
and issues (still-distant, summary-missing, summary-long).`,
  );
