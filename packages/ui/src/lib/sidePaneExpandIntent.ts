/**
 * 侧边面板铺满意图
 *
 * 为什么不用共享 state：`isSidePaneExpanded` 是 AnimatedSidePanePanel 的局部 useState
 * （刻意不落 store、不持久化 —— 刷新后回到普通宽度）。收藏点击发生在侧边栏，
 * 拿不到那份 state，所以用一次性意图事件把「这次打开请铺满」传给面板。
 *
 * 语义边界：
 * - 只影响发起意图的那一次打开；面板组件消费后即失效，不改变「铺满」本身的持久语义。
 * - 面板不可见时意图被丢弃（与 shouldApplySidePaneExpanded 的「收起不铺满」一致）。
 * - 用户手动点过「恢复面板宽度」后，不会再被旧意图重新铺满。
 */

const SIDE_PANE_EXPAND_INTENT_EVENT = "zcode:side-pane-expand-intent";

let pendingIntent = false;

/**
 * 请求下一次面板展开时铺满。
 *
 * 调用方（如侧边栏网站收藏）在触发打开动作前调用，不等待、不关心面板是否已挂载：
 * 事件与 pending 标记同时设置，面板在任意时刻挂载都能消费到。
 */
export function requestSidePaneExpanded(): void {
  pendingIntent = true;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SIDE_PANE_EXPAND_INTENT_EVENT));
}

/**
 * 消费待处理的铺满意图。
 *
 * 返回 true 表示本次消费到了一个意图；无论结果如何都会清空，避免同一意图重复生效。
 */
export function consumeSidePaneExpandedIntent(): boolean {
  const intent = pendingIntent;
  pendingIntent = false;
  return intent;
}

export function addSidePaneExpandedIntentListener(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(SIDE_PANE_EXPAND_INTENT_EVENT, listener);
  return () => window.removeEventListener(SIDE_PANE_EXPAND_INTENT_EVENT, listener);
}
