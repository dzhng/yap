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
  title: "Yap — just yap. Your agent gets it.",
  description:
    "Show your agent a bug or a design in four keys, or show people a polished video. Yap gives Claude Code, Codex and any agent the eyes, ears and hands for video on your Mac. Free and local.",
  /** Describes og.png for social cards. */
  imageAlt: "Yap — just yap. Your agent gets it.",
};

export const hero = {
  kicker: "for Claude Code, Codex & any agent",
  headline: "Just yap.",
  subline: "Your agent gets it.",
  lede: "Talk and point at your screen, then paste it to your agent. Or hand it one rough take for people. Yap gives your agent the eyes, ears and hands to get what you meant.",
};

/** The two directions, equal weight: the hotkey loop for agents, polished video for people. */
export const directions = [
  {
    hand: "show",
    title: "your agent",
    body: "Bug reports, design feedback, a pull request reviewed out loud, “watch me do it”. Four keys instead of three paragraphs:",
    items: [
      { title: "Start `⌥⇧S`", body: "Records the display under your pointer. No countdown." },
      {
        title: "Talk and draw `hold ⇧`",
        body: "Shift-click drops a numbered pin. `⌥⇧Z` undoes a mark, `⌥⇧X` cancels.",
      },
      { title: "Finish `⌥⇧S`", body: "The transcript is prepared in the background." },
      {
        title: "Paste `⌥⇧V`",
        body: "A short prompt: the recording, what was captured, your marks and clicks.",
      },
    ],
    fine: "Rebind the keys in Settings. No extra permission; allow Accessibility so `⌥⇧V` can paste for you; otherwise it copies.",
  },
  {
    hand: "show",
    title: "people",
    body: "Demos, team updates, podcasts and talks. One rough take instead of an editor:",
    items: [
      { title: "Record `⌥⇧S`", body: "Same key, or drop in any video you already have." },
      { title: "Ask `⌥⇧V`", body: "Paste, then add “a 60-second demo with captions.”" },
      {
        title: "Review",
        body: "Your agent cuts, captions and cleans up.",
      },
      { title: "Export", body: "Video, audio or captions for where it’s going." },
    ],
    fine: "Originals stay untouched; every edit is a revision you can undo.",
  },
];

export const heroArt = {
  image: "hero.png",
  alt: "A person just yaps and circles a pin on their laptop; Xiaohei, the agent, untangles the rambling, gets it, and turns it into a fix and a great video",
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
  "Here's the checkout bug. Fix the button I pinned.",
  "Watch me do this, then write a script that does it for me.",
  "I drew on the three spacing issues. Fix them in the CSS.",
  "Here's my review of the diff. Address each thing I pointed at.",
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
    body: "Press ⌥⇧S and talk, record from the menu bar, or hand over a video you already have. Paste the prompt or ask in plain words. Your agent reads the transcript, looks at the frames and your pins, listens to the audio, then fixes what you showed, or cuts, captions and exports.",
  },
  {
    image: "02-evidence-not-opinions.png",
    alt: "A toolbox holds the transcript, waveform and frames while Xiaohei, on a stool, marks the cut",
    kicker: "the agent decides",
    title: "Evidence, not opinions",
    body: "Word-timed transcripts, frames, your marks and pins, waveforms, scene and cursor events, loudness. Yap supplies the facts; your agent makes the calls, so the result follows your intent, not a house style.",
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
    body: "Press ⌥⇧S to show your agent something and ⌥⇧V to hand it over, or record and ask for the video you want. Not happy? Say so in one more sentence.",
  },
];

/** Plain-text instructions for agents, served as /llms.txt and shown in the page's agent view. */
export function llmsText() {
  return `# Yap

> Just yap. Your agent gets it. Yap is a free macOS toolkit (a menu-bar app, the \`yap\` CLI and an agent skill) that gives Claude Code, Codex and other agent harnesses the eyes, ears and hands to record, understand and edit video locally. It works in two directions. Show your agent: the user records with a hotkey, talks, draws and drops numbered pins, then pastes a prompt that hands you the recording. Show people: the user hands you a rough take and you make it a polished, captioned video in the right format. Yap has no built-in agent and makes zero editorial decisions: the agent decides, Yap supplies evidence and precise, non-destructive operations, and originals are never touched.

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

- A prompt the user pastes from Yap (⌥⇧V) names a recording ID, what was captured (screen, camera, microphone), and the user's marks, pins and clicks with their times and the window each was on. Every recording and import is transcribed in the background. Explore the recording with the yap CLI as the skill describes, then act on what the user showed you.
- [yap skill](${links.skill}): how to record, understand and edit video for the user with the toolkit. Start a fresh agent session after the app installs it so it is discovered (\`/yap\` in Claude Code, \`$yap\` in Codex).

## Optional

- [README](${links.repo}): what Yap is, the hotkey loop, and what people make with it.
- [Positioning](${links.positioning}): what is possible today, what isn't yet, and how Yap compares with the alternatives.
- [Latest release](${links.releases}): the app kit, its release.json receipt and SHA256SUMS.
`;
}
