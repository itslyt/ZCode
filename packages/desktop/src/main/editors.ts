/**
 * 编辑器检测与打开 —— 检测系统中已安装的编辑器/终端，获取图标，打开路径
 *
 * 候选目录表与路径解析在 `editorCatalog.ts`；这里只负责图标提取和已安装列表组装。
 * 当前支持 macOS / Windows。Linux 后续再补。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app, nativeImage } from "electron";
import type { EditorInfo } from "@zcode/shared";
import { getZCodeDataRootDir } from "@zcode/services/node";
import {
  getEditorDefsForCurrentPlatform,
  resolveEditorDefAppPath,
  type EditorDef,
} from "./editorCatalog.js";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);

interface AppBundleInfoPlist {
  CFBundleIconFile?: string;
  CFBundleIconFiles?: string[];
  CFBundleIconName?: string;
  CFBundleIcons?: {
    CFBundlePrimaryIcon?: {
      CFBundleIconFiles?: string[];
      CFBundleIconName?: string;
    };
  };
}

interface ResolvedAppIconPath {
  candidateIconNames: string[];
  path: string | null;
  reason: "resolved" | "missing-plist" | "missing-icon-name" | "missing-icon-file";
}

interface ParsedIcnsPngCandidate {
  osType: string;
  size: number;
  image: Buffer;
}

let cachedEditors: EditorInfo[] | null = null;
let cachedIcnsModule: typeof import("@fiahfy/icns") | null | undefined;

function getIcnsModule(): typeof import("@fiahfy/icns") | null {
  if (cachedIcnsModule !== undefined) {
    return cachedIcnsModule;
  }

  try {
    cachedIcnsModule = require("@fiahfy/icns") as typeof import("@fiahfy/icns");
  } catch (error) {
    // 这里之前在模块顶层直接 require("@fiahfy/icns")。
    // 一旦安装包漏掉它的子依赖（这次是 pngjs），主进程会在文件加载阶段直接崩溃，
    // 连后面的 sips / file icon 降级路径都来不及执行。改成按需懒加载后，缺包时只降级图标解析。
    cachedIcnsModule = null;
    logger.warn("[editors] 加载 @fiahfy/icns 失败，图标解析将回退到 sips", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return cachedIcnsModule;
}

function readAppBundleInfoPlist(appPath: string): AppBundleInfoPlist | null {
  try {
    const infoPlistPath = join(appPath, "Contents", "Info.plist");
    const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", infoPlistPath], {
      encoding: "utf8",
      timeout: 3000,
    });
    return JSON.parse(raw) as AppBundleInfoPlist;
  } catch (error) {
    logger.warn("[editors] 读取 Info.plist 失败，图标将回退到 file icon", {
      appPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function resolveAppIconPath(appPath: string): ResolvedAppIconPath {
  const plist = readAppBundleInfoPlist(appPath);
  if (!plist) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-plist",
    };
  }

  // `defaults read` 对不少第三方 .app 读不到 CFBundleIconFile，
  // 会让所有编辑器误回退到 Electron 的通用文件图标；这里改为直接解析 Info.plist。
  const iconNames = [
    plist.CFBundleIconFile,
    ...(plist.CFBundleIconFiles ?? []),
    ...(plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles ?? []),
    plist.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconName,
    plist.CFBundleIconName,
  ].filter(
    (iconName): iconName is string => typeof iconName === "string" && iconName.trim().length > 0,
  );

  if (iconNames.length === 0) {
    return {
      candidateIconNames: [],
      path: null,
      reason: "missing-icon-name",
    };
  }

  for (const iconName of iconNames) {
    const candidateFileNames = iconName.endsWith(".icns")
      ? [iconName]
      : [iconName, `${iconName}.icns`];

    for (const candidateFileName of candidateFileNames) {
      const candidatePath = join(appPath, "Contents", "Resources", candidateFileName);
      // Ghostty 这类应用会同时存在同名资源目录和真正的 .icns 文件。
      // 之前这里只判断 existsSync，先命中目录后就会把目录当成图标文件读，
      // 最终解析失败并退回成发白的系统 file icon。这里要求候选路径必须是文件。
      if (existsSync(candidatePath) && statSync(candidatePath).isFile()) {
        return {
          candidateIconNames: iconNames,
          path: candidatePath,
          reason: "resolved",
        };
      }
    }
  }

  return {
    candidateIconNames: iconNames,
    path: null,
    reason: "missing-icon-file",
  };
}

function loadNativeImageFromIcnsViaPackage(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const icnsModule = getIcnsModule();
  if (!icnsModule) {
    return null;
  }

  const { Icns } = icnsModule;

  try {
    const icnsBuffer = readFileSync(icnsPath);
    const icns = Icns.from(icnsBuffer);
    const pngCandidates = icns.images
      .map((image): ParsedIcnsPngCandidate | null => {
        const supportedIconType = Icns.supportedIconTypes.find(
          (iconType) => iconType.osType === image.osType,
        );
        if (!supportedIconType || supportedIconType.format !== "PNG") {
          return null;
        }
        return {
          osType: image.osType,
          size: supportedIconType.size,
          image: image.image,
        };
      })
      .filter((candidate): candidate is ParsedIcnsPngCandidate => candidate !== null)
      .sort((left, right) => right.size - left.size);

    if (pngCandidates.length === 0) {
      logger.info("[editors] @fiahfy/icns 未解析到 PNG icon，图标将回退到 sips", {
        editorId,
        appPath,
        icnsPath,
        availableIconTypes: icns.images.map((image) => image.osType),
      });
      return null;
    }

    for (const candidate of pngCandidates) {
      const icon = nativeImage.createFromBuffer(candidate.image);
      if (!icon.isEmpty()) {
        return icon;
      }
    }

    logger.warn("[editors] @fiahfy/icns 已解析到 PNG icon，但 nativeImage 仍为空", {
      editorId,
      appPath,
      icnsPath,
      pngCandidateTypes: pngCandidates.map((candidate) => `${candidate.osType}:${candidate.size}`),
    });
    return null;
  } catch (error) {
    logger.warn("[editors] @fiahfy/icns 解析失败，图标将回退到 sips", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function loadNativeImageFromIcnsViaSips(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  const tempRootDir = join(getZCodeDataRootDir(), "editor-icon");
  mkdirSync(tempRootDir, { recursive: true });
  const tempDirPath = mkdtempSync(join(tempRootDir, "icon-"));
  const tempPngPath = join(tempDirPath, "icon.png");

  try {
    execFileSync("sips", ["-s", "format", "png", icnsPath, "--out", tempPngPath], {
      encoding: "utf8",
      timeout: 5000,
    });
    const pngBuffer = readFileSync(tempPngPath);
    const icon = nativeImage.createFromBuffer(pngBuffer);
    if (icon.isEmpty()) {
      logger.warn("[editors] sips 已输出 PNG，但 nativeImage 仍为空", {
        editorId,
        appPath,
        icnsPath,
        tempPngPath,
      });
      return null;
    }
    return icon;
  } catch (error) {
    logger.warn("[editors] .icns 转 PNG 失败，图标将回退到 file icon", {
      editorId,
      appPath,
      icnsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    try {
      rmSync(tempDirPath, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响图标加载
    }
  }
}

function loadNativeImageFromIcns(
  editorId: string,
  appPath: string,
  icnsPath: string,
): Electron.NativeImage | null {
  // Electron 的 nativeImage 不适合直接读取 .icns，
  // 这里优先用 npm 包解析出 PNG icon，减少每个图标都起系统子进程的成本；
  // 只有遇到老格式或包解析不到的 case，才回退到 macOS 的 sips。
  return (
    loadNativeImageFromIcnsViaPackage(editorId, appPath, icnsPath) ??
    loadNativeImageFromIcnsViaSips(editorId, appPath, icnsPath)
  );
}

/**
 * 从 .app bundle 的 Info.plist 读取多个可能的 icon 字段，
 * 然后把 .icns 转成 PNG，再生成可用于菜单的真实图标。
 * 如果解析不到真实图标，再 fallback 到 Electron 的 app.getFileIcon。
 */
export function getAppIconDataUrl(editorId: string, appPath: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    return app
      .getFileIcon(appPath, { size: "normal" })
      .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
      .catch((error) => {
        logger.warn("[editors] 获取 file icon 失败", {
          editorId,
          appPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
  }
  // Step 1: 尝试从 .icns 文件加载真实 app 图标
  const resolvedIcon = resolveAppIconPath(appPath);
  if (resolvedIcon.path) {
    const icon = loadNativeImageFromIcns(editorId, appPath, resolvedIcon.path);
    if (icon && !icon.isEmpty()) {
      // 缩放到合适大小（32x32 用于菜单显示）
      const resized = icon.resize({ width: 32, height: 32 });
      return Promise.resolve(`data:image/png;base64,${resized.toPNG().toString("base64")}`);
    }
  } else {
    logger.info("[editors] 未解析到真实 app 图标，图标将回退到 file icon", {
      editorId,
      appPath,
      reason: resolvedIcon.reason,
      candidateIconNames: resolvedIcon.candidateIconNames,
    });
  }

  // Step 2: fallback 到 Electron 的 app.getFileIcon
  return app
    .getFileIcon(appPath, { size: "normal" })
    .then((icon) => `data:image/png;base64,${icon.toPNG().toString("base64")}`)
    .catch((error) => {
      logger.warn("[editors] 获取 file icon 失败", {
        editorId,
        appPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
}

/**
 * 检测系统中已安装的编辑器/终端，返回带图标的列表。
 * 结果会被缓存（应用生命周期内不变）。
 */
export async function getInstalledEditors(): Promise<EditorInfo[]> {
  if (cachedEditors) {
    return cachedEditors;
  }

  const installed = getEditorDefsForCurrentPlatform()
    .map((def) => {
      const appPath = resolveEditorDefAppPath(def);
      return appPath ? { def, appPath } : null;
    })
    .filter((entry): entry is { def: EditorDef; appPath: string } => entry !== null);

  const results = await Promise.all(
    installed.map(async ({ def, appPath }) => {
      const iconDataUrl = await getAppIconDataUrl(def.id, appPath);
      if (!iconDataUrl) {
        return null;
      }
      return { id: def.id, name: def.name, iconDataUrl };
    }),
  );

  cachedEditors = results.filter((r): r is EditorInfo => r !== null);
  return cachedEditors;
}
