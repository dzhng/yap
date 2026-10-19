import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { pictureObservationsSchema } from "./picture.js";
const controls = JSON.parse(
  readFileSync(
    new URL(
      "../../../specs/done/video-editing-feedback/assets/14-picture-statistics/control-receipts.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("native controls retain complete measurable and unavailable mask evidence", () => {
  for (const value of Object.values(controls))
    expect(pictureObservationsSchema.safeParse(value).success).toBe(true);
});

test("malformed native histogram, coverage, region and edge operands refuse without throwing", () => {
  const cases = [
    (v: typeof controls.chart) => {
      v.request.regions = Array.from({ length: 8 }, (_, i) => ({
        id: `large-${i}`,
        rect: { x: 0, y: 0, width: 8192, height: 8192 },
      }));
    },
    (v: typeof controls.chart) => {
      v.full.luma.histogram[0]++;
    },
    (v: typeof controls.chart) => {
      v.full.coverage.opaquePixels--;
    },
    (v: typeof controls.chart) => {
      v.full.luma.mean = 0;
    },
    (v: typeof controls.chart) => {
      v.regions.push(structuredClone(v.regions[0]));
    },
    (v: typeof controls.chart) => {
      v.regions[0].sampledRect.x++;
    },
    (v: typeof controls.chart) => {
      v.sourceProfile.iccStatus = "present";
    },
  ];
  for (const mutate of cases) {
    const value = structuredClone(controls.chart);
    mutate(value);
    expect(() => pictureObservationsSchema.safeParse(value)).not.toThrow();
    expect(pictureObservationsSchema.safeParse(value).success).toBe(false);
  }
  const dark = structuredClone(controls.dark);
  dark.edgeBands[0].adjacentMeanLuma = 255;
  expect(pictureObservationsSchema.safeParse(dark).success).toBe(false);
});
