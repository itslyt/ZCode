export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
}): string {
  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";

  return [
    "Executes a bash command and returns its output.",
    "",
    "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs}.`,
    "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    // Git 策略（提交/推送/分支/gh CLI）的唯一所有者在 identity 段；这里只留本工具自己的限制。
    // 曾在此重复一条与 identity 冲突的 "Commit or push only when the user asks"：
    // 两句同时在场时模型只能猜，见 specs/tool-definition-slimming.md §3.3。
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
  ].join("\n");
}
