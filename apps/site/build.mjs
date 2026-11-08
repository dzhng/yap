// Renders the static website into dist/ from content.mjs. No dependencies.
// Run `node apps/site/build.mjs`; Vercel runs it with apps/site as the root.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as content from "./content.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const artwork = join(here, "../../.github/readme");
const staticFiles = [
  "style.css",
  "main.js",
  "favicon.svg",
  "og.png",
  "notices.json",
  content.launchVideo.poster,
];

/** Production origin: explicit SITE_URL, else Vercel's production domain, else local preview. */
function defaultSiteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : "http://localhost:4173";
}

const escape = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Inline `code` in copy becomes <code>; everything else is escaped. */
const prose = (text) => escape(text).replace(/`([^`]+)`/g, "<code>$1</code>");

/** The README owns the human-facing prompt too; refuse to publish a different one. */
function checkPromptMatchesReadme(readme) {
  const quoted = readme
    .split("\n")
    .filter((line) => line.startsWith("> "))
    .map((line) => line.slice(2))
    .join(" ");
  if (!quoted.includes(content.agentPrompt))
    throw new Error(
      `README "Get started" prompt no longer matches apps/site/content.mjs agentPrompt:\n  ${content.agentPrompt}`,
    );
}

/** Intrinsic PNG size from the IHDR chunk, so images reserve their space before loading. */
function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function illustration(name, alt, { eager = false } = {}) {
  const { width, height } = pngSize(join(artwork, name));
  const loading = eager ? `fetchpriority="high"` : `loading="lazy"`;
  return `<img src="/art/${name}" alt="${escape(alt)}" width="${width}" height="${height}" ${loading} decoding="async">`;
}

const blob = (id) => `<svg class="blob" id="${id}" viewBox="0 0 120 130" aria-hidden="true">
  <path d="M60 6c30 0 52 22 54 58 2 34-18 60-54 60S4 100 6 64C8 28 30 6 60 6z" fill="var(--ink)"/>
  <g class="eyes"><circle cx="44" cy="58" r="8" fill="var(--paper)"/><circle cx="78" cy="58" r="8" fill="var(--paper)"/></g>
</svg>`;

const copyButton = (label, source) =>
  `<button class="copy" type="button" data-copy="${source}"><span class="copy-label">${label}</span><span class="copy-done" aria-live="polite"></span></button>`;

/** One direction column: numbered steps in the setup section's look (`.for-humans`). */
function direction(item) {
  const list = `<div class="for-humans"><ol>${item.items.map((entry) => `<li><strong>${prose(entry.title)}</strong><p>${prose(entry.body)}</p></li>`).join("")}</ol></div>`;
  const fine = item.fine ? `<p class="fine">${prose(item.fine)}</p>` : "";
  return `<div>
        <h3><span class="hand">${escape(item.hand)}</span> ${escape(item.title)}</h3>
        <p>${prose(item.body)}</p>
        ${list}${fine}
      </div>`;
}

function renderPage(siteUrl) {
  const { meta, hero, links, agentPrompt, requirements } = content;
  const og = `${siteUrl}/og.png`;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Yap",
    description: meta.description,
    url: `${siteUrl}/`,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "macOS",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@type": "Organization", name: "Yap", url: links.repo },
  };
  return `<!doctype html>
<!-- AI agents: plain-text instructions are at /llms.txt -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(meta.title)}</title>
<meta name="description" content="${escape(meta.description)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${siteUrl}/">
<link rel="alternate" type="text/plain" href="/llms.txt" title="Instructions for AI agents">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="${escape(meta.title)}">
<meta property="og:description" content="${escape(meta.description)}">
<meta property="og:url" content="${siteUrl}/">
<meta property="og:image" content="${og}">
<meta property="og:image:alt" content="${escape(meta.imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(meta.title)}">
<meta name="twitter:description" content="${escape(meta.description)}">
<meta name="twitter:image" content="${og}">
<meta name="twitter:image:alt" content="${escape(meta.imageAlt)}">
<meta name="theme-color" content="#fbf7ef">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&family=Caveat:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<link rel="stylesheet" href="/style.css">
<script defer src="/_vercel/insights/script.js"></script>
<script type="application/ld+json">${JSON.stringify(structuredData)}</script>
<script>document.documentElement.dataset.mode = /[?&#]agent\\b/.test(location.href) || localStorage.getItem("yap-mode") === "agent" ? "agent" : "human";</script>
</head>
<body>
<header class="bar">
  <a class="brand" href="/" aria-label="Yap home">${blob("brand-blob")}<span>Yap</span></a>
  <nav class="nav" aria-label="Sections"><a href="#how">How it works</a><a href="#setup">Setup</a></nav>
  <div class="mode" role="group" aria-label="Who is reading?">
    <button type="button" data-set-mode="human"><span class="long">I'm a </span>human</button>
    <button type="button" data-set-mode="agent"><span class="long">I'm an </span>agent</button>
  </div>
  <a class="gh" href="${links.repo}">GitHub</a>
</header>

<main class="human-view">
  <section class="hero">
    <p class="kicker hand">${escape(hero.kicker)}</p>
    <h1>${escape(hero.headline)}<br><span>${escape(hero.subline)}</span></h1>
    <p class="lede">${prose(hero.lede)}</p>

    <figure class="hero-art">${illustration(content.heroArt.image, content.heroArt.alt, { eager: true })}</figure>

    <div class="ctas">
      <div class="cta prompt">
        <p class="hand prompt-label">tell your agent to install it</p>
        <blockquote id="agent-prompt">${escape(agentPrompt)}</blockquote>
        <div class="actions">
          ${content.openIn.map((link) => `<a class="open" href="${escape(link.href)}">${escape(link.label)}</a>`).join("\n          ")}
          ${copyButton("Copy prompt", "agent-prompt")}
        </div>
        <p class="fine">The open buttons type the prompt into your agent without sending it.</p>
        <p class="fine req">${requirements} · Free</p>
      </div>
    </div>
  </section>

  <section class="directions" aria-label="Two directions">
    <div class="columns">
      ${content.directions.map(direction).join("\n      ")}
    </div>
  </section>

  <section class="film" aria-label="Launch video">
    <p class="hand film-label">${escape(content.launchVideo.label)}</p>
    <div class="film-player">
      <video controls playsinline preload="none" poster="/${content.launchVideo.poster}" width="1920" height="1080">
        <source src="${content.launchVideo.src}" type="video/mp4">
      </video>
      <button class="film-play" type="button" aria-label="Play the launch video" hidden><span class="film-play-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5z"/></svg></span></button>
    </div>
    <p class="fine">${prose(content.launchVideo.caption)}</p>
  </section>

  <section class="asks">
    <h2>Things you can just say</h2>
    <ul>${content.asks.map((ask) => `<li>“${escape(ask)}”</li>`).join("")}</ul>
  </section>

  <section class="how" id="how">
    <h2>How it works</h2>
    ${content.howItWorks
      .map(
        (item) => `<article>
      <figure>${illustration(item.image, item.alt)}</figure>
      <div><p class="hand how-kicker">${escape(item.kicker)}</p><h3>${escape(item.title)}</h3><p>${prose(item.body)}</p></div>
    </article>`,
      )
      .join("\n    ")}
  </section>

  <section class="promises">
    ${content.promises.map((item) => `<div><h3>${escape(item.title)}</h3><p>${prose(item.body)}</p></div>`).join("\n    ")}
  </section>

  <section class="setup" id="setup">
    <h2>Setting it up</h2>
    <div class="columns">
      <div class="for-humans">
        <h3><span class="hand">for</span> humans</h3>
        <ol>${content.humanSteps.map((step) => `<li><strong>${prose(step.title)}</strong><p>${prose(step.body)}</p></li>`).join("")}</ol>
      </div>
      <div class="for-agents">
        <h3><span class="hand">for</span> agents</h3>
        <p>Everything an agent needs is plain text at <a href="/llms.txt">/llms.txt</a>, or flip the switch up top.</p>
        <div class="terminal" role="presentation"><div class="dots"><i></i><i></i><i></i><span>llms.txt</span></div><pre>${escape(content.llmsText())}</pre></div>
      </div>
    </div>
  </section>
</main>

<main class="agent-view">
  <p class="agent-banner"># You're reading the agent view. Same words as <a href="/llms.txt">/llms.txt</a> ${copyButton("Copy all", "agent-text")}</p>
  <pre id="agent-text">${escape(content.llmsText())}</pre>
</main>

<footer class="foot">
  ${blob("foot-blob")}
  <p>Yap is free, local and open on <a href="${links.repo}">GitHub</a>. <a href="${links.releases}">Releases</a> · <a href="/llms.txt">llms.txt</a> · <a href="${links.agentSetup}">Agent setup</a></p>
</footer>
<script type="module" src="/main.js"></script>
</body>
</html>
`;
}

export function build({
  out = join(here, "dist"),
  siteUrl = defaultSiteUrl(),
  readme = readFileSync(join(here, "../../README.md"), "utf8"),
} = {}) {
  checkPromptMatchesReadme(readme);
  siteUrl = siteUrl.replace(/\/$/, "");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "art"), { recursive: true });
  writeFileSync(join(out, "index.html"), renderPage(siteUrl));
  writeFileSync(join(out, "llms.txt"), content.llmsText());
  writeFileSync(
    join(out, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`,
  );
  writeFileSync(
    join(out, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}/</loc></url>\n</urlset>\n`,
  );
  for (const file of staticFiles) copyFileSync(join(here, file), join(out, file));
  for (const item of [content.heroArt, ...content.howItWorks])
    copyFileSync(join(artwork, item.image), join(out, "art", item.image));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Built ${build()}`);
