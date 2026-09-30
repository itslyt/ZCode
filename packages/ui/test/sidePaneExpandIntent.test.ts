import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeSidePaneExpandedIntent,
  requestSidePaneExpanded,
} from "../src/lib/sidePaneExpandIntent.js";

/**
 * 铺满意图的「一次性」语义。
 *
 * 关键边界：意图必须只被消费一次。否则用户手动点「恢复面板宽度」后，
 * 残留的 pending 标记会在下一次面板可见时把它重新铺满。
 */

test("未请求时消费返回 false", () => {
  // 先清空可能由其它用例留下的标记，避免用例间串扰。
  consumeSidePaneExpandedIntent();
  assert.equal(consumeSidePaneExpandedIntent(), false);
});

test("请求后首次消费返回 true，再次消费返回 false", () => {
  consumeSidePaneExpandedIntent();
  requestSidePaneExpanded();
  assert.equal(consumeSidePaneExpandedIntent(), true);
  assert.equal(consumeSidePaneExpandedIntent(), false);
});

test("重复请求只算一次意图", () => {
  consumeSidePaneExpandedIntent();
  requestSidePaneExpanded();
  requestSidePaneExpanded();
  assert.equal(consumeSidePaneExpandedIntent(), true);
  assert.equal(consumeSidePaneExpandedIntent(), false);
});
