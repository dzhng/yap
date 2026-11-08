import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { frameworkIdentity } from "./sparkle/framework.mjs";
export const releaseFeedURL = "https://github.com/dzhng/yap/releases/latest/download/appcast.xml";
export const launchLockRelativePath = "Library/Caches/com.dzhng.yap/launch.lock";
export async function bundleFacts(root) {
  const { version } = JSON.parse(readFileSync(join(root, "apps/macos/package.json")));
  const { catalogFormat, minimumSupportedCatalogFormat: minimumCatalogFormat } = await import(
    pathToFileURL(join(root, "packages/core/dist/catalog.js"))
  );
  if (!Number.isSafeInteger(catalogFormat) || catalogFormat < 1)
    throw new Error("Core does not export its catalog format");
  if (
    !Number.isSafeInteger(minimumCatalogFormat) ||
    minimumCatalogFormat < 1 ||
    minimumCatalogFormat > catalogFormat
  )
    throw new Error("Core does not export the oldest catalog format it opens");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { version, revision, catalogFormat, minimumCatalogFormat };
}
/** The first release that wrote each catalog format. A release bumping the format adds its own. */
export const catalogFormatSince = { 29: "0.1.23", 30: "0.1.62" };
/**
 * An installed app accepts only a feed item declaring its own catalog format, so the feed
 * offers the same update once per format the candidate opens, newest first. Sparkle drops an
 * item whose minimum update version is newer than the installed app, and takes the first of
 * equal versions, so every app meets the item for the format it wrote.
 */
export function appcast({
  facts,
  title,
  minimumSystemVersion,
  enclosure,
  formatSince = catalogFormatSince,
}) {
  const { version, catalogFormat, minimumCatalogFormat } = facts;
  const items = [];
  for (let format = catalogFormat; format >= minimumCatalogFormat; format--) {
    const since = formatSince[format];
    if (!since) throw new Error(`Record the first release with catalog format ${format}`);
    items.push(
      `<item><title>${version}</title><sparkle:version>${version}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString>${minimumSystemVersion ? `<sparkle:minimumSystemVersion>${minimumSystemVersion}</sparkle:minimumSystemVersion>` : ""}<sparkle:minimumUpdateVersion>${since}</sparkle:minimumUpdateVersion><yapCatalogFormat>${format}</yapCatalogFormat>${enclosure}</item>`,
    );
  }
  return `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>${title}</title>${items.join("")}</channel></rss>\n`;
}
export function verifiedFramework(root, env = process.env) {
  const framework = env.YAP_SPARKLE_FRAMEWORK ?? join(root, "dist/sparkle/Sparkle.framework");
  const receipt = JSON.parse(readFileSync(join(framework, "../build-receipt.json")));
  const pin = JSON.parse(readFileSync(join(root, "scripts/sparkle/upstream.json")));
  if (
    receipt.inputs.commit !== pin.commit ||
    receipt.inputs.patchSha256 !== pin.patchSha256 ||
    frameworkIdentity(framework).sha256 !== receipt.framework.sha256
  )
    throw new Error("Sparkle framework does not match its pinned build receipt");
  return { framework, receipt };
}
export function configureReleasePlist(plist, facts, publicKey) {
  const fields = {
    CFBundleVersion: ["string", facts.version],
    CFBundleShortVersionString: ["string", facts.version],
    YapCatalogFormat: ["integer", facts.catalogFormat],
    YapLaunchLockRelativePath: ["string", launchLockRelativePath],
    SUFeedURL: ["string", releaseFeedURL],
    SUPublicEDKey: ["string", publicKey],
    SURequireSignedFeed: ["bool", true],
    SUVerifyUpdateBeforeExtraction: ["bool", true],
    SUSignedFeedFailureExpirationInterval: ["real", 0],
    SUEnableAutomaticChecks: ["bool", true],
    // Sparkle's shortest schedule: a cycle that failed, or found the installer busy, is retried
    // within the hour instead of the default day.
    SUScheduledCheckInterval: ["integer", 3600],
    SUAllowsAutomaticUpdates: ["bool", false],
    SUAutomaticallyUpdate: ["bool", false],
  };
  for (const [name, [type, value]] of Object.entries(fields)) {
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${name}`, plist], {
        stdio: "ignore",
      });
    } catch {}
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${name} ${type} ${value}`, plist]);
  }
}
