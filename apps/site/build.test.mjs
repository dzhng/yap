import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "./build.mjs";
import { agentPrompt } from "./content.mjs";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const siteUrl = "https://yap.example";

function built(options = {}) {
  const out = mkdtempSync(join(tmpdir(), "yap-site-"));
  build({ out, siteUrl, readme, ...options });
  return (name) => readFileSync(join(out, name), "utf8");
}

test("humans and agents are handed the same install prompt", () => {
  const file = built();
  assert.ok(file("index.html").includes(agentPrompt), "page shows the prompt");
  assert.ok(file("llms.txt").includes(agentPrompt), "llms.txt carries the prompt");
});

test("the agent view on the page is the llms.txt text", () => {
  const file = built();
  const escaped = file("llms.txt")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  assert.ok(file("index.html").includes(escaped));
});

test("the build refuses a prompt that has drifted from the README", () => {
  assert.throws(() => built({ readme: readme.replaceAll("yap CLI", "yap tool") }), /README/);
});

test("the one indexed page is sitemapped, allowed and canonical at the production origin", () => {
  const file = built();
  assert.match(file("sitemap.xml"), /<loc>https:\/\/yap\.example\/<\/loc>/);
  assert.match(file("robots.txt"), /Allow: \//);
  assert.match(file("robots.txt"), /Sitemap: https:\/\/yap\.example\/sitemap\.xml/);
  assert.match(file("index.html"), /<link rel="canonical" href="https:\/\/yap\.example\/">/);
  assert.doesNotMatch(file("index.html"), /noindex/);
});

test("the product page publishes complete crawler and social metadata", () => {
  const page = built()("index.html");
  assert.match(page, /<meta name="robots" content="index, follow">/);
  assert.match(
    page,
    /<meta property="og:image:alt" content="Yap — just yap\. Your agent gets it\.">/,
  );
  assert.match(page, /<meta property="og:image" content="https:\/\/yap\.example\/og\.png">/);
  assert.match(page, /<meta name="twitter:title" content="Yap — just yap\. Your agent gets it\.">/);
  assert.match(page, /<script type="application\/ld\+json">[\s\S]*"@type":"SoftwareApplication"/);
  assert.match(page, /"operatingSystem":"macOS"/);
});

test("the product page loads Vercel Web Analytics", () => {
  const page = built()("index.html");
  assert.match(page, /<script defer src="\/_vercel\/insights\/script\.js"><\/script>/);
});

test("the page offers no download, only the agent route", () => {
  const page = built()("index.html");
  assert.doesNotMatch(page, /Download for Mac|href="[^"]*\.zip"|api\.github\.com/);
});

test("both open-in links carry the exact prompt, unsent", () => {
  const page = built()("index.html");
  const encoded = encodeURIComponent(agentPrompt);
  assert.ok(page.includes(`claude-cli://open?q=${encoded}`));
  assert.ok(page.includes(`codex://new?prompt=${encoded}`));
});

test("the page streams the launch video from its host and ships the poster", () => {
  const out = mkdtempSync(join(tmpdir(), "yap-site-"));
  build({ out, siteUrl, readme });
  const page = readFileSync(join(out, "index.html"), "utf8");
  const video = page.match(/<video[^>]*>/)?.[0];
  assert.ok(video, "page has a video");
  assert.match(video, /\bcontrols\b/);
  assert.match(video, /preload="(none|metadata)"/, "a visit doesn't download the whole film");
  assert.match(
    page,
    /<source src="https:\/\/[^"]+\.mp4" type="video\/mp4">/,
    "film is hosted, not in the repo",
  );
  const poster = video.match(/poster="\/([^"]+)"/)?.[1];
  assert.ok(poster && statSync(join(out, poster)).size > 0, "poster is shipped");
});

test("the site publishes the admin notice feed the app reads", () => {
  const feed = JSON.parse(built()("notices.json"));
  assert.ok(Array.isArray(feed.notices));
  for (const notice of feed.notices) {
    // Patterns are ICU regular expressions, checked by the app; one it cannot compile is skipped.
    assert.equal(typeof notice.versions, "string");
    assert.equal(typeof notice.message, "string");
  }
});
