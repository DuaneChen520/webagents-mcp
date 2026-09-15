# WEBAGENTS 编排剧本（skill 层负责组合，CLI 保持"一次一问"薄原语）

## 剧本 1：多站点同题对比（fanout）

同站串行是铁律，扇出只跨站。CLI 不设 fanout 子命令 —— 编排层自己起后台进程：

```bash
node $WA ask deepseek "问题Q" --out q-ds.md &
node $WA ask qwen      "问题Q" --out q-qw.md &
wait
```

然后分别读 `q-ds.md` / `q-qw.md`（按需、可只读开头），对比后给结论。
要点：两问的 prompt 必须逐字节一致（对比才公平）；不要并发同站点。

## 剧本 2：批量任务（同站串行批处理）

```bash
# tasks.txt 每行一个 prompt
while IFS= read -r q; do
  node $WA ask deepseek "$q" --out "out/$(echo "$q" | md5sum | cut -c1-8).md"
done < tasks.txt
```

跑之前先 `runs --dedupe`：重复的 prompt 自己决定跳不跳过（CLI 不做自动缓存 ——
答案有时效性，缓存语义不进桥）。

## 剧本 3：代码审查（--attach 注入）

```bash
node $WA ask deepseek "审查以下文件的数据流安全，输出问题清单" \
  --attach server/bridge.mjs --attach server/cli.mjs --out review.md
```

决策规则：文件 >2k token 或不需要自己先读 → `--attach`；
要自己基于内容推理的小片段 → 直接拼 prompt。审查结果落盘，挑重点汇报。

## 剧本 4：结构化输出（机器可读结果）

在 prompt 里附 JSON 约定，要求**只回 JSON**；`--json` 拿全量、落盘后程序化消费：

```text
<任务描述>

输出要求：只返回一个 JSON 对象，不要任何其它文字。字段：
{ "verdict": "pass|fail", "issues": [{"file": "...", "line": 1, "desc": "..."}] }
```

解析失败的处理（v0.6.0 起已自动化）：`--schema s.json` 让 CLI 校验回复 JSON，
违规**自动同会话修复一次**（原 prompt 已在站点上下文里，修复只花一小条消息）；
两次违规才 `FAIL stage=quality`。协议模板用 `--protocol <file>` 注入，保持字节级一致。
手工修复等价于：`ask <site> "只返回符合协议的 JSON" --continue last`。

## 剧本 5：失败后的标准动作序列

1. 读 stdout 的 `FAIL stage=…` 行（O(1) 定位，见 references/cli.md 判定表）。
2. 需要细节 → `runs --why last`。
3. 需要看现场 → `inspect <site>`（只读；**永远不要用 probe 取现场**，它整页重载）。
4. 确认是瞬时问题才重跑；结构性失败先跑 `doctor`（桥/扩展/令牌/版本/失败模式一次看清）。

## 剧本 6：多轮任务（调研 → 写作 → 审查，同一会话链）

```bash
node $WA ask deepseek "调研 X，列出要点" --out r1.md
node $WA ask deepseek "基于上面的要点写初稿" --continue last --out r2.md
node $WA ask deepseek "审查你刚写的初稿，列出问题" --continue last --out r3.md
```

要点：`--continue last` 链式续接（上一轮的正文就在站点上下文里，不用重复喂）；
每轮正文落盘、按需读；出现 `sessionExhausted` 警告就收尾 —— 先让旧会话总结，
再开新会话把总结作为首问。
