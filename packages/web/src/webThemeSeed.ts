import {
  DEFAULT_THEME_PREFERENCE,
  isTheme,
  normalizeThemePreference,
  type Theme,
} from "@zcode/ui/useTheme";

type WebThemeSeed = Theme;

// Web 入口无本地偏好时的默认主题。取值来自 UI 包的唯一所有者，
// 分享页会显式传入 "zai-light" 覆盖它。
export const WEB_DEFAULT_THEME: WebThemeSeed = DEFAULT_THEME_PREFERENCE;

export function resolveWebInitialTheme({
  storedTheme,
  defaultTheme = WEB_DEFAULT_THEME,
}: {
  storedTheme?: string | null;
  defaultTheme?: WebThemeSeed;
}): WebThemeSeed {
  if (isTheme(storedTheme)) {
    return normalizeThemePreference(storedTheme);
  }

  return normalizeThemePreference(defaultTheme);
}
