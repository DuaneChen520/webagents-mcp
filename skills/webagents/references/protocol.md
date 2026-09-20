# 输出协议（CLI `--protocol` 默认模板）

配合 `ask --schema <file>` 使用；单独用 `--protocol skills/webagents/references/protocol.md` 也可。
字段清单由你的 `--schema` 决定，本模板只约定**形态**，不重复字段名。

## 必须遵守

1. 整条回复**只有一个 JSON 对象**：`{` 开头、`}` 结尾，前后没有任何文字。
2. 不要 Markdown 围栏（不要 ```），不要"好的／以下是"这类引导语，不要在 JSON 后追加解释、注释、致谢。
3. 严格使用 schema 声明的键名与类型；不确定的键**必须出现**，用 `null` 而不是省略（schema 允许时）。
4. 字符串内含双引号要转义；数字不要用引号包；数组无元素时给 `[]`，不要给 `null` 或省略。
5. 只写结论，不复述我的问题、不解释你为什么这么判。理由放进 schema 规定的字段里。
6. 信息不足以填某字段时，该字段给 `null`，并在 schema 的理由字段里写明缺什么——不要编造。

## 正例

{"verdict":"pass","score":8,"issues":[],"note":"结构完整"}

## 反例（任一种都算违约，会被要求重发）

- `好的，结果如下：{"verdict":"pass"}` ← 前面有引导语
- ```` ```json\n{"verdict":"pass"}\n``` ```` ← 套了围栏
- `{"verdict":"pass"` ← 缺右括号 / 被截断
- `{"verdict":"通过","score":"8"}` ← 枚举值改用了中文、数字加了引号
- `{"verdict":"pass","score":8,"issues":[],"note":"...","extra":"..."}` ← schema 没有的键不要自己加
