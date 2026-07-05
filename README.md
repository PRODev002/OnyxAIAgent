<div align="center">
  <img src="icons/icon128.png" alt="Onyx AI Agent Logo" width="120"/>
  <h1>Onyx AI Agent</h1>
  <p><strong>Your browser, now an autonomous agent.</strong> Describe any task in plain English — Onyx analyzes the DOM, plans a sequence of actions, and executes them directly in the page, from clicking buttons to filling forms to navigating across tabs.</p>

  <p>
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">
    <img src="https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg" alt="License: CC BY-NC-SA 4.0">
    <img src="https://img.shields.io/badge/Manifest-V3-orange.svg" alt="Chrome MV3">
  </p>
</div>

---

> 🎥 **[INSERT LOOM/GIF LINK HERE]** *(Show the agent navigating the DOM or executing a task automatically!)*

---

## Key Features

- **Smart DOM Analysis (Set-of-Mark)** — Instead of dumping raw HTML to the LLM, Onyx runs an intelligent extraction layer (`content.js`) that filters static noise, scores elements by viewport visibility and interactivity, and maps the top 200 interactive elements to numeric IDs. Shadow DOM traversal included.

- **Autonomous Multi-Step Execution** — Onyx operates as a multi-turn agent loop: analyze page → plan action → execute → observe result → repeat. Supports `click`, `type`, `scroll`, `select`, `hover`, `read`, `navigate`, `drag_and_drop`, `press_keys`, `click_coordinate`, `copy_to_clipboard`, `open_tab`, `switch_tab`, `close_tab`, `wait`, `request_permission`, `save_macro`, `search_memory`, and `done` — with auto-retry and exponential backoff on transient failures.

- **Multi-Tab Orchestration** — Spawn background tabs, switch focus between them, read content across pages, and close tabs when done — all without leaving your current window.

- **Multi-Provider LLM Support** — Connect to Groq, OpenRouter, Gemini, or any self-hosted OpenAI-compatible endpoint (Ollama, vLLM, LocalTunnel, Ngrok). Vision-enabled providers (OpenRouter, Gemini) receive live screenshots alongside DOM state for layout-aware reasoning.

- **Human-in-the-Loop Safety** — Sensitive actions (purchases, deletions, financial transactions) trigger a permission modal requiring explicit user approval. Three safety modes: Relaxed, Moderate, and Strict. Sensitive pages (banking, checkout, billing) are auto-detected.

- **Persistent Memory & Macros** — Cross-session memory stores page context for future recall (up to 500 entries, keyword-searchable). Record successful task sequences as reusable macros for instant replay.

- **Visual Agent Feedback** — A phantom cursor animates across the page showing exactly where the agent is interacting. A pulsing blue aura frames the viewport during execution. Targeted elements flash with a glow highlight before being clicked or typed into.

- **Smart Input Handling** — Bypasses React, Vue, and Angular's synthetic event systems using native property setters. Handles rich text editors (Slate.js, ProseMirror, Draft.js) via paste simulation and `beforeinput` event dispatch.

- **Chat Persistence** — Conversations auto-save with date-based grouping (Today, Yesterday, This Week, Older). Configurable retention period (1–30 days) with automatic purge of old sessions.

---

## Quick Start

1. **Clone the Repo:**
   ```bash
   git clone https://github.com/your-username/OnyxAIAgent.git
   ```

2. **Load in Chrome:**
   - Open `chrome://extensions/` (or `edge://extensions/` for Edge)
   - Toggle **Developer mode** in the top right
   - Click **Load unpacked** in the top left
   - Select the cloned project folder

3. **Pin the Extension:**
   The Onyx icon will appear in your extensions bar. Pin it for quick access.

4. **Configure Your Provider:**
   - Click the Onyx icon to open the side panel
   - Select your LLM provider (Groq, OpenRouter, Gemini, or Self-Hosted)
   - Enter your API key (or base URL for self-hosted)
   - Select a model and click **Connect Agent**

---

## Architecture & Tech Stack

**Built with vanilla HTML/CSS/JS** — no build tools, no frameworks, no bundlers. Just three files that talk to each other through Chrome's extension messaging system.

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 definition. Declares permissions, side panel, service worker, and icon set. |
| `sidepanel.html/css/js` | The UI state machine. Manages onboarding, chat with collapsible reasoning blocks, history, macros, settings, and the HITL permission modal. Communicates with the background via long-lived `chrome.runtime.connect()` ports. Includes a heartbeat ping every 20s to keep the MV3 service worker alive during long agent runs. |
| `background.js` | The core agent loop engine. Coordinates multi-turn LLM calls, parses structured JSON responses, dispatches actions to content scripts, handles CDP native mouse/keyboard events, manages chat persistence, macro storage, persistent memory, screenshot capture for vision models, and auto-retry with exponential backoff. |
| `content.js` | Injected dynamically into active tabs. Extracts interactive DOM elements into a Set-of-Mark representation, executes actions, renders the phantom cursor and aura visuals, highlights targeted elements, handles rich text editor paste simulation, and detects sensitive pages (banking, checkout). |

**Communication flow:**
```
Side Panel ←port→ Background Service Worker ←chrome.tabs.sendMessage→ Content Script
                                        ↑
                                Chrome DevTools Protocol (CDP)
                            (native mouse/keyboard events for
                             anti-bot-detection bypass)
```

**Key Chrome APIs used:** `tabs`, `scripting`, `storage`, `debugger` (CDP), `sidePanel`, `notifications`

---

## Supported Providers

| Provider | Auth | Notes |
|---|---|---|
| **Groq** | API Key | Ultra-fast inference. Recommended: `llama-3.3-70b-versatile` |
| **OpenRouter** | API Key | Access 200+ models via unified API. Vision support for screenshots. |
| **Gemini** | API Key | Google's free tier. Vision support. Recommended: `gemini-1.5-pro` |
| **Self-Hosted** | Base URL | Any OpenAI-compatible endpoint (Ollama, vLLM, LocalTunnel, Ngrok). Use 32B+ param models for reliable instruction following. |

---

## Usage Examples

Open the side panel and try these commands against any live web page:

**Navigation:**
> *"Click the first news article on this page"*

**Automated Research:**
> *"Open a new tab to wikipedia.org, search for 'Quantum Computing', summarize the intro, and close the tab"*

**Form Automation:**
> *"Fill out this contact form with the name John Doe, email john@test.com, and request a demo"*

**Data Extraction:**
> *"Read the table on this page, find the highest selling item, and copy the product name to my clipboard"*

---

## Privacy & Security

- **No telemetry.** No analytics. No middle-man servers.
- API keys are stored only in `chrome.storage.local` — they never leave your device except in direct calls to your chosen provider.
- Fully offline capable: point it to a `localhost:11434` Ollama instance and no data touches the public web.
- Anti-prompt-injection hardening in the system prompt — page content is treated as data, never instructions.
- Password fields are refuse-only; sensitive actions require explicit human approval.
- Sensitive pages (banking, checkout, billing, credit cards) are auto-detected and flagged.

---

## License

[CC BY-NC-SA 4.0](LICENSE) — Free for personal and educational use with attribution. Commercial use is prohibited. Derivative works must use the same license.

---

<div align="center">
  <i>"The browser, reimagined as an autonomous workspace."</i>
</div>
