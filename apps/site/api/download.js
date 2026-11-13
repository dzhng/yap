// Tracks download clicks and redirects to GitHub releases.
// Storage: Vercel KV when configured, otherwise logs only (queryable in Vercel dashboard).
// Also calls Vercel Analytics track() which activates automatically on Pro plan upgrade.

const GITHUB_RELEASE_URL = "https://github.com/dzhng/yap/releases/latest/download/Yap-macos-arm64.zip";

export const config = { runtime: "edge" };

async function incrementKV(key) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const response = await fetch(`${kvUrl}/incr/${key}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.result;
  } catch {
    return null;
  }
}

async function appendToList(key, value, maxLength = 10000) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return;

  try {
    await fetch(`${kvUrl}/lpush/${key}/${encodeURIComponent(value)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    await fetch(`${kvUrl}/ltrim/${key}/0/${maxLength - 1}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}` },
    });
  } catch {
    // Best effort
  }
}

async function trackVercelAnalytics(eventName, properties) {
  // Vercel Analytics track() requires Pro plan; this prepares for upgrade.
  // On Hobby plan this will 402, which we ignore.
  const analyticsEndpoint = process.env.VERCEL_ANALYTICS_ENDPOINT;
  if (!analyticsEndpoint) return;

  try {
    await fetch(analyticsEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: eventName, properties }),
    });
  } catch {
    // Expected to fail on Hobby plan
  }
}

export default async function handler(request) {
  const timestamp = new Date().toISOString();
  const source = new URL(request.url).searchParams.get("source") || "direct";
  const userAgent = request.headers.get("user-agent") || "unknown";
  const isAgent = /curl|wget|fetch|node|python|bot/i.test(userAgent);

  // Log for Vercel dashboard (always works, free tier)
  console.log(
    JSON.stringify({
      event: "download",
      timestamp,
      source,
      isAgent,
      userAgent: userAgent.slice(0, 200),
    })
  );

  // Try Vercel KV storage (requires setup)
  const count = await incrementKV("yap:downloads:total");
  await appendToList("yap:downloads:log", `${timestamp}|${source}|${isAgent ? "agent" : "browser"}`);

  // Try Vercel Analytics custom event (requires Pro)
  await trackVercelAnalytics("download", { source, isAgent });

  // Redirect to GitHub releases
  return Response.redirect(GITHUB_RELEASE_URL, 302);
}
