// ============================================================
// AskUserQuestion Tool Handler
// ============================================================

import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionAnsweredInputSchema,
  AskUserQuestionInputJsonSchema,
  AskUserQuestionInputSchema,
  AskUserQuestionOutputJsonSchema,
  AskUserQuestionOutputSchema,
  AskUserQuestionProviderInputJsonSchema,
  CoreErrorType,
  createCoreError,
  type AskUserQuestionOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_ASK_USER_QUESTION_MODEL_BYTES = 100_000;

const ASK_USER_QUESTION_DESCRIPTION =
  [
    "Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.",
    "",
    "Usage notes:",
    '- Users will always be able to select "Other" to provide custom text input',
    "- Use multiSelect: true to allow multiple answers to be selected for a question",
    '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
    "",
    "Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.",
    "",
    // 原来这里有一整段 686 字符的 "Preview feature"，讲选项可用 `preview` 渲染成
    // 「并排布局 / monospace 框 / ASCII mockup」。逐层查过消费链后删掉：
    //   - Desktop 的 `ZCodeElicitationOption` 类型没有 preview 字段，
    //     `zcodeTaskServiceAdapter` 映射 option 时只取 value/label/description，preview 被丢；
    //   - `packages/ui/src/ElicitationDialog.tsx` 零处渲染 preview；
    //   - TUI 只把 preview 原文塞进 `annotation` 回传给模型，并不渲染。
    // 也就是说那段承诺的 UI 形态在任何客户端都不存在，只会把模型引向一个不存在的交互。
    // `preview` 字段本身保留（TUI 的回传链路仍读它，见 app-question-state.ts），
    // 只是不再向模型宣传；详见 specs/tool-definition-slimming.md §3.6。
  ].join("\n") + "\n";

const askUserQuestionHandler: ToolHandler = async (input, context) => {
  const parsed = AskUserQuestionAnsweredInputSchema.safeParse(input);

  if (!parsed.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "AskUserQuestion requires user answers before execution",
      {
        context: {
          issues: parsed.error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
          toolCallId: context.toolCallId,
          toolName: ASK_USER_QUESTION_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }

  return {
    questions: parsed.data.questions,
    answers: parsed.data.answers ?? {},
    ...(parsed.data.annotations ? { annotations: parsed.data.annotations } : {}),
  } satisfies AskUserQuestionOutput;
};

export const askUserQuestionToolEntry: ToolEntry = {
  capability:
    "Ask the user multiple-choice clarification questions and continue with their answers",
  requiresUserInteraction: true,
  metadata: {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: ASK_USER_QUESTION_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    requiresUserInteraction: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    sideEffectScope: "userInteraction",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: askUserQuestionHandler,
  formatModelContent: formatAskUserQuestionModelContent,
  // 模型面只留 questions；answers/annotations/metadata 由权限阶段注入，不进 provider schema。
  providerInputSchema: AskUserQuestionProviderInputJsonSchema,
  inputSchema: AskUserQuestionInputJsonSchema,
  outputSchema: AskUserQuestionOutputJsonSchema,
  runtimeInputSchema: AskUserQuestionInputSchema,
  runtimeOutputSchema: AskUserQuestionOutputSchema,
  permission: {
    permission: "userInteraction.askQuestion",
    reason: "AskUserQuestion pauses execution to collect answers from the user",
    riskLevel: "low",
    sideEffectScope: "userInteraction",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    maxModelBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_ASK_USER_QUESTION_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "AskUserQuestion was cancelled before answers were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatAskUserQuestionModelContent(output: unknown): string {
  const result = output as AskUserQuestionOutput;
  if (Object.keys(result.answers).length === 0) {
    return "The user did not provide answers to these questions. Continue using your best judgment; do not treat this as a rejection or invent a user preference.";
  }
  const answersText = Object.entries(result.answers)
    .map(([questionText, answer]) => {
      const annotation = result.annotations?.[questionText];
      const parts = [`"${questionText}"="${answer}"`];
      if (annotation?.preview) {
        parts.push(`selected preview:\n${annotation.preview}`);
      }
      if (annotation?.notes) {
        parts.push(`user notes: ${annotation.notes}`);
      }
      return parts.join(" ");
    })
    .join(", ");

  const unansweredCount = result.questions.filter(
    (question) => !(question.question in result.answers),
  ).length;
  if (unansweredCount > 0) {
    return `The user answered some questions and skipped ${unansweredCount}. Provided answers: ${answersText}. Continue with the provided answers and use your best judgment for the unanswered questions; do not invent user preferences.`;
  }

  return `User has answered your questions: ${answersText}. You can now continue with the user's answers in mind.`;
}
