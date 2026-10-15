# Website

The public site: one indexed product page for humans and the same instructions
as plain text at `/llms.txt` for agents.

## Principles

- **One copy source.** [content.mjs](content.mjs) holds every word. The page,
  its agent view and `llms.txt` all render from it, so humans and agents
  can't be told different things.
- **Link, don't restate.** Install procedure belongs to the repository README's
  agent setup and the consumer skill's references. The site points agents there
  and keeps only the facts that change what an agent does first.
- **The README owns the install prompt.** The build fails if `agentPrompt`
  differs from the prompt in the README's "Get started" section. Change both
  together.
- **Artwork has one home.** Illustrations are copied from `.github/readme` at
  build time; the site keeps no copies.
- **Video stays out of the repository.** Every deploy clones the repository, so
  the launch film streams from the `justyap-media` Vercel Blob store and
  [content.mjs](content.mjs) holds its URL; only its poster ships with the site.
  To replace the film, upload a web encode under a new pathname with
  `vercel blob put` and point `launchVideo.src` at it.
- **No dependencies, no framework.** [build.mjs](build.mjs) writes static files
  to `dist/`. There is no download button: agents are the only install route, and
  the page's Open in Claude Code / Open in Codex links only pre-fill the prompt.

## Build and check

```sh
node apps/site/build.mjs     # writes apps/site/dist
node --test apps/site/build.test.mjs
```

Preview `apps/site/dist` with any static server. Canonical URLs, the sitemap and
robots use `SITE_URL`, else Vercel's production domain, else a local origin.

## Deploying on Vercel

The Vercel project is connected to the repository with **Root Directory** `apps/site`,
so every push to `main` deploys; [vercel.json](vercel.json) supplies the build. Keep
"Include files outside the root directory" enabled, because the build reads the
README and artwork. `SITE_URL` is set on the project. A deploy spends most of its
time cloning the repository, whose archived evidence is large.

## Download and install tracking

The site tracks downloads and installs to understand usage. See
[TELEMETRY.md](../../TELEMETRY.md) for the privacy policy.

### What's tracked

1. **Downloads**: When someone hits `/api/download`, it logs the event and
   redirects to GitHub Releases. This counts site-driven downloads.
2. **Installs**: On first launch, the macOS app sends an anonymous ping to
   `/api/install` with a random UUID. This counts unique installs.

### Setup (required for persistence)

The API routes log to Vercel's function logs by default. For persistent counts,
set up Vercel KV:

1. In the Vercel dashboard, go to the `justyap` project → Storage → Create → KV
2. Connect it to the project (this adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   environment variables automatically)
3. Redeploy

Without KV, counts are still visible in Vercel's function logs (Logs → filter by
`event: download` or `event: install`).

### Optional: protect the stats endpoint

To require authentication for `/api/stats`:

1. In Vercel dashboard → Settings → Environment Variables
2. Add `STATS_API_KEY` with a random secret value
3. Redeploy

Then query with:

```sh
curl -H "Authorization: Bearer YOUR_API_KEY" https://justyap.io/api/stats
```

### Viewing counts

**With Vercel KV configured:**

```sh
# Basic counts
curl https://justyap.io/api/stats

# Detailed breakdown by day
curl "https://justyap.io/api/stats?detailed=true"
```

**Without KV (from Vercel logs):**

1. Go to Vercel dashboard → `justyap` → Logs
2. Filter by `event: download` or `event: install`
3. Count entries manually or export

### Local development

The API routes work locally with `vercel dev`:

```sh
cd apps/site
npx vercel dev
```

KV features require running `vercel env pull` first to get the credentials.

### Vercel Analytics custom events

The routes also call Vercel Analytics `track()` for custom events. This requires
the Pro plan (returns 402 on Hobby). When/if the project upgrades, the events
will automatically appear in the Analytics dashboard without code changes.
