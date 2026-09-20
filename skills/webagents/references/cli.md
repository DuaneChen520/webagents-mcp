# WEBAGENTS CLI 完整参考（v0.7.0）

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 执行失败（stdout 有 `FAIL stage=…` 行） |
| 2 | 用法/输入错误（`FAIL stage=input`） |

## ask 全部旗标

| 旗标 | 作用 |
|---|---|
| `--out <file>` | 正文落盘位置；缺省 `<WEBAGENTS_HOME>/outputs/<runId>.md` |
| `--attach <file>`（可重复） | 附件由 CLI 直读拼进 prompt；单文件 ≤60KB，超限报错 |
| `--prompt-file <file>` 或 `-` | prompt 主体来自文件；`-` = stdin（绕开 Windows argv 32767 字符上限） |
| `--continue <runId>` / `last` / `here` | 同会话追问（不新开会话）：精确 runId / 该站最近成功问答 / 该站当前标签页 |
| `--protocol <file>` | 在 prompt 末尾附加输出协议模板；缺省时**给了 `--schema` 会自动带仓库自带的 `references/protocol.md`** |
| `--schema <file>` | 校验回复 JSON：`{"required":[...],"properties":{"k":"string"}}`，类型支持 string/number/boolean/array/object；违规自动同会话修复一次，两次违规 FAIL stage=quality |
| `--think on\|off` / `--search on\|off` | 仅 deepseek：深度思考 / 联网搜索。不指定=跟随页面残留状态（不可复现），要可复现必须显式给 |
| `--mode fast\|think\|research` | 仅 qwen：快速 / 深度思考 / 深入研究 |
| `--json` | stdout 输出全量 JSON（含 runId/text/data（schema 解析结果）/diag）；文件仍落盘 |
| `--why` | 失败时向 stderr 打印完整诊断 JSON |
| `--help` | 用法 |

环境变量：`WEBAGENTS_PORT`（默认 8765）、`WEBAGENTS_TOKEN`（优先于 bridge.json）、`WEBAGENTS_TIMEOUT`（默认 300000ms）、`WEBAGENTS_HOME`（状态目录）、`WEBAGENTS_EXT_WAIT_MS`（扩展重连等待上限，默认 30000）。

成功 stdout 示例（一行）：

```
done 14.7s 正文=stream md=242/0 status=FINISHED -> C:\...\outputs\rmu2xxxx.md schema=ok
```

`CONTEXT_LENGTH_EXCEEDED` 时照常成功落盘，但 stderr 输出 `sessionExhausted` 警告 ——
这是"该换新会话"的信号（可先让旧会话总结自己，把总结带进新会话）。

## 失败判定表

`FAIL stage=<段> reason=<原因> hint=<建议> runId=<id>`，按段行动：

| stage | 含义 | 第一步 |
|---|---|---|
| `input` | 参数/输入校验失败（未进入执行管线） | 按 reason 修参数 |
| `connect` | 桥不可达 / 扩展未连接 / 令牌不匹配 | `status` → `bridge start` 驻留桥；跑着的是旧版桥就 `bridge stop --force` 换掉 |
| `queue` | 同站点排队超 4 分钟 | 稍候重试；前序任务是否卡死用 `inspect` 看 |
| `send` | 发送未生效（ack 丢失）或页面被人为操作 | `inspect <site>` 看现场（**没有 probe 可误用了**，它会重载） |
| `challenge` | 站点弹出人工验证（标签页已自动切前台） | 通常自愈；超时才人手处理 |
| `generate` | 生成迟迟未开始/未结束（含 continue 无新回复超时） | 检查 search/deepThink 是否拖长首字；continue 场景确认会话页没被人动过 |
| `retrieve` | `mdLen=0` 且 `streamId` 有值：流里有正文但取回为空 | 重试通常自愈；复现则 `runs --why last` |
| `quality` | 站点非正常终态，或协议校验两次未通过 | 按 `streamStatus` 语义；schema 失败看 reason 里的字段错误 |
| `timeout` | **扩展在预算内一个字都没回**（等待天花板用尽） | 不是"连不上"，别去重启会话：`inspect <site>` 看它在不在干活 → `status` 看有没有「半开」事件 → 并发命令是否在同站点排队 |
| `adapter` | 标签页在，但页面里的内容脚本没应答（inspect 取不到任何取证） | 刷新该站页面，或直接跑一次 `ask`（会程序化补注入） |
| `session_gone` | `--continue` 找不到可续接会话（标签页没开/在首页/无历史回复） | 去掉 `--continue` 发首问，或重新打开会话页 |
| `inject` | 注入未通过读回比对（登录页 / 编辑器未就绪 / 站点改版） | `inspect <site>` 看 `data.probe` 的输入框候选 |
| `options` | 切换对话开关失败（`--think/--search/--mode` 对应的站点开关结构改版） | 先去掉开关旗标试一次，再用 `inspect` 校准 `setOptions` |
| `no_site_feedback` | 发送后站点毫无反应 | **刷新该站点页**再试（扩展重载后页面里的内容脚本已失效，ask 的补注入救不了这种） |
| `stream_empty` | 响应流已关闭但一个字都没取到 | `runs --why last` 看 `diag.frames`：能分辨"没抓到流"与"抓到但还原失败" |
| `site_network_error` | 站点自报网络异常，代点「重试」已用尽（上限 2 次） | 人手点页面上的「重试」；正文若其实已渲染则 `--continue here` 重发取回 |
| `empty_body` | 执行成功但正文为空 | 同 `site_network_error` 的处置顺序 |

诊断字段语义（出现在 runs 记录与 `--why` 输出里）：
`textSource`（stream/dom-md/dom/**stream-unverified**/none）· `mdVia`（cache/probe）· `mdLen`/`domLen`（长度快照）·
`streamId`/`streamStatus`（哪条流/什么终态）· `unverified`（正文未经交叉校验，值即原因：`answer_not_mounted`=页面还没把答案挂进 DOM（实测比流关闭晚数秒，
此时正文通常是完整的，DeepSeek 开深度思考时会常态出现）/ `dom_call_failed`=DOM 那一跳失败）·
`stage`（判定表段落）· `promptHash`（去重键）·
`runId` · `continued`/`repaired`（continue 与协议修复标记）· `domErr`（DOM 那一跳失败的原因，null=成功但没正文）·
`streamShortBy`（流还原比页面少多少字）· `askOptions`（本次显式指定的开关）。

> **看到 `⚠正文未交叉校验` 就别把这份正文当完整答案用**：它意味着页面 DOM 里一个字都没对上，
> 长度可能已经被截掉（实测过一次页面显示 7 字、我们只回了尾缀 4 字且当时毫无警告）。
> 通常同时说明该站点的答案区选择器失效了 —— 用 `inspect <site>` 看 `data.probe`，校准适配器。

## runs 子命令

```bash
runs [--limit n] [--site deepseek|qwen] [--errors] [--dedupe] [--why <runId>|last]
```

`--why last` = 最近一次失败记录的完整 JSON + 对应段的建议。

## doctor 子命令

`webagents doctor` 一键体检：版本口径（server/扩展）→ 令牌与配对 → 桥 → 扩展连接（承载/排队）→
两个站点的会话页状态（只读 inspect，**判据是"适配器有没有应答"而不是"标签页在不在"**）→ 近 24h 失败模式统计。
核心项（令牌/桥/扩展）任一不过 → 退出码 1；站点页未打开、适配器无应答、历史失败为警告级（⚠），不影响退出码。

## 后台与并行（调用方负责编排）

```bash
node $WA ask deepseek "..." --out a.md &    # bash 后台
node $WA ask qwen "..." --out b.md &        # 跨站真并行；同站会被队列串行化（预期行为）
wait
```

## bridge 子命令（桥的显式生命周期）

```bash
bridge start   # 驻留桥：已有桥 → 复用；没有 → Windows 走计划任务（schtasks，服务拉起、隐藏窗口）、
               # macOS/Linux 走 detached 进程（POSIX 守护写法）。两种平台都跨命令存活，pid 记入 bridge-keep.json
bridge stop    # 收尾：杀驻留桥 + 删计划任务 + 清记录；外部桥（非本命令驻留）需 --force 才关闭
```

推荐节奏：**任务开始 `bridge start` → 任务期间任意命令直接用 → 任务结束 `bridge stop`**。
未驻留时每条命令也会自拉桥（多 ~5s 重连延迟，已自动等扩展就绪）；`status`/`doctor` 会报告桥归属。

## 会话与桥的真相（排障必备）

- **CLI 是唯一入口**（0.7.0 起 MCP 工具面已移除）。桥连不上时 CLI 自拉桥（未驻留则为命令级，命令结束宿主可能回收）并等待扩展重连（`ensureExtensionReady`，默认上限 30s）后再执行。
- **桥按请求 id 路由在飞请求，id 必须全局唯一**。CLI 每个进程带随机前缀，所以并发 fanout 安全；自己写调用方时别用 `req-1` 这种进程内序号 —— 后注册者会顶掉前者，**前者的答案会被投给后者**（比失败更难查），前者只能干等超时。桥现在会明确拒绝冲突 id。
- **半开由应用层心跳检测**（两侧都保）：机器休眠时 socket 名义上还通着、没人应答，桥连续 2 次心跳无应答（约 30s）即判半开并回收该连接，在飞请求随即明确失败。`runs` 里能看到「扩展半开 / 调用方半开」事件 —— 看到它就是"刚才那段时间机器睡了/浏览器被冻了"，不是代码坏了。
- 桥的存活由 `bridge start`/`bridge stop` 显式管理（跨命令驻留）；归属记录在 `<WEBAGENTS_HOME>/bridge-keep.json`，`status`/`doctor` 可见。
- 令牌在 `%LOCALAPPDATA%\webagents\bridge.json`，扩展首次连接自动配对（TOFU）；桥重启后扩展自动重连（重连上限 5s），无需手工操作。
- `inspect` 返回的 `url` 只证明**标签页存在**；适配器是否真在应答要看 `adapterReady`（`doctor` 已按它判定）。刚重载过扩展 / 页面停在登录页时会出现"标签页在、内容脚本不在"，此时是 `stage=adapter`。
- `--continue` 的权威校验在扩展侧（v0.4.2+ 的 `ensureContinueTab`：不导航、遍历候选标签、冻结时激活解冻、要求会话页+历史回复）；
  扩展版本过旧（无 continue 支持）时会收到"未知 action"类错误 → 重载扩展。
