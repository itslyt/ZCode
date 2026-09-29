import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplySidePaneExpanded } from "../src/app-shell/animatedSidePanePanelModel.js";

/**
 * 侧栏铺满的生效判定。
 *
 * 这里锁定「本地按下 ≠ 实际铺满」这条语义：面板收起时即使本地还记着用户按过铺满，
 * 也不该继续铺满——否则下次打开面板会莫名又是铺满态。
 */

test("面板可见且用户按下铺满时生效", () => {
  assert.equal(shouldApplySidePaneExpanded({ isExpanded: true, isSidePaneVisible: true }), true);
});

test("用户没按下铺满时不生效", () => {
  assert.equal(shouldApplySidePaneExpanded({ isExpanded: false, isSidePaneVisible: true }), false);
});

test("面板收起时即使本地记着铺满也不生效", () => {
  assert.equal(shouldApplySidePaneExpanded({ isExpanded: true, isSidePaneVisible: false }), false);
});
