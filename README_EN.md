<p align="center">
  <img src=".github/assets/banner.jpg" width="100%" alt="HanaAgent Banner">
</p>

<p align="center">
  <img src=".github/assets/HanaAgent-280.png" width="80" alt="HanaAgent">
</p>

<h1 align="center">HanaAgent</h1>

<p align="center">A personal AI agent with memory and soul</p>

<p align="center"><a href="README.md">中文版</a></p>

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)](https://github.com/Peppermeow29/openhanako)

---

## What is HanaAgent

HanaAgent is a personal AI agent that is easier to use than traditional coding agents. It has memory, personality, and can act autonomously. Multiple agents can work together on your machine.

As an assistant, it is gentle: no complex configuration files, no obscure jargon. HanaAgent is designed not just for coders, but for everyone who works at a computer.
As a tool, it is powerful: it remembers everything you've said, browses the web, searches for information, reads and writes files, executes code, manages schedules, and can even learn new skills on its own.

## Features

**Memory** — A custom memory system that keeps recent events sharp and lets older ones fade naturally.

**Personality** — Not a generic "AI assistant". Each agent has its own voice and behavior through personality templates. Agents are self-contained folders, easy to back up and manage.

**Tools** — Read/write files, run one-shot commands or persistent terminal sessions, browse the web, search the internet through browser-backed or API providers, take screenshots and segmented long screenshots, preview media, and inspect pages. Covers the vast majority of daily work scenarios. A server-first CLI can also attach to the same HanaAgent Server to show status, list sessions, and continue chats from a terminal.

**Skills** — Built-in compatibility with the community Skills ecosystem. Agents can also install skills from GitHub or write their own. Strict safety review enabled by default.

**Character Cards & Skill Bundles** — Export and import agents as local-first character-card zip packages with allowlisted identity, avatar, optional memory, and skills. Skill Bundles are separate skill-pack infrastructure: group skills, drag them between bundles, toggle a whole bundle for an agent, and export a bundle as a standalone zip for migration or sharing.

**Multi-Agent** — Create multiple agents, each with independent memory, personality, and scheduled tasks. Agents can delegate tasks to each other.

**Desk** — Each agent has a desk for files and notes (Jian). Supports drag-and-drop, file preview, and workspace file-tree change watching, serving as an async collaboration space between you and your agent.

**Full-Screen Media Viewer** — Click any image, SVG, or video from chat or the desk to open a dark-overlay viewer with wheel-zoom, drag-to-pan, `+` / `−` / `0` shortcuts, and left/right navigation between sibling media in the same session or folder.

**Session Management** — The sidebar can search chat history, prioritizing title matches and then searching message content. Old sessions can be archived, restored, or permanently deleted from settings. Selecting text in a chat message turns it into a composer quote card so follow-up questions keep the original context.

**Cron & Heartbeat** — Agents can run scheduled tasks and periodically check for file changes on the desk. The current automation executor separates "when to run" from "what to do": complex tasks still run as background Agent sessions, lightweight reminders can send direct notifications, and plugin actions can be scheduled too.

**Sandbox** — Application-level PathGuard with four access tiers and platform command isolation (macOS Seatbelt / Linux Bubblewrap / Windows restricted token). Agent writes and deletes stay limited to the workspace and managed data folders.

**Plugins** — Extensible plugin system with a convention-first architecture. Install community plugins by drag-and-drop. Plugins can contribute tools, skills, commands, agent templates, HTTP routes, Pi SDK extensions, LLM providers, pages, widgets, configuration schemas, and background tasks. Routes have direct access to core services (PluginContext injection) and can interact with agent sessions via the Session Bus; plugin cards flow through the same message-block and history replay pipeline as built-in cards. The two-level permission model (restricted / full-access) keeps advanced surfaces safe: `extensions/`, routes, providers, pages, and lifecycle hooks only load for full-access plugins.

**Multi-Platform Bridge** — A single agent can connect to Feishu and WeChat. Bridge sessions carry platform context, and notifications can be delivered back to the current external platform.

**Mobile & LAN Frontends** — HanaAgent Server can host the `/mobile/` PWA. Phones can sign in with a device access key or local account, view sessions, chat, and manage workbench files. Another desktop frontend can also connect to an existing LAN HanaAgent Server with a LAN URL and access key.

**i18n** — Interface available in 5 languages: Chinese, English, Japanese, Korean, and Traditional Chinese.

## Screenshots

<p align="center">
  <img src=".github/assets/screenshot-main.jpg" width="100%" alt="HanaAgent Main Interface">
</p>

## Quick Start

### Run From Source

This project is shared as GitHub source only. It does not provide DMG files, installers, or an auto-update service. You need Node.js 24.12+ and npm:

```bash
git clone https://github.com/Peppermeow29/openhanako.git
cd openhanako
npm install
npm start
```

### First Run

On first launch, an onboarding wizard will guide you through setup: choose a language, enter your name, connect a model provider (API key + base URL), and select three models — a **chat model** (main conversation), a **utility model** (lightweight tasks), and a **utility large model** (memory compilation and deep analysis). In settings you can also choose a **vision model** that lets text-only chat models work with image attachments through Vision Bridge. HanaAgent supports OpenAI-compatible providers, Anthropic-style providers, OAuth providers, and local models via Ollama.

### Use the MiniCPM5 local model

MiniCPM5 weights are not bundled with this repository. They must be downloaded separately, and the current MLX launcher supports Apple Silicon macOS only.

```bash
npm run minicpm:setup
```

This installs the Python dependencies. If no model is detected, put `MiniCPM5-2B-MLX-8-bit/` (or the 4-bit variant) beside the repository, or set `MINICPM5_MODEL_ROOT` to a folder containing that checkpoint directory. Download the checkpoint from Hugging Face's `openbmb` MiniCPM5 MLX models. `MINICPM5_MODEL_PATH` can also point directly to any checkpoint directory.

Launch the app and select **MiniCPM5-2B (MLX local)**; the runtime automatically starts `npm run minicpm:server` and serves inference at `127.0.0.1:8080`. Keep the default `edge` profile on 16 GB Apple Silicon machines; other machines can tune `MINICPM5_MEMORY_PROFILE`. On Windows/Linux, use Ollama or an OpenAI-compatible local server instead.

## Architecture

```
core/           Engine orchestration + Managers (including PluginManager)
lib/            Core libraries (memory, tools, sandbox, bridge adapters)
server/         Hono HTTP + WebSocket server (standalone Node.js process)
hub/            Scheduler, EventBus
desktop/        Electron app + React frontend
shared/         Cross-layer utilities (config schema, error bus, model refs)
plugins/        Built-in system plugins (bundled into app)
skills2set/     Built-in skill definitions
scripts/        Source build, launch, and test tools
tests/          Vitest test suite
```

The engine layer coordinates multiple managers (Agent, Session, Model, Preferences, Skill, BridgeSession, Plugin, etc.) and exposes them through a unified facade. The Hub handles background tasks (heartbeat, automation / cron, and agent messaging) independently of the active chat session.

User-visible files inside a session are registered through `SessionFile` sidecars. Desktop, Bridge, Mobile PWA, and other remote frontends consume the same file identity according to their own capabilities. Each Bridge adapter explicitly declares its supported media kinds, delivery modes, and size limits; plugin file contribution rules live in `PLUGINS.md`.

Local staged files are uploaded directly by platform adapters when possible: Telegram / Feishu / WeChat use their native upload flows, and QQ uses the official bot chunked-upload flow before sending `msg_type: 7` rich media. `preferences.bridge.mediaPublicBaseUrl` / `HANA_BRIDGE_PUBLIC_BASE_URL` are only for consumers or fallback paths that still require an internet-reachable URL.

The server runs as a standalone Node.js process (spawned by Electron or independently), bundled via Vite with @vercel/nft for dependency tracing. It communicates with the Electron renderer through WebSocket.
User data is rooted at `HANA_HOME` (`~/.hanako` in production, `~/.hanako-dev` in development). Hana-managed Pi SDK runtime resources live under `${HANA_HOME}/runtime/pi-sdk/`; Hana does not rely on Pi's global agent directory or `PI_CODING_AGENT_DIR`. Legacy `fd` / `rg` binaries under `${HANA_HOME}/.pi/agent/bin/` are copied into the new directory on first use of the corresponding search tool, while the legacy files remain untouched.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 42 |
| Frontend | React 19 + Zustand 5 + CSS Modules |
| Build | Vite 7 |
| Server | Hono + @hono/node-server |
| Agent Runtime | [Pi SDK](https://github.com/badlogic/pi-mono) |
| Database | better-sqlite3 (WAL mode) |
| Testing | Vitest |
| i18n | 5 languages (zh / en / ja / ko / zh-TW) |

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Source development supported |
| macOS (Intel) | Supported |
| Windows | Beta |
| Linux | Source development supported |
| Mobile (PWA) | v0: phone sessions and workbench access through the same HanaAgent Server |

## Development

```bash
# Install dependencies
npm install

# Start with Electron (builds renderer first)
npm start

# Start with Vite HMR (run npm run dev:renderer first)
npm run start:vite

# Server only
npm run server

# Server-first CLI
npm run cli

# Run tests
npm test

# Type check
npm run typecheck
```

## Acknowledgments

- [tw93/kami](https://github.com/tw93/kami): the progressive-disclosure structure of the beautify plugin's HTML aesthetic guide (a router entry with flat on-demand sections) was inspired by this project.

## License

[Apache License 2.0](LICENSE)

## Links

- [Homepage](https://openhanako.com)
- [Report an Issue](https://github.com/Peppermeow29/openhanako/issues)
- [Security](https://github.com/Peppermeow29/openhanako/security)
- [Security Policy](SECURITY.md)
- [Plugin Development](PLUGINS.md)
- [Contributing](CONTRIBUTING.md)
