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
  build time; the site keeps no copies. The art is black ink on opaque white, so
  it stays readable in the README on GitHub's dark theme; the page frames
  nothing and multiplies the art onto its paper, so it reads as drawn there.
  New art is Xiaohei-style line drawing (generated with `gpt-image-2.5-flare`),
  cropped to the drawing plus an even margin and quantized to a small palette.
- **Video stays out of the repository.** Every deploy clones the repository, so
  the launch film streams from the `justyap-media` Vercel Blob store and
  [content.mjs](content.mjs) holds its URL; only its poster ships with the site.
  To replace the film, upload a web encode under a new pathname with
  `vercel blob put` and point `launchVideo.src` at it.
- **No dependencies, no framework.** [build.mjs](build.mjs) writes static files
  to `dist/`. There is no download button: agents are the only install route, and
  the page's Open in Claude Code / Open in Codex links only pre-fill the prompt.

## Admin notices

[notices.json](notices.json) is how the team tells people on a particular release
what to do when something has gone wrong, such as "back up your library" or
"reinstall from justyap.io". The app fetches it at launch and hourly, shows the first
notice whose `versions` regular expression matches its version in the menu and in
Settings, and saves it so the command line prints it on stderr. Anchor patterns, as
in `^0\.1\.4[01]$`. Patterns are ICU regular expressions
(`NSRegularExpression`); a notice whose pattern the app cannot compile, or whose
message is blank, is skipped, and messages are cut to 500 characters. A missing,
unreadable or wrongly shaped file changes nothing, so a mistake here can leave the
current notice up or hide a new one, but never breaks the app.

```json
{ "notices": [{ "versions": "^0\\.1\\.4[01]$", "message": "Reinstall Yap from justyap.io." }] }
```

To publish one, edit the file and push to `main`: the site deploys in about two minutes
and running apps pick it up within the hour (at once on their next launch). To
clear it, set `"notices": []` the same way. Only Yap 0.1.45 and later read notices.

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
