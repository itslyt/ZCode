// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  type JsonSchema,
} from "@zcode/contracts";
import type { ToolEntry } from "../types.js";
import type { AgentProfile } from "../../subagent/profile.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { editAnchoredToolEntry } from "./edit-anchored.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { webFetchToolEntry } from "./webfetch.js";
import { webSearchToolEntry } from "./websearch.js";
import {
  agentToolEntry,
  createAgentToolEntry,
  createTaskToolEntry,
  taskToolEntry,
} from "./agent.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { skillToolEntry } from "./skill.js";
import { todoReadToolEntry, todoWriteToolEntry } from "./todo.js";
import {
  cronCreateToolEntry,
  cronDeleteToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
} from "./cron.js";
import { offPeakCreateToolEntry, offPeakListToolEntry } from "./off-peak.js";
import {
  createEnterPlanModeToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "./plan-mode.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { sendMessageToolEntry } from "./send-message.js";
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";
import { createSubmitResultToolEntry, submitResultToolEntry } from "./submit-result.js";
import { escalateToolEntry } from "./escalate.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readSessionContextToolEntry } from "./read-session-context.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
// import { workflowToolEntry } from "./workflow.js";
import { createToolRuleNameSet } from "../tool-visibility.js";

// direct 分支保留 Glob/Grep 工具实现；embedded search 分支由 registerBuiltInTools
// 统一隐藏 Glob/Grep，并通过 Bash find/grep 接管搜索。

export const builtInTools: ToolEntry[] = [
  readToolEntry,
  writeToolEntry,
  editToolEntry,
  editAnchoredToolEntry,
  // applyPatchToolEntry,
  bashToolEntry,
  globToolEntry,
  grepToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
  askUserQuestionToolEntry,
  sendMessageToolEntry,
  respondToCoordinatorToolEntry,
  submitResultToolEntry,
  // actor 的升级通道。与 submit_result 完全同构：
  // 端口在场即注册（includeEscalate），`tools:"none"` 下由 workflow_child 的 allowlist
  // 补回逻辑救回来。不入 actor 的默认 disallow——最可能撞上未预见之墙的 actor 恰是
  // 作者没标记的那一个。
  escalateToolEntry,
  taskOutputToolEntry,
  taskStopToolEntry,
  readSessionContextToolEntry,
  agentToolEntry,
  taskToolEntry,
  skillToolEntry,
  jsToolEntry,
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  // 保存的定义：写侧 gate 与 CreateWorkflow 同档（alwaysAsk），读侧无 gate。
  saveWorkflowToolEntry,
  // workflow 创作的实验通道：同步、只读（v1）、完全瞬态。
  evalWorkflowSnippetToolEntry,
  // run 内省的两个只读工具：always-on、无 gate。它们不进 WORKFLOW_CHILD_DISALLOWED_TOOLS——
  // 那条禁令的理由是 CreateWorkflow 的 alwaysAsk 在子 runtime 里无窗可弹，只读查询不适用。
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  // run 的恢复入口：与上面两个只读内省工具同族（run_id 键、端口探测失败同款），但它是
  // 执行语义——alwaysAsk 非 yolo 不可（cancelled 是用户的显式停止决定，复活必须先问），
  // 因此须进 WORKFLOW_CHILD_DISALLOWED_TOOLS（child yolo 无窗可弹）。插在 GetWorkflowRun 之后：run 工具簇 list/get/resume 相邻。
  resumeWorkflowRunToolEntry,
  // 升级问答的主代理侧：与上面三个 run 工具同族——
  // 同一个 dwf run 端口、同款 typeof 探测失败。与它们的不同点在下游：它进 actor 会话的
  // 禁用名单（bootstrap 的 workflowActorToolPolicy），子代理不许替主代理作答。
  resolveWorkflowQuestionToolEntry,
  // 定义清单（与上面两个 run 工具是两件事：那是历史，这是可跑的东西）。同为只读、无 gate。
  listSavedWorkflowsToolEntry,
  // 模型目录：同为只读、无 gate 的发现面，服务于 CreateWorkflow / AmendWorkflow 的
  // `subagent_model`。不进 WORKFLOW_CHILD_DISALLOWED_TOOLS
  // ——那条禁令的理由是 alwaysAsk 在 child 里无窗可弹，只读查询不适用。
  listModelsToolEntry,
  // workflowToolEntry,
];

/**
 * 动态工作流灰度门关闭时不注册的十个工具。
 * 灰度关的语义是「没有任何办法开始一条工作流」，所以创建、修订、保存、快照实验与四个
 * run 面工具一起下架；只读的 run 内省工具也在列，因为关闭态下它们只会指向用户无法再操作的历史。
 * `ListModels` 也在列：它唯一的用途是给一次 run 挑 `subagent_model`，没有 CreateWorkflow 可填时留着它只会把模型引向不存在的工具。
 * 旧的 `Workflow` 工具（`/expert` 脚本通道）是另一个功能，**不在**这份名单里。
 */
const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
]);

interface RegisterBuiltInToolsOptions {
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  includeSubmitResult?: boolean;
  /**
   * 在场时 submit_result 以 typed 声明注册（`{ result: <schema> }`，strict 资格），供 dwf mono
   * 子代理；缺席即通用声明。只在 includeSubmitResult 为真时有意义。
   */
  submitResultSchema?: JsonSchema;
  /** actor 的升级通道；门与 includeSubmitResult 同款（注入了 WorkflowEscalatePort 才注册）。 */
  includeEscalate?: boolean;
  includeWorkflow?: boolean;
  includeAutomation?: boolean;
  /** Off-Peak 会话内创建工具面；由 host 的 offPeakToolEnabled flag（灰度/远程门）驱动。 */
  includeOffPeak?: boolean;
  /**
   * 动态工作流灰度门。**只有显式 false
   * 才下架** DYNAMIC_WORKFLOW_TOOL_NAMES：缺席代表调用方不参与灰度（TUI、headless、
   * workflow_child），它们必须保留全部工具面；fail-closed 的缺省值落在协议服务端的
   * appRuntimePreferences，不在这一层。
   */
  includeDynamicWorkflow?: boolean;
  /** node_repl（js）默认关闭，由官方 browser-use 插件启用。 */
  includeNodeRepl?: boolean;
  /** browser-use 说明和 agent.browsers 注入由官方 browser-use 插件 + 宿主 browser bridge 共同启用。 */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  agentProfiles?: readonly AgentProfile[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}

export function registerBuiltInTools(
  registry: {
    register(entry: ToolEntry, options?: { silentDuplicateWarning?: boolean }): void;
  },
  options: RegisterBuiltInToolsOptions = {},
): void {
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowedTools = createToolRuleNameSet(options.disallowedTools);

  // 先算出**真正会被注册**的工具名集合，再据此烘焙描述。
  //
  // 根因：Agent 描述里那条「工作流请求必须改用 CreateWorkflow」原先只看
  // `includeDynamicWorkflow`（默认 true），但本 fork 的工具面还被 allowlist（CODING_ONLY_TOOLS
  // 不含 CreateWorkflow）与 disallowlist 收窄。两套判据彼此独立，于是出现「描述指向一个
  // 不存在的工具」——实测 17 个工具的请求里仍在写 "the CreateWorkflow tool is mandatory"。
  // 用同一趟过滤的结果做判据，描述与工具面**结构上不可能**再漂移。
  const registeredNames = new Set(
    builtInTools
      .filter((entry) => shouldRegisterBuiltInTool(entry, { allowedTools, disallowedTools, options }))
      .map((entry) => entry.metadata.name),
  );

  for (const entry of builtInTools) {
    if (!shouldRegisterBuiltInTool(entry, { allowedTools, disallowedTools, options })) {
      continue;
    }
    registry.register(resolveBuiltInToolEntryForBranch(entry, options, registeredNames), {
      silentDuplicateWarning: options.silentDuplicateWarnings,
    });
  }
}

function shouldRegisterBuiltInTool(
  entry: ToolEntry,
  context: {
    allowedTools: Set<string> | undefined;
    disallowedTools: ReadonlySet<string> | undefined;
    options: RegisterBuiltInToolsOptions;
  },
): boolean {
  const { allowedTools, disallowedTools, options } = context;
  const name = entry.metadata.name;

  if (
    options.embeddedSearchEnabled === true &&
    (name === "Glob" || name === "Grep")
  ) {
    return false;
  }
  if (allowedTools && !allowedTools.has(name)) {
    return false;
  }
  if (disallowedTools?.has(name)) {
    return false;
  }
  if (isSubagentDispatchToolName(name) && options.includeAgent !== true) {
    return false;
  }
  if (name === "Skill" && options.includeSkill === false) {
    return false;
  }
  if (name === "SendMessage" && options.includeSendMessage !== true) {
    return false;
  }
  if (name === "RespondToCoordinator" && options.includeRespondToCoordinator !== true) {
    return false;
  }
  if (name === "submit_result" && options.includeSubmitResult !== true) {
    return false;
  }
  if (name === "escalate" && options.includeEscalate !== true) {
    return false;
  }
  if (name === "Workflow" && options.includeWorkflow !== true) {
    return false;
  }
  if (
    (name === "CronCreate" || name === "CronList" || name === "CronUpdate" || name === "CronDelete") &&
    options.includeAutomation !== true
  ) {
    return false;
  }
  if ((name === "OffPeakCreate" || name === "OffPeakList") && options.includeOffPeak !== true) {
    return false;
  }
  if (options.includeDynamicWorkflow === false && DYNAMIC_WORKFLOW_TOOL_NAMES.has(name)) {
    return false;
  }
  if (name === "js" && options.includeNodeRepl !== true) {
    return false;
  }
  return true;
}

function resolveBuiltInToolEntryForBranch(
  entry: ToolEntry,
  options: RegisterBuiltInToolsOptions,
  registeredNames: ReadonlySet<string>,
): ToolEntry {
  // 描述里的工作流一行以**实际注册结果**为准，而不是 includeDynamicWorkflow 单一开关：
  // allowlist（本 fork 的 CODING_ONLY_TOOLS 不含 CreateWorkflow）同样会让它缺席。
  // 见 registerBuiltInTools 的根因注释。
  const dynamicWorkflowToolPresent = registeredNames.has(CREATE_WORKFLOW_TOOL_NAME);
  if (entry.metadata.name === "Bash") {
    return createBashToolEntry({
      bashTimeoutPolicy: options.bashTimeoutPolicy,
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === SUBMIT_RESULT_TOOL_NAME && options.submitResultSchema !== undefined) {
    return createSubmitResultToolEntry(options.submitResultSchema);
  }
  if (entry.metadata.name === "Agent") {
    return createAgentToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
      profiles: options.agentProfiles,
      dynamicWorkflowEnabled: dynamicWorkflowToolPresent,
    });
  }
  if (entry.metadata.name === "Task") {
    return createTaskToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
      profiles: options.agentProfiles,
      dynamicWorkflowEnabled: dynamicWorkflowToolPresent,
    });
  }
  if (entry.metadata.name === "EnterPlanMode") {
    return createEnterPlanModeToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === "js") {
    return createJsToolEntry({
      browserUseEnabled: options.includeBrowserUse === true,
    });
  }
  return entry;
}
