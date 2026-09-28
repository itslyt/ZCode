import assert from "node:assert/strict";
import test from "node:test";
import { taskIdentityKey } from "../src/host/windowHostControllerService.js";

const PATH = "/Users/someone/Work/example";

test("无 identity 时回落到 workspacePath", () => {
  assert.equal(taskIdentityKey({ workspacePath: PATH }), PATH);
  assert.equal(taskIdentityKey({ workspacePath: PATH, workspaceIdentity: undefined }), PATH);
  assert.equal(taskIdentityKey({ workspacePath: PATH, workspaceIdentity: null }), PATH);
  assert.equal(taskIdentityKey({ workspacePath: PATH, workspaceIdentity: "" }), PATH);
  assert.equal(taskIdentityKey({ workspacePath: PATH, workspaceIdentity: "   " }), PATH);
});

test("显式 identity 原样使用并去除首尾空白", () => {
  const remote = "remote:abc:123";
  assert.equal(taskIdentityKey({ workspacePath: PATH, workspaceIdentity: remote }), remote);
  assert.equal(
    taskIdentityKey({ workspacePath: PATH, workspaceIdentity: `  ${remote}  ` }),
    remote,
  );
});

test("identity 为空的各种等价形态归一到同一 key（回归：null vs undefined）", () => {
  const fromRow = taskIdentityKey({ workspacePath: PATH, workspaceIdentity: undefined });
  const fromParams = taskIdentityKey({ workspacePath: PATH, workspaceIdentity: null });
  assert.equal(fromRow, fromParams);
});

test("不同 workspacePath 不因 identity 缺失而被混同", () => {
  assert.notEqual(
    taskIdentityKey({ workspacePath: "/a" }),
    taskIdentityKey({ workspacePath: "/b" }),
  );
});
