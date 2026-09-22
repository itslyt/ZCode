// ============================================================
// Anchor Served — 记录「哪些行锚点已经给模型看过」
// ============================================================
//
// 锚点编辑的硬约束是「只允许改模型看过的行」。这里维护这份集合。
//
// 两条不变量：
//
// 1. **只增不减**。文件内容变了也不清空——模型自己编辑一次后，它手里其余行的锚点
//    仍然是被展示过的，清掉会让这些锚点被误判为 unserved，逼模型重新读整个文件。
// 2. **按文件聚合**。同一文件可能有多次 range read，落在不同 key 的条目上；
//    判定 served 时必须跨条目取并集，不能只看最后一次读取。

import type { ReadFileStateMap } from "./types.js";

/** 合并两组 served 哈希，保持去重。 */
export function mergeServedAnchors(
  existing: readonly string[] | undefined,
  incoming: readonly string[],
): string[] {
  const merged = new Set(existing ?? []);
  for (const hash of incoming) merged.add(hash);
  return [...merged];
}

/**
 * 聚合某个文件在所有读取条目里的 served 哈希。
 *
 * 判定用的是「这个哈希有没有出现过」，而不是「第几行」——文件被编辑后行号会移动，
 * 但哈希代表的仍是同一段内容，所以按哈希判定才是稳定的。
 */
export function collectServedAnchors(
  readFileState: ReadFileStateMap | undefined,
  filePath: string,
): Set<string> {
  const served = new Set<string>();
  if (!readFileState) return served;

  for (const entry of readFileState.values()) {
    if (entry.path !== filePath) continue;
    for (const hash of entry.servedAnchors ?? []) served.add(hash);
  }
  return served;
}
