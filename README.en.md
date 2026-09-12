# WebAgents

**[中文](README.md) | English**

Turn **web-based chat UIs** (DeepSeek, Qwen/Tongyi, ...) into your subagents: an Edge extension + an MCP bridge that lets MCP-capable AI clients (Claude / Trae / ...) inject prompts into these web pages and harvest replies — with **parallel dispatch** across sites.

> Reuses your existing browser login sessions. No API keys, no protocol reverse-engineering.

## Architecture

```text
MCP Client (Claude / Trae / ...)
   ↕ stdio (MCP protocol)
server/index.mjs — MCP server + server/bridge.mjs — WebSocket bridge (ws://127.0.0.1:8765)
   ↕ WebSocket (token auth)
Edge extension background.js — task routing / tab pool / state polling
   ├─ chat.deepseek.com  persistent pinned tab (content/deepseek.js)
   └─ www.qianwen.com    persistent pinned tab (content/qwen.js)
```

## Features

- **MCP tools**:
  - `deepseek(prompt, options?)` — ask DeepSeek, return the reply
  - `qwen(prompt, options?)` — ask Qwen, return the reply
  - `probe(site)` — dump page DOM structure (input/send-button/mode toggles) for recalibration after site redesigns
  - `fleet_status()` — extension connection status & version
- **Conversation switches** (optional per call):
  - DeepSeek: `{ deepThink: true/false, search: true/false }`
  - Qwen: `{ mode: "fast" | "think" }`
- **Toolbar popup**: set the switches above as **enforced defaults** (they override caller-provided options); "default" = leave the page as-is
- **Parallel dispatch**: calls to different sites run concurrently in separate tabs

## Reliability

- Two-phase ask: the page only injects + sends (tolerates full-page navigation); the service worker polls page state every 1.5s until the reply stabilizes
- Completion detection: text stable for 0.8s + 0.5s re-confirm → typically returns within 1.3–2.8s of the final token
- Fresh-session guard: double check (URL + no leftover replies) before each ask, so stale answers are never returned
- 15s grace polling if sending fails; at the 170s hard timeout, partial text is still returned
- Tab sleeping disabled (`autoDiscardable: false`)
- Adaptive text injection (paste event first, per-char fallback, content verification against duplication)

## Install

### 1. Load the Edge extension

1. Open `edge://extensions`, enable **Developer mode** (bottom left)
2. **Load unpacked** → select the `extension/` folder of this repo
3. Open `chat.deepseek.com` and `www.qianwen.com` and log in
4. (Optional) Pin the WebAgents toolbar icon to configure default switches via the popup

### 2. Register the MCP server

Add to your MCP client config (e.g. Trae's `mcp.json`):

```json
{
  "mcpServers": {
    "webagents": {
      "command": "node",
      "args": ["<repo path>/server/index.mjs"]
    }
  }
}
```

The only dependency is `ws` — run `npm install` inside `server/` once.

### 3. Use it

Restart your MCP client and call the `deepseek` / `qwen` tools. Dedicated pinned tabs are created/reused automatically.

## Directory Layout

```text
webagents-mcp/
├── extension/            # Edge extension (MV3)
│   ├── manifest.json
│   ├── background.js     # SW: WS client, task routing, state polling, CDP fallback
│   ├── content/
│   │   ├── common.js     # shared helpers (txt, sleep, ...)
│   │   ├── deepseek.js   # DeepSeek adapter (inject/send/harvest/switches)
│   │   └── qwen.js       # Qwen adapter (contenteditable inject/mode switch/harvest)
│   ├── popup.html/js     # toolbar popup: enforced switch defaults
│   └── options.html/js   # full settings page (shares logic with popup)
├── server/
│   ├── index.mjs         # MCP stdio server (tool definitions & dispatch)
│   ├── bridge.mjs        # WebSocket bridge (127.0.0.1:8765, token auth)
│   └── package.json
└── test-client.mjs       # standalone WS test client (tests the extension without MCP)
```

## Adding a new site

Copy the adapter template in `content/qwen.js`, implement `ask` (inject/send/harvest) and optionally `setOptions`, then register the `content_scripts` match, `host_permissions`, and the `SITES` entry in `background.js`. After a site redesign, use the `probe` tool to inspect the live DOM and recalibrate selectors.

## Caveats

- Automating the web UI may trigger anti-abuse systems — space out requests and respect each site's terms of service
- Frontend redesigns can break selectors; diagnose with `probe` and patch the adapter
- Intended for local personal automation only

## License

MIT
