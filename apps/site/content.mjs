// The one copy source for the website. The page and llms.txt both render from here.
// Install procedure lives in the repo (README agent setup, skills/yap/references);
// this file links to it rather than restating it.

export const repo = "https://github.com/dzhng/yap";
const raw = "https://raw.githubusercontent.com/dzhng/yap/main";

/** Must match the prompt in the README's "Get started" section; the build checks. */
export const agentPrompt =
  "Install Yap (the Mac app, which sets up the yap CLI and skill) by following https://justyap.io/llms.txt";

/** Links that open the agent with the prompt typed in, unsent. Copy always works. */
export const openIn = [
  { label: "Open in Claude Code", href: `claude-cli://open?q=${encodeURIComponent(agentPrompt)}` },
  { label: "Open in Codex", href: `codex://new?prompt=${encodeURIComponent(agentPrompt)}` },
];

export const requirements = "Apple Silicon · macOS 26 or newer";

export const links = {
  repo,
  releases: `${repo}/releases/latest`,
  kit: `${repo}/releases/latest/download/Yap-macos-arm64.zip`,
  kitTracked: "/api/download?source=site",
  agentSetup: `${repo}#agent-setup`,
  installation: `${raw}/skills/yap/references/installation.md`,
  skill: `${raw}/skills/yap/SKILL.md`,
  positioning: `${repo}/blob/main/positioning.md`,
};

export const meta = {
  title: "Yap — just yap; your agent makes it a great video",
  description:
    "Yap gives Claude Code, Codex and any agent the eyes, ears and hands to record, understand and edit video on your Mac. Free, local, and your originals are never touched.",
};

export const heroArt = {
  image: "header.png",
  alt: "A person just talks; Xiaohei, the agent, irons the tangle into a finished video",
};

/**
 * The launch film: one take, four cameras, edited by an agent with Yap. The film is a web encode
 * on the justyap Vercel Blob store, kept out of the repository; the poster ships with the site.
 */
export const launchVideo = {
  src: "https://dgl4bh1uqqy7y9zf.public.blob.vercel-storage.com/launch/yap-launch-v3.mp4",
  poster: "launch-poster.jpg",
  label: "made with yap",
  caption: "An agent edited this launch video end to end with Yap.",
};

export const asks = [
  "Watch this recording of the checkout bug and fix it.",
  "Tighten this into a 60-second product demo. Cut the dead air and false starts.",
  "Make a vertical version for X with big, punchy captions.",
  "Here's a launch video I love. Match its pacing and caption style.",
  "I said 'version three' at 0:42 but meant 'version two'. Fix it in my voice.",
  "Zoom in when I open the settings panel, fade out at the end, export 1080p.",
  "Clean up the background hum and give me an M4A of just the narration.",
  "I practised my pitch on camera. How's my pacing, and where did I ramble?",
  "Turn yesterday's podcast episode into three captioned clips and show notes.",
];

export const promises = [
  { title: "Runs on your Mac", body: "Recordings, transcripts and voice models stay local." },
  {
    title: "Originals untouched",
    body: "Every edit is a revision you can undo. Source media stays byte-for-byte.",
  },
  {
    title: "Your agent decides",
    body: "Yap has no built-in agent and makes zero editorial calls. It hands yours evidence and precise tools.",
  },
  { title: "Free", body: "No account, no subscription. Free for now while it grows up." },
];

export const howItWorks = [
  {
    image: "01-you-ask-agent-edits.png",
    alt: "A person hands over a note in plain words while Xiaohei cuts the recorded film with huge scissors",
    kicker: "in plain words",
    title: "Yap, ask, done",
    body: "Record from the menu bar, or hand over a video you already have. Ask in plain words. Your agent reads the transcript, looks at the frames, listens to the audio, then cuts, captions and exports.",
  },
  {
    image: "02-evidence-not-opinions.png",
    alt: "A toolbox holds the transcript, waveform and frames while Xiaohei, on a stool, marks the cut",
    kicker: "the agent decides",
    title: "Evidence, not opinions",
    body: "Word-timed transcripts, frames, waveforms, scene and cursor events, loudness. Yap supplies the facts; your agent makes the calls, so the result follows your intent, not a house style.",
  },
  {
    image: "03-originals-untouched.png",
    alt: "The original reel sits under a glass dome while Xiaohei pegs revisions on a line it can undo",
    kicker: "non-destructive",
    title: "Nothing to lose",
    body: "The agent works on revisions. Preview, compare, undo or restore any of them. Letting an agent edit carries no risk.",
  },
];

/** What a person does: hand the prompt to their agent, which does the rest. */
export const humanSteps = [
  {
    title: "Paste the prompt into Claude Code or Codex",
    body: "Or click Open in Claude Code / Open in Codex above. Your agent downloads Yap, checks it, puts it in Applications and opens it.",
  },
  {
    title: "Yap sets up your agent",
    body: "On first launch the app installs the `yap` command and the yap skill, and keeps both current with every update. Turn this off in Settings → Set up my agents.",
  },
  {
    title: "Just yap",
    body: "Record from the menu bar and ask for the video you want. Not happy? Say so in one more sentence.",
  },
];

/** Plain-text instructions for agents, served as /llms.txt and shown in the page's agent view. */
export function llmsText() {
  return `# Yap

> Yap is a free macOS toolkit (a menu-bar app, the \`yap\` CLI and an agent skill) that gives Claude Code, Codex and other agent harnesses the eyes, ears and hands to record, understand and edit video locally. It has no built-in agent and makes zero editorial decisions: the agent decides, Yap supplies evidence and precise, non-destructive operations.

Requirements: ${requirements.replace(" · ", ", ")}. Linux and Docker cannot run the native app or capture media.

## Install

If your user asked you to install Yap, the request is:

    ${agentPrompt}

You install the app; the app installs the rest. The [installation procedure](${links.installation}) has the exact commands: check the Mac, resolve the latest release's tag once and download its \`SHA256SUMS\`, \`release.json\` and kit from that tag (the \`latest/download\` links can briefly mix two releases right after one is published), checksum-verify them, place Yap.app in /Applications or ~/Applications, and open it. Within a few seconds the app installs \`~/.local/bin/yap\`, the yap skill for every agent it finds, and a PATH line when one is missing. Then verify with \`~/.local/bin/yap cli.status\`, \`skill.status\` and \`service.health\` (use the full path: the PATH line reaches only new shells) and report a short checklist. [Agent setup](${links.agentSetup}) is the same in the README.

Facts that change what you do:

- Don't copy a launcher or run \`npx skills add\` yourself; the app owns both. Use the manual steps in the installation procedure only when \`cli.status\` or \`skill.status\` reports a problem.
- The app refuses to run outside /Applications or ~/Applications and offers to move itself.
- Releases are not notarized. A download made with \`curl\` is never blocked; a browser download needs System Settings → Privacy & Security → Open Anyway. Never remove quarantine attributes or disable Gatekeeper.
- Installation does not grant screen, microphone or camera permissions; the user grants them on first recording.

## Use

- [yap skill](${links.skill}): how to record, understand and edit video for the user with the toolkit. Start a fresh agent session after the app installs it so it is discovered (\`/yap\` in Claude Code, \`$yap\` in Codex).

## Optional

- [README](${links.repo}): what Yap is and what people make with it.
- [Positioning](${links.positioning}): what is possible today and what isn't yet.
- [Latest release](${links.releases}): the app kit, its release.json receipt and SHA256SUMS.
`;
}
