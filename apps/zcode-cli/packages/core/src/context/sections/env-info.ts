// ============================================================
// Environment Info Section Builder
// ============================================================

import type { ContextSection, EnvInfo } from "../types.js";
import type { Model } from "@zcode/contracts";
import { estimateTokens } from "../utils.js";

const ENVIRONMENT_HEADING = "# Environment";
const WORKING_DIRECTORY_LABEL = "Primary working directory";
const IS_GIT_REPOSITORY_LABEL = "Is a git repository";
const PLATFORM_LABEL = "Platform";
const SHELL_LABEL = "Shell";
const OS_VERSION_LABEL = "OS Version";
// const NODE_VERSION_LABEL = "Node version";
// const OPERATING_SYSTEM_LABEL = "Operating system";
const YES_LABEL = "yes";
const NO_LABEL = "no";

export function buildEnvInfoSection(envInfo: EnvInfo, model?: Model): ContextSection {
  const content = buildEnvInfoContent(envInfo, model);

  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(info: EnvInfo, model?: Model): string {
  const hasGitRepository = isEnvInfoGitRepository(info);
  const lines: string[] = [
    ENVIRONMENT_HEADING,
    "You have been invoked in the following environment:",
    `- ${WORKING_DIRECTORY_LABEL}: ${info.cwd}`,
    `- ${IS_GIT_REPOSITORY_LABEL}: ${hasGitRepository ? YES_LABEL : NO_LABEL}`,
    `- ${PLATFORM_LABEL}: ${info.platform}`,
    `- ${SHELL_LABEL}: ${info.shell}`,
    `- ${OS_VERSION_LABEL}: ${info.osVersion}`,
    // 旧环境快照可能携带历史模型字段；渲染只读取本步骤实际执行的 Model。
    ...(model
      ? [`- You are powered by the model named ${model.providerId}/${model.modelId}.`]
      : []),
  ];

  return lines.join("\n");
}

export function isEnvInfoGitRepository(info: EnvInfo): boolean {
  return (
    info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch))
  );
}
