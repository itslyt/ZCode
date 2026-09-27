# 个人化精简：去掉更新/引导/自动化入口/建议胶囊，默认完全访问

状态：已实现。背景：`custom` 分支是自用 fork，用户明确"这个 zcode 就我自己在用"，要求按个人使用习惯改造：
只保留编程模式相关的入口，去掉会覆盖自建包、以及用不到的引导与推荐。

## 1. 去掉自动更新检测与更新入口

产品规则：

1. 不再自动检查更新（自建 Preview 包被官方更新覆盖会丢掉本 fork 的改动）。
2. 不再出现更新入口（标题栏更新徽标、帮助菜单"检查更新"）。
3. 不触发远端强制升级拦截（`maybeBlockStartupForForceUpdate`）。

实现：`packages/desktop/src/main/index.ts` 的 `initAutoUpdater({ enabled })` 改为常量 `AUTO_UPDATE_ENABLED = false`；
UI 侧移除 `DesktopTopOverlay` 的 `UpdateStatusButton` 与帮助菜单里的检查更新项。
更新模块本身保留（不删上游代码，恢复只需把常量改回 true）。

## 2. 去掉系统设置里的引导入口

`packages/ui/src/SettingsPage.tsx` 侧栏底部的"引导"按钮（`Rocket` 图标 → `open_onboarding`）移除。
`OccupationOnboarding` 组件保留（首次启动流程不受影响，用户已走过）。

## 3. 侧边栏去掉自动化入口

`packages/ui/src/WorkspaceSidebar.tsx` 的"自动化"按钮（`TID_AUTOMATIONS_OPEN` → `handleOpenAutomationsMain`）移除。
自动化页面本体保留在路由里（未注册工具面已使其不可用），只去掉入口。

## 4. 新建任务默认权限改为完全访问

`permission.mode` 默认值 `"build"`（界面文案"变更前确认"）→ `"yolo"`（"完全访问"），
位于 `apps/zcode-cli/packages/contracts/src/config/index.ts` 的 `DefaultRuntimeConfig`。

注意：项目级"上次选择"（session DB `local_setting`）优先于默认值，所以**已存在且切过模式的项目仍用其持久值**；
新项目、以及没有持久值的项目走新默认。要全局统一需在界面里切一次，或清掉 `local_setting` 里的对应行。

## 5. 去掉空态建议胶囊（周报总结 / 报错修复 / PPT 制作 / 闲时任务）

原理（用户提问）：

- 胶囊列表来自 **Client Scenes 的 `draft-suggestion` 远端场景配置**，本地 `featureSuggestedPrompts` 是回退语料。
- 点前三个只是把一段**预置提示词**填进输入框（`resolveDraftSuggestedPromptText`），本身不含任何自动化能力；
  文案由服务端下发，所以本地 i18n 里搜不到"周报总结""报错修复"。
- "闲时任务"是带 `DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK` 动作的导航项，点了跳自动化页。
- 结论：前三个是纯提示词模板（可自己手打），第四个是导航捷径——对"只写代码"的场景都没用。

实现：`packages/ui/src/v4/SessionPane.tsx` 不再挂载 `ConversationDraftSuggestedPromptsContainer`（同时去掉主动推荐区）。
容器组件保留（上游代码），只取消挂载点。

## 验收

1. 启动后标题栏无更新徽标、帮助菜单无"检查更新"；`~/.zcode` 日志无 `[auto-update]` 检查记录。
2. 设置侧栏无"引导"入口。
3. 侧边栏无"自动化"入口。
4. 新项目新建任务，输入框权限显示"完全访问"。
5. 空态无四个建议胶囊。
6. `pnpm typecheck` / `pnpm lint` / `pnpm fmt:check` / `pnpm architecture:check --changed` 全绿。

## 实测记录（打包产物 + CDP 核验）

产物：`packages/desktop/dist/ZCode Preview-3.14.0-mac-arm64.dmg`（重建 agent 包后打包）。

| 项           | 验证方式                                                                                                                                  | 结果       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 更新徽标     | 打包 App 的 DOM `innerText` 查“更新”                                                                                                      | 无         |
| 更新检测     | 读打包后 agent 包：`initAutoUpdater` 只读 `AUTO_UPDATE_ENABLED`（false）；`autoUpdater.ts:59` 注释确认 `enabled: false` 只清轮询并 return | 不检查     |
| 设置里的引导 | 打开设置读 nav 项（常规/外观/模型设置/…/使用统计）                                                                                        | 无“引导”   |
| 侧边栏自动化 | DOM 查“自动化” + `data-testid` 含 automation 的元素                                                                                       | 均无       |
| 默认权限     | 新建任务读 `chat-mode-select-trigger` 文案                                                                                                | “完全访问” |
| 四个建议胶囊 | DOM 查四个文案与 suggest 相关 testid                                                                                                      | 均无       |

源码级验证（DOM 未能覆盖）：帮助菜单的“检查更新”项已从 `WorkspaceHelpMenuButton` 移除（DOM 检查时菜单未展开，未能证实；该 JSX 已删、typecheck 通过）。

命令：`pnpm typecheck` 0 error、`pnpm lint` 74 warnings/0 errors（基线一致）、`pnpm fmt:check` 通过、
`pnpm architecture:check --changed` 0 新增违规。

副作用：验证时在真实 session DB 里留下 `/tmp/zcode-hook-test`（5 个）与 `/tmp/zcode-mode-test`（1 个）测试会话，未自行删除，可在 App 里删。

## 6. 去掉 4 个插件子智能体（配置级）

现象：设置 → 子智能体 页面列出 4 条 `visual-judge`（Documents / Pdf / Presentations / Spreadsheets），
每条标“2 个工具”。用户没有对应插件能力需求。

来源：这 4 条不是内置子智能体，而是 4 个官方插件（`documents` / `pdf` / `presentations` / `spreadsheets`，
定义见 `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`）各自 seed 的 `agents/visual-judge.md`。
这些插件是拆分后的新插件，`defaultEnabled: true`，所以用户把旧的聚合插件 `document-skills` 置为 false 并不能挡住它们。

处理：在 `~/.zcode/cli/config.json` 的 `plugins.suppressedBuiltins` 里加入这 4 个插件 id。
该开关在 seed/discovery 层生效（`bundled-plugins.ts`），所以插件不安装、不出现在插件列表、
子智能体也不被发现——比 `enabledPlugins: false`（装了但不启用）更彻底。

核验（打包 App + CDP）：设置 → 子智能体只剩“内置子智能体”段（`general-purpose`、`Explore`），
`visual-judge` 出现 0 次；`zcode plugins list` 只剩 `node-repl-host`（启用）与 `browser-use`（禁用）。
副作用：插件带的 docx/pptx/xlsx 技能也不再进提示词（真实请求里已搜不到这三个技能名）。

## 7. 子智能体的实际使用情况（数据）

- 设置页的“继承默认”只是给每个子智能体指定**模型/思考等级**，不新增能力；不委派就无影响。
- 真实数据：82 个会话 / 1282 次工具调用中，`Agent` 调用 **0 次**；
  仅有的 2 个 `parent_id` 子会话 `task_type` 都是 `selection_side_chat`（划词提问），不是子智能体运行。
- 两个内置子智能体：`general-purpose`（全部工具，多步研究委派）、`Explore`（7 个工具，只读广域搜索）。
  当前提示词里“委派只用于答案很短的广域探查”那条指向的就是 `Explore`。
- 若要彻底去掉委派：从 `CODING_ONLY_TOOLS` 里移除 `Agent`，省 2 834 字符 schema（27 499 的 ~10%）。
  （`SendMessage`/`TaskOutput`/`TaskStop` 是为后台任务准备的，与 Agent 独立，可保留。）

## 8. 工具面调整：恢复 Glob/Grep，去掉计划模式与 WebSearch

### 8.1 实测基线

从真实请求体（`~/.zcode/cli/rollout/model-io-sess_*.jsonl`）量出：本 fork 默认工具面是 **16 个工具 / 30 928 字符 / 7 742 tokens**（按 `core/context/utils.ts` 的 `estimateTokens`，与界面同源）。

构成为 **描述 4 552 + schema 2 833**，而 schema 里还有 1 450 是参数 `.describe()` 散文——**散文合计占 78%**，真正的结构只占 ~18%。所以降成本要从描述开刀，不是改 schema。

最重的三笔：`AskUserQuestion` 1 229、`EnterPlanMode` 1 082、`ExitPlanMode` 695，合计 **3 006 = 39%**。`EnterPlanMode` 的描述是 **4 011 字符纯散文**（7 条带例子的判断条件），而它的 schema 只 30 token。

对比 DSH（同一个模型跑的另一套 harness）：DSH 是一句话描述（`"Read a UTF-8 text file and return line-numbered content."`），全部工具包描述合计约 3 242 tokens；本 fork 仅 16 个活跃工具就 4 552。**差距在英文散文，不在工具数或 schema 结构。**

### 8.2 恢复 Glob/Grep

现状：这两个工具在 `builtInTools` 与 `CODING_ONLY_TOOLS` 里都有，但**运行时看不到**——`embedded search branch` 把它们拿掉了，搜索改走 Bash 的 `find`/`grep`（带前导注入）。移除发生在三处，全部派生自 `resolveRuntimeEmbeddedSearchEnabled`：

1. `registerBuiltInTools` 跳过注册（`handlers/index.ts`）；
2. `refreshBranchAwareBuiltInTools` 主动 `unregister`（`embedded-search-branch.ts`）；
3. `filterEmbeddedSearchRuntimeVisibleTools` 从模型可见列表里滤掉。

所以只需关一个开关：`embedded-search/capability.ts` 的 `ENABLE_EMBEDDED_SEARCH_BRANCH = true` → `false`。三处同时恢复。

**为什么不只改一处**：三处都派生自同一个 resolve，而且 Bash 提示词的引导必须与工具面一致——`embeddedSearchEnabled` 为真时避让清单是 `cat/head/tail/sed/awk/echo`（**不避** `find`/`grep`，即鼓励用 Bash 搜），若一边恢复 Glob/Grep 一边保留这条引导，模型会被同时告知“用 Bash 搜”和“有专用搜索工具”。所以开关与提示词要一起翻。

连带效果（都是同一个设计选择的后果，方向一致）：Bash 避让清单改回含 `find`/`grep`；Bash 前导注入关闭；`Explore` 子代理切到 direct 那套工具面（两套都含 Glob/Grep，差别在别的工具）。

### 8.3 去掉计划模式工具

`EnterPlanMode` + `ExitPlanMode` = **1 777 tokens = 23%** 的工具定义，其中 1 483 是描述散文。用户不用计划模式。

**只下工具，不下模式。** 计划模式不是一个开关，它穿透了运行时：`intent.planEnabled` 持久化、`target.ts`（2 处）、`turn-loop.ts`、`timeline-persistence.ts`、`steering.ts`、`message-persistence.ts`、i18n 与 UI 模式选择器。全部拆掉是另一件事，本轮不做。

后果说清楚：模型**不能自己**进出计划模式了（两个工具就是它唯一的进出手段），但 UI 选择器与 `/plan` 仍能切进去。用户已声明不会选，所以这个组合可接受；真正要彻底去掉模式需要单独立项。

### 8.4 WebSearch（恢复）

它不是 ZCode 自己调搜索 API，而是**模型 provider 的原生工具**：`runtime/methods/config.ts` 的
`shouldExposeWebSearch` 读 `model.properties.supportsNativeWebSearch`（模型配置界面的“原生联网搜索”
复选框），这是工具面之外的第二道门。

`cdaffe1` 曾把它从 `CODING_ONLY_TOOLS` 移除（当时用户 provider 未勾该能力，行为上无变化）。
现恢复：`CODING_ONLY_TOOLS` 重新包含 `WebSearch`，不再由本 fork 的白名单提前拦掉。

**仍生效的门（恢复白名单不等于一定能用）**：

1. `supportsNativeWebSearch === true` 才会出现在请求的 `toolNames` 里；否则注册了也不可见。
2. `adapters/model/tool-transform.ts` 的 `toAiSdkProviderNativeTool` **目前只编码 `anthropic`**：
   `openai` / `openai-compatible` 会抛 `Provider API kind ... does not encode provider-native WebSearch`。
   所以走 OpenAI 兼容端点的 provider（含本机 `openai-responses` 网关）能看到工具、调用即报错；
   要让这条链路真跑通，需在适配器里补 OpenAI Responses 的 provider-native web search 编码。

### 8.5 `/plan` 与 `/goal`

- `/plan` 是 App Composer 专用命令，语义就是“切到 Plan mode”，**依赖计划模式存在**。本轮保留模式，所以它仍可用；但模型自己不能进出了。
- `/goal` 与会话目标相关（`/goal [action]`，同 `--target`），**与计划模式无关**，继续有效。

### 验收

1. 真实请求的 `toolNames` 含 `Glob`/`Grep`，不含 `EnterPlanMode`/`ExitPlanMode`；`WebSearch` 是否出现取决于当前模型的 `supportsNativeWebSearch`。
2. 工具定义 token 数下降（预期 7 742 → 约 5 965，−23%）。
3. `Explore` 子代理仍能搜索（它的两套工具面都含 Glob/Grep）。
4. 不改 `builtInTools` 代码（工具定义保留，随时可恢复）。
