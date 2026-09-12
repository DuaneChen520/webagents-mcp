# WebAgents

**中文 | [English](README.md)**

把 DeepSeek / 通义千问等**网页版聊天**变成你的 subagent：一个 Edge 扩展 + 一个 MCP 桥，让 Claude / Trae 等支持 MCP 的 AI 客户端直接向这些网页注入 prompt 并抓取回复，还可以**并行派发**任务给多个站点。

> 复用浏览器里已有的登录态，无需 API Key，无需逆向协议。

## 架构

```text
MCP 客户端（Claude / Trae / ...）
   ↕ stdio（MCP 协议）
server/index.mjs — MCP server + server/bridge.mjs — WebSocket 桥（ws://127.0.0.1:8765）
   ↕ WebSocket（token 鉴权）
Edge 扩展 background.js — 任务路由 / 标签页池 / 状态轮询
   ├─ chat.deepseek.com  常驻 pinned 标签页（content/deepseek.js）
   └─ www.qianwen.com    常驻 pinned 标签页（content/qwen.js）
```

## 功能

- **MCP 工具**：
  - `deepseek(prompt, options?)` — 向 DeepSeek 提问并返回回复
  - `qwen(prompt, options?)` — 向千问提问并返回回复
  - `probe(site)` — 诊断页面 DOM（输入框/发送按钮/模式开关结构），用于站点改版后的校准
  - `fleet_status()` — 查看扩展连接状态与版本
- **对话开关**（调用时可选传入）：
  - DeepSeek：`{ deepThink: true/false, search: true/false }`（深度思考 / 联网搜索）
  - 千问：`{ mode: "fast" | "think" }`（快速 / 思考研究）
- **工具栏 popup 浮窗**：把上述开关设为**强制默认值**，优先级高于调用参数；「默认」= 不干预页面当前状态
- **并行派发**：多个站点的调用可同时进行，各自独立标签页互不干扰

## 可靠性设计

- 两段式 ask：页面只负责注入 + 发送（容忍整页跳转），SW 每 1.5s 轮询直到回复稳定
- 回复完成判定：文本稳定 0.8s + 复确认 0.5s，最快约 1.3~2.8s 返回
- 首页归位双重校验（URL + 无残留回复），杜绝上一次对话的回复被误抓
- 发送失败 15s 宽限轮询；170s 超时仍返回已生成的部分文本
- 防标签页休眠（`autoDiscardable: false`）
- 自适应文本注入（paste 事件优先 + 逐字符兜底 + 内容校验防重复）

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
│   ├── background.js     # SW：WS 客户端、任务路由、状态轮询、CDP 兜底
│   ├── content/
│   │   ├── common.js     # 通用工具（txt、sleep 等）
│   │   ├── deepseek.js   # DeepSeek 适配器（注入/发送/回复抓取/开关）
│   │   └── qwen.js       # 千问适配器（contenteditable 注入/模式切换/回复抓取）
│   ├── popup.html/js     # 工具栏浮窗：强制开关设置
│   └── options.html/js   # 完整设置页（与 popup 共用逻辑）
├── server/
│   ├── index.mjs         # MCP stdio server（工具定义与分发）
│   ├── bridge.mjs        # WebSocket 桥（127.0.0.1:8765，token 鉴权）
│   └── package.json
└── test-client.mjs       # 独立 WS 测试客户端（不经过 MCP 直接测扩展）
```

## 接入新站点

照 `content/qwen.js` 的适配器模板新建文件，实现 `ask`（注入/发送/回复抓取）与可选 `setOptions` 钩子，在 `manifest.json` 加 `content_scripts` 匹配规则、`host_permissions`，在 `background.js` 的 `SITES` 中注册即可。站点改版时用 `probe` 工具实测 DOM 结构后校准选择器。

## 注意事项

- 网页版自动操作存在账号风控风险，建议任务间留出间隔，并遵守各站点服务条款
- 站点前端改版可能导致选择器失效，用 `probe` 诊断后更新对应适配器
- 仅用于本地个人自动化场景

## License

MIT
