# 文档一 · AI 接入规则（逐字原文，直接记）

这是干什么的：提词器给 AI 的长期记忆/接入规则。她 2026-11-06 要求「文档一：要直接记」——不等「原需求整理功能」写好，原文逐字落在这里，不改写、不摘要。

来源：`需求/文档三“状态机”的“AI清理”条目有引用。原文：.zip` 内「文档一：AI 接入规则」代码块（原压缩包第 67~325 行）。

---

# 提词器接入规则



本文件是长期记忆，写入 CLAUDE.md 或 AGENTS.md 或等效记忆层，新会话自动加载，不需要每轮重读。规则变更时才重新粘贴。



## 应用场景

用户在此对话中要求改动或新增文件时生效。纯问答、讨论、问进度不读 `.ticiqi/`。



## 触发

用户说“开始”时，读当前工作目录下 `.ticiqi/C_TODO.md`。

用户说“继续”时，读 `.ticiqi/C_TODO.md` 中带“上次进度”的条目，从该进度继续。

当前工作目录下无 `.ticiqi/`：询问用户在哪个项目。

`C_TODO.md` 不存在或为空：回复“请先在提词器点同步待办”，不继续开发。



## 读

1. `.ticiqi/C_TODO.md`（分三区：用户待办区、AI待办区、待修复区）。文件头部有“未标注优先级的条目默认为中优先级”的说明，按此理解。

2. 每条用户待办必读 `.ticiqi/C_DETAIL/{id}/meta.md`（含 id、nodeId、treePath、状态、version、上次进度）和 `requirement.md`（标题、原文、补充原文、验收标准）。

3. 需要六段中某段时，读 `.ticiqi/C_DETAIL/{id}/` 下对应文件：application-scene.md、background.md、frontend.md、backend.md、data-source.md、frontend-layout.md。不需要就不读。

4. 涉及项目级或功能级文件时，先读该组的 `_index.md` 看文件清单，再按需读具体文件。遇到 `_split.md` 表示原文件已拆分，按 `_split.md` 列出的新文件清单去读。

5. 回看已完成：先读 `.ticiqi/C_DONE_INDEX.md` 有效段，再读 `.ticiqi/C_DONE/{id}.md` 对应节。不读已失效段、不读 `C_DONE.jsonl` 历史行。



## 处理优先级

1. 先处理用户待办区。

2. 用户待办处理完后，处理待修复区（归属误判、节点移动待检查）。

3. 待修复处理完后，若 AI待办区有条目，回复用户“用户待办和待修复已处理完，AI待办区有 N 条待检查，是否继续？”用户回答“继续”后再检查 AI待办。



用户待办未处理完时，不读 AI待办区，不检查待修复区（除非用户明确要求）。



## 写

你只写以下两个文件：`C_DONE.jsonl`、`C_ISSUES.jsonl`。`C_DONE_INDEX.md`、`C_DONE/{id}.md`、`C_ISSUES_INDEX.md` 由软件生成，你不写。



每行必须有 `type` 字段，软件按 type 分派。六种行格式：



- 完成用户待办一条：

`{"type":"complete","id":"...","version":N,"summary":"...","files":["..."],"evidence":["..."],"reason":"...","time":"ISO"}`

- 做一半：

`{"type":"partial","id":"...","version":N,"summary":"...","files":["..."],"evidence":["..."],"reason":"...","time":"ISO"}`

- AI 新增：

`{"type":"ai_new","fromReq":"req_003","newText":"...","summary":"...","files":["..."],"evidence":["..."],"reason":"...","time":"ISO"}`

- AI 清理自己的 ai_done 条目：

`{"type":"ai_cleanup","ids":["req_005","req_007"],"reason":"..."}`

- 修复归属误判：

`{"type":"reclassify","reqId":"req_003","newPath":"翻译软件/命令行/帮助提示","reason":"..."}`

- 修复拖拽后引用：

`{"type":"fix_move","nodeId":"...","fixed":["req_001","req_003"],"reason":"..."}`



发现范围外新问题，`.ticiqi/C_ISSUES.jsonl` 追加：

`{"id":"issue_001","fromReq":"...","summary":"...","evidence":["..."],"suggestion":"...","severity":"high|medium|low","time":"ISO"}`



字段约束：

- `complete` / `partial` 行的 `id` 必须来自本次 `C_TODO.md`。

- `complete` / `partial` 行的 `version` 必须来自 C_TODO.md 中该条目的 version，原样回传。

- `ai_new` 行不写 id，软件自动生成。

- `ai_new` 行的 `fromReq` 必须存在：来源用户待办 id 字符串，或 `null`。

- `files` 非空数组（`complete` / `ai_new` 必须非空；`partial` 可为空数组，例如只做了调研）；元素为本次实际改动的文件/文件夹，相对当前目录，文件夹以 `/` 结尾。

- `evidence` 非空数组；元素为 `commit:hash` / 文件路径 / `test:名称`。

- `summary` ≤100 字，`reason` ≤100 字，`newText` ≤200 字。

- `issue.summary` ≤100 字，`issue.suggestion` ≤100 字。

- 只追加，不改旧行。



**同一 id 多报告**：同一 id 一轮可写多条（先 partial 后 complete，或多次 partial）。软件按 id 分组处理：有 complete 行则用 complete，该 id 的 partial 全部作废；只有 partial 行则用最后一条 partial。



## AI新增规范

只写大的新增，不产生调试代码、小功能补丁、临时改动。



可以 AI 新增（满足任一）：

1. 必须补的边界处理：空值、异常、越界、权限、错误提示缺失。

2. 明显缺失的小功能：提示文字、默认值、必填校验、加载态、失败反馈。

3. 用户原需求里隐含但没明写的必要条件（例如“翻译命令行”隐含“参数为空时给帮助”）。



不可 AI 新增、必须写 C_ISSUES（满足任一）：

1. 可优化点：性能、命名、代码结构、风格统一。

2. 与当前需求冲突、需要用户决策的问题。

3. 跨需求的新功能，超出当前 `C_TODO.md` 范围。

4. 改动范围超过当前需求，可能影响其他模块。

5. 你不确定该不该做的问题。



`ai_new` 的 `files` 必须非空——AI 新增定义是“新增功能并做完”，做完必然有改动。只调研或建议的写 C_ISSUES。



## 无法完成的条目

C_TODO 中的条目如果无法完成（依赖缺失、需求矛盾、权限不足），写 `partial` 行，`reason` 字段说明原因。软件会将 syncCount+1，用户读取报告时可见原因。



## AI待办检查与清理

`C_TODO.md` 的“AI待办”区列出 `ai_done` 条目。逐条判断是否仍有效。



清理前提（满足任一条）：

- 前提A：C_TODO.md 中该条“用户已查看：否”，且满足以下任一：

 1. 该条目描述的问题已被用户后续需求覆盖。

 2. 该条目描述的问题已被其他已完成需求顺带解决。

 3. 该条目与当前项目方向冲突。

- 前提B：关联的用户待办（fromReq）已完成或归档，该 ai_done 是附属产物（即使“用户已查看：是”也可清理）。



不能清理：用户已查看过且不满足前提B；不确定时不清理，留给用户。



清理写 `ai_cleanup` 行，一行可清理多条。



## 修改范围规范

用户标记错误时的处理：用户对某条 `ai_done`、`done_ai` 或 `done_user` 条目点“标记错误”时，你把用户新写的原文当作新的 `text`，原 `text` 和 `doneReport` 进失效。你不需要判断用户写得对不对，直接按用户给的执行。



默认可以修改、修改前询问用户：

1. 没有具体用户原文对应的功能（整体架构、界面布局、默认配置）。

2. ai_done 条目（AI 自己新增的，用户还没确认的）。



默认不可以修改、修改前必须询问并让用户确认无歧义：

1. 含用户原文对应的功能（status=todo、status=idea 且有明确 text）。

2. done_ai 状态的条目。

3. done_user 状态的条目。

4. 用户手动填写的标题、需求级六段内容、项目级文件、功能级文件。除 AI 自动写的内容（`C_DONE.jsonl`、`C_ISSUES.jsonl`）外，用户输入的内容 AI 默认不可改。



用户要求“优化”“排版”“重写”某些内容时，只改用户明确指定的部分；未提及的字段逐字保持原样，不顺手重构、不统一风格、不改命名。



## 归属误判修复

待修复区有“归属误判：N条”时，读 `.ticiqi/C_MISCLASSIFIED.jsonl` 每行（文件不存在视为无）：

`{"reqId":"...","suggested":"...","userChose":"...","reason":"...","time":"ISO"}`

本次开发涉及节点里有误判的，检查需求，判断用户选的归属是否合理。合理则写 `reclassify` 行；不合理则在完成报告里说明“用户选的归属 X 我认为有问题，原因是 Y”，不直接改。



## 拖拽后引用修复

待修复区有“节点移动待检查：N条”时，读 `.ticiqi/C_MOVE_PENDING/` 目录下文件（目录不存在或为空视为无）：

`{"from":"...","to":"...","affected":["req_001","req_003"],"reason":"..."}`

检查受影响需求，修正引用路径（relatedIds、fromReq 中引用旧路径的），写 `fix_move` 行。找不到需修的就写 `fix_move` 行并在 fixed 里写空数组。



## 不读不写

不读 `C_ISSUES.jsonl`、`C_ISSUES_INDEX.md`、`C_DONE.jsonl` 历史行、已失效段、其他项目、全量需求、历史对话。

不写 `C_DONE_INDEX.md`、`C_DONE/{id}.md`、`C_ISSUES_INDEX.md`，软件自动生成。



## 约束

原文不可改删，只能追加补充原文；用户要求改原文时拒绝。

每次只处理 `C_TODO.md` 中的条目，不自行加需求、不自行改状态。

你只有被动对话、提问、读写后交付三种能力。软件无法调起你。
