import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@zcode/contracts";
import {
  createWorkspaceHookSourceInput,
  discoverWorkspaceHookConfigPaths,
  workspaceHooksConfigSchema,
  type WorkspaceHookSourceInput,
} from "@zcode/shared/workspace-hook-discovery";
import { loadFileConfig, type LoadedConfig } from "./file-config.adapter.js";

const CURRENT_DIRECTORY = ".";

export interface ProjectConfigFile {
  baseDir: string;
  config: RuntimeConfigPatch;
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidate?: WorkspaceHookSourceInput;
  loaded: boolean;
  path: string;
}

export interface ProjectConfigDiscovery {
  files: ProjectConfigFile[];
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidates: WorkspaceHookSourceInput[];
  loaded: boolean;
  paths: string[];
  mcpServerNames: string[];
}

export function loadProjectConfigs(
  workingDirectory?: string,
  explicitProjectConfigPath?: string,
): ProjectConfigDiscovery {
  const resolvedWorkingDirectory = resolve(workingDirectory ?? process.cwd());
  const files = discoverWorkspaceHookConfigPaths({
    workingDirectory: resolvedWorkingDirectory,
    ...(explicitProjectConfigPath ? { explicitProjectConfigPath } : {}),
  }).map((ref, discoveryOrder) =>
    loadProjectConfigFile(ref.path, {
      discoveryOrder,
      explicitProjectConfig: ref.explicitProjectConfig,
      workingDirectory: resolvedWorkingDirectory,
    }),
  );

  return summarizeProjectConfigs(files);
}

export function loadProjectConfigFile(
  path: string,
  options: {
    discoveryOrder?: number;
    explicitProjectConfig?: boolean;
    workingDirectory?: string;
  } = {},
): ProjectConfigFile {
  const result = loadFileConfig(path);
  const baseDir = getProjectConfigBaseDir(result.path);
  const diagnostics = [...result.diagnostics];
  const hooks = result.loaded ? result.config.hooks : undefined;
  const projectEnv = result.loaded ? result.config.env : undefined;

  if (hooks) {
    diagnostics.push({
      code: "config_project_hooks_pending_trust",
      filePath: result.path,
      message: "Project hooks are pending workspace trust and remain blocked",
      path: "hooks",
      severity: "warning",
    });
  }

  if (projectEnv && Object.keys(projectEnv).length > 0) {
    // 项目层 env 等价于“仓库可向工具子进程注入任意变量”（PATH/NODE_OPTIONS/BASH_ENV），
    // 而 acquire 授权的基础设施尚未做，所以一律剥离而不是放行，见 specs/config-env.md。
    diagnostics.push({
      code: "config_project_env_blocked",
      filePath: result.path,
      message: "Project env is blocked until workspace trust support lands",
      path: "env",
      severity: "warning",
    });
  }

  return {
    baseDir,
    config: result.loaded ? normalizeProjectConfig(result.config, baseDir) : {},
    diagnostics,
    ...(hooks
      ? {
          hookCandidate: createWorkspaceHookSourceInput({
            path: result.path,
            workingDirectory: resolve(options.workingDirectory ?? baseDir),
            // hooks 字段已由 loadFileConfig 经 ZCodeConfigFileSchema（shared 单源
            // schema）完成运行时校验；这里的 parse 仅做类型桥接——HooksRuntimeConfigPatch
            // 与 WorkspaceHooksConfig 是两个领域类型（执行 side vs 配置 side，字段语义有
            // 微差），不共享 TS 结构。禁止改成 as 断言绕过校验。
            hooks: workspaceHooksConfigSchema.parse(hooks),
            discoveryOrder: options.discoveryOrder ?? 0,
            explicitProjectConfig: options.explicitProjectConfig,
          }),
        }
      : {}),
    loaded: result.loaded,
    path: result.path,
  };
}

export function summarizeProjectConfigs(files: ProjectConfigFile[]): ProjectConfigDiscovery {
  const loadedFiles = files.filter((file) => file.loaded);
  const mcpServerNames = new Set<string>();

  for (const file of loadedFiles) {
    for (const name of Object.keys(file.config.mcp?.servers ?? {})) {
      mcpServerNames.add(name);
    }
  }

  return {
    diagnostics: files.flatMap((file) => file.diagnostics),
    files: loadedFiles,
    hookCandidates: loadedFiles.flatMap((file) => (file.hookCandidate ? [file.hookCandidate] : [])),
    loaded: loadedFiles.length > 0,
    paths: loadedFiles.map((file) => file.path),
    mcpServerNames: [...mcpServerNames],
  };
}

function getProjectConfigBaseDir(path: string): string {
  const configDirectory = dirname(path);
  return basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory;
}

function normalizeProjectConfig(config: RuntimeConfigPatch, baseDir: string): RuntimeConfigPatch {
  // 项目层的 hooks 与 env 都不进可执行 patch：
  // hooks 保留在不可变候选 side-channel，等后续 admission 阶段；
  // env 本期不支持项目层（工具子进程环境变量的唯一来源是用户级配置），直接剥离。
  const { hooks: _hooks, env: _env, ...safeConfig } = config;
  const normalized: RuntimeConfigPatch = safeConfig;

  if (!normalized.mcp?.servers) return normalized;

  return {
    ...normalized,
    mcp: {
      ...normalized.mcp,
      servers: Object.fromEntries(
        Object.entries(normalized.mcp.servers).map(([name, server]) => [
          name,
          normalizeProjectMcpServer(server, baseDir),
        ]),
      ),
    },
  };
}

function normalizeProjectMcpServer(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;

  const cwd = server.cwd ?? CURRENT_DIRECTORY;
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}
