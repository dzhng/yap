import { defineConfig } from "vitest/config";

// Services these tests start inherit this environment, so none of them fetches presets from the
// network.
export default defineConfig({ test: { env: { YAP_PRESETS_REFRESH: "0" } } });
