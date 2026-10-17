import { CatalogError } from "@yap/core/catalog";
import { CONTROL_FRAME_BYTES, encodeJsonLine, personalHome } from "@yap/protocol";
import { startProjectService } from "./project-service.js";
import { StartupFailure } from "./startup.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import appManifest from "../../macos/package.json" with { type: "json" };

// Installed runtime metadata records the assembled app; standalone builds use its manifest.
let version = appManifest.version;
const runtimeUrl = new URL("./runtime.json", import.meta.url);
let runtimeMetadata: Record<string, unknown> = {};
try {
  runtimeMetadata = JSON.parse(readFileSync(runtimeUrl, "utf8")) as Record<string, unknown>;
  if (typeof runtimeMetadata.version === "string" && runtimeMetadata.version.length)
    version = runtimeMetadata.version;
} catch {}

try {
  const bundledPresets =
    process.env.YAP_PRESETS_DIRECTORY ??
    (typeof runtimeMetadata.presetsDirectory === "string"
      ? fileURLToPath(new URL(runtimeMetadata.presetsDirectory, runtimeUrl))
      : undefined);
  const service = await startProjectService({
    home: personalHome(),
    ffmpeg: process.env.YAP_FFMPEG_DIRECTORY
      ? {
          directory: process.env.YAP_FFMPEG_DIRECTORY,
          receiptSha256: process.env.YAP_FFMPEG_RECEIPT_SHA256 ?? "",
        }
      : undefined,
    // Every run refreshes presets at launch and daily unless YAP_PRESETS_REFRESH=0, which the test runners set.
    presets: {
      ...(bundledPresets ? { bundled: bundledPresets } : {}),
      ...(process.env.YAP_PRESETS_REFRESH === "0" ? {} : { refresh: true as const }),
    },
    version,
    control: { input: process.stdin, output: process.stdout },
    // Empty-home lifecycle tests opt out explicitly; installed runs keep the
    // first-party model acquisition default when the variable is absent.
    autoPrepareModels: process.env.YAP_AUTO_PREPARE_MODELS !== "0",
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => {
      void service.close();
    });
} catch (error) {
  const typed = error instanceof CatalogError || error instanceof StartupFailure;
  process.stdout.write(
    encodeJsonLine(
      {
        event: "failed",
        error: {
          code: typed ? error.code : "SERVICE_UNAVAILABLE",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          retryable: error instanceof CatalogError ? error.retryable : false,
          details: error instanceof CatalogError ? error.details : {},
        },
      },
      CONTROL_FRAME_BYTES,
    ),
  );
  process.exitCode = 1;
}
