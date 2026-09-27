// ============================================================
// EditAnchored Tool - 用行锚点编辑文件（不重抄原文）
// ============================================================
//
// 与 Edit 的分工：
//
// - `Edit` 用 old_string 定位，需要模型**重抄**要替换的原文；抄错一个字就匹配不上，
//   而这份原文往往正是文件里已经存在、模型刚刚读过的内容——纯属重复传输。
// - `EditAnchored` 用 Read 回显的 `N:HASH` 锚点定位，模型只传锚点和新内容。
//
// 两者并存，各有适用面：锚点编辑适合「改我已读过的行」，replace 适合
// 「这段文本在多处出现、我要按内容选一处」以及锚点失效需要重新落地的场景。

import { z } from "zod";
import { EditDiffHunkSchema, type DiffHunk } from "./edit.js";
import { toToolJsonSchema } from "./json-schema.js";
import { ToolExecutionTelemetrySchema } from "./performance.js";

/**
 * 锚点形如 `22:AB3F`：行号 + 4 字符内容哈希。
 *
 * 也接受只给 4 位哈希的裸形式（`AB3F`）——模型常省掉行号。裸哈希只在当前文件里
 * 唯一命中、或该哈希确实在已读集合里时才能定位；否则照常 unserved / stale / ambiguous 拒绝。
 */
const AnchorString = z
  .string()
  .describe(
    "Line anchor copied from a Read result, e.g. `22:AB3F`. The bare 4-character hash (`AB3F`) is also accepted when it uniquely identifies a line.",
  );

export const EditAnchoredInputSchema = z.object({
  /**
   * The absolute path to the file to modify.
   */
  file_path: z.string().describe("The absolute path to the file to modify"),
  /**
   * Edits to apply. Every entry replaces the inclusive line range
   * remove_from..remove_to with replacement_text.
   *
   * All entries are resolved against the file's ORIGINAL content, so entries never
   * displace each other; if any entry fails, nothing is written.
   */
  edits: z
    .array(
      z.object({
        remove_from: AnchorString.describe(
          "Anchor of the first line to replace, e.g. `22:AB3F`",
        ),
        remove_to: AnchorString.describe(
          "Anchor of the last line to replace (same as remove_from for a single line)",
        ),
        replacement_text: z
          .string()
          .describe("Replacement text. Use an empty string to delete the range."),
      }),
    )
    .min(1)
    .describe("Line-range replacements addressed by anchor. All-or-nothing."),
});

export type EditAnchoredInput = z.infer<typeof EditAnchoredInputSchema>;

export const EditAnchoredInputJsonSchema = toToolJsonSchema(EditAnchoredInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface EditAnchoredOutput {
  filePath: string;
  /** 实际应用的编辑条数 */
  editCount: number;
  /** 编辑前的文件内容 */
  originalFile: string;
  structuredPatch: DiffHunk[];
  userModified: boolean;
  /** 受影响区域编辑后的新锚点，模型可直接继续用，无需重新读取 */
  updatedAnchors?: string;
  perf?: z.infer<typeof ToolExecutionTelemetrySchema>;
}

export const EditAnchoredOutputSchema = z.object({
  filePath: z.string(),
  editCount: z.number().int().positive(),
  originalFile: z.string(),
  structuredPatch: z.array(EditDiffHunkSchema),
  userModified: z.boolean(),
  updatedAnchors: z.string().optional(),
  perf: ToolExecutionTelemetrySchema.optional(),
});

export const EditAnchoredOutputJsonSchema = toToolJsonSchema(EditAnchoredOutputSchema);
