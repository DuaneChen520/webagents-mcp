---
name: webagents
description: 用 DeepSeek/千问网页版作为 0 成本 subagent。CLI 原语：ask/runs/inspect/status/doctor。需要第二意见、批量思考、长文生成、代码审查、多轮任务时使用；失败时按 stage 判定表定位。
---

# WEBAGENTS CLI

把 prompt 派给 DeepSeek / 千问网页版（真实登录会话），正文落盘，stdout 只有一行摘要。

CLI 路径：`<本仓库>/server/cli.mjs`（下称 `$WA`）。

## 命令速查

```bash
node $WA ask deepseek "问题"                 # 摘要一行；正文写 %LOCALAPPDATA%\webagents\outputs\<runId>.md
node $WA ask qwen "问题" --out answer.md     # 指定落盘位置
node $WA ask deepseek --prompt-file p.txt    # 大 prompt 走文件（不过 argv）
node $WA ask deepseek "审查" --attach a.mjs --attach b.mjs   # 文件由 CLI 直读，不过你的上下文
node $WA ask deepseek "追问" --continue last # 同会话追问（last / <runId> / here）
node $WA ask deepseek "任务" --schema s.json # 要求 JSON 输出+校验，违规自动同会话修复一次
node $WA ask deepseek "任务" --think off --search on      # 按调用指定开关（qwen 用 --mode）
node $WA ask qwen "任务" --mode think        # fast | think | research
node $WA runs --errors                       # 排障第一步：先看记录，不要重跑
node $WA runs --why last                     # 最近一次失败的完整诊断
node $WA runs --dedupe                       # 找重复问过的 prompt（跳不跳过你自己定）
node $WA inspect deepseek                    # 只读看现场，不导航
node $WA status                              # 扩展连接状态
node $WA doctor                              # 一键体检：桥/扩展/令牌/版本/近 24h 失败模式
node $WA bridge start                        # 显式驻留桥（长续任务开始前）
node $WA bridge stop                         # 长续任务全部结束后收尾
```

## 决策规则（按此选通道，省 token）

- 文件喂给网页 AI：**大文件 / 不需要自己先理解内容 → `--attach`**；小片段且要基于内容推理 → 直接拼进 prompt（此时内容已是沉没成本）。单附件 ≤60KB，超限报错不截断。
- **不要把落盘的答案整段读回上下文**：先看 stdout 摘要，需要时按 offset/grep 选择性读文件。
- **多轮任务用 `--continue`**（同会话追问，省上下文重建）：`last` = 该站最近成功问答，`<runId>` = 精确续接，`here` = 该站当前标签页。链式追问直到 stdout 出现 `sessionExhausted` 警告（站点报告上下文爆了）—— 此时先让旧会话总结自己，再开新会话带总结。
- **要机器可读结果用 `--schema`**：给了 schema 就会自动带上仓库自带的 `references/protocol.md` 模板（要换再显式 `--protocol`）；违规自动同会话修复一次，两次违规才报 `FAIL stage=quality`。
- **开关要显式指定**（`--think/--search/--mode`）：不指定时跟随站点页面残留状态，**同一 prompt 两次跑可能一个开思考一个不开**，结果不可复现。注意扩展设置页的强制默认值优先级更高，真被覆盖时 stderr 会告警。
- 同站点自动串行（排队上限 4 分钟）；**跨站点并行**：用后台运行同时起多个 ask。

## 长续任务的桥管理（重要：任务开始驻留，任务结束收尾）

- **任务开始**：运行一次 `$WA bridge start` —— 桥通过计划任务（Windows）或 detached 进程（macOS/Linux）**驻留**，跨命令存活；任务期间任何命令直接复用，不再付拉桥/重连成本。
- **任务过程**：`ask` / `runs` / `inspect` 随便用，单条命令即可（无需合并）。
- **任务结束**：运行一次 `$WA bridge stop`（杀桥、删计划任务、清记录）。
- 未驻留时每条命令也会自拉桥（多 ~5s 重连延迟，已自动等扩展就绪，功能不受影响）—— 忘了 start 也不会坏。
- `bridge stop` 只杀**自己驻留的桥**；外部桥（你的终端或残留的旧进程拉的）需 `--force` 才会关闭，防误杀。
  升级过 server 代码后必须换一次桥（旧桥不认新 CLI 的 `role:'cli'`，会把它当成扩展连接顶掉真扩展）。
- macOS/Linux：`bridge start` 走 detached 进程（POSIX 标准守护写法），行为一致。

## 失败处理（铁律）

失败时 stdout 一行 `FAIL stage=<段> reason=… hint=… runId=…`，退出码 1（用法错误 2）。
按 `references/cli.md` 的判定表行动；顺序永远是 **runs → inspect，绝不盲目重跑**；
**没有 probe 可用**（它会整页重载、摧毁验证弹窗与流记录，0.7.0 已移除；DOM 探测结果本来就在 `inspect` 的 `data.probe` 里）。
`--continue` 报 `session_gone` = 会话已不在（页面没开/在首页/无历史回复），去掉 --continue 发首问。

详细参数与判定表：`references/cli.md`；编排剧本（多站对比/批量/结构化输出/多轮任务）：`references/playbooks.md`。
