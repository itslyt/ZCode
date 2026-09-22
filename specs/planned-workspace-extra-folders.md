# [规划中，未实现] 项目附加目录（跨仓工作）

状态：**仅记录，暂不实现**（2026-09-22 评估结论）。触发条件见文末。

## 需求背景

Codex 的「Create project」支持一个项目挂多个 source folder，其中一个为 Primary（截图见对话记录）。当前 ZCode 一个
workspace 只对应一个根目录，用户偶尔需要在一次任务里改隔壁仓库。

## 现状：不做也能跨仓改

工具路径策略**故意不硬拦 workspaceRoot 之外的路径**：

- `apps/zcode-cli/packages/core/src/tool/path-policy.ts:36` — 注释明确 "Current release intentionally does not
  hard-block paths outside workspaceRoot"，原因是 subagent 可能需要查看用户指定的兄弟仓库或外部文件。
- `resolveWorkspacePath` 只把相对路径按 workingDirectory 解析、校验绝对路径，然后原样返回（同文件 19-39）。
- 权限按「模式 + 工具能力」判定，不按路径范围：`core/src/tool/executor/permission-capability.ts:8-22`；
  模式取值 `plan / build / edit / yolo / auto`（`contracts/src/tools/plan-mode.ts:23`），项目模式持久化在
  `session-store.port.ts:1120`。

结论：消息里写绝对路径（或让 agent `cd ../other-repo`）即可改隔壁仓，零成本。缺的是**便利性**：文件树、搜索、
@ 提及、上下文只覆盖主根。

## Codex 参考实现（供将来对照）

- 协议：`runtime_workspace_roots: Vec<AbsolutePathBuf>` 随 thread create/resume 下发
  （`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:85,201,394,449,588,645`），另有 `cwd` 表示 Primary。
- 核心：`workspace_roots` + `workspace_roots_explicit`（`codex-rs/core/src/config/mod.rs:844-847,2616-2619`），
  物化为权限/沙箱条目（同文件 841-843），由 apply_patch / unified_exec / sandboxing 消费
  （`core/src/tools/runtimes/apply_patch.rs:102`、`unified_exec.rs:595`、`core/src/tools/sandboxing.rs:397,498`）。
- Git **没有**多仓聚合：`git_diff_to_remote(params.cwd)`（`codex-rs/app-server/src/request_processors/git_processor.rs:15,20,24`）。

## 将来若做：廉价版形态

只加「附加目录」作为**可见性与上下文范围**，不动项目模型与任务索引。

- 入口：项目「…」菜单「附加目录…」（或项目设置页），可添加/移除；主目录固定不可移除。
- 效果：@ 提及与文件搜索覆盖附加目录；agent 上下文带上一行「主目录 X；附加可读写目录 A、B」。
- 存储：复用 host `local_settings`（`namespace: "workspace"`、`key: "extraFolders"`、`scope: "project"`、
  `scopeID: projectId`），参考 `adapters/src/storage/session-store/repositories/local-settings.ts:7-40`。
  不改 tasks-index，不改 v4 会话协议。
- 传递：host 读设置 → 会话启动交给 CLI；`workspaceRoot` 仍是主根、cwd 语义不变
  （`core/src/tool/executor/impl.ts:67-73`），`extraRoots` 只进提示词与搜索范围。
- 明确不做：任务归属（仍属主项目）、git 面板（仍看主根）、终端默认 cwd、远程 SSH 项目附加本地目录。
- 第一版不做文件树多根展示（成本大头），用「能被搜索/@ 到」替代。

风险：提示词列出目录会让 agent 更爱动别的仓，需要一句默认约束；多根搜索要定去重与路径展示规则；
远程 workspace 需显式禁用。

## 触发条件（满足其一再启动）

1. 出现「一次任务常态性跨 2-3 个仓、且希望搜索/@/上下文都覆盖」的实际工作流；
2. 用户反馈「每次都要手写绝对路径，太啰嗦」成为高频抱怨；
3. 上游（Codex/官方 ZCode）把多根作为一等能力，需要对齐。
