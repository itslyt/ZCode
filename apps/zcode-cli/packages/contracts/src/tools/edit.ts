// ============================================================
// Edit Tool - File Editing Tool
// ============================================================
// Reference: file edit input / output shape

import { z } from "zod";
import { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const EditInputSchema = z.object({
  /**
   * The absolute path to the file to modify.
   */
  file_path: z
    .string()
    .describe("The absolute path to the file to modify"),
  /**
   * The text to replace
   */
  old_string: z.string().optional().describe("The text to replace"),
  /**
   * The text to replace it with (must be different from old_string)
   */
  new_string: z
    .string()
    .optional()
    .describe("The text to replace it with (must be different from old_string)"),
  /**
   * Replace all occurrences of old_string (default false)
   */
  replace_all: semanticBoolean()
    .optional()
    .default(false)
    .describe("Replace all occurrences of old_string (default false)"),
  /**
   * Atomic batch edits. Every entry is located against the file's ORIGINAL content,
   * so entries never displace each other; if any entry fails, nothing is written.
   * Use this instead of old_string/new_string when a single change touches several
   * places in one file.
   */
  edits: z
    .array(
      z.object({
        old_string: z.string().describe("The text to replace"),
        new_string: z.string().describe("The text to replace it with"),
        replace_all: semanticBoolean()
          .optional()
          .default(false)
          .describe("Replace all occurrences of this entry's old_string (default false)"),
      }),
    )
    .optional()
    .describe(
      "Atomic batch of edits applied to one file. Located against the original content; all-or-nothing.",
    ),
});

export type EditInput = z.infer<typeof EditInputSchema>;

export const EditInputJsonSchema = toToolJsonSchema(EditInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface EditOutput {
  /**
   * The file path that was edited
   */
  filePath: string;
  /**
   * The original string that was replaced
   */
  oldString: string;
  /**
   * The new string that replaced it
   */
  newString: string;
  /**
   * The original file contents before editing
   */
  originalFile: string;
  /**
   * Diff patch showing the changes
   */
  structuredPatch: DiffHunk[];
  /**
   * Whether the user modified the proposed changes
   */
  userModified: boolean;
  /**
   * Whether all occurrences were replaced
   */
  replaceAll: boolean;
  /**
   * Matching strategy used to find oldString. Exact is expected for normal edits.
   */
  matchStrategy?: string;
  /**
   * Number of candidate positions observed by the selected match strategy.
   */
  matchCandidateCount?: number;
  /** `edits` 批量路径下实际应用的编辑条数；单条路径不出现 */
  batchEditCount?: number;
  /** 批量路径下同时给出了 old_string/new_string，这两个参数被忽略（结果里会明说） */
  ignoredSingleEditArguments?: boolean;
  /**
   * Git diff information (for remote scenarios)
   */
  gitDiff?: GitDiff;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface GitDiff {
  filename: string;
  status: "modified" | "added";
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  /**
   * GitHub owner/repo when available
   */
  repository?: string | null;
}

export const EditDiffHunkSchema = z
  .object({
    oldStart: z.number().int(),
    oldLines: z.number().int(),
    newStart: z.number().int(),
    newLines: z.number().int(),
    lines: z.array(z.string()),
  })
  .strict();

export const EditGitDiffSchema = z
  .object({
    filename: z.string(),
    status: z.enum(["modified", "added"]),
    additions: z.number().int(),
    deletions: z.number().int(),
    changes: z.number().int(),
    patch: z.string(),
    repository: z.string().nullable().optional(),
  })
  .strict();

export const EditOutputSchema = z
  .object({
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    originalFile: z.string(),
    structuredPatch: z.array(EditDiffHunkSchema),
    userModified: z.boolean(),
    replaceAll: z.boolean(),
    matchStrategy: z.string().optional(),
    matchCandidateCount: z.number().int().nonnegative().optional(),
    /** `edits` 批量路径下实际应用的编辑条数；单条路径不出现 */
    batchEditCount: z.number().int().positive().optional(),
    ignoredSingleEditArguments: z.boolean().optional(),
    gitDiff: EditGitDiffSchema.optional(),
    perf: ToolExecutionTelemetrySchema.optional(),
  })
  .strict();

export const EditOutputJsonSchema = toToolJsonSchema(EditOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface EditToolCall {
  id: ToolCallId;
  name: "Edit";
  input: EditInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface EditToolResult {
  toolCallId: ToolCallId;
  output: EditOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// Edit Errors
// -----------------------------------------------

export const EditErrorCode = {
  NO_CHANGE: 1,
  FILE_EXISTS_NO_OLD_STRING: 3,
  FILE_NOT_EXIST: 4,
  NOTEBOOK_FILE: 5,
  FILE_NOT_READ: 6,
  STALE_FILE: 7,
  OLD_STRING_NOT_FOUND: 8,
  AMBIGUOUS_REPLACE: 9,
  FILE_TOO_LARGE: 10,
  INVALID_PATH: 13,
  /** `edits` 与 `old_string`/`new_string` 同时给出，或 `edits` 为空 */
  INVALID_EDIT_ARGUMENTS: 14,
  /** 批量中某一条匹配失败/不唯一，整批未写入；消息里带失败下标与就近片段 */
  BATCH_EDIT_FAILED: 15,
  /** 批量中两条编辑的命中区间重叠，无法确定应用顺序 */
  BATCH_EDIT_OVERLAP: 16,
} as const;

export type EditErrorCode = (typeof EditErrorCode)[keyof typeof EditErrorCode];

function semanticBoolean(): z.ZodEffects<z.ZodBoolean, boolean, unknown> {
  return z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return value;
    }
    if (typeof value !== "string") return value;

    const normalized = value.trim().toLowerCase();
    if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
    if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
    return value;
  }, z.boolean());
}
