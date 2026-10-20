import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CapturePublication, CapturePublishedSource } from "./capture-publication.js";

/** Native fixture input replaces pictures/PCM/pointers; production writers publish every byte. */
export function writeNativeCaptureFixture(
  directory: string,
  options: {
    recordingId?: string;
    sourceId?: string;
    cameraSourceId?: string;
    kind?: "display" | "camera";
    legacy?: boolean;
    mic?: boolean;
    system?: boolean;
    camera?: boolean;
    marks?: CapturePublishedSource["marks"];
  } = {},
): CapturePublication {
  const native = process.env.YAP_NATIVE;
  if (!native) throw new Error("Set YAP_NATIVE and build its sibling YapCaptureTests product");
  execFileSync(join(dirname(resolve(native)), "YapCaptureTests"), [], {
    env: {
      ...process.env,
      YAP_RECORDING_PROMPT_FIXTURE: directory,
      YAP_RECORDING_PROMPT_OPTIONS: JSON.stringify(options),
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return JSON.parse(readFileSync(join(directory, "publication.json"), "utf8"));
}
