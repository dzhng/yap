#!/usr/bin/env node
// Draws a profile (measure.mjs) as one SVG strip: cuts, momentary loudness and average luma over time,
// plus optional labelled sections. Put a reference's strip above an export's to compare rhythm at a glance.
//   node timeline.mjs <profile.json> [--sections sections.json] [--out timeline.svg] [--title text]
// sections.json: [{ "start": s, "end": s, "label": "cold open" }]
import { readFileSync, writeFileSync } from "node:fs";

const W = 1200, PAD = 40, LANE = 70;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function timelineSvg(profile, { sections = [], title = "" } = {}) {
  const span = profile.durationSeconds || 1;
  const x = (t) => PAD + (t / span) * (W - 2 * PAD);
  const lanes = { sections: 30, cuts: 30 + LANE, loudness: 30 + 2 * LANE, luma: 30 + 3 * LANE };
  const H = lanes.luma + LANE + 30;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui" font-size="11">`, `<rect width="${W}" height="${H}" fill="#111"/>`];
  out.push(`<text x="${PAD}" y="18" fill="#eee" font-size="13">${esc(title)}</text>`);
  for (const [name, y] of Object.entries(lanes)) out.push(`<text x="4" y="${y + 12}" fill="#888">${name}</text>`, `<line x1="${PAD}" x2="${W - PAD}" y1="${y + LANE - 8}" y2="${y + LANE - 8}" stroke="#333"/>`);
  sections.forEach((s, i) => {
    out.push(`<rect class="section" x="${x(s.start)}" y="${lanes.sections + 4}" width="${Math.max(1, x(s.end) - x(s.start))}" height="${LANE - 16}" fill="${i % 2 ? "#3a4a5a" : "#4a5a3a"}"/>`);
    // A label only goes where it fits (about 6.5 px per character), so narrow bands never overlap.
    if (x(s.end) - x(s.start) > 6.5 * String(s.label).length + 6)
      out.push(`<text x="${x(s.start) + 3}" y="${lanes.sections + 18}" fill="#eee">${esc(s.label)}</text>`);
  });
  for (const t of profile.cuts ?? []) out.push(`<line class="cut" x1="${x(t)}" x2="${x(t)}" y1="${lanes.cuts + 4}" y2="${lanes.cuts + LANE - 8}" stroke="#e8c36a"/>`);
  const curve = (points, y0, lo, hi, color) => {
    const pts = points.filter((p) => p.v != null).map((p) => `${x(p.t).toFixed(1)},${(y0 + LANE - 8 - ((Math.min(hi, Math.max(lo, p.v)) - lo) / (hi - lo)) * (LANE - 14)).toFixed(1)}`);
    if (pts.length) out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.2"/>`);
    out.push(`<text x="${W - PAD + 4}" y="${y0 + 12}" fill="#666">${hi}</text>`, `<text x="${W - PAD + 4}" y="${y0 + LANE - 8}" fill="#666">${lo}</text>`);
  };
  curve((profile.loudness?.momentary ?? []).map((m) => ({ t: m.t, v: m.lufs })), lanes.loudness, -50, -5, "#6ab0e8");
  curve((profile.picture?.samples ?? []).map((s) => ({ t: s.t, v: s.yavg })), lanes.luma, 0, 255, "#ddd");
  for (let t = 0; t <= span; t += span > 600 ? 300 : span > 120 ? 30 : 5)
    out.push(`<text x="${x(t) - 8}" y="${H - 10}" fill="#777">${span > 600 ? `${t / 60}m` : `${t}s`}</text>`);
  out.push("</svg>");
  return out.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (!args[0] || args[0].startsWith("--")) {
    console.error("usage: timeline.mjs <profile.json> [--sections sections.json] [--out timeline.svg] [--title text]");
    process.exit(2);
  }
  const profile = JSON.parse(readFileSync(args[0], "utf8"));
  const sections = flag("--sections") ? JSON.parse(readFileSync(flag("--sections"), "utf8")) : [];
  const svg = timelineSvg(profile, { sections, title: flag("--title") ?? "" });
  if (flag("--out")) writeFileSync(flag("--out"), svg);
  else process.stdout.write(svg);
}
