import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfiguredToolEnv } from "@zcode/shared";

test("普通键原样接受，大小写与符号都不动", () => {
  const result = resolveConfiguredToolEnv({
    KS_AGENT_PLATFORM: "codeflicker",
    FLICKER_USERNAME: "liuyutong08",
    Path: "/custom/bin:/usr/bin",
    EMPTY: "",
  });

  assert.deepEqual(result.accepted, {
    KS_AGENT_PLATFORM: "codeflicker",
    FLICKER_USERNAME: "liuyutong08",
    Path: "/custom/bin:/usr/bin",
    EMPTY: "",
  });
  assert.deepEqual(result.rejected, []);
});

test("未声明 env 时返回空结果", () => {
  assert.deepEqual(resolveConfiguredToolEnv(undefined), { accepted: {}, rejected: [] });
  assert.deepEqual(resolveConfiguredToolEnv({}), { accepted: {}, rejected: [] });
});

test("sanitize 名单里的键被拒（放行只会在子进程边界被删或被网络配置覆盖）", () => {
  const result = resolveConfiguredToolEnv({
    HTTP_PROXY: "http://proxy:8080",
    http_proxy: "http://proxy:8080",
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/sock",
    OTEL_SERVICE_NAME: "zcode",
    npm_config_proxy: "http://proxy:8080",
  });

  assert.deepEqual(result.accepted, {});
  assert.deepEqual(result.rejected, [
    { key: "HTTP_PROXY", reason: "sanitized_key" },
    { key: "http_proxy", reason: "sanitized_key" },
    { key: "ZCODE_CUA_PERMISSION_BROKER_SOCKET", reason: "sanitized_key" },
    { key: "OTEL_SERVICE_NAME", reason: "sanitized_key" },
    { key: "npm_config_proxy", reason: "sanitized_key" },
  ]);
});

test("封存载体键被拒（不允许配置伪造内部通道）", () => {
  const result = resolveConfiguredToolEnv({ ZCODE_TOOL_ENV_PASSTHROUGH_JSON: '{"A":"1"}' });

  assert.deepEqual(result.accepted, {});
  assert.deepEqual(result.rejected, [{ key: "ZCODE_TOOL_ENV_PASSTHROUGH_JSON", reason: "reserved_key" }]);
});

test("非法键名被拒", () => {
  const result = resolveConfiguredToolEnv({ "1BAD": "x", "A-B": "y", "A B": "z" });

  assert.deepEqual(result.accepted, {});
  assert.deepEqual(result.rejected, [
    { key: "1BAD", reason: "invalid_name" },
    { key: "A-B", reason: "invalid_name" },
    { key: "A B", reason: "invalid_name" },
  ]);
});

test("被拒的键不影响同一份配置里的合法键", () => {
  const result = resolveConfiguredToolEnv({ KS_AGENT_PLATFORM: "codeflicker", HTTPS_PROXY: "x" });

  assert.deepEqual(result.accepted, { KS_AGENT_PLATFORM: "codeflicker" });
  assert.deepEqual(result.rejected, [{ key: "HTTPS_PROXY", reason: "sanitized_key" }]);
});
