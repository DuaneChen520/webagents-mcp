# WebAgents

**[中文](README.md) | English**

Turn **web-based AI chats** like DeepSeek / Qwen (通义千问) into your subagents: an Edge extension plus an MCP bridge that lets MCP-capable AI clients (Claude, Trae, …) inject prompts into these web pages, capture the replies, and even **dispatch tasks to multiple sites in parallel**.

> Reuses the login sessions already in your browser. No API keys, no protocol reverse-engineering.

## Architecture

```text
MCP client (Claude / Trae / ...)
   ↕ stdio (MCP protocol)
server/index.mjs — MCP server + server/bridge.mjs — WebSocket bridge (ws://127.0.0.1:8765)
   ↕ WebSocket (random token auth + Origin check)
Edge extension offscreen.js — persistent WS connection (lifetime independent of the service worker)
   ↕ chrome.runtime messages
Edge extension background.js — task routing / per-site queue / completion detection
   ├─ chat.deepseek.com  persistent pinned tab (content/deepseek.js)
   └─ www.qianwen.com    persistent pinned tab (content/qwen.js)

Each site page also hosts a main-world stream probe (content/stream-probe.js):
it intercepts response streams, providing the "server closed the stream" hard
completion signal plus the raw markdown.
```

> Why the connection lives in an offscreen document: an MV3 service worker gets
> terminated after ~30s idle, and the WebSocket it holds dies with it — so
> "extension online" becomes uncertain. An offscreen document's lifetime is
> independent of the SW (no time limit except for audio), so the connection can
> stay up while the SW sleeps and wakes on demand.

## Features

- **MCP tools**:
  - `deepseek(prompt, options?)` — ask DeepSeek, get the reply
  - `qwen(prompt, options?)` — ask Qwen, get the reply
  - `probe(site)` — inspect page DOM (input box / send button / mode toggles) for recalibrating after site redesigns. **Navigates the tab back to the homepage first (full reload)**
  - `inspect(site)` — **read-only view of the current page, no navigation or reload**. Use it to see a CAPTCHA scene, the answer area, and the stream probe records (which `probe` would destroy by reloading)
  - `fleet_status()` — extension connection status (transport type + per-site queue depth)
  - `recent_runs(limit?, site?, onlyErrors?)` — read the run log; **first stop for troubleshooting**: no need to re-run a question
- **Chat toggles** (optional per call):
  - DeepSeek: `{ deepThink: true/false, search: true/false }`
  - Qwen: `{ mode: "fast" | "think" }`
- **Toolbar popup**: pin the toggles as **forced defaults** (override call arguments); "default" = leave the page state untouched
- **Parallel dispatch**: calls to different sites run concurrently in independent tabs

## Security

- **The bridge token is no longer hardcoded** (the old version shipped `webagents-local`, which meant no auth at all).
  Resolution order: `WEBAGENTS_TOKEN` env var → `bridge.json` in the user data dir (randomly generated) → generated on first run.
  Location: Windows `%LOCALAPPDATA%\webagents\bridge.json`, other platforms `~/.local/share/webagents/bridge.json`.
- **Extension pairing (TOFU)**: on first connect the extension has no token; the bridge verifies its origin and hands the token over.
  The extension stores it in `chrome.storage.local` and only accepts the token afterwards. If the storage is cleared it re-pairs automatically (same extension origin only).
- **Origin check**: any connection carrying an `Origin` other than `chrome-extension://` is rejected —
  this blocks "open a web page in the browser to drive the local bridge".
- **Honest residual-risk note**: the token file belongs to the same OS user as a potential malicious process, so it can be read.
  This layer stops "incidental local programs" and "web pages", not "malware already running as you".

## CAPTCHA (slider) handling

Sites occasionally pop a slider CAPTCHA (Qwen uses **Alibaba Baxia** risk control, SDK domain `sec.qianwen.com`). The core problem is **it pops where you can't see it** —
our site tab is a background tab (`active:false`), so the symptom is "the task silently stalls until timeout" instead of "please slide".

The approach is to **turn the invisible wait into a visible one** — never bypassing the site's risk control:

1. **Detection**: on every state poll the content script checks multiple signals for a *visible* challenge component (reasonable size, not hidden).
   Loading the risk-control SDK alone does **not** count (it happens on every page load; a false positive would interrupt every normal ask) — it is only reported as context.
2. **Bring to front**: on a hit, the tab (and its window) is brought to the foreground and the result explicitly says
   `⚠ the site requires manual verification: … (tab brought to front)`. Once you finish the CAPTCHA the task **continues automatically — no re-dispatch needed**.
3. **Extended budget**: detecting a challenge extends the wait budget (`CAPTCHA_WAIT_MS`), otherwise "the site is waiting for you to slide" would be reported as a timeout failure.
4. **Adaptive cooldown** (reduces recurrence): after a hit, that site's call interval is automatically extended
   (+5s per hit, cap 60s, auto-recovers after 30 clean minutes) and the result notes `adaptive cooldown +Ns`. Note this only lowers the probability; it does **not** resolve an already-shown CAPTCHA.

> Explicitly out of scope: dragging the slider automatically via the debugger channel. Risk control looks at
> trajectories and fingerprints, not just event trust; automated CAPTCHA solving raises the odds of account
> flagging, which conflicts with this project's "minimal risk-control footprint" principle.

## Run log

Every tool call and bridge event is appended to `runs.jsonl` (same directory as the token file), readable via `recent_runs`:

```text
2026/9/15 01:48:27  [bridge] listening on ws://127.0.0.1:8765 (token source=generated)
2026/9/15 01:48:52  deepseek "explain closures in one sentence"  ok | 8.4s | text=stream | md=142/dom=65
```

Recorded fields: duration, queue/throttle waits, text source and length, site terminal status, failure stage, on-the-spot diagnostics.
Previously, troubleshooting meant "run it again and watch"; now most questions can be answered from history.

## Reliability design

**Completion detection (two tiers, since v8)**

- **① Primary signal: main-world stream probe** (`content/stream-probe.js`). A site's "reply finished" is definite — but it exists only in the network response stream (not in the DOM, not in the console), so the extension hooks response streams from the main world *before* the page loads and uses **"the server closed the response stream"** as the protocol-level hard completion signal. It also reads the site's self-reported terminal status (DeepSeek `MessageStatus`: `FINISHED` / `INCOMPLETE` / `CONTENT_FILTER` / `CONTEXT_LENGTH_EXCEEDED` / `TIMEOUT`).
  **Non-`FINISHED` terminal states are returned together with the result and called out explicitly**, preventing the silent error of "a truncated answer treated as complete".
- **② Fallback**: when the probe is unavailable, the original logic applies — the SW polls every **600ms**; text stable for **400ms** plus a **300ms** re-check means done.
- **Text source**: when a stream can be reconstructed, the **raw markdown** is preferred (code blocks / tables / formulas preserved).
  When it can't (e.g. Qwen — its answer data never passes through any hooked channel), we fall back to the page: the **DOM→markdown serializer**
  (`content/dom-md.js`) converts the rendered result back into markdown — tables become pipe tables, code blocks become fenced blocks, toolbars/line numbers are stripped.
  It relies only on a minimal DOM interface, is site-agnostic, and can be unit-tested offline. As a last resort, `innerText` is used. Results are annotated with the source (stream / dom-md / dom).

**Concurrency & stability (since v8)**

- **Per-site serial queue**: each site runs one task at a time. Each site has a single persistent tab; concurrent calls would overwrite each other's input, fight over the same completion detection, and navigate the page away from each other — so **same-site calls queue up automatically** while cross-site calls stay parallel.
- **Queueing is not infinite waiting**: if a predecessor task hangs, a queued caller errors out after at most 4 minutes (never silent). `fleet_status` reports per-site queue depth.
- **Call throttling**: a minimum interval between asks on the same site (default 3s, adjustable/disable in the extension options) to reduce risk-control probability. **It only waits when the previous call ended within the interval** — normal pacing feels nothing; when a wait happens, the result states the actual duration.
- **Fast-fail on disconnect**: browser closed / extension unloaded / service worker recycled — the local bridge **immediately** fails all in-flight requests (measured 3ms) instead of letting callers wait for a timeout.

**Other reliability details**

- Two-phase ask: the page only injects + sends (tolerating full-page navigation)
- Staged send verification: injection read-back compare (3s × 2) → send-equivalence signal (8s); every stage fails fast, never silently retried
- Homepage reposition double-check (URL exactly equal + no residual answer blocks), so a previous conversation's reply is never mistaken for the current one
- First-signal window: no sign of life after send → `no_site_feedback`. **Two tiers based on whether the send was confirmed** — with ack confirmed (injection read-back + send check passed) a lenient 25s applies, because "slow" ≠ "not sent" (with web search on, the first token can land after 12s); only when the ack was lost — genuinely unable to tell — does the strict per-site window apply (DeepSeek 12s / Qwen 30s). The **170s hard timeout** still returns the partial text generated so far
- Tab anti-sleep (`autoDiscardable: false`) + discarded-tab wake-up + programmatic re-injection
- Adaptive injection: textarea via native setter; contenteditable via explicit selection + `execCommand insertText` (paste as the only fallback), with 3 rounds of hydration-remount self-healing

## Install

### 1. Load the Edge extension

1. Open `edge://extensions`, enable "Developer mode" (bottom left)
2. "Load unpacked" → select the `extension/` directory of this repo
3. Open `chat.deepseek.com` and `www.qianwen.com` and sign in
4. (Optional) pin the WebAgents toolbar icon to configure default chat toggles

### 2. Register the MCP server

Add to your MCP client's config file (e.g. Trae's `mcp.json`):

```json
{
  "mcpServers": {
    "webagents": {
      "command": "node",
      "args": ["<path-to-this-repo>/server/index.mjs"]
    }
  }
}
```

`server/` depends only on `ws`; run `npm install` in that directory before first use.

### 3. Use

Restart your MCP client and call the `deepseek` / `qwen` tools. The extension automatically creates/reuses the persistent tab for the target site in Edge.

## Repository layout

```text
webagents-mcp/
├── extension/            # Edge extension (MV3)
│   ├── manifest.json
│   ├── background.js     # SW: task routing, per-site queue, completion detection, debugger fallback (holds no connection)
│   ├── content/
│   │   ├── common.js     # shared utils + probe bridge + ask/probe logic
│   │   ├── stream-parse.js  # stream delta parsing (pure functions, node-testable)
│   │   ├── stream-probe.js  # main-world stream probe (completion hard signal + raw markdown)
│   │   ├── dom-md.js     # DOM→markdown serializer (faithful extraction of rendered answers)
│   │   ├── deepseek.js   # DeepSeek adapter (inject/send/capture/toggles)
│   │   └── qwen.js       # Qwen adapter (contenteditable inject/mode switch/capture)
│   ├── offscreen.html/js # persistent WS connection (lifetime independent of the SW)
│   ├── popup.html/js     # toolbar popup: forced toggle defaults
│   └── options.html/js   # full options page (shared logic with popup)
├── server/
│   ├── index.mjs         # MCP stdio server (tool definitions & dispatch + run log)
│   ├── bridge.mjs        # WebSocket bridge (127.0.0.1:8765, token auth + Origin check)
│   ├── store.mjs         # local state: bridge token + run log (in the user dir, not in the repo)
│   └── package.json
├── test-client.mjs       # standalone test client (status / ask / probe / runs)
├── test-stream-parse.mjs # stream parsing unit tests
├── test-stream-probe.mjs # stream probe integration tests (fake XHR + fake fetch + fake WebSocket)
├── test-scheduling.mjs   # per-site serial queue + first-signal budget
├── test-bridge-failfast.mjs   # bridge fast-fail on disconnect (real process + real WS)
├── test-bridge-auth.mjs  # bridge auth & pairing (token / Origin / TOFU)
├── test-offscreen.mjs    # offscreen connection behavior (fake chrome + fake WebSocket)
└── test-concurrent-asks.mjs   # same-site concurrency verification (needs the extension online)
```

## Adding a new site

Copy the adapter template in `content/qwen.js`, implement `ask` (inject/send/capture) and the optional `setOptions` hook, add `content_scripts` match rules and `host_permissions` to `manifest.json`, and register the site in `SITES` in `background.js`. After a site redesign, use the `probe` tool to inspect the DOM and recalibrate selectors.

The stream probe is site-agnostic: as long as a site streams over SSE / fetch streams / XHR, `content/stream-probe.js` catches it — no per-site changes needed. Two conditions qualify a response as a stream: the `text/event-stream` content type, **or** a body that looks like SSE frames (`event:` lines / `data:{...}` lines) —
the latter was added for Qwen, whose `fetch` accept list includes `text/plain` and wildcards and which never validates the content-type before reading the body.

Three payload shapes are supported: `data:{...}` (direct object), **`data:"{...}"` (payload is an encoded JSON string — unwrap one more layer; observed on Qwen)**,
and `data:[DONE]` (protocol-level end). Bare-string payloads are only recorded as diagnostic samples, never merged into the answer (site streams can carry risk-control telemetry).
The probe counts frames per shape (`frames`) and includes the stats in failure diagnostics — one real run tells you which shape a site switched to.

Terminal-state detection covers two sources: status fields in the payload (`STATUS_KEYS`) and **named SSE events**
(`complete` / `finish` / `done` → normal end, `audit` / `security` → content blocked, `error` → incomplete).
For new sites with different event names, extend the regexes like `TERMINAL_EVENTS` in `content/stream-parse.js`.
Fragment recognition accepts both `type` and `mimeType` field names.

## Tests

```bash
node test-stream-parse.mjs     # stream parsing: SSE frames, envelope semantics, named-event terminals, cards, JSON-string payloads (94)
node test-stream-probe.mjs     # stream probe: fake XHR + fake fetch + fake WebSocket drivers (45)
node test-scheduling.mjs       # per-site serial queue + first-signal budget (19)
node test-bridge-failfast.mjs  # bridge two-phase disconnect handling: jitter survival / grace expiry (14)
node test-bridge-auth.mjs      # bridge auth & pairing: token / Origin / TOFU (20)
node test-offscreen.mjs        # offscreen connection behavior: fake chrome + fake WS (31)
node test-dom-md.mjs           # DOM→markdown serializer: tables/code/lists/decor stripping (29)
node test-concurrent-asks.mjs  # same-site concurrency: needs the extension online, hits real sites
```

The first seven are offline tests covering the parts most error-prone and hardest to reproduce in a browser
(protocol parsing, cross-world wiring, concurrent scheduling, connection lifecycles, auth).
Run them after touching `stream-parse.js` / `stream-probe.js` / `background.js` / `bridge.mjs` / `offscreen.js`.

The last one requires the extension loaded and signed in; it asks two real questions to verify "same-site concurrency doesn't cross-talk".

## Notes

- Automating web chats carries account risk-control risk; keep intervals between tasks and respect each site's terms of service
- Site redesigns can break selectors; diagnose with `probe` and update the adapter
- The stream probe needs MV3 **main-world content scripts** (`world: "MAIN"`), i.e. Chrome / Edge **116+** (declared via `minimum_chrome_version`).
  Check `probe`'s `stream.probeWorld`: `main` = active, `isolated` = not (completion detection automatically falls back to DOM heuristics; nothing breaks)
- **Upgrading to 0.4.0**: the bridge token is now randomly generated, so the extension re-pairs once.
  After reloading the extension it connects once without a token; the bridge verifies the origin and hands the token down — **no manual steps**.
  Note that a running MCP session still holds the old server (hardcoded token) and **needs a restart** to reach the new bridge.
- The `debugger` permission changed from always-on to **optional**. To be honest: neither site currently needs it
  (Qwen uses `execCommand insertText`, DeepSeek the native setter); it is kept as a fallback only. Grant it from the options page if ever needed.
- After changing extension code or `manifest.json`, **reload the extension** in `edge://extensions`
- Completion detection is a two-tier design: "site self-reported terminal / DOM completion marker (e.g. Qwen's `qk-markdown-complete`) first, text stability as fallback"; text prefers raw markdown (stream path) or DOM reconstruction (dom-md serializer)
- For local personal automation only

## License

MIT
