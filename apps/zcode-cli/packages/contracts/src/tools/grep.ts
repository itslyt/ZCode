// ============================================================
// Grep Tool - Content Search Tool
// ============================================================
// Reference: grep-style search tool

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { pickToolJsonSchemaProperties, toToolJsonSchema } from "./json-schema.js";

export const GrepOutputMode = {
  Content: "content",
  FilesWithMatches: "files_with_matches",
  Count: "count",
} as const;

export type GrepOutputMode = (typeof GrepOutputMode)[keyof typeof GrepOutputMode];

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const GrepInputSchema = z.object({
  /**
   * Ripgrep-compatible regular expression pattern to search for in file contents.
   */
  pattern: z
    .string()
    .describe("The regular expression pattern to search for in file contents"),
  /**
   * Optional file or directory to search. Defaults to the current working directory.
   */
  path: z
    .string()
    .optional()
    .describe(
      "File or directory to search in (rg PATH). Defaults to current working directory.",
    ),
  /**
   * Glob pattern to filter files.
   */
  glob: z
    .string()
    .optional()
    .describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .describe(
      'Output mode: "content" (matching lines), "files_with_matches" (file paths, default), or "count" (match counts). The -A/-B/-C/context, -n, -i and -o flags apply only in "content" mode.',
    ),
  "-B": z.number().optional().describe("Lines to show before each match (rg -B)."),
  "-A": z.number().optional().describe("Lines to show after each match (rg -A)."),
  "-C": z.number().optional().describe("Alias for context."),
  context: z.number().optional().describe("Lines to show before and after each match (rg -C)."),
  "-n": z.boolean().optional().describe("Show line numbers (rg -n). Defaults to true."),
  "-i": z.boolean().optional().describe("Case insensitive search (rg -i)."),
  "-o": z
    .boolean()
    .optional()
    .describe("Print only the matched parts of each line, one match per line (rg -o). Defaults to false."),
  // type / offset 仍被 handler 与运行时校验接受（老脚本、hook 改写可能带），只是不再发给模型：
  // 632 次真实调用里两者均为 0 次，留着只占 schema 篇幅。见 ToolEntry.providerInputSchema。
  type: z.string().optional().describe("File type to search (rg --type), e.g. js, py, rust, go."),
  head_limit: z
    .number()
    .optional()
    .describe(
      'Limit output to the first N lines/entries, like "| head -N". Defaults to 250. Pass 0 for unlimited (use sparingly — large result sets waste context).',
    ),
  offset: z
    .number()
    .optional()
    .describe(
      'Skip the first N lines/entries before applying head_limit, like "| tail -n +N | head -N". Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe("Enable multiline mode where . matches newlines (rg -U --multiline-dotall). Default: false."),
});

export type GrepInput = z.infer<typeof GrepInputSchema>;

export const GrepInputJsonSchema = toToolJsonSchema(GrepInputSchema);

/**
 * 模型面参数 schema：去掉 `type` 与 `offset`。
 *
 * 依据是对本地真实会话的统计：632 次 Grep 调用里 `type` 与 `offset` 各出现 **0** 次，
 * 而它们合计占 schema 约 350 字符。运行时 `GrepInputSchema` 原样保留——hook 改写或
 * 旧插件仍可能传这两个字段，executor 校验必须继续接受。
 */
export const GrepProviderInputJsonSchema = pickToolJsonSchemaProperties(GrepInputJsonSchema, [
  "pattern",
  "path",
  "glob",
  "output_mode",
  "-A",
  "-B",
  "-C",
  "context",
  "-n",
  "-i",
  "-o",
  "head_limit",
  "multiline",
]);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface GrepOutput {
  mode: GrepOutputMode;
  durationMs: number;
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  truncated: boolean;
  appliedLimit?: number;
  appliedOffset?: number;
}

export const GrepOutputSchema = z
  .object({
    mode: z.enum(["content", "files_with_matches", "count"]),
    durationMs: z.number().int().nonnegative(),
    numFiles: z.number().int().nonnegative(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().int().nonnegative().optional(),
    numMatches: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    appliedLimit: z.number().int().nonnegative().optional(),
    appliedOffset: z.number().int().nonnegative().optional(),
  })
  .strict();

export const GrepOutputJsonSchema = toToolJsonSchema(GrepOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface GrepToolCall {
  id: ToolCallId;
  name: "Grep";
  input: GrepInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface GrepToolResult {
  toolCallId: ToolCallId;
  output: GrepOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Grep Errors
// -----------------------------------------------

export const GrepErrorCode = {
  INVALID_PATTERN: "grep_invalid_pattern",
  INVALID_PATH: "grep_invalid_path",
  PERMISSION_DENIED: "grep_permission_denied",
  TOO_LARGE: "grep_too_large",
  CANCELLED: "grep_cancelled",
  IO_ERROR: "grep_io_error",
} as const;

export type GrepErrorCode = (typeof GrepErrorCode)[keyof typeof GrepErrorCode];
