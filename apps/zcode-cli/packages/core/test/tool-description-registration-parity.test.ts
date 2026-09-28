import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_WORKFLOW_TOOL_NAME } from "@zcode/contracts";
import { createToolRegistry } from "../src/tool/registry.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createAgentToolEntry } from "../src/tool/handlers/agent.js";
import { resolveBuiltInToolAllowlist } from "../src/runtime/helpers/tool-allowlist.js";

// 根因见 specs/tool-definition-slimming.md §3.5：Agent 描述里的「工作流必须用
// CreateWorkflow」原先只看 includeDynamicWorkflow（默认 true），而本 fork 的工具面
// 还被 allowlist 收窄（CODING_ONLY_TOOLS 不含 CreateWorkflow），于是描述指向一个
// 不存在的工具。现在描述以**实际注册结果**为准，两者结构上不可能再漂移。

function contractsFor(options: {
  allowedTools?: readonly string[];
  includeDynamicWorkflow?: boolean;
  includeAgent?: boolean;
}): Map<string, string> {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {
    allowedTools: options.allowedTools,
    includeDynamicWorkflow: options.includeDynamicWorkflow,
    includeAgent: options.includeAgent,
  });
  return new Map(
    registry.toContracts().map((tool) => [tool.name, tool.description ?? ""]),
  );
}

const mentionsCreateWorkflow = (description: string | undefined): boolean =>
  (description ?? "").includes(CREATE_WORKFLOW_TOOL_NAME);

test("默认工具面（CODING_ONLY_TOOLS）里 CreateWorkflow 缺席，Agent 描述也不再提它", () => {
  const allowlist = resolveBuiltInToolAllowlist({} as never);
  assert.ok(allowlist);
  assert.ok(
    !allowlist.includes(CREATE_WORKFLOW_TOOL_NAME),
    "本 fork 的默认工具面不含 CreateWorkflow",
  );

  const contracts = contractsFor({ allowedTools: allowlist });
  assert.ok(!contracts.has(CREATE_WORKFLOW_TOOL_NAME));
  assert.ok(
    !mentionsCreateWorkflow(contracts.get("Agent")),
    "CreateWorkflow 不在工具面时，Agent 描述不得指向它",
  );
});

test("显式放开工作流且工具在面里时，Agent 描述保留那一行", () => {
  const contracts = contractsFor({
    allowedTools: ["Agent", CREATE_WORKFLOW_TOOL_NAME],
    includeDynamicWorkflow: true,
    includeAgent: true,
  });
  assert.ok(contracts.has(CREATE_WORKFLOW_TOOL_NAME));
  assert.ok(mentionsCreateWorkflow(contracts.get("Agent")));
});

test("灰度关闭时，即使 allowlist 放行也不提 CreateWorkflow", () => {
  const contracts = contractsFor({
    allowedTools: ["Agent", CREATE_WORKFLOW_TOOL_NAME],
    includeDynamicWorkflow: false,
    includeAgent: true,
  });
  assert.ok(!contracts.has(CREATE_WORKFLOW_TOOL_NAME));
  assert.ok(!mentionsCreateWorkflow(contracts.get("Agent")));
});

// 直接对着 entry 构造函数验证两种取值，避免只经由 registry 间接覆盖。
test("描述按入参决定是否包含工作流行", () => {
  const enabled = createAgentToolEntry({ dynamicWorkflowEnabled: true }).metadata.description;
  const disabled = createAgentToolEntry({ dynamicWorkflowEnabled: false }).metadata.description;
  assert.ok(mentionsCreateWorkflow(enabled));
  assert.ok(!mentionsCreateWorkflow(disabled));
  assert.ok((disabled ?? "").length > 0, "关掉工作流一行不应把整段描述清空");
});
