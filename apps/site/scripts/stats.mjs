#!/usr/bin/env node
// Fetches and displays download/install stats from justyap.io.
// Usage: node apps/site/scripts/stats.mjs [--detailed]

const endpoint = process.env.STATS_ENDPOINT || "https://justyap.io/api/stats";
const apiKey = process.env.STATS_API_KEY;

const detailed = process.argv.includes("--detailed");
const url = detailed ? `${endpoint}?detailed=true` : endpoint;

const headers = {};
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

try {
  const response = await fetch(url, { headers });
  const data = await response.json();

  if (!data.kvConfigured) {
    console.log("Vercel KV not configured.\n");
    console.log(data.message);
    console.log(`\nHint: ${data.hint}`);
    process.exit(0);
  }

  console.log("Yap Download & Install Stats");
  console.log("============================\n");
  console.log(`Downloads: ${data.totals.downloads}`);
  console.log(`Installs:  ${data.totals.installs}`);
  console.log(`\nAs of: ${data.asOf}`);

  if (detailed && data.recent) {
    console.log("\n--- Downloads by day ---");
    for (const [day, count] of Object.entries(data.recent.downloadsByDay).sort().slice(-14)) {
      console.log(`  ${day}: ${count}`);
    }

    console.log("\n--- Installs by day ---");
    for (const [day, count] of Object.entries(data.recent.installsByDay).sort().slice(-14)) {
      console.log(`  ${day}: ${count}`);
    }
  }
} catch (error) {
  console.error("Failed to fetch stats:", error.message);
  process.exit(1);
}
