# WebAgents

**中文 | [English](README.en.md)**

把 DeepSeek / 通义千问等**网页版聊天**变成你的 subagent：一个 Edge 扩展 + 一个 MCP 桥，让 Claude / Trae 等支持 MCP 的 AI 客户端直接向这些网页注入 prompt 并抓取回复，还可以**并行派发**任务给多个站点。

> 复用浏览器里已有的登录态，无需 API Key，无需逆向协议。

## 架构

```text
MCP 客户端（Claude / Trae / ...）
   ↕ stdio（MCP 协议）
server/index.mjs — MCP server + server/bridge.mjs — WebSocket 桥（ws://127.0.0.1:8765）
   ↕ WebSocket（随机令牌鉴权 + Origin 校验）
Edge 扩展 offscreen.js — 常驻 WS 连接（生命周期独立于 Service Worker）
   ↕ chrome.runtime 消息
Edge 扩展 background.js — 任务路由 / 站点队列 / 完成判定
   ├─ chat.deepseek.com  常驻 pinned 标签页（content/deepseek.js）
   └─ www.qianwen.com    常驻 pinned 标签页（content/qwen.js）

每个站点页内另有一条主世界流探针（content/stream-probe.js）：
拦截响应流，提供"服务端已关闭流"这一完成硬信号与原始 markdown
```

> 连接为什么放在 offscreen 文档里：MV3 的 Service Worker 空闲 30s 会被回收，
> 回收时它持有的 WebSocket 必然断开 —— "扩展在线"因此变得不确定。
> offscreen 文档的生命周期与 SW 独立（除音频播放外不设时长上限），
> 所以连接可以一直保持，SW 该睡就睡、收到请求时被唤醒。

## 功能

- **MCP 工具**：
  - `deepseek(prompt, options?)` — 向 DeepSeek 提问并返回回复
  - `qwen(prompt, options?)` — 向千问提问并返回回复
  - `probe(site)` — 诊断页面 DOM（输入框/发送按钮/模式开关结构），用于站点改版后的校准。**会先把标签页导回首页（整页重载）**
  - `inspect(site)` — **只读查看当前页面状态，不导航不重载**。用于查看风控验证现场、回复区状态与流探针记录（`probe` 会重载页面从而摧毁这些现场）
  - `fleet_status()` — 查看扩展连接状态（含连接承载方式与各站点排队深度）
  - `recent_runs(limit?, site?, onlyErrors?)` — 读取运行记录，**排障首选**：不必重跑问答
- **对话开关**（调用时可选传入）：
  - DeepSeek：`{ deepThink: true/false, search: true/false }`（深度思考 / 联网搜索）
  - 千问：`{ mode: "fast" | "think" }`（快速 / 思考研究）
- **工具栏 popup 浮窗**：把上述开关设为**强制默认值**，优先级高于调用参数；「默认」= 不干预页面当前状态
- **并行派发**：多个站点的调用可同时进行，各自独立标签页互不干扰

## 安全

- **桥接令牌不再硬编码**（旧版写死 `webagents-local`，等于没有鉴权）。
  现在的取值顺序：环境变量 `WEBAGENTS_TOKEN` → 用户目录下的 `bridge.json`（随机生成）→ 首次运行时生成。
  文件位置：Windows `%LOCALAPPDATA%\webagents\bridge.json`，其它平台 `~/.local/share/webagents/bridge.json`。
- **扩展配对（TOFU）**：扩展第一次连接时还没有令牌，桥核对来源后把令牌发给它，
  扩展存入 `chrome.storage.local`，此后只认令牌。扩展存储被清空后会自动重新配对（仅限同一扩展来源）。
- **Origin 校验**：任何携带 `Origin` 且不是 `chrome-extension://` 的连接一律拒绝 ——
  专门拦"用浏览器打开一个网页来驱动你本机的桥"。
- **诚实说明残留风险**：令牌文件与恶意进程同属一个用户，能被读走。
  这一层挡的是"偶然连上的本机程序"和"网页"，不是"已经以你身份运行的恶意代码"。

## 风控验证（滑块）的处理

站点偶尔会弹出滑块验证（千问走**阿里霸下风控**，SDK 域 `sec.qianwen.com`）。**关键问题是它弹在你看不见的地方** ——
我们的站点标签页是后台标签（`active:false`），所以现象是"任务无声卡死到超时"，而不是"请你划一下"。

处理方式是**把看不见的等待变成看得见的等待**，不尝试绕过站点的风控：

1. **检测**：内容脚本在每次状态轮询时做多信号判定 —— 可见的挑战组件（尺寸合理、未被隐藏）。
   单独加载风控 SDK **不算**（每次页面加载都在，误判会打断每一次正常问答），只作为上下文如实上报。
2. **切前台**：一旦命中，把该标签页（及其窗口）切到前台，返回中明确写出
   `⚠ 站点要求人工验证：…（标签页已切到前台）`，你验证完任务会自动继续 —— **不需要重新发起**。
3. **延长预算**：检测到验证时把等待预算额外延长（`CAPTCHA_WAIT_MS`），
   否则"站点在等你划一下"会被当成"任务超时失败"。
4. **自适应降温**（降低再次触发的概率）：命中过验证的站点，后续调用间隔自动多等
   （每次 +5 秒、上限 60 秒，30 分钟无验证自动恢复），并在返回中注明
   `自适应降温 +Ns`。注意这只降概率，**不解决已弹出的验证**。

> 明确不做：用调试通道自动拖动滑块。风控判断的不只是事件可信度，还有轨迹与指纹；
> 自动过验证会提升账号被标记的概率，与项目"最低风控"的底线冲突。



## 运行记录

每次工具调用与桥事件都会追加到 `runs.jsonl`（与令牌同目录），可用 `recent_runs` 读取：

```text
2026/9/15 01:48:27  [桥] listening on ws://127.0.0.1:8765（令牌来源=generated）
2026/9/15 01:48:52  deepseek/deepseek "用一句话解释闭包"  成功 | 8.4s | 正文=stream | md=142/dom=65
```

记录字段：耗时、排队/节流等待、正文来源与长度、站点终态、失败阶段、当次诊断。
此前排障只能"再跑一次看现象"，代价是一次真实问答 + 一次扩展重载；有了它多数问题可以直接从历史看出趋势。

## 可靠性设计

**完成判定（两级，v8 起）**

- **① 主信号：主世界流探针**（`content/stream-probe.js`）。站点的"回复结束"是明确的，但只存在于网络响应流里（不写 DOM、不进控制台），因此扩展会在页面加载前从主世界拦下响应流，以**「服务端关闭响应流」**作为答完的协议级硬信号。同时读取站点自报终态（DeepSeek `MessageStatus`：`FINISHED` / `INCOMPLETE` / `CONTENT_FILTER` / `CONTEXT_LENGTH_EXCEEDED` / `TIMEOUT`）。
  **非 `FINISHED` 的终态会连同结果一起返回并显式提示**，避免"半截答案被当作完整答案"这种静默错误。
- **② 兜底**：探针不可用时退回原逻辑 —— SW 每 **600ms** 轮询，文本稳定 **400ms** 后复确认 **300ms** 判定答完。
- **正文来源**：流可还原时优先用**原始 markdown**（保留代码块 / 表格 / 公式）；
  流不可用（如千问，作答数据不在已 hook 的通道里）则退回页面 —— 此时用 **DOM→markdown 序列化器**
  （`content/dom-md.js`）把渲染结果还原成 markdown：表格还原为管道表、代码块还原为围栏、工具栏/行号剔除。
  它只依赖最小 DOM 接口，站点无关、可离线单测。再不行才用 innerText。返回中会标注来源（stream / dom-md / dom）。

**并发与稳定性（v8 起）**

- **站点级串行队列**：每个站点同一时刻只跑一个任务。每个站点只有一个常驻标签页，并发进入会互相覆盖输入框、抢同一块屏幕做完成判定、互相把页面导航走 —— 所以**同站点的调用会自动排队**，跨站点仍可并行。
- **排队不是无限等待**：前序任务卡死时最多排 4 分钟即明确报错（不让调用方无限沉默）。`fleet_status` 会报出各站点的排队深度。
- **调用节流**：同一站点两次提问之间保持最小间隔（默认 3 秒，可在扩展设置页调整 / 关闭），用于降低账号风控概率。**只在"距上次结束不足间隔"时才等待**，正常节奏使用完全无感；等待若发生，返回中会注明实际等待时长。
- **掉线快速失败**：浏览器关闭 / 扩展被卸载 / Service Worker 被回收时，本地桥会**立即**让所有在飞请求失败（实测 3ms），而不是让调用方等到超时。

**其余可靠性设计**

- 两段式 ask：页面只负责注入 + 发送（容忍整页跳转）
- 发送分级校验：注入读回比对（3s × 2 次）→ 发送等价信号（8s），每级失败立即回传，绝不静默重试
- 首页归位双重校验（URL 精确等于首页 + 无残留回复块），杜绝上一次对话的回复被误抓
- 首反馈窗口：发送后无生命信号即报 `no_site_feedback`。**窗口按"发送是否已确认"取两档** —— 注入读回 + 发送校验都通过（ack 确认）时用宽松档 25s，因为此时"慢"不代表"没发出去"（开启智能搜索时首字可能落在 12s 之后）；只有 ack 丢失、确实无法判断发送是否发生时才用站点严格档（DeepSeek 12s / 千问 30s）。**170s 硬超时**仍返回已生成的部分文本
- 防标签页休眠（`autoDiscardable: false`）+ discarded 唤醒 + 程序化补注入
- 注入自适应：textarea 走 native setter；contenteditable 走显式选区 + `execCommand insertText`（唯一回退 paste），含水合重挂自愈 3 轮

## 安装

### 1. 加载 Edge 扩展

1. 打开 `edge://extensions`，开启左下角「开发人员模式」
2. 「加载解压缩的扩展」→ 选择本仓库的 `extension/` 目录
3. 分别打开 `chat.deepseek.com` 和 `www.qianwen.com` 并登录
4. （可选）把工具栏上的 WebAgents 图标固定住，点开即可配置默认对话开关

### 2. 注册 MCP server

在 MCP 客户端的配置文件（如 Trae 的 `mcp.json`）中加入：

```json
{
  "mcpServers": {
    "webagents": {
      "command": "node",
      "args": ["<本仓库路径>/server/index.mjs"]
    }
  }
}
```

`server/` 依赖仅 `ws`，首次使用前在该目录 `npm install`。

### 3. 使用

重启 MCP 客户端后即可调用 `deepseek` / `qwen` 工具。调用时 Edge 中会自动创建/复用对应站点的常驻标签页。

## 目录结构

```text
webagents-mcp/
├── extension/            # Edge 扩展（MV3）
│   ├── manifest.json
│   ├── background.js     # SW：任务路由、站点队列、完成判定、CDP 兜底（不持有连接）
│   ├── content/
│   │   ├── common.js     # 通用工具 + 探针桥接 + 问答/探测逻辑
│   │   ├── stream-parse.js  # 流增量解析（纯函数，可 node 单测）
│   │   ├── stream-probe.js  # 主世界流探针（拦响应流：完成硬信号 + 原始 markdown）
│   │   ├── deepseek.js   # DeepSeek 适配器（注入/发送/回复抓取/开关）
│   │   └── qwen.js       # 千问适配器（contenteditable 注入/模式切换/回复抓取）
│   ├── offscreen.html/js # 常驻 WS 连接（生命周期独立于 SW）
│   ├── content/dom-md.js # DOM→markdown 序列化器（保真提取渲染后的答案）
│   ├── popup.html/js     # 工具栏浮窗：强制开关设置
│   └── options.html/js   # 完整设置页（与 popup 共用逻辑）
├── server/
│   ├── index.mjs         # MCP stdio server（工具定义与分发 + 运行记录）
│   ├── bridge.mjs        # WebSocket 桥（127.0.0.1:8765，令牌鉴权 + Origin 校验）
│   ├── store.mjs         # 本地状态：桥接令牌 + 运行记录（在用户目录，不在仓库里）
│   └── package.json
├── test-client.mjs       # 独立测试客户端（status / 问答 / probe / runs）
├── test-stream-parse.mjs # 流解析单元测试
├── test-stream-probe.mjs # 流探针集成测试（假 XHR + 假 fetch + 假 WebSocket 驱动）
├── test-scheduling.mjs   # 站点串行队列 + 首反馈预算
├── test-bridge-failfast.mjs   # 桥掉线快速失败（起真进程 + 真 WS）
├── test-bridge-auth.mjs  # 桥鉴权与配对（令牌 / Origin / TOFU）
├── test-offscreen.mjs    # offscreen 连接行为（假 chrome + 假 WebSocket）
└── test-concurrent-asks.mjs   # 同站点并发验证（需扩展在线）
```

## 接入新站点

照 `content/qwen.js` 的适配器模板新建文件，实现 `ask`（注入/发送/回复抓取）与可选 `setOptions` 钩子，在 `manifest.json` 加 `content_scripts` 匹配规则、`host_permissions`，在 `background.js` 的 `SITES` 中注册即可。站点改版时用 `probe` 工具实测 DOM 结构后校准选择器。

流探针与站点无关：只要站点用 SSE / fetch 流 / XHR 读流，`content/stream-probe.js` 就能拦到，无需为新站点改动。
判定条件有两条：响应头是 `text/event-stream`，**或**响应体本身长得像 SSE 帧（`event:` 行 / `data:{...}` 行）——
后者是为千问补的：它的 `fetch` 请求 accept 里同时列了 `text/plain` 与通配，且读 body 前不校验 content-type。

负载形态支持三种：`data:{...}`（直接结构）、**`data:"{...}"`（负载是被编码的 JSON 字符串，需再解一层 —— 千问实测形态）**、
`data:[DONE]`（协议级结束）。裸字符串负载只登记为诊断样本、不并入正文（站点流里可能混有风控遥测）。
探针会统计各形态的帧数（`frames`），失败时随诊断带出 —— 一次实跑就能判断站点换了哪种负载。

终态识别已覆盖两类来源：响应里的状态字段（`STATUS_KEYS`）与 **SSE 命名事件**
（`complete` / `finish` / `done` → 正常结束，`audit` / `security` → 内容拦截，`error` → 不完整）。
新站点如有别的事件名，在 `content/stream-parse.js` 的 `TERMINAL_EVENTS` 等正则里补即可。
正文片段识别同时支持 `type` 与 `mimeType` 两种字段名。

## 测试

```bash
node test-stream-parse.mjs     # 流解析：SSE 帧、信封语义、命名事件终态、卡片形态、JSON 字符串负载（94 项）
node test-stream-probe.mjs     # 流探针：假 XHR + 假 fetch + 假 WebSocket 驱动（45 项）
node test-scheduling.mjs       # 站点串行队列 + 首反馈预算（19 项）
node test-bridge-failfast.mjs  # 桥掉线两段式处理：抖动保活 / 宽限期后失败（14 项）
node test-bridge-auth.mjs      # 桥鉴权与配对：令牌 / Origin / TOFU（20 项）
node test-offscreen.mjs        # offscreen 连接行为：假 chrome + 假 WS（31 项）
node test-dom-md.mjs           # DOM→markdown 序列化器：表格/代码/列表/装饰剔除（29 项）
node test-concurrent-asks.mjs  # 同站点并发验证：需扩展在线，打真实站点
```

前七个是离线测试，覆盖最容易出错、又最难在浏览器里复现的部分
（协议解析、跨世界接线、并发调度、连接生命周期、鉴权）。
改动 `stream-parse.js` / `stream-probe.js` / `background.js` / `bridge.mjs` / `offscreen.js` 后请先跑它们。

最后一个需要扩展已加载并登录，会真实发起两次提问，用于验证"同站点并发不串话"。

## 注意事项

- 网页版自动操作存在账号风控风险，建议任务间留出间隔，并遵守各站点服务条款
- 站点前端改版可能导致选择器失效，用 `probe` 诊断后更新对应适配器
- 流探针依赖 MV3 的**主世界内容脚本**（`world: "MAIN"`），需 Chrome / Edge **116+**（`minimum_chrome_version` 已声明）。
  是否生效可用 `probe` 查看 `stream.probeWorld`：`main` = 生效，`isolated` = 未生效（此时完成判定自动退回 DOM 兜底，功能不受影响）
- **升级到 0.4.0 需要注意**：桥接令牌改为随机生成，扩展需要重新配对一次。
  重新加载扩展后扩展会发一次不带令牌的连接，桥核对来源后自动下发 —— **无需手工操作**。
  另外正在运行的 MCP 会话仍是旧版 server（硬编码令牌），**需要重启 MCP 会话**才能连上新桥。
- 「调试」权限已从常驻改为**按需授予**（`optional_permissions`）。如实说明：当前两个站点都不依赖它
  （千问走 `execCommand insertText`，DeepSeek 走原生 setter），保留只为降级备用。需要时在设置页点「授予调试权限」。
- 改动扩展代码或 `manifest.json` 后，需在 `edge://extensions` **重新加载扩展**才生效
- 完成判定采用「站点自报终态 / DOM 完成标记（如千问 `qk-markdown-complete`）优先、文本稳定性兜底」的两级设计，正文优先取原始 markdown（流路径）或 DOM 还原（dom-md 序列化器）
- 仅用于本地个人自动化场景

## License

MIT
