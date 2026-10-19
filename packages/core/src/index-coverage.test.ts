import { expect, test } from "vitest";
import { coverageDue } from "./index-coverage.js";

test("coverage needs a changed picture and a thirty second quiet gap", () => {
  expect(
    coverageDue({
      sinceLastChosenUs: 30_000_000,
      pictureChanged: true,
      pointerTravelPt: 0,
      displayWidthPt: 1000,
    }),
  ).toBe(true);
  expect(
    coverageDue({
      sinceLastChosenUs: 30_000_000,
      pictureChanged: false,
      pointerTravelPt: 0,
      displayWidthPt: 1000,
    }),
  ).toBe(false);
});

test("coverage can be due after one display width of travel during change", () => {
  expect(
    coverageDue({
      sinceLastChosenUs: 1,
      pictureChanged: true,
      pointerTravelPt: 1000,
      displayWidthPt: 1000,
    }),
  ).toBe(true);
  expect(
    coverageDue({
      sinceLastChosenUs: 1,
      pictureChanged: true,
      pointerTravelPt: 999,
      displayWidthPt: 1000,
    }),
  ).toBe(false);
});
