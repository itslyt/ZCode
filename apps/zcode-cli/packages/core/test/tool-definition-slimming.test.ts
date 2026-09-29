import assert from "node:assert/strict";
import test from "node:test";
import {
  AskUserQuestionInputJsonSchema,
  AskUserQuestionProviderInputJsonSchema,
  GrepInputJsonSchema,
  GrepProviderInputJsonSchema,
} from "@zcode/contracts";
import { validateInput, validateInitialModelToolInput } from "../src/tool/executor/validation.js";
import { askUserQuestionToolEntry } from "../src/tool/handlers/ask-user-question.js";
import { grepToolEntry } from "../src/tool/handlers/grep.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { editAnchoredToolEntry } from "../src/tool/handlers/edit-anchored.js";
import { buildIdentitySection } from "../src/context/sections/identity.js";

// 本轮改动的验收场景见 specs/tool-definition-slimming.md §4。
// 核心不变式：模型可见面 ⊆ 运行时接受面。provider schema 做减法时，
// executor 校验（validateInput）必须继续接受被减掉的字段——它们由权限阶段或旧插件注入。

function propertiesOf(schema: unknown): string[] {
  return Object.keys((schema as { properties?: Record<string, unknown> }).properties ?? {});
}

test("AskUserQuestion 模型面只暴露 questions", () => {
  assert.deepEqual(propertiesOf(askUserQuestionToolEntry.providerInputSchema), ["questions"]);
  assert.deepEqual(propertiesOf(AskUserQuestionProviderInputJsonSchema), ["questions"]);
});

// 不变式：运行时 schema 仍接受 answers/annotations/metadata —— 权限组件注入它们后再校验。
test("AskUserQuestion 运行时仍接受权限阶段注入的字段", () => {
  assert.deepEqual(propertiesOf(AskUserQuestionInputJsonSchema), [
    "questions",
    "answers",
    "annotations",
    "metadata",
  ]);

  const input = {
    questions: [
      {
        question: "Which?",
        header: "Pick",
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
        multiSelect: false,
      },
    ],
    answers: { "Which?": "A" },
  };
  assert.equal(
    validateInput(input, askUserQuestionToolEntry),
    undefined,
    "带 answers 的输入必须仍能通过 executor 校验",
  );
});

test("AskUserQuestion 描述不再引用面外的计划模式工具与内部命令", () => {
  const description = askUserQuestionToolEntry.metadata.description ?? "";
  for (const dead of ["EnterPlanMode", "ExitPlanMode", "/remember"]) {
    assert.ok(!description.includes(dead), `描述不应提及 ${dead}`);
  }
});

test("Grep 模型面去掉 0 使用的 type/offset", () => {
  const provider = propertiesOf(GrepProviderInputJsonSchema);
  assert.ok(!provider.includes("type"));
  assert.ok(!provider.includes("offset"));
  assert.ok(provider.includes("pattern"));
});

test("Grep 运行时仍接受 type/offset（hook 改写与旧插件）", () => {
  assert.ok(propertiesOf(GrepInputJsonSchema).includes("type"));
  assert.ok(propertiesOf(GrepInputJsonSchema).includes("offset"));

  const input = { pattern: "x", type: "ts", offset: 0 };
  assert.equal(
    validateInput(input, grepToolEntry),
    undefined,
    "带 type/offset 的输入必须仍能通过 executor 校验",
  );
});

test("Grep 描述不再宣传已被移出模型面的 type 参数", () => {
  const description = grepToolEntry.metadata.description ?? "";
  assert.ok(!description.includes("`type`"), "描述不应再提 type");
});

test("provider schema 的 required 随属性一起裁", () => {
  const provider = GrepProviderInputJsonSchema as { required?: unknown };
  assert.deepEqual(provider.required, ["pattern"]);
});

test("未声明 providerInputSchema 的工具不受影响", () => {
  assert.equal(readToolEntry.providerInputSchema, undefined);
  assert.deepEqual(
    propertiesOf(readToolEntry.inputSchema),
    propertiesOf(readToolEntry.providerInputSchema ?? readToolEntry.inputSchema),
  );
});

// 最小合法输入在模型面与运行时两侧都通过。
test("最小合法输入在模型面与运行时两侧都通过", () => {
  const grepMinimal = { pattern: "foo" };
  assert.equal(validateInitialModelToolInput(grepMinimal, grepToolEntry), undefined);

  const askMinimal = {
    questions: [
      {
        question: "Which?",
        header: "Pick",
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
        multiSelect: false,
      },
    ],
  };
  assert.equal(validateInitialModelToolInput(askMinimal, askUserQuestionToolEntry), undefined);
});

// Git 策略的唯一所有者在 identity 段：工具描述只说工具自己的行为
// （specs/tool-definition-slimming.md §3.3）。曾有两句互相矛盾的说法同时在场——
// identity 的 "Commit when it fits the work" 与 Bash 的 "only when the user asks"，
// 模型只能猜。
test("Bash 描述不再承载 Git 工作流策略", () => {
  const description = bashToolEntry.metadata.description ?? "";
  assert.ok(!description.includes("`gh` CLI"), "gh CLI 指引归 identity 段");
  assert.ok(!description.includes("Commit or push only when the user asks"));
  assert.ok(!description.includes("# Git"), "Git 小节整体移出工具描述");
  // 工具自身的限制留在原处：交互式 flag 在这个环境确实不可用。
  assert.ok(description.includes("`-i`"), "交互式 flag 限制属于本工具，应保留");
});

test("identity 是 Git 策略的唯一所有者", () => {
  const identity = buildIdentitySection().content;
  assert.ok(identity.includes("`gh` CLI"), "identity 承载 gh CLI 指引");
  assert.ok(identity.includes("branch first"), "identity 承载 branch first");
  assert.ok(identity.includes("never push"), "identity 承载推送禁令");
});

// Edit 与 EditAnchored 曾各用 163 字符解释「何时改用另一个」（重叠 79%）。
// 现在 Edit 只剩一句短指针。
test("Edit 不再重复 EditAnchored 的完整回退说明", () => {
  const editDescription = editToolEntry.metadata.description ?? "";
  const anchoredDescription = editAnchoredToolEntry.metadata.description ?? "";
  for (const noisy of ["after two `EditAnchored` failures", ".ipynb"]) {
    assert.ok(!editDescription.includes(noisy), `Edit 描述不应再展开 ${noisy}`);
  }
  assert.ok(editDescription.includes("EditAnchored"), "但仍需保留一句指向 EditAnchored");
  assert.ok(anchoredDescription.includes("anchors that Read prints"));
});

// 第二轮：删掉的是**失实**与**纯重复**，不是「短一点好」。下面每条都钉住一个具体机制，
// 防止将来有人凭「描述太长」再把它改回去或删掉仍有用的那条。

test("AskUserQuestion 不再宣传任何客户端都不存在的并排预览", () => {
  const description = askUserQuestionToolEntry.metadata.description ?? "";
  for (const phantom of ["side-by-side", "monospace box", "ASCII mockup", "Preview feature"]) {
    assert.ok(!description.includes(phantom), `不该承诺不存在的 UI：${phantom}`);
  }
  // preview 字段本身保留（TUI 回传链路仍读它），所以描述里提一句它的用途是对的，
  // 但不能再描述渲染形态。这里只钉「没有渲染承诺」，不钉字段是否被提及。
});

test("Edit 不再教模型手工剥一个已经自动被剥的前缀", () => {
  const description = editToolEntry.metadata.description ?? "";
  assert.ok(
    !description.includes("Strip the Read line prefix"),
    "findEditMatch 已自动剥 N:HASH│ 与旧 N\\t 前缀，手工剥的指引既过时又多余",
  );
  // 未读拒绝是**事前**指引，能省下一次失败往返，必须留着。
  assert.ok(
    description.includes("Read the file in this conversation before editing"),
    "事前的未读指引应保留（错误消息只能事后补救）",
  );
});

test("Read 不再引用已被移除的未变更短路", () => {
  const description = readToolEntry.metadata.description ?? "";
  assert.ok(
    !description.includes("Do NOT re-read a file you just edited"),
    "该短路按 specs/read-unchanged-stub.md 已移除，Read 一律返回内容",
  );
  // 锚点是 Read 的产出，这条必须留在 Read 里（EditAnchored 与模型都依赖它）。
  assert.ok(description.includes("N:HASH"), "锚点格式的定义属于 Read");
});

test("identity 不再复述工具描述已有的编辑细节", () => {
  const identity = buildIdentitySection().content;
  assert.ok(identity.includes("EditAnchored"), "仍需保留「什么时候用哪个工具」的判断");
  for (const detail of ["N:HASH", ".ipynb", "stale-anchor"]) {
    assert.ok(!identity.includes(detail), `编辑细节应只在工具描述里说一次：${detail}`);
  }
});

// §3.9：一次真实会话的 13 次 unserved 全部源于用 Bash 看内容后自拼锚点。
// 这两条指引是唯一能事前拦下它的手段，删掉会退回那 13 次失败。
test("锚点来源被点明：只有 Read 产出锚点，Bash 看到的内容不算", () => {
  const anchored = editAnchoredToolEntry.metadata.description ?? "";
  assert.ok(anchored.includes("Only lines you have already read"), "事前指引必须留");
  assert.ok(anchored.includes("Read is the only source of anchors"));
  assert.ok(anchored.includes("cat") && anchored.includes("sed"), "需要给出非 Read 的反例");

  const read = readToolEntry.metadata.description ?? "";
  assert.ok(read.includes("N:HASH"), "锚点格式的定义属于 Read");
  assert.ok(read.includes("carries no anchors"), "Read 需说明：其他工具看到的内容不带锚点");
});
