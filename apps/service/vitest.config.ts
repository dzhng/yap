import { defineConfig } from "vitest/config";

// These suites start real services, workers and background jobs, and the full repo check runs
// every package at once. Vitest's unit-test defaults (5 s per test, 1 s per poll) fail them on a
// loaded machine without any wrong behavior; a test with tighter needs still sets its own budget.
// Spawned services inherit this environment, so none of them fetches presets from the network,
// and every response a test receives is held to the public naming rule.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    expect: { poll: { timeout: 10_000 } },
    env: { YAP_PRESETS_REFRESH: "0", YAP_NAMING_GUARD: "1" },
  },
});
