// Receives anonymous install/first-launch pings from the macOS app.
// Privacy: Only accepts an anonymous random UUID. No personal data, IP logging, or fingerprinting.
// The app generates a random install ID on first launch and sends it exactly once.

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

async function setIfNotExists(key) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return { stored: false, duplicate: false };

  try {
    // SETNX returns 1 if key was set (new install), 0 if key already existed (duplicate ping)
    const response = await fetch(`${kvUrl}/setnx/${key}/1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    if (!response.ok) return { stored: false, duplicate: false };
    const data = await response.json();
    return { stored: true, duplicate: data.result === 0 };
  } catch {
    return { stored: false, duplicate: false };
  }
}

async function trackVercelAnalytics(eventName, properties) {
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

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { installId, version, platform } = body;

  // Validate install ID is a proper UUID (privacy: reject anything that looks like personal data)
  if (!installId || !isValidUUID(installId)) {
    return new Response(JSON.stringify({ error: "Invalid install ID format" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const timestamp = new Date().toISOString();

  // Log for Vercel dashboard
  console.log(
    JSON.stringify({
      event: "install",
      timestamp,
      installId,
      version: version || "unknown",
      platform: platform || "macos",
    })
  );

  // Check if this install ID has been seen before (deduplication)
  const { stored, duplicate } = await setIfNotExists(`yap:installs:id:${installId}`);

  if (!duplicate) {
    // New unique install
    await incrementKV("yap:installs:total");
    await appendToList("yap:installs:log", `${timestamp}|${version || "unknown"}`);
    await trackVercelAnalytics("install", { version: version || "unknown", platform: platform || "macos" });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      recorded: stored,
      duplicate,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
