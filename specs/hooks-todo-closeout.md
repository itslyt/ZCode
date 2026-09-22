# todo-closeout：待办收尾的强制机制（ZCode hook）

状态：已实现。来源：DSH preset `code-max-omni` 的 `todo-closeout.mjs`（165 行 in-process 插件），
按 ZCode 的 hook 契约重写为**配置级机制**——不改 fork 源码，因此没有上游同步成本。

## 为什么需要它

提示词只能"请求"，不能"强制"。DSH 的实现注释就是这条机制的论据：

> The persona asks for a closing `todo_write`; **a prompt is not enforcement**.

ZCode 有 `TodoWrite` 和跨轮持久化的待办（session DB 的 `todo` 表），但没有任何东西阻止一轮
"活儿干完了、列表还开着"就结束——用户看到的是假状态（`in_progress`/`pending` 一堆，实际已完成）。

## 产品规则

1. **只在"本轮写过列表"时提醒**：侧问一句、而长任务本来就开着列表的轮次，不该被说教。
2. **每轮最多提醒一次**：提醒后本轮继续执行，若模型仍不写列表，不再纠缠。
3. **两个方向都要真话**：干完的标完成；真没干完的保持打开并说明还剩什么；**禁止为了关列表把未完成标成完成**。
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

ZCode 侧契约（已核对源码）：

- 输入 stdin JSON：`hook_event_name` / `session_id` / `cwd` / `transcript_path` / `tool_name` /
  `tool_input`（`hooks/configured-runner-input.ts`）
- Stop 额外给 `stop_hook_active`（本轮是否已经因 Stop hook 续跑过）
- 输出 JSON：`continue: true` → 把 `additionalContext` 以 user role 注入并继续本轮
  （`hooks/output.ts` → `runtime/methods/turn-stop.ts:204`，带 `stopHookContinuationCount` 防死循环）

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
