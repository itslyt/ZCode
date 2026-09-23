// 本 fork 关闭 embedded search branch，改用专用的 Glob/Grep 工具。
//
// 上游默认进入这个 branch：搜索走 Bash 的 find/grep（带前导注入），同时把 Glob/Grep 从模型
// 可见的工具面里拿掉（三处：注册时跳过、refresh 时 unregister、filter 时滤掉，均派生自
// resolveRuntimeEmbeddedSearchEnabled）。本 fork 要那两个工具，所以翻这个开关——它是三处的
// 共同源头，改它一处即可同时恢复。
//
// 不要只改一处：Bash 的避让清单与工具面必须一致。开关为真时清单是 cat/head/tail/sed/awk/echo
// （不避 find/grep，等于鼓励用 Bash 搜），若一边恢复 Glob/Grep 一边留着那条引导，模型会同时
// 被告知“用 Bash 搜”和“有专用搜索工具”。
const ENABLE_EMBEDDED_SEARCH_BRANCH = false;

interface EmbeddedSearchBranchCapabilityContext {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
}

type EmbeddedSearchBranchCapabilityReason =
  | "supported"
  | "disabled_by_global_flag"
  | "bash_unavailable";

interface EmbeddedSearchBranchCapabilityDecision {
  reason: EmbeddedSearchBranchCapabilityReason;
  useEmbeddedSearchBranch: boolean;
}

function evaluateEmbeddedSearchBranchCapability(
  context: EmbeddedSearchBranchCapabilityContext,
): EmbeddedSearchBranchCapabilityDecision {
  const branchEnabled = context.embeddedSearchBranchEnabled ?? ENABLE_EMBEDDED_SEARCH_BRANCH;

  if (!branchEnabled) {
    return {
      reason: "disabled_by_global_flag",
      useEmbeddedSearchBranch: false,
    };
  }

  if (!context.bashAvailable) {
    return {
      reason: "bash_unavailable",
      useEmbeddedSearchBranch: false,
    };
  }

  return {
    reason: "supported",
    useEmbeddedSearchBranch: true,
  };
}

export function resolveEmbeddedSearchBranchCapability(input: {
  bashAvailable: boolean;
  embeddedSearchBranchEnabled?: boolean;
}): EmbeddedSearchBranchCapabilityDecision {
  return evaluateEmbeddedSearchBranchCapability({
    bashAvailable: input.bashAvailable,
    embeddedSearchBranchEnabled: input.embeddedSearchBranchEnabled,
  });
}
