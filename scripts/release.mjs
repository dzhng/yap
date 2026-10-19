import { releaseSigningInputs, withReleaseIdentity, signReleaseTree } from "./release-signing.mjs";
import { appcast, bundleFacts, configureReleasePlist, verifiedFramework } from "./release-info.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  globSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "apps/macos/package.json")));
const { node, sparkleTools } = JSON.parse(readFileSync(join(root, "scripts/release-inputs.json")));
node.version = readFileSync(join(root, ".node-version"), "utf8").trim();
node.archive = `node-v${node.version}-darwin-arm64.tar.gz`;
const denoise = JSON.parse(readFileSync(join(root, "helpers/denoise/provenance.json")));
const inputs = join(root, "dist/release-inputs");
const modelName = `rnnoise_data-${denoise.modelArchiveSha256}.tar.gz`;
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const sha = async (file) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
};
async function verified(file, expected) {
  if ((await sha(file)) !== expected) throw new Error(`Checksum mismatch: ${file}`);
}
async function download(url, file, expected) {
  if (existsSync(file)) {
    await verified(file, expected);
    return;
  }
  const temporary = `${file}.part-${process.pid}`;
  try {
    const answer = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!answer.ok) throw new Error(`Download failed: ${url} (${answer.status})`);
    await pipeline(answer.body, createWriteStream(temporary, { flags: "wx" }));
    await verified(temporary, expected);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function validate(tag) {
  if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? ""))
    throw new Error(`Tag ${JSON.stringify(tag)} does not match app version v${version}`);
}
async function prepare() {
  mkdirSync(inputs, { recursive: true });
  await download(
    `https://nodejs.org/dist/v${node.version}/${node.archive}`,
    join(inputs, node.archive),
    node.sha256,
  );
  await download(
    `https://media.xiph.org/rnnoise/models/${modelName}`,
    join(inputs, modelName),
    denoise.modelArchiveSha256,
  );
  run(process.execPath, [join(root, "helpers/denoise/prepare.mjs"), join(inputs, modelName)]);
  run(process.execPath, [join(root, "helpers/ffmpeg/prepare.mjs"), "prepare", "--cache", inputs]);
  await download(sparkleTools.url, join(inputs, sparkleTools.archive), sparkleTools.sha256);
  if (
    !process.env.YAP_SPARKLE_FRAMEWORK &&
    !existsSync(join(root, "dist/sparkle/build-receipt.json"))
  ) {
    const pin = JSON.parse(readFileSync(join(root, "scripts/sparkle/upstream.json")));
    const source = join(inputs, "sparkle-source");
    if (!existsSync(source)) {
      run("git", ["clone", "--no-checkout", "--filter=blob:none", pin.repository, source]);
      run("git", ["-C", source, "checkout", "--detach", pin.commit]);
    }
    run(process.execPath, [
      join(root, "scripts/sparkle/build.mjs"),
      "--source",
      source,
      "--output",
      join(root, "dist/sparkle"),
    ]);
  }
  verifiedFramework(root);
}
async function packageRelease(tag) {
  validate(tag);
  const signing = releaseSigningInputs();
  const facts = await bundleFacts(root);
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Release packaging requires an Apple Silicon Mac.");
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (dirty) throw new Error("Commit source changes before packaging a release.");
  await verified(join(inputs, node.archive), node.sha256);
  const built = join(root, "dist/Yap.app");
  const builtVersion = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleShortVersionString", join(built, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  if (builtVersion !== version)
    throw new Error(`Built app version ${builtVersion} does not match ${tag}`);
  const minimumMacOS = execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :LSMinimumSystemVersion", join(built, "Contents/Info.plist")],
    { encoding: "utf8" },
  ).trim();
  const runtimeFacts = JSON.parse(
    readFileSync(join(built, "Contents/Resources/service/runtime.json")),
  );
  for (const [name, value] of Object.entries(facts))
    if (runtimeFacts[name] !== value)
      throw new Error(`Built runtime ${name} does not match committed source`);
  const engine = verifiedFramework(root);
  await verified(join(inputs, sparkleTools.archive), sparkleTools.sha256);
  const out = join(root, "dist/release");
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(out, "package-"));
  const tools = mkdtempSync(join(out, "tools-"));
  const app = join(work, "Yap.app");
  // A fixed kit name keeps releases/latest/download/<name> stable; the tag lives in release.json.
  const archive = join(out, "Yap-macos-arm64.zip");
  const temporaryArchive = `${archive}.part-${process.pid}`;
  try {
    run("tar", ["-xf", join(inputs, sparkleTools.archive), "-C", tools]);
    run("ditto", [built, app]);
    const embeddedFramework = join(app, "Contents/Frameworks/Sparkle.framework");
    rmSync(embeddedFramework, { recursive: true, force: true });
    run("ditto", [engine.framework, embeddedFramework]);
    run("tar", ["-xzf", join(inputs, node.archive), "-C", work]);
    const distribution = join(work, `node-v${node.version}-darwin-arm64`);
    const resources = join(app, "Contents/Resources");
    const runtime = join(resources, "node/bin");
    mkdirSync(runtime, { recursive: true });
    copyFileSync(join(distribution, "bin/node"), join(runtime, "node"));
    const notices = join(resources, "ThirdParty");
    for (const [name, file] of [
      ["Node", join(distribution, "LICENSE")],
      ["Sparkle", join(tools, "LICENSE")],
      ["FluidAudio", join(root, "helpers/mac/.build/checkouts/FluidAudio/LICENSE")],
      [
        "SignalsmithStretch",
        join(root, "helpers/stretch/Sources/CSignalsmith/vendor/LICENSE-stretch.txt"),
      ],
      [
        "SignalsmithLinear",
        join(root, "helpers/stretch/Sources/CSignalsmith/vendor/LICENSE-linear.txt"),
      ],
    ]) {
      mkdirSync(join(notices, name), { recursive: true });
      copyFileSync(file, join(notices, name, "LICENSE"));
    }
    for (const file of globSync(
      "node_modules/.bun/*/node_modules/{*,@*/*}/{LICENSE*,COPYING*,NOTICE*}",
      { cwd: root },
    )) {
      const destination = join(notices, "JavaScript", file.slice("node_modules/.bun/".length));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, file), destination);
    }
    rmSync(distribution, { recursive: true });
    const manifestFile = join(resources, "service/runtime.json");
    const manifest = JSON.parse(readFileSync(manifestFile));
    manifest.nodePath = "../node/bin/node";
    configureReleasePlist(join(app, "Contents/Info.plist"), facts, signing.publicKey);
    for (const executable of [
      join(runtime, "node"),
      join(app, "Contents/MacOS/yap-native"),
      join(app, "Contents/MacOS/Yap"),
    ]) {
      const arch = execFileSync("lipo", ["-archs", executable], { encoding: "utf8" }).trim();
      if (arch !== "arm64") throw new Error(`Expected arm64 executable: ${executable} (${arch})`);
    }
    // The app carries its launcher as nested code and installs the command from it; the kit
    // ships no other copy.
    const launcher = join(resources, "bin/yap");
    mkdirSync(dirname(launcher), { recursive: true });
    run("xcrun", [
      "clang",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-arch",
      "arm64",
      `-mmacosx-version-min=${minimumMacOS}`,
      join(root, "scripts/launcher/main.c"),
      "-o",
      launcher,
    ]);
    let ffmpeg;
    await withReleaseIdentity(signing, async ({ keychain, keyFile, identity }) => {
      const signedResources = [];
      const { stageFFmpeg } = await import("../helpers/ffmpeg/prepare.mjs");
      const ffmpegDirectory = join(resources, "ffmpeg");
      rmSync(ffmpegDirectory, { recursive: true, force: true });
      ffmpeg = await stageFFmpeg({
        source: join(built, "Contents/Resources/ffmpeg"),
        destination: ffmpegDirectory,
        sign: (file) => {
          const arch = execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim();
          if (arch !== "arm64")
            throw new Error(`Expected arm64 FFmpeg resource: ${file} (${arch})`);
          signReleaseTree(file, identity, keychain);
          signedResources.push(file);
        },
      });
      manifest.ffmpegDirectory = "../ffmpeg";
      manifest.ffmpegReceiptSha256 = await sha(join(ffmpegDirectory, "receipt.json"));
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
      signReleaseTree(app, identity, keychain, { signedResources });
      const updateArchive = join(out, `Yap-${tag}-update-macos-arm64.zip`);
      run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, updateArchive]);
      const tool = join(tools, "bin/sign_update");
      const signature = execFileSync(tool, ["--ed-key-file", keyFile, "-p", updateArchive], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      run(tool, ["--ed-key-file", keyFile, "--verify", updateArchive, signature]);
      const updateName = updateArchive.split("/").at(-1);
      const feed = join(out, "appcast.xml");
      writeFileSync(
        feed,
        appcast({
          facts,
          title: "Yap",
          minimumSystemVersion: minimumMacOS,
          enclosure: `<enclosure url="https://github.com/dzhng/yap/releases/download/${tag}/${updateName}" sparkle:edSignature="${signature}" length="${readFileSync(updateArchive).length}" type="application/octet-stream"/>`,
        }),
      );
      run(tool, ["--ed-key-file", keyFile, feed]);
      run(tool, ["--ed-key-file", keyFile, "--verify", feed]);
      manifest.updateArchive = { name: updateName, sha256: await sha(updateArchive) };
      manifest.appcast = { name: "appcast.xml", sha256: await sha(feed) };
    });
    writeFileSync(
      join(work, "release.json"),
      JSON.stringify(
        {
          ...facts,
          tag,
          platform: "macOS",
          minimumMacOS,
          architecture: "arm64",
          nodeVersion: node.version,
          ffmpeg: {
            version: ffmpeg.version,
            sourceSha256: ffmpeg.sourceSha256,
            recipeSha256: ffmpeg.recipeSha256,
            receiptSha256: manifest.ffmpegReceiptSha256,
          },
          signature: "stable-self-signed",
          signingIdentity: { sha1: signing.sha1, certificateSha256: signing.certificateSha256 },
          updatePublicKey: signing.publicKey,
          sparkle: {
            commit: engine.receipt.inputs.commit,
            patchSha256: engine.receipt.inputs.patchSha256,
          },
          updateArchive: manifest.updateArchive,
          appcast: manifest.appcast,
          notarized: false,
        },
        null,
        2,
      ) + "\n",
    );
    run("ditto", ["-c", "-k", "--sequesterRsrc", work, temporaryArchive]);
    renameSync(temporaryArchive, archive);
    copyFileSync(join(work, "release.json"), join(out, "release.json"));
    writeFileSync(
      join(out, "SHA256SUMS"),
      `${await sha(archive)}  ${archive.split("/").at(-1)}\n${await sha(join(out, "release.json"))}  release.json\n`,
    );
    console.log(archive);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
    rmSync(temporaryArchive, { force: true });
  }
}
try {
  const [command, tag, ...extra] = process.argv.slice(2);
  if (extra.length || (command === "prepare" && tag))
    throw new Error("Unexpected release arguments");
  if (command === "validate") {
    validate(tag);
    console.log(version);
  } else if (command === "prepare") await prepare();
  else if (command === "package") await packageRelease(tag);
  else throw new Error("Usage: node scripts/release.mjs validate TAG | prepare | package TAG");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
