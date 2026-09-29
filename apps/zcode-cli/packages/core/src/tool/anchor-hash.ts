// ============================================================
// Anchor Hash — 行锚点的哈希计算与解析
// ============================================================
//
// 锚点形如 `22:AB3F`，含义是「第 22 行，其内容哈希为 AB3F」。
//
// 为什么不是「纯哈希寻址」（better-edit 那种只回显哈希的方案）：
// 内容派生的短哈希在单文件内必然碰撞。3 字符 base62 = 238 328 个值，按生日问题
// 估算，1000 行文件的碰撞概率约 88%；哈希一旦碰撞，模型引用的锚点就无法确定指向
// 哪一行。带上行号后，行号负责定位、哈希负责见证，碰撞不再破坏唯一性。
//
// 哈希的**唯一职责是见证**：校验模型引用的那一行内容是否还是它看到的内容。
// 定位优先用行号，行号对不上时按哈希在文件里重新定位（自愈合），
// 只有哈希在文件内唯一命中才敢移动，否则拒绝——绝不猜。
//
// 冻结要求：哈希函数一旦上线就不能改。改了会让所有历史会话的锚点失效
// （表现为大批 E_ANCHOR_STALE）。需要改算法时必须同时升级 ANCHOR_HASH_VERSION
// 并让旧锚点被识别为过期。

/** Crockford base32：去掉 I/L/O/U，避免模型抄锚点时混淆 1/0。 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ALPHABET_SIZE = ALPHABET.length;
/** 4 字符 → 32^4 = 1 048 576 个值。 */
export const ANCHOR_HASH_LENGTH = 4;
/** 参与哈希的版本盐；换算法时必须一起改，用于让旧锚点失效而不是静默错配。 */
const ANCHOR_HASH_VERSION = "zcode-anchor-v1";
export const ANCHOR_SEPARATOR = "│";

/** FNV-1a 32 位。短字符串分布足够均匀，且无需引入依赖。 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 行内容 → 定长锚点哈希。空行也参与（用版本盐区分，避免与任意内容碰撞）。 */
export function hashLineContent(lineContent: string): string {
  const seed = fnv1a32(`${ANCHOR_HASH_VERSION}\0${lineContent}`);
  let value = seed;
  let out = "";
  for (let index = 0; index < ANCHOR_HASH_LENGTH; index += 1) {
    out += ALPHABET[value % ALPHABET_SIZE];
    value = Math.floor(value / ALPHABET_SIZE);
  }
  return out;
}

/** 计算全文逐行哈希，索引与行号对齐（0 起始）。 */
export function computeLineHashes(lines: readonly string[]): string[] {
  return lines.map((line) => hashLineContent(line));
}

export function splitLines(content: string): string[] {
  return content.split("\n");
}

/**
 * 归一化模型抄回来的哈希：大小写不敏感，并按 Crockford 规则把易混字符映射回数字。
 * 抄错大小写不该让编辑失败——那是无意义的往返。
 */
export function normalizeAnchorHash(raw: string): string | null {
  const mapped = raw
    .trim()
    .toUpperCase()
    .replaceAll("I", "1")
    .replaceAll("L", "1")
    .replaceAll("O", "0")
    .replaceAll("U", "V");
  if (mapped.length !== ANCHOR_HASH_LENGTH) return null;
  for (const char of mapped) {
    if (!ALPHABET.includes(char)) return null;
  }
  return mapped;
}

export interface ParsedAnchor {
  /** 1 起始的行号 */
  line: number;
  hash: string;
}

/**
 * 剥掉排版记号，只留锚点本体。
 *
 * 错误信息会渲染 `>>> 22:AB3F│...` 与 `22:AB3F│content`，模型常连标记或正文一起抄回来。
 * 抄错的是**排版**而不是语义，不该判 malformed——那是一次无意义的往返。
 * 剥的是「行首标记」与「分隔符后的正文」，不碰锚点本身。
 */
function stripAnchorDecorations(raw: string): string {
  let value = raw.trim();
  // 行首装饰：`>>> `、`* `、`+ `、`- `（错误信息与 diff 的记号）
  value = value.replace(/^(?:>>>|\*|\+|-)\s+/, "");
  // 分隔符之后的正文（`22:AB3F│const x = 1;`）→ 只取锚点
  const separatorIndex = value.indexOf(ANCHOR_SEPARATOR);
  if (separatorIndex >= 0) value = value.slice(0, separatorIndex);
  return value.trim();
}

/** 解析 `22:AB3F`。行号缺失或哈希非法都返回 null（由调用方给出可修正的错误）。 */
export function parseAnchor(raw: string): ParsedAnchor | null {
  const trimmed = stripAnchorDecorations(raw);
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0) return null;

  const line = Number.parseInt(trimmed.slice(0, separatorIndex), 10);
  if (!Number.isInteger(line) || line < 1) return null;

  const hash = normalizeAnchorHash(trimmed.slice(separatorIndex + 1));
  if (hash === null) return null;

  return { line, hash };
}

/**
 * 锚点串的解析结果。
 *
 * `hash-only` 是模型常见的省略写法（只给 4 位哈希、不写行号）。它必须与 `malformed`
 * 区分开：前者是合法哈希、能靠文件内唯一匹配定位，后者是真正的垃圾输入。
 * 混为一谈会把「你少写了行号」报成「你的锚点是垃圾」。
 */
export type ParsedAnchorToken =
  | { kind: "explicit"; line: number; hash: string }
  | { kind: "hash-only"; hash: string }
  | { kind: "malformed" };

/**
 * 解析锚点串，兼容 `22:AB3F`、裸哈希 `AB3F`，以及被 `>>>` 标记过的行。
 *
 * 排版记号不参与语义：错误信息用 `>>> ` 标出「你指的那一行」，
 * 模型会连标记一起抄回来，所以这里必须容忍它。见 specs/edit-anchored-verification.md。
 *
 * 裸哈希的定位需要知道文件当前内容，由调用方完成；这里只做格式判定。
 */
export function parseAnchorToken(raw: string): ParsedAnchorToken {
  const trimmed = stripAnchorDecorations(raw);
  if (trimmed === "") return { kind: "malformed" };

  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === 0) return { kind: "malformed" };
  if (separatorIndex > 0) {
    const line = Number.parseInt(trimmed.slice(0, separatorIndex), 10);
    if (!Number.isInteger(line) || line < 1) return { kind: "malformed" };
    const hash = normalizeAnchorHash(trimmed.slice(separatorIndex + 1));
    if (hash === null) return { kind: "malformed" };
    return { kind: "explicit", line, hash };
  }

  const hash = normalizeAnchorHash(trimmed);
  if (hash === null) return { kind: "malformed" };
  return { kind: "hash-only", hash };
}

/** 渲染 Read 输出的行前缀：`22:AB3F│`。 */
export function formatAnchorPrefix(line: number, hash: string): string {
  return `${line}:${hash}${ANCHOR_SEPARATOR}`;
}

/** 渲染一个锚点（供错误信息与编辑结果使用）。 */
export function formatAnchor(line: number, hash: string): string {
  return `${line}:${hash}`;
}
