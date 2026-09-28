# todo-closeout：待办收尾的强制机制（ZCode hook）

状态：已实现。来源：DSH preset `code-max-omni` 的 `todo-closeout.mjs`（165 行 in-process 插件），
按 ZCode 的 hook 契约重写为**配置级机制**——不改 fork 源码，因此没有上游同步成本。

已知展示副作用与候选修法见「同轮双正文与展示层折叠」；量化工具：
`scripts/hooks/analyze-turn-collapse.mjs`（只读会话库）。

## 为什么需要它

提示词只能"请求"，不能"强制"。DSH 的实现注释就是这条机制的论据：

> The persona asks for a closing `todo_write`; **a prompt is not enforcement**.

ZCode 有 `TodoWrite` 和跨轮持久化的待办（session DB 的 `todo` 表），但没有任何东西阻止一轮
"活儿干完了、列表还开着"就结束——用户看到的是假状态（`in_progress`/`pending` 一堆，实际已完成）。

## 产品规则

1. **只在"本轮写过列表"时提醒**：侧问一句、而长任务本来就开着列表的轮次，不该被说教。
2. **每轮最多提醒一次**：提醒后本轮继续执行，若模型仍不写列表，不再纠缠。
3. **两个方向都要真话**：干完的标完成；真没干完的保持 `pending`/`in_progress` 并说明还剩什么；
   **禁止为了关列表把未完成标成完成**。
4. **失败绝不影响对话**：脚本任何异常都静默退出（exit 0），最多写一次 stderr 警告。

## 状态所有者

脚本自己维护状态文件，不读 session DB（避免耦合 DB schema 与 dev/隔离模式的路径差异）：

- 目录：`$ZCODE_TODO_CLOSEOUT_STATE_DIR`，缺省 `~/.zcode/hooks/state/todo-closeout/`
- 文件：`<stateDir>/<session_id>.json`，内容 `{ writtenAt, consumedAt?, todos: [{content, status}] }`

"本轮写过列表"的判定：`writtenAt !== consumedAt`。`PostToolUse(TodoWrite)` 写 `writtenAt`，
`Stop` 提醒后把 `consumedAt` 置为 `writtenAt`。

## 接口

两个 hook 事件，同一个脚本，按 stdin 的 `hook_event_name` 分派：

| 事件          | matcher     | 行为                                                                                                |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `PostToolUse` | `TodoWrite` | 从 `tool_input.todos` 记录列表与 `writtenAt`，静默退出                                              |
| `Stop`        | 无          | 有未完成项且本轮写过列表 → 输出 `{"continue": true, "additionalContext": "<notice>"}`；否则静默退出 |

提醒文案只有一种（`NOTICE_TEXT`），要求把干完的标完成、真未完成的保持打开并说明还剩什么。
**不要求模型静默**：曾尝试加「只调 TodoWrite、不输出正文」来避让展示层折叠，真机验证无效（见下节）。

ZCode 侧契约（已核对源码）：

- 输入 stdin JSON：`hook_event_name` / `session_id` / `cwd` / `transcript_path` / `tool_name` /
  `tool_input`（`hooks/configured-runner-input.ts`）
- Stop 额外给 `stop_hook_active`（本轮是否已经因 Stop hook 续跑过）
- 输出 JSON：`continue: true` → 把 `additionalContext` 以 user role 注入并继续本轮
  （`hooks/output.ts` → `runtime/methods/turn-stop.ts:204`，带 `stopHookContinuationCount` 防死循环）

### 同轮双正文与展示层折叠（已知代价，未修）

轮只有一段可见正文：`conversationTurnRenderUnits.ts` 的 `latestAssistantTextRow` 只取**最后一段**
（`actionAssistantTextRow ?? 末行若是正文则取它`），其余正文连同行内旁白一起落进过程折叠组；
折叠组在轮已结束时默认收起（`conversationTurnWorkSegments.ts` 的 `assistantHistoryDefaultOpen`）。

**经实测，主因不是本 hook**。用 `scripts/hooks/analyze-turn-collapse.mjs`（只读会话库）解剖：

- 全库 819 次 mid-turn 注入中 **762 次（93%）是 `todo_reminder`**（ZCode 内置的 TodoWrite 使用提醒，
  由 `turn-loop.ts` 注入），其余为系统提醒、后台通知等。
- 本 hook 的 `NOTICE_TEXT` 命中的**全是 assistant 正文**（是模型在对话里引用过它），
  从未作为 `hidden` 注入行落库。即 Stop 续跑注入的 `hook_context` 行**不持久化**
  （`turn-stop.ts:208` 只写内存 messageHistory，见 `hooks.ts:106`）。
- 本 hook 历史上只触发 4 次（`state/` 目录），相对内置提醒可忽略；但触发时同样会造成切分。

**尝试过的 hook 侧避让（无效，已回退）**：在 notice 里要求模型“只调 TodoWrite、不输出正文”。
真机（headless glm，两个场景）证实模型不遵守，两段正文依在；且与产品规则 3 冲突。

**“不折叠正文”不可行**：实测段长 <200 字符的占 **89.8%**（工具间旁白），
每轮正文段数中位 2、最大 316。全展开会让长任务轮冒出几十条碎片气泡。

**B''（UI 跳过隐藏注入行之后的正文）——不可实现，已否决**。原设想依赖 UI 能拿到那条隐藏注入行，
但实测不存在这个信号：

- `hook_context`（本 hook）**根本不落库**：`turn-stop.ts:208` 只写内存 messageHistory（`hooks.ts:106`）。
- `todo_reminder`（内置，占注入量 762/819=93%）在投影层为 `providerContextOnly`
  （`conversation-message-projection-policy.ts:110`），`transcript-hydration.ts:1846` 跳过；
  实时链路根本不发事件，不产生任何 `ConversationRow`。
- `assistantTextRow` 上无任何字段可区分注入前/后：`turnId`/`productTurnId` 不变，
  `rowId` 中间无插行，`assistantResponseId` 每个模型步都变（不具区分性）。

且 `product-projection.ts:5139` 有明确约束：

> 分段边界必须由 CLI 记录，React 不能按邻接行猜。

**候选修法（均未实施，用户 2026-09-28 决定先不动）**：

1. **UI 启发式**：短旁白（<200 字）继续折叠，成段正文保持可见。不需改协议与 CLI。
   实测（448 turn）：可见气泡中位 **1**、均值 1.36、p90 2，**94.0% 的轮次 <=2 个**；
   对比全展开的均值 10.12、28.1% 的轮次 >=8 个。代价：按长度启发式而非语义判断；
   长任务轮仍可能出现 17 个气泡（最大值）。
2. **CLI 开启工作段**（语义最正）：把 `openGuidedWorkSegment`（`product-projection.ts:5128`，
   现仅 `delivery === "guide"` 触发）推广到 `todo_reminder` / Stop 续跑，UI 再按段选正文。
   代价：动协议 + CLI + UI 三层。
3. **消除切分源**：内置 todo 提醒改到轮首注入，一次消除 93% 的切分。代价：改变提醒时效语义。

**注意**：选项 1 在 UI 层，不违反后文的 CLI 约束——它不推断“注入边界”，只按段长度做展示取舍。

### 复现与度量

用 `scripts/hooks/analyze-turn-collapse.mjs`（只读会话库，不改状态）：

```bash
node scripts/hooks/analyze-turn-collapse.mjs                 # 全局统计
node scripts/hooks/analyze-turn-collapse.mjs --session <id>  # 附加逐轮解剖
```

首次实测快照（分母随对话增长而小幅上浮，比例稳定）：

- 每轮正文段数：中位 **2**，最大 **316**；>=8 段的轮次占 **28%**。
- 段长 <200 字符的占 **89.8%**（工具间旁白）——这是全展开方案不可行的原因。
- 注入把正文切成两截的轮次 ≈ **41%**；其中末段短于前文最长段的（真答案可能被折）≈ **14%**。

## 配置（user 层，`~/.zcode/cli/config.json`）

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PostToolUse": [
        {
          "matcher": "TodoWrite",
          "hooks": [
            {
              "type": "process",
              "command": "/bin/sh",
              "args": ["<repo>/scripts/hooks/run-todo-closeout.sh"],
              "timeoutMs": 10000
            }
          ]
        }
      ],
      "Stop": [
        {
          "hooks": [
            {
              "type": "process",
              "command": "/bin/sh",
              "args": ["<repo>/scripts/hooks/run-todo-closeout.sh"],
              "timeoutMs": 10000
            }
          ]
        }
      ]
    }
  }
}
```

`hooks.enabled` 默认 `false`（`DefaultHooksRuntimeConfig`），必须显式打开。user 层不需要 workspace 信任流程。

## 验收场景

1. 本轮 `TodoWrite` 留下 `in_progress` → 结束该轮时收到提醒并继续（实测：见下）。
2. 同一轮第二次 Stop（`stop_hook_active: true`）→ 不重复提醒。
3. 本轮 `TodoWrite` 全部 `completed` → 不提醒。
4. 本轮没写过 `TodoWrite`（只是提问）→ 不提醒。
5. stdin 非法 / 状态文件损坏 / 目录不可写 → 静默退出，不影响对话。

## 实测记录

- 单元测试：`node --test scripts/hooks/todo-closeout.test.mjs`（10 个用例，覆盖上述 1-5）。
- 配置校验：`~/.zcode/cli/config.json` 的 `hooks` 过 `HooksRuntimeConfigPatchSchema` 通过。
- 启动器：在 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`（模拟 Finder 启动的 App）下能找到 nvm 的 node 并正常输出 steer。

### 真机验证（内置 agent CLI 无头会话）

命令：`node packages/desktop/bundled-agents/darwin-arm64/glm/zcode.cjs -p "<让模型写两个任务，一个 completed 一个 in_progress，写完就结束>" --cwd /tmp/zcode-hook-test --surface terminal`

| 组                  | provider 请求数                                        | 最终回复                                                        |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| 开启 hook           | 3（`tool-calls` → `stop` 26 token → `stop` 334 token） | 主动说明“任务乙背后没有实际动作，所以不该改成 completed 来收尾” |
| 关闭 hook（对照组） | 2（`tool-calls` → `stop` 30 token）                    | 只回一句“已写入两个任务”，不做收尾判断                          |

hook 诊断日志（`ZCODE_TODO_CLOSEOUT_DEBUG=1`）显示 Stop 事件被调用两次：

```
stop  {"active":false,"consumed":false,"open":1}   → steer {"open":1}
stop  {"active":true, "consumed":true, "open":1}   → 静默
```

即**每轮只 steer 一次**，第二次是 ZCode 自己带上 `stop_hook_active: true` 的复查，被本机制主动让过。

**代价（必须知晓）**：被 steer 的轮次会多一次 provider 请求（上表 2 → 3）。这是转向型机制的固有成本（DSH 同样是 steer 后再跑一步）。

副作用：验证过程中在真实 session DB 里留下了 5 个测试会话（项目目录 `/tmp/zcode-hook-test`），未自行删除——
应用里的删除入口会同时清理索引与 tombstone，用原生 SQL 删会绕过这些清理。需要清掉的话用应用删除即可。

## 与 DSH 版本的差异

| 维度     | DSH                                                     | ZCode 本实现                                      |
| -------- | ------------------------------------------------------- | ------------------------------------------------- |
| 载体     | in-process Cordis 插件，`ctx.on('agent/turn-stopping')` | 外部进程 hook，`Stop` 事件 + `continue: true`     |
| 状态来源 | 冷扫持久事件日志（`session/event`）                     | `PostToolUse(TodoWrite)` 落状态文件               |
| 去重     | 自己维护 `steeredTurns` 集合                            | `consumedAt` + ZCode 的 `stop_hook_active`        |
| 子代理   | `delegationDepth` 判断，默认不提醒                      | 未区分（ZCode hook 载荷无该字段），子代理同样提醒 |
