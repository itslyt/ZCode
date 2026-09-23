import assert from "node:assert/strict";
import test from "node:test";
import { resolveEmbeddedSearchBranchCapability } from "../src/embedded-search/capability.js";
import { resolveBuiltInToolAllowlist } from "../src/runtime/helpers/tool-allowlist.js";
import { builtInTools } from "../src/tool/handlers/index.js";

// 本 fork 的工具面取舍见 specs/personal-fork-simplification.md §8。
// 搜索用专用的 Glob/Grep（不走 Bash 的 find/grep）；计划模式工具与 WebSearch 不在面里。

const allowlist = resolveBuiltInToolAllowlist({} as never) ?? [];

test("embedded search branch 关闭，搜索走专用 Glob/Grep", () => {
  const decision = resolveEmbeddedSearchBranchCapability({ bashAvailable: true });
  assert.equal(decision.useEmbeddedSearchBranch, false);
  assert.equal(decision.reason, "disabled_by_global_flag");
});

test("Bash 不可用时也走 direct 分支（两个条件都不再启用 branch）", () => {
  const decision = resolveEmbeddedSearchBranchCapability({ bashAvailable: false });
  assert.equal(decision.useEmbeddedSearchBranch, false);
});

test("工具面含 Glob/Grep", () => {
  assert.ok(allowlist.includes("Glob"), "Glob 应在默认工具面里");
  assert.ok(allowlist.includes("Grep"), "Grep 应在默认工具面里");
});

test("工具面不含计划模式工具与 WebSearch", () => {
  assert.ok(!allowlist.includes("EnterPlanMode"));
  assert.ok(!allowlist.includes("ExitPlanMode"));
  assert.ok(!allowlist.includes("WebSearch"));
});

test("被移出工具面的定义仍在注册表里，随时可恢复", () => {
  const registered = new Set(builtInTools.map((entry) => entry.metadata.name));
  for (const name of ["Glob", "Grep", "EnterPlanMode", "ExitPlanMode", "WebSearch"]) {
    assert.ok(registered.has(name), `${name} 的定义应仍在 builtInTools 里`);
  }
});
