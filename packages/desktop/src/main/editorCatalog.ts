/**
 * 编辑器候选目录表与路径解析。
 *
 * 这里只有数据与纯函数，不依赖 Electron，便于脱离主进程做单测；
 * 图标提取与「已安装列表」组装留在 `editors.ts`。
 */

import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, win32 as pathWin32 } from "node:path";

export interface EditorDef {
  id: string;
  name: string;
  /** 候选列表首项，同时也是解析失败时的兜底路径 */
  appPath: string;
  appPathCandidates?: string[];
  windowsCommandAppNames?: string[];
  /** CLI 命令名（如果有）。用于 open folder；null 则 fallback 到 `open -a` */
  command: string | null;
}

const WINDOWS_EXPLORER_PATH = pathWin32.join(process.env.WINDIR ?? "C:/Windows", "explorer.exe");

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0),
    ),
  );
}

/**
 * macOS 应用的安装根目录，顺序即优先级。
 *
 * JetBrains Toolbox 与「手动把 .app 拖进用户目录」都默认装在 `~/Applications`。
 * 这里之前只有 `/Applications` 一份静态清单，导致这类安装的 IDE 永远进不了候选列表。
 */
const MAC_APP_ROOTS: string[] = ["/Applications", join(homedir(), "Applications")];

/**
 * 同一个编辑器在不同安装渠道下 bundle 名称不同（JetBrains 的 Ultimate / CE / Professional），
 * 候选按「安装根目录 × bundle 名称」展开。
 */
function createMacEditorDef(
  id: string,
  name: string,
  bundleNames: string[],
  command: string | null,
): EditorDef {
  const candidates = uniquePaths(
    MAC_APP_ROOTS.flatMap((root) => bundleNames.map((bundleName) => join(root, bundleName))),
  );
  return {
    id,
    name,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    command,
  };
}

/** 系统自带应用位置固定，不参与用户目录扫描。 */
function createMacSystemAppDef(id: string, name: string, appPath: string): EditorDef {
  return { id, name, appPath, command: null };
}

const MAC_EDITOR_DEFS: EditorDef[] = [
  // 代码编辑器
  createMacEditorDef("vscode", "VS Code", ["Visual Studio Code.app"], "code"),
  // 这里之前只登记了稳定版 VS Code，`getInstalledEditors()` 又完全依赖这份静态白名单做 existsSync 过滤。
  // 用户安装的是 `Visual Studio Code - Insiders.app` 时，主进程根本不会把它纳入候选列表，UI 自然也就显示不出来。
  // 补上独立定义后，既能识别 Insiders，也能复用现有的 `code-insiders` CLI / `open -a` 降级打开链路。
  createMacEditorDef(
    "vscode-insiders",
    "VS Code Insiders",
    ["Visual Studio Code - Insiders.app"],
    "code-insiders",
  ),
  createMacEditorDef("cursor", "Cursor", ["Cursor.app"], "cursor"),
  createMacEditorDef("trae", "Trae", ["Trae.app"], null),
  createMacEditorDef("zed", "Zed", ["Zed.app"], "zed"),
  createMacEditorDef("sublime", "Sublime Text", ["Sublime Text.app"], "subl"),
  createMacEditorDef("codebuddy", "CodeBuddy", ["CodeBuddy.app"], null),
  createMacEditorDef("qoder", "Qoder", ["Qoder.app"], null),
  // JetBrains 系列：官网直装与 Toolbox 使用不同的 bundle 名称，逐个登记才能都识别到。
  createMacEditorDef(
    "idea",
    "IntelliJ IDEA",
    ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app"],
    "idea",
  ),
  createMacEditorDef(
    "idea-ce",
    "IntelliJ IDEA CE",
    ["IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"],
    "idea",
  ),
  createMacEditorDef("webstorm", "WebStorm", ["WebStorm.app"], "webstorm"),
  createMacEditorDef(
    "pycharm",
    "PyCharm",
    ["PyCharm.app", "PyCharm Professional.app", "PyCharm CE.app", "PyCharm Community.app"],
    "pycharm",
  ),
  createMacEditorDef("goland", "GoLand", ["GoLand.app"], "goland"),
  createMacEditorDef("phpstorm", "PhpStorm", ["PhpStorm.app"], "phpstorm"),
  createMacEditorDef("rider", "Rider", ["Rider.app", "JetBrains Rider.app"], "rider"),
  createMacEditorDef("clion", "CLion", ["CLion.app"], "clion"),
  createMacEditorDef("rubymine", "RubyMine", ["RubyMine.app"], "rubymine"),
  createMacEditorDef("datagrip", "DataGrip", ["DataGrip.app"], "datagrip"),
  // 终端（macOS 新版系统 Terminal 在 /System/Applications 下）
  createMacSystemAppDef("terminal", "Terminal", "/System/Applications/Utilities/Terminal.app"),
  createMacEditorDef("iterm2", "iTerm", ["iTerm.app"], null),
  createMacEditorDef("ghostty", "Ghostty", ["Ghostty.app"], null),
  createMacEditorDef("warp", "Warp", ["Warp.app"], null),
  // 文件管理器
  createMacSystemAppDef("finder", "Finder", "/System/Library/CoreServices/Finder.app"),
  // 功能扩展：QSpace / QSpace Pro 是 macOS 第三方文件管理器，默认没有 CLI，复用 open -a app bundle 打开路径。
  createMacEditorDef("qspace", "QSpace", ["QSpace.app"], null),
  createMacEditorDef("qspace-pro", "QSpace Pro", ["QSpace Pro.app"], null),
];

function getWindowsProgramFilesRoots(): string[] {
  const systemDrive = process.env.SystemDrive || "C:";
  return uniquePaths([
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    `${systemDrive}\\Program Files`,
    `${systemDrive}\\Program Files (x86)`,
  ]);
}

function getWindowsLocalProgramsRoot(): string {
  const systemDrive = process.env.SystemDrive || "C:";
  return pathWin32.join(
    process.env.LOCALAPPDATA || `${systemDrive}\\Users\\Default\\AppData\\Local`,
    "Programs",
  );
}

function windowsLocalProgramCandidate(...segments: string[]): string {
  return pathWin32.join(getWindowsLocalProgramsRoot(), ...segments);
}

function windowsProgramFilesCandidates(...segments: string[]): string[] {
  return getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, ...segments));
}

function findWindowsJetBrainsExecutableCandidates(
  productDirPrefix: string,
  executableName: string,
): string[] {
  const roots = uniquePaths([
    ...getWindowsProgramFilesRoots().map((root) => pathWin32.join(root, "JetBrains")),
    pathWin32.join(getWindowsLocalProgramsRoot(), "JetBrains"),
  ]);
  const candidates: string[] = [];

  for (const root of roots) {
    try {
      const entries = readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.toLowerCase().startsWith(productDirPrefix.toLowerCase()),
        )
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left));

      for (const entry of entries) {
        candidates.push(pathWin32.join(root, entry, "bin", executableName));
      }
    } catch {
      // JetBrains products are optional; missing roots are expected.
    }
  }

  return candidates;
}

function createWindowsEditorDef(
  id: string,
  name: string,
  appPathCandidates: string[],
  command: string | null = null,
  windowsCommandAppNames: string[] = [],
): EditorDef {
  const candidates = uniquePaths(appPathCandidates);
  return {
    id,
    name,
    appPath: candidates[0] ?? "",
    appPathCandidates: candidates.slice(1),
    windowsCommandAppNames,
    command,
  };
}

function resolveWindowsCommandPaths(command: string): string[] {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const output = execFileSync("where.exe", [command], {
      encoding: "utf8",
      timeout: 1000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

function deriveWindowsAppPathsFromCommand(command: string, appNames: string[]): string[] {
  const candidates: string[] = [];

  for (const commandPath of resolveWindowsCommandPaths(command)) {
    const commandDir = pathWin32.dirname(commandPath);
    for (const appRoot of uniquePaths([commandDir, pathWin32.dirname(commandDir)])) {
      for (const appName of appNames) {
        candidates.push(pathWin32.join(appRoot, appName));
      }
    }
  }

  // Windows PATH 常见的是 bin\code.cmd 这类 shim，真实 exe 才能提供和 mac 一致的应用图标。
  return uniquePaths(candidates).filter((candidate) => existsSync(candidate));
}

const WINDOWS_EDITOR_DEFS: EditorDef[] = [
  // Workspace 顶部“Open in Editor”以前只把真正的 IDE 暴露给 UI，
  // Windows 用户缺少最基础的“在资源管理器里打开”入口，只能回到其它菜单操作。
  // 这里把系统文件管理器也作为 editor 列表的一员，让 macOS Finder / Windows 资源管理器体验对齐。
  { id: "explorer", name: "资源管理器", appPath: WINDOWS_EXPLORER_PATH, command: null },
];

const WINDOWS_ADDITIONAL_EDITOR_DEFS: EditorDef[] = [
  createWindowsEditorDef(
    "vscode",
    "VS Code",
    [
      windowsLocalProgramCandidate("Microsoft VS Code", "Code.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code", "Code.exe"),
    ],
    "code",
    ["Code.exe"],
  ),
  createWindowsEditorDef(
    "vscode-insiders",
    "VS Code Insiders",
    [
      windowsLocalProgramCandidate("Microsoft VS Code Insiders", "Code - Insiders.exe"),
      ...windowsProgramFilesCandidates("Microsoft VS Code Insiders", "Code - Insiders.exe"),
    ],
    "code-insiders",
    ["Code - Insiders.exe"],
  ),
  createWindowsEditorDef(
    "cursor",
    "Cursor",
    [
      windowsLocalProgramCandidate("Cursor", "Cursor.exe"),
      ...windowsProgramFilesCandidates("Cursor", "Cursor.exe"),
    ],
    "cursor",
    ["Cursor.exe"],
  ),
  createWindowsEditorDef("trae", "Trae", [
    windowsLocalProgramCandidate("Trae", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae.exe"),
    windowsLocalProgramCandidate("Trae CN", "Trae CN.exe"),
    ...windowsProgramFilesCandidates("Trae", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae.exe"),
    ...windowsProgramFilesCandidates("Trae CN", "Trae CN.exe"),
  ]),
  createWindowsEditorDef("idea", "IntelliJ IDEA", [
    ...findWindowsJetBrainsExecutableCandidates("IntelliJ IDEA", "idea64.exe"),
  ]),
  createWindowsEditorDef("webstorm", "WebStorm", [
    ...findWindowsJetBrainsExecutableCandidates("WebStorm", "webstorm64.exe"),
  ]),
  createWindowsEditorDef("pycharm", "PyCharm", [
    ...findWindowsJetBrainsExecutableCandidates("PyCharm", "pycharm64.exe"),
  ]),
  createWindowsEditorDef("goland", "GoLand", [
    ...findWindowsJetBrainsExecutableCandidates("GoLand", "goland64.exe"),
  ]),
  createWindowsEditorDef("clion", "CLion", [
    ...findWindowsJetBrainsExecutableCandidates("CLion", "clion64.exe"),
  ]),
];

export function getEditorDefsForCurrentPlatform(): EditorDef[] {
  if (process.platform === "darwin") {
    return MAC_EDITOR_DEFS;
  }

  if (process.platform === "win32") {
    return [...WINDOWS_EDITOR_DEFS, ...WINDOWS_ADDITIONAL_EDITOR_DEFS];
  }

  return [];
}

/** 按优先级展开候选路径；纯函数，不做 IO，便于单测断言扫描范围。 */
export function resolveEditorDefAppPathCandidates(def: EditorDef): string[] {
  const commandAppPaths =
    def.command && def.windowsCommandAppNames?.length
      ? deriveWindowsAppPathsFromCommand(def.command, def.windowsCommandAppNames)
      : [];
  const commandPaths =
    process.platform === "win32" && def.windowsCommandAppNames?.length
      ? []
      : def.command
        ? resolveWindowsCommandPaths(def.command)
        : [];

  return uniquePaths([
    def.appPath,
    ...(def.appPathCandidates ?? []),
    ...commandAppPaths,
    ...commandPaths,
  ]);
}

/** 候选里第一个真实存在的路径；都不存在时返回 null。 */
export function resolveEditorDefAppPath(def: EditorDef): string | null {
  return resolveEditorDefAppPathCandidates(def).find((candidate) => existsSync(candidate)) ?? null;
}
