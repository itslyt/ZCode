import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_THEME_PREFERENCE,
  isTheme,
  normalizeThemePreference,
  resolveStoredThemePreference,
} from "../src/useTheme.js";

test("无本地偏好时默认跟随系统", () => {
  assert.equal(DEFAULT_THEME_PREFERENCE, "system");
  assert.equal(resolveStoredThemePreference(null), "system");
  assert.equal(resolveStoredThemePreference(undefined), "system");
  assert.equal(resolveStoredThemePreference(""), "system");
});

test("非法存储值回退到默认主题，不被当成有效偏好", () => {
  assert.equal(resolveStoredThemePreference("zai-blue"), "system");
  assert.equal(resolveStoredThemePreference("DARK"), "system");
  assert.equal(resolveStoredThemePreference("{}"), "system");
});

test("合法存储值优先，新默认不覆盖已有偏好", () => {
  assert.equal(resolveStoredThemePreference("system"), "system");
  assert.equal(resolveStoredThemePreference("zai-dark"), "zai-dark");
  assert.equal(resolveStoredThemePreference("zai-light"), "zai-light");
});

test("legacy 别名归一为 Zai 变体", () => {
  assert.equal(resolveStoredThemePreference("dark"), "zai-dark");
  assert.equal(resolveStoredThemePreference("light"), "zai-light");
});

test("isTheme 接受全部合法取值并拒绝其他值", () => {
  for (const value of ["light", "dark", "zai-light", "zai-dark", "system"]) {
    assert.equal(isTheme(value), true, value);
  }
  for (const value of ["", "auto", "ZAI-DARK", null, undefined]) {
    assert.equal(isTheme(value), false, String(value));
  }
});

test("normalizeThemePreference 只映射 legacy 别名，system 原样保留", () => {
  assert.equal(normalizeThemePreference("dark"), "zai-dark");
  assert.equal(normalizeThemePreference("light"), "zai-light");
  assert.equal(normalizeThemePreference("system"), "system");
  assert.equal(normalizeThemePreference("zai-dark"), "zai-dark");
});
