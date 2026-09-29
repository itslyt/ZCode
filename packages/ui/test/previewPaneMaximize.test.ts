import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyPreviewPaneMaximized } from "../src/app-shell/animatedSidePanePanelModel.js";

/**
 * 预览铺满的生效判定。
 *
 * 这里锁定「本地按下 ≠ 实际铺满」这条语义：面板收起或 active tab 换成非预览类型时，
 * 即使本地还记着用户按过铺满，也不该继续铺满——否则切回来会莫名又铺满。
 */

test("前提全部成立时铺满生效", () => {
  assert.equal(
    shouldApplyPreviewPaneMaximized({
      isMaximized: true,
      isSidePaneVisible: true,
      isCodeViewerTabActive: true,
    }),
    true,
  );
});

test("用户没按下铺满时不生效", () => {
  assert.equal(
    shouldApplyPreviewPaneMaximized({
      isMaximized: false,
      isSidePaneVisible: true,
      isCodeViewerTabActive: true,
    }),
    false,
  );
});

test("面板收起时即使本地记着铺满也不生效", () => {
  assert.equal(
    shouldApplyPreviewPaneMaximized({
      isMaximized: true,
      isSidePaneVisible: false,
      isCodeViewerTabActive: true,
    }),
    false,
  );
});

test("active tab 不是预览时即使本地记着铺满也不生效", () => {
  assert.equal(
    shouldApplyPreviewPaneMaximized({
      isMaximized: true,
      isSidePaneVisible: true,
      isCodeViewerTabActive: false,
    }),
    false,
  );
});
