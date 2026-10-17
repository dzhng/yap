#!/usr/bin/env node
// Writes a preset's look.cube from its look.json: node make-look-lut.mjs <look.json> <look.cube>
// The look is a simple grade: per-channel lift/gain, a gamma, saturation, then a soft highlight roll-off.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: make-look-lut.mjs <look.json> <look.cube>");
  process.exit(2);
}
const look = JSON.parse(readFileSync(input, "utf8"));
const size = look.size ?? 17;
if (!Number.isInteger(size) || size < 2 || size > 33) throw new RangeError("size must be 2–33");

const clamp = (v) => Math.min(1, Math.max(0, v));
const lift = look.lift ?? [0, 0, 0];
const gain = look.gain ?? [1, 1, 1];
const gamma = look.gamma ?? 1;
const saturation = look.saturation ?? 1;
const shoulder = look.shoulder ?? 1; // highlight ceiling; 1 leaves highlights alone

function grade([r, g, b]) {
  let c = [r, g, b].map((v, i) => lift[i] + v * (gain[i] - lift[i]));
  c = c.map((v) => Math.pow(clamp(v), 1 / gamma));
  const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  c = c.map((v) => luma + (v - luma) * saturation);
  // Soft shoulder: compress toward the ceiling instead of clipping.
  if (shoulder < 1) c = c.map((v) => (v <= 0.7 * shoulder ? v : 0.7 * shoulder + (shoulder - 0.7 * shoulder) * Math.tanh((v - 0.7 * shoulder) / (shoulder - 0.7 * shoulder))));
  return c.map(clamp);
}

// Yap applies LUTs in linear sRGB (packages/composition/src/lut.ts). The grade is authored on
// display (sRGB-encoded) values, so a "linear-srgb" cube encodes, grades, then decodes.
const space = look.space ?? "linear-srgb";
const encode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const decode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const entry = space === "linear-srgb" ? (c) => grade(c.map(encode)).map(decode) : grade;

const rows = [`TITLE "${look.title ?? "preset look"}"`, `LUT_3D_SIZE ${size}`, "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"];
// .cube order: red varies fastest, then green, then blue.
for (let b = 0; b < size; b++)
  for (let g = 0; g < size; g++)
    for (let r = 0; r < size; r++)
      rows.push(entry([r, g, b].map((v) => v / (size - 1))).map((v) => v.toFixed(5)).join(" "));
writeFileSync(output, rows.join("\n") + "\n");
