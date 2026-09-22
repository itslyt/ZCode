import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getEditorDefsForCurrentPlatform,
  resolveEditorDefAppPath,
  resolveEditorDefAppPathCandidates,
} from "../src/main/editorCatalog.js";

const isDarwin = process.platform === "darwin";
const darwinOnly = { skip: isDarwin ? false : "仅在 macOS 上验证 macOS 候选表" };
const HOME_APPLICATIONS = join(homedir(), "Applications");

/** 位置固定、不参与用户目录扫描的系统自带应用。 */
const MAC_SYSTEM_APP_IDS = ["finder", "terminal"];

test("macOS 候选表为每个可用户安装的应用展开 /Applications 与 ~/Applications", darwinOnly, () => {
  for (const def of getEditorDefsForCurrentPlatform()) {
    if (MAC_SYSTEM_APP_IDS.includes(def.id)) {
      continue;
    }

    const candidates = resolveEditorDefAppPathCandidates(def);
    const systemCandidates = candidates.filter((path) => path.startsWith("/Applications/"));
    const homeCandidates = candidates.filter((path) => path.startsWith(`${HOME_APPLICATIONS}/`));

    assert.ok(systemCandidates.length > 0, `${def.id} 缺少 /Applications 候选`);
    assert.equal(
      homeCandidates.length,
      systemCandidates.length,
      `${def.id} 的 ~/Applications 候选数量与 /Applications 不一致`,
    );

    // 同一 bundle 名称下 /Applications 必须排在 ~/Applications 之前，保证安装位置冲突时优先系统目录。
    for (const systemPath of systemCandidates) {
      const bundleName = systemPath.slice("/Applications/".length);
      const homePath = join(HOME_APPLICATIONS, bundleName);
      assert.ok(
        candidates.indexOf(systemPath) < candidates.indexOf(homePath),
        `${def.id} 的 ${systemPath} 未排在 ${homePath} 之前`,
      );
    }
  }
});

test("JetBrains 条目覆盖 Toolbox 与官网直装的不同 bundle 名称", darwinOnly, () => {
  const defs = new Map(getEditorDefsForCurrentPlatform().map((def) => [def.id, def]));
  const expectedBundles: Record<string, string[]> = {
    idea: ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app"],
    "idea-ce": ["IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"],
    pycharm: ["PyCharm.app", "PyCharm Professional.app", "PyCharm CE.app", "PyCharm Community.app"],
    rider: ["Rider.app", "JetBrains Rider.app"],
  };

  for (const [id, bundleNames] of Object.entries(expectedBundles)) {
    const def = defs.get(id);
    assert.ok(def, `缺少 ${id} 定义`);

    const candidates = resolveEditorDefAppPathCandidates(def);
    for (const bundleName of bundleNames) {
      assert.ok(
        candidates.includes(join(HOME_APPLICATIONS, bundleName)),
        `${id} 缺少 ~/Applications/${bundleName} 候选`,
      );
    }
  }
});

test("系统自带应用只使用固定路径", darwinOnly, () => {
  const defs = new Map(getEditorDefsForCurrentPlatform().map((def) => [def.id, def]));

  for (const id of MAC_SYSTEM_APP_IDS) {
    const def = defs.get(id);
    assert.ok(def, `缺少 ${id} 定义`);
    assert.deepEqual(resolveEditorDefAppPathCandidates(def), [def.appPath]);
  }
});

test("候选表保持既有编辑器 id，避免已持久化的选中项失效", darwinOnly, () => {
  const ids = getEditorDefsForCurrentPlatform().map((def) => def.id);

  for (const id of [
    "vscode",
    "vscode-insiders",
    "cursor",
    "trae",
    "zed",
    "sublime",
    "codebuddy",
    "qoder",
    "idea",
    "idea-ce",
    "webstorm",
    "pycharm",
    "goland",
    "phpstorm",
    "rider",
    "clion",
    "rubymine",
    "datagrip",
    "terminal",
    "iterm2",
    "ghostty",
    "warp",
    "finder",
    "qspace",
    "qspace-pro",
  ]) {
    assert.ok(ids.includes(id), `候选表缺少 ${id}`);
  }
});

test("解析结果一定来自候选列表，且候选列表首项是 appPath", darwinOnly, () => {
  for (const def of getEditorDefsForCurrentPlatform()) {
    const candidates = resolveEditorDefAppPathCandidates(def);
    assert.equal(candidates[0], def.appPath, `${def.id} 的 appPath 不是候选首项`);

    const resolved = resolveEditorDefAppPath(def);
    if (resolved !== null) {
      assert.ok(candidates.includes(resolved), `${def.id} 解析出的路径不在候选列表里`);
    }
  }
});

test("候选列表去重", darwinOnly, () => {
  for (const def of getEditorDefsForCurrentPlatform()) {
    const candidates = resolveEditorDefAppPathCandidates(def);
    assert.equal(new Set(candidates).size, candidates.length, `${def.id} 候选列表存在重复`);
  }
});
