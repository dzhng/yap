# Telemetry

Yap collects minimal, anonymous telemetry to understand how many people download
and install the app. This page explains exactly what is collected, why, and how
to opt out.

## What is collected

### Download tracking (website)

When you download Yap through `justyap.io/api/download`, the server logs:

- **Timestamp** of the download
- **Source** parameter (e.g. "site" for website clicks)
- **User agent category** (browser vs agent, not the full string)

No IP addresses or personal information are stored. The redirect happens
immediately; no tracking pixels or cookies are used.

### Install tracking (app)

On first launch, the Yap app sends a single anonymous ping to
`justyap.io/api/install` containing:

- **Install ID**: A random UUID generated locally (e.g.
  `a1b2c3d4-e5f6-7890-abcd-ef1234567890`). This ID has no connection to your
  identity, hardware, or Apple account.
- **Version**: The app version number (e.g. "1.0.0")
- **Platform**: Always "macos"

This ping is sent exactly once, on first launch. It is not sent again on
subsequent launches, updates, or reinstalls on the same machine (the install ID
persists in preferences).

## What is NOT collected

- Your name, email, or Apple ID
- Your IP address (not logged server-side)
- Your Mac's hardware identifiers (serial number, MAC address, etc.)
- Any recording content, transcripts, or project files
- Usage patterns, feature usage, or crash reports
- Any data that could identify you personally

## Why we collect this

David (the developer) uses these counts to understand:

1. How many people visit the site and download Yap
2. How many actually install and launch the app

This helps prioritize development and understand where to focus effort. That's
it—no advertising, no analytics beyond these two numbers.

## How to opt out

### Disable install telemetry

Set the environment variable before launching Yap:

```sh
export YAP_NO_TELEMETRY=1
open /Applications/Yap.app
```

Or add to your shell profile (`~/.zshrc` or `~/.bashrc`):

```sh
export YAP_NO_TELEMETRY=1
```

When this variable is set, the app skips the first-launch ping entirely.

### Download without tracking

Download directly from GitHub Releases instead of the website:

```sh
curl -LO https://github.com/dzhng/yap/releases/latest/download/Yap-macos-arm64.zip
```

This bypasses the tracking redirect entirely.

## Data retention

- Download logs: Kept for 90 days, then deleted
- Install IDs: Stored only to deduplicate pings, not for tracking

## Source code

The telemetry implementation is fully open source:

- **App telemetry**: `apps/macos/Sources/Yap/Telemetry.swift`
- **Website tracking**: `apps/site/api/download.js`, `apps/site/api/install.js`

Review the code to verify these claims.

## Questions

Open an issue on [GitHub](https://github.com/dzhng/yap/issues) if you have
questions about telemetry.
