# WebAgents

**[中文](README.md) | English**

Turn **web-based AI chats** like DeepSeek and Qwen (通义千问) into your subagents: an Edge extension, a local WebSocket bridge, and a set of command-line primitives that let an AI agent (a skill, a script, or you) inject prompts into those pages and capture the replies — including **dispatching tasks to several sites in parallel**.

> Reuses the sessions already logged in in your browser. No API keys, no reverse-engineered protocol.

The Chinese README is the authoritative one; this file is kept in sync with it.

## Architecture

```text
caller: agent skill / playbook / script / human
   ↓ process call (one summary line on stdout, the answer goes to a file)
server/cli.mjs — CLI primitives (ask / runs / inspect / status / doctor / bridge)
   ↕ WebSocket (random token auth + Origin check + application-level heartbeat)
server/bridge.mjs — the single bridge (ws://127.0.0.1:8765)
   ↕ chrome.runtime messages
Edge extension offscreen.js — the persistent WS connection (lifetime independent of the SW)
Edge extension background.js — routing / per-site queue / completion detection
   ├─ chat.deepseek.com  persistent pinned tab (content/deepseek.js)
   └─ www.qianwen.com    persistent pinned tab (content/qwen.js)

Each page also runs a main-world stream probe (content/stream-probe.js):
it hooks the response stream, which yields the hard "the server closed the stream"
completion signal plus the original markdown
```

> Why the connection lives in an offscreen document: an MV3 Service Worker is recycled
> after 30s idle, and its WebSocket dies with it — which makes "the extension is online"
> uncertain. An offscreen document has a lifetime of its own (no time limit except for
> audio playback), so the connection simply stays up and the SW can sleep until a request wakes it.

## Features

- **CLI primitives** (the only entry point; the MCP tool surface was removed in 0.7.0):
  - `ask <site> "prompt"` — asks a question, writes the answer to a file, prints one summary line; see `--attach` / `--prompt-file` / `--continue` / `--schema` below
  - `inspect <site>` — **read-only view of the current page: no navigation, no reload**. Use it to see a CAPTCHA scene, the answer area, and the stream probe records
  - `runs` — read the run log; **first stop for troubleshooting**, no need to re-ask (`--errors` / `--why last` / `--dedupe`)
  - `status` — extension connection state (what carries the connection, per-site queue depth)
  - `doctor` — one-shot health check: version alignment / token pairing / bridge / extension / whether both site adapters actually answer / failure patterns in the last 24h
  - `bridge start|stop` — keep the bridge resident and tear it down explicitly (one shared connection for a long job)
- **Conversation toggles** (pass per call with `--think/--search/--mode`, or set defaults on the extension options page):
  - DeepSeek: `{ deepThink: true/false, search: true/false }`
  - Qwen: `{ mode: "fast" | "think" }`
- **Toolbar popup**: pin the toggles above as **forced defaults**, which override caller arguments; "default" means "don't touch whatever the page has"
- **Parallel dispatch**: several sites can run at once (the caller spawns background CLI processes); each site has its own tab

## Security

- **The bridge token is no longer hardcoded** (older builds shipped `webagents-local`, i.e. no auth at all).
  Resolution order: `WEBAGENTS_TOKEN` → `bridge.json` in the user directory (randomly generated) → generated on first run.
  Location: Windows `%LOCALAPPDATA%\webagents\bridge.json`, elsewhere `~/.local/share/webagents/bridge.json`.
- **Extension pairing (TOFU)**: on its first connection the extension has no token, so the bridge verifies the
  origin and hands one over; the extension stores it in `chrome.storage.local` and only ever uses tokens after that.
  If the extension's storage is cleared it re-pairs automatically (same extension origin only).
- **Origin check**: any connection carrying an `Origin` that is not `chrome-extension://` is refused —
  this is specifically there to stop "a web page driving the bridge on your machine".
- **Honest note on the residual risk**: the token file and a malicious process belong to the same user, so the
  token can be read. This layer stops "some local process that happens to connect" and "a web page",
  not "code already running as you".

## Handling CAPTCHAs (slider verification)

Sites occasionally pop a slider challenge (Qwen goes through **Alibaba Baxia**, SDK host `sec.qianwen.com`).
**The real problem is that it appears somewhere you cannot see** — our site tabs are background tabs
(`active: false`), so the symptom is "the task silently wedges until it times out", not "please slide this".

The approach is **to turn an invisible wait into a visible one**. We do not try to bypass the site's risk control:

1. **Detect**: the content script decides from several signals on every state poll — a *visible* challenge
   widget with a plausible size. Merely loading the risk SDK does **not** count (it loads on every page view,
   and treating it as a challenge would interrupt every normal question); it is only reported as context.
2. **Surface**: when hit, the tab (and its window) is brought to the foreground and the result says so
   explicitly — `⚠ the site requires manual verification: … (tab brought to front)`. Once you finish the
   challenge the task continues on its own; **you do not re-issue it**.
3. **Extend the budget**: a detected challenge extends the waiting budget (`CAPTCHA_WAIT_MS`), otherwise
   "the site is waiting for you to slide" gets reported as "the task timed out".
4. **Adaptive cooldown** (lowers the chance of hitting it again): a site that hit a challenge gets a longer
   interval between calls (+5s per hit, capped at 60s, auto-clears after 30 minutes without one), reported as
   `自适应降温 +Ns`. This only lowers probability — **it does not resolve an already-displayed challenge**.

> Explicitly out of scope: auto-dragging the slider through a debug channel. Risk control judges trajectory and
> fingerprinting, not just event credibility; automating the solve raises the chance of the account being flagged
> and conflicts with this project's "minimal risk" bottom line.

## Run log

Every call and every bridge event is appended to `runs.jsonl` (next to the token file), readable with `runs`:

```text
2026/9/15 01:48:27  [bridge] listening on ws://127.0.0.1:8765 (token source=generated)
2026/9/15 01:48:52  deepseek/deepseek "explain a closure in one sentence"  ok | 8.4s | text=stream | md=142/dom=65
```

Recorded: duration, queue/throttle waits, where the text came from and how long it was, the site's terminal
status, the failure stage, and the diagnostics captured for that run. Before this, troubleshooting meant
"run it again and watch" — one real question plus one extension reload each time. Now most trends are
readable straight out of history.

## Reliability design

**Completion detection (two tiers)**

- **① Primary signal: the main-world stream probe** (`content/stream-probe.js`). A site's "reply finished" is
  definite, but it exists only in the network response stream (never in the DOM, never in the console), so the
  extension hooks response streams from the main world *before* the page loads and treats **"the server closed
  the response stream"** as the protocol-level hard signal. It also reads the site's self-reported terminal
  status (DeepSeek `MessageStatus`: `FINISHED` / `INCOMPLETE` / `CONTENT_FILTER` / `CONTEXT_LENGTH_EXCEEDED` /
  `TIMEOUT`). **Any terminal status other than `FINISHED` is returned and surfaced explicitly**, so a truncated
  answer can never quietly pass as a complete one.
- **② Fallback**: when the probe is unavailable, fall back to the old logic — the SW polls every **600ms**, and
  text stable for **400ms** plus a **300ms** re-confirmation means done.
- **The two text sources cross-check each other (since 0.7.0)**: when both the stream reconstruction and the page
  DOM yield text, **the page wins** — a shorter stream means characters were lost, so we return the DOM text and
  report `streamShortBy`; if the DOM genuinely has nothing at that moment, the result is marked `unverified` with
  `textSource=stream-unverified` and the summary line carries `⚠正文未交叉校验`. The old rule ("trust the stream if it
  is at least half the DOM length") let truncated answers through silently — measured on 2026-09-21: the parser
  treated a path-operation frame **missing the `o` field** as SET and overwrote the first 1~4 characters of every
  answer; across five runs the lost prefix was always exactly the inline `content` of the fragment-creation frame.
- **Where the text comes from**: when the stream can be reassembled we prefer the **raw markdown** (code fences,
  tables, formulas intact). When it can't (Qwen's answer data isn't on the hooked channel), we fall back to the
  page and run the **DOM→markdown serializer** (`content/dom-md.js`) over the rendered result: tables become pipe
  tables, code blocks become fences, toolbars and line numbers are dropped. It depends only on a minimal DOM
  surface, so it is site-agnostic and unit-testable offline. `innerText` is the last resort. The result is
  labelled with its source (`stream` / `dom-md` / `dom`).

**Concurrency and stability**

- **Per-site serial queue**: one task per site at a time. Each site has a single persistent tab, and concurrent
  entry means overwriting each other's input box, fighting over the same screen for completion detection, and
  navigating each other's page away — so **same-site calls queue automatically** while different sites still run
  in parallel.
- **Queueing is not infinite waiting**: if a predecessor hangs, a queued caller errors out after at most 4 minutes
  rather than staying silent. `status` reports per-site queue depth.
- **Call throttling**: a minimum gap between two questions to the same site (3s by default; adjustable or off on
  the options page) to lower the risk-control odds. It **only waits when less than the interval has elapsed since
  the last finish**, so normal use is unaffected; when a wait does happen, the result says how long.
- **Fast failure on disconnect**: when the browser closes / the extension is unloaded / the SW is recycled, the
  local bridge fails all in-flight requests **immediately** (3ms measured) instead of letting callers wait out
  their timeouts.
- **Half-open detection (application-level heartbeat)**: when the machine sleeps or the browser is frozen, the
  socket never emits `close` — there is no TCP FIN, `readyState` stays 1 — so messages go out and nobody answers,
  and in-flight requests neither fail nor return (one measured ask recorded `ms=7212.9s` with **no "extension
  disconnected" event anywhere in the log**). The bridge now calls a heartbeat at both ends (extension and each
  caller) every 15s; two consecutive misses mark the link half-open, terminate that zombie socket, and write the
  event to `runs.jsonl`. Only connections that self-declare `hb:1` during the handshake take part — otherwise
  "bridge upgraded, extension not yet" would get the old extension evicted every ~45s, a fake incident of our own making.

**Other reliability measures**

- Two-phase ask: the page only injects and sends (tolerating a full-page navigation)
- Graded send verification: inject read-back comparison (3s × 2 attempts) → send equivalence signal (25s; long
  prompts make the site's navigation/clear slower, and 8s produced false failures), each level reporting failure
  immediately — never a silent retry
- Double home-page check (URL exactly equal to the homepage + no leftover answer blocks), so a previous
  conversation's reply can never be scraped by mistake
- First-feedback window: no life signal after sending reports `no_site_feedback`. **The window has two widths
  depending on whether the send was acknowledged** — with inject read-back *and* send verification both passed,
  the generous 25s applies, because "slow" does not mean "not sent" (with web search enabled the first token can
  land after 12s); only when the ack is lost and we genuinely cannot tell does the strict per-site window apply
  (DeepSeek 12s / Qwen 30s). The **170s hard timeout** still returns whatever was generated
- Tab sleep prevention (`autoDiscardable: false`) + discarded wake-up + programmatic re-injection
- Adaptive injection: native setter for `textarea`; explicit selection + `execCommand insertText` for
  contenteditable (paste as the only fallback), with a 3-round self-heal for hydration re-mounting

## Installation

### 1. Load the Edge extension

1. Open `edge://extensions` and enable "Developer mode" (bottom left)
2. "Load unpacked" → select this repository's `extension/` directory
3. Open `chat.deepseek.com` and `www.qianwen.com` and log in
4. (Optional) Pin the WebAgents toolbar icon to configure default conversation toggles

### 2. Install the dependency and bring up the bridge

`server/` depends on exactly one package, `ws`; run `npm install` in that directory before first use.

```bash
node server/cli.mjs bridge start     # keep the bridge resident (Windows: scheduled task; macOS/Linux: detached process)
node server/cli.mjs doctor           # health check: bridge / extension / token / do both adapters answer
```

Residency is optional — every command also spawns a bridge if none answers (it may then be reclaimed when the
command ends, costing an extra ~5s reconnect). For a long job: **`bridge start` at the beginning → use anything
freely → `bridge stop` at the end**.

### 3. Usage (the CLI is the only entry point)

The first call automatically creates/reuses the persistent tab for that site in Edge.

```bash
node server/cli.mjs ask deepseek "question"              # one summary line on stdout; answer in outputs/<runId>.md
node server/cli.mjs ask qwen "review this" --attach a.mjs  # the CLI reads the file itself (never enters your context; ≤60KB each)
node server/cli.mjs ask deepseek --prompt-file p.txt     # big prompts via file (around the Windows argv 32767-char limit)
node server/cli.mjs ask deepseek "follow-up" --continue last  # continue the same session (last / <runId> / here)
node server/cli.mjs ask deepseek "task" --schema s.json  # require JSON, validate, auto-repair once in the same session
node server/cli.mjs ask deepseek "task" --think off --search on  # per-call toggles (Qwen: --mode fast|think|research)
node server/cli.mjs ask qwen "task" --mode think         # omit them and the site's leftover page state decides — not reproducible
node server/cli.mjs runs --errors / --dedupe / --why last
node server/cli.mjs inspect deepseek                     # read-only look at the scene (no navigation)
node server/cli.mjs status                               # extension connection state
node server/cli.mjs doctor                               # one-shot health check
```

Design points: on success stdout is a single summary line (the answer goes to a file, read it on demand); on
failure stdout is one line
`FAIL stage=<connect|queue|send|challenge|generate|retrieve|quality|timeout|adapter|session_gone> reason=… hint=… runId=…`
(exit 1; exit 2 for usage errors) — look up the stage instead of digging through logs. Same-site calls serialize,
different sites parallelize (the caller spawns background processes).
`timeout` means the extension returned *nothing* within budget — **that is not a connection problem**, so don't
follow the `connect` advice and restart a session. `adapter` means the tab exists but the content script did not
answer (extension just reloaded / page sitting on a login screen); refresh it or run one `ask`, which re-injects.
`--continue` needs extension v0.4.1+ (effective after reloading the extension).
Full flags, the stage table, and orchestration playbooks: `skills/webagents/`.

## Layout

```text
webagents-mcp/               # the directory name is historical (the MCP entry point was removed in 0.7.0)
├── extension/               # Edge extension (MV3)
│   ├── manifest.json
│   ├── background.js        # SW: routing, per-site queue, completion detection (does not hold the connection)
│   ├── offscreen.html/js    # persistent WS connection (lifetime independent of the SW)
│   ├── options.html/js    # settings UI (the same page serves as toolbar popup and full options tab)
│   └── content/
│       ├── common.js        # shared utils + probe bridge + ask/probe logic
│       ├── dom-md.js        # DOM→markdown serializer (faithful answer extraction)
│       ├── stream-parse.js  # incremental stream parsing (pure functions, node-testable)
│       ├── stream-probe.js  # main-world stream probe (completion hard signal + raw markdown)
│       ├── deepseek.js      # DeepSeek adapter
│       └── qwen.js          # Qwen adapter
├── server/
│   ├── cli.mjs              # CLI primitives (ask/runs/inspect/status/doctor/bridge)
│   ├── bridge.mjs           # the single WS bridge (token auth + Origin check + heartbeat on both links)
│   ├── store.mjs            # bridge token + run log (stored in the user directory, not in the repo)
│   └── package.json         # runtime dependency: ws only
├── skills/webagents/        # agent skill (SKILL.md + flag reference + playbooks)
├── tests/                   # all tests live here; see the table below
│   └── run-all.mjs          # what `npm test` runs
└── package.json             # test / test:live scripts
```

## Adding a site

Copy the adapter template in `content/qwen.js`, implement `ask` (inject / send / capture) and the optional
`setOptions` hook, add `content_scripts` match rules and `host_permissions` to `manifest.json`, and register the
site in `SITES` in `background.js`. After a redesign, calibrate selectors from real measurements taken with
`inspect <site>` — the full DOM survey is already in its `data.probe` (the old separate `probe` entry navigated
the tab back to the homepage, i.e. a full reload that destroyed the CAPTCHA scene and the stream records; it was
called once in its lifetime and removed in 0.7.0).

The stream probe is site-agnostic: as long as a site streams over SSE / fetch streams / XHR,
`content/stream-probe.js` catches it with no per-site changes. Two conditions qualify a response as a stream: the
`text/event-stream` content type, **or** a body that looks like SSE frames (`event:` / `data:{...}` lines) — the
latter was added for Qwen, whose `fetch` accept list also names `text/plain` and a wildcard and which does not
check content type before reading the body.

Three payload shapes are supported: `data:{...}` (direct structure), **`data:"{...}"` (payload is an encoded JSON
string needing a second decode — Qwen's measured shape)**, and `data:[DONE]` (protocol-level end). Bare-string
payloads are recorded as diagnostic samples only, never merged into the answer (risk-control telemetry can share
the stream). The probe counts frames per shape (`frames`) and ships the stats with failure diagnostics, so one
real run tells you which shape a site switched to.

Terminal status is recognized from two sources: status fields in the payload (`STATUS_KEYS`) and **named SSE
events** (`complete` / `finish` / `done` → finished, `audit` / `security` → filtered, `error` → incomplete). New
event names go into the `TERMINAL_EVENTS` regexes in `content/stream-parse.js`. Text-fragment detection accepts
both `type` and `mimeType` field names.

## Tests

```bash
npm test                # 12 offline suites, 342 assertions (each uses its own port and temp WEBAGENTS_HOME;
                        #   they never touch your running bridge or browser)
npm run test:live       # additionally runs the same-site concurrency check: two real questions, extension must be online
node tests/test-cli.mjs # or a single suite
```

| Suite | What it locks | Checks |
|---|---|---|
| `test-stream-parse` | SSE frames, envelope semantics, named-event terminals, card shapes, JSON-string payloads | 99 |
| `test-stream-probe` | main-world probe: fake XHR + fake fetch + fake WebSocket drivers | 45 |
| `test-dom-md` | DOM→markdown: tables / code / lists / decoration stripping | 29 |
| `test-scheduling` | per-site serial queue + first-feedback budget (loads the real background.js) | 21 |
| `test-offscreen` | offscreen connection behaviour: fake chrome + fake WS | 31 |
| `test-cli` | CLI pure functions + failure contract + fake-bridge integration (real CLI subprocess) | 62 |
| `test-bridge-auth` | bridge auth and pairing: token / Origin / TOFU | 20 |
| `test-bridge-failfast` | two-stage disconnect handling: flap survives / grace expiry fails | 14 |
| `test-bridge-halfopen` | half-open: no answer → detected → reclaimed → new connection works | 5 |
| `test-bridge-hb-compat` | heartbeat capability negotiation: an old extension must not be evicted | 4 |
| `test-bridge-tofu-hb` | the TOFU first-pairing connection gets half-open detection too | 6 |
| `test-bridge-routeid` | in-flight request id collisions are refused, not silently cross-delivered | 6 |
| `test-concurrent-asks` | same-site concurrency without cross-talk (two parallel `cli.mjs ask` subprocesses, real sites) | — |

Run `npm test` after touching `stream-parse.js` / `stream-probe.js` / `background.js` / `bridge.mjs` /
`offscreen.js` / `cli.mjs`. The last suite needs a loaded, logged-in extension and asks two real questions
(since 0.7.0 it drives two parallel CLI subprocesses instead of hand-rolling JSON-RPC at an MCP server).

## Notes

- Automating web chats carries account risk-control exposure; leave gaps between tasks and respect each site's terms of service.
- **When running several CLI processes at once, request ids must be globally unique** (0.7.0's `cli.mjs` gives
  each process a random prefix). The bridge routes in-flight requests by id, so two processes using the same id
  means the later registration replaces the earlier one: **the first caller's answer gets delivered to the
  second** (wrong content, worse than a failure) while the first waits out its timeout. Use unique ids in your own
  callers; the bridge now refuses collisions, but that only turns a silent error into a loud one.
- Site front-end redesigns can break selectors; diagnose with `inspect` (`data.probe`) and update the adapter
- The stream probe needs MV3 **main-world content scripts** (`world: "MAIN"`), i.e. Chrome / Edge **116+**
  (declared via `minimum_chrome_version`). Check `probeWorld` via `inspect`: `main` = active, `isolated` = not
  (completion detection then falls back to the DOM heuristics automatically; nothing breaks)
- **Upgrading to 0.4.0**: the bridge token became randomly generated and the extension re-pairs once. After
  reloading the extension it makes one token-less connection; the bridge verifies the origin and hands the token
  over — **no manual steps**.
- **Version scheme since 0.5.0**: `server/package.json` matches the CLI's `VERSION`, and from that release the
  server and the extension **version independently** (the manifest is not bumped when the extension is unchanged).
- **0.7.0 removed the MCP tool surface**: `server/index.mjs`, the `@modelcontextprotocol/sdk` dependency and
  `test-client.mjs` are gone (measured basis: no client on this machine had the server registered, and in the run
  log MCP calls clustered on the day the CLI landed — afterwards CLI traffic ran 63 to 1). The only remaining
  dependency is `ws`. `role:'mcp'` became `role:'cli'`, so **the bridge and the CLI must be upgraded together**:
  an old, still-running bridge will mistake the new CLI for an extension and evict the real one. To swap:
  `node server/cli.mjs bridge stop --force && node server/cli.mjs bridge start`, then reload the extension in
  `edge://extensions`.
- **Extension 0.4.2**: offscreen reconnect ceiling 30s → **5s**, connection self-check 25s → 10s. Rationale: after
  the CLI migration there is such a thing as a "command-scoped bridge" (each command spawns one, and the host
  reclaims it when the command ends), so the reconnect ceiling must be far shorter than a typical command window
  or the extension and the bridge keep missing each other (measured: a 10s `status` command never caught a
  30s-ceiling reconnect window).
- **The debugger permission and the whole CDP click channel were removed** (0.7.0). To be honest about it:
  `cdpClick` never had a caller — Qwen injects via an explicit selection plus `execCommand insertText`, DeepSeek
  via the native setter, and neither needs trusted input events. Keeping an unwired capability cost the heaviest
  entry in the permission list plus a permanent "debugging this browser" banner. If a downgrade path is ever
  needed, take it back out of git history.
- After changing extension code or `manifest.json`, **reload the extension** in `edge://extensions`
- Completion detection prefers "site-reported terminal status / DOM completion marker (e.g. Qwen's
  `qk-markdown-complete`)" with text stability as the fallback; the answer text prefers raw markdown (stream
  path) or DOM reassembly (the dom-md serializer)
- Intended for local personal automation only

## License

MIT
