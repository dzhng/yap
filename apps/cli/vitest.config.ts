import { defineConfig } from "vitest/config";

// Services these tests start inherit this environment, so none of them fetches presets from the
// network, and every response is held to the public naming rule.
export default defineConfig({ test: { env: { YAP_PRESETS_REFRESH: "0", YAP_NAMING_GUARD: "1" } } });
