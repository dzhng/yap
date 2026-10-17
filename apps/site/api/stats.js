// Returns download and install counts. Protected by optional API key.
// When Vercel KV is not configured, returns instructions to check Vercel logs.

export const config = { runtime: "edge" };

async function getKVValue(key) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const response = await fetch(`${kvUrl}/get/${key}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.result;
  } catch {
    return null;
  }
}

async function getKVList(key, start = 0, end = -1) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const response = await fetch(`${kvUrl}/lrange/${key}/${start}/${end}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.result;
  } catch {
    return null;
  }
}

function aggregateByDay(entries) {
  const byDay = {};
  for (const entry of entries || []) {
    const timestamp = entry.split("|")[0];
    const day = timestamp.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return byDay;
}

export default async function handler(request) {
  // Optional API key protection
  const apiKey = process.env.STATS_API_KEY;
  if (apiKey) {
    const authHeader = request.headers.get("authorization");
    const providedKey = authHeader?.replace("Bearer ", "");
    if (providedKey !== apiKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const kvConfigured = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

  if (!kvConfigured) {
    return new Response(
      JSON.stringify({
        kvConfigured: false,
        message:
          "Vercel KV not configured. View counts in Vercel dashboard: Logs → filter by 'event: download' or 'event: install'. See apps/site/README.md for KV setup.",
        hint: "Set KV_REST_API_URL and KV_REST_API_TOKEN environment variables.",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const url = new URL(request.url);
  const detailed = url.searchParams.get("detailed") === "true";
  const recentDays = parseInt(url.searchParams.get("days") || "30", 10);

  const [downloads, installs, downloadLog, installLog] = await Promise.all([
    getKVValue("yap:downloads:total"),
    getKVValue("yap:installs:total"),
    detailed ? getKVList("yap:downloads:log", 0, 999) : null,
    detailed ? getKVList("yap:installs:log", 0, 999) : null,
  ]);

  const response = {
    kvConfigured: true,
    totals: {
      downloads: parseInt(downloads || "0", 10),
      installs: parseInt(installs || "0", 10),
    },
    asOf: new Date().toISOString(),
  };

  if (detailed) {
    response.recent = {
      downloadsByDay: aggregateByDay(downloadLog),
      installsByDay: aggregateByDay(installLog),
      recentDownloads: (downloadLog || []).slice(0, 100),
      recentInstalls: (installLog || []).slice(0, 100),
    };
  }

  return new Response(JSON.stringify(response, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
