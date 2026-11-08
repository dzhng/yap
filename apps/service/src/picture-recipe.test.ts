import { expect, test } from "vitest";
import { nativePictureCapabilities } from "./project-render.js";

test("picture discovery retains the exact native recipe and treats unavailable providers as absent", async () => {
  const id = "coreimage-sdr-source-neutral-recovery-v2:Version 26.1 (Build 25B1)";
  expect(
    await nativePictureCapabilities(async () => ({ ok: true, data: { sdrCorrection: id } })),
  ).toEqual({ sdrCorrection: id });
  expect(
    await nativePictureCapabilities(async () => ({
      ok: true,
      data: { sdrCorrection: "invented-backend" },
    })),
  ).toEqual({});
  expect(
    await nativePictureCapabilities(async () => ({
      ok: false,
      error: { code: "NOT_READY", message: "missing", retryable: true, details: {} },
    })),
  ).toEqual({});
});
