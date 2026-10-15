/**
 * 编辑区滚动位置「钉住」工具
 *
 * 背景（AI 润色框）：
 *   润色框在【插入 / 逐段生成 / 折叠展开】时高度会变化，这是一个纯 CSS
 *   高度过渡（.ai-block-body 的 grid-template-rows 0fr↔1fr，340ms）。
 *   高度一变，浏览器会自作主张做两件事：
 *     1) 滚动锚定（scroll anchoring）补偿，自己改 scrollTop；
 *     2) 重排后把光标 / 选区重新滚进可视区。
 *   结果就是「方框一展开，整个画面自己动了」——用户没滚，界面却滚了。
 *
 * 做法：
 *   在给定时间内，每一帧把滚动位置还原成调用时的值。
 *   方框于是从当前位置就地展开：画面上方不动、不跳、不滚。
 *
 * 不抢用户的操作：
 *   用户滚轮 / 触摸 / 按键时立即放手（钉住只用于抵消「自动」滚动）。
 *
 * @param scroller 滚动容器（.editor-scroll）
 * @param ms       钉住时长，默认 420ms（覆盖 340ms 展开动画 + 余量）
 * @returns        release(tailMs?)：提前结束；传 tailMs 则再多钉一会儿，
 *                 用于吸收最后一次光标重定位引发的自动滚动
 */
export function pinScroll(
  scroller: HTMLElement | null,
  ms = 420,
): (tailMs?: number) => void {
  if (!scroller) return () => {};

  const keep = scroller.scrollTop;
  let deadline = performance.now() + ms;
  let raf = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    scroller.removeEventListener("wheel", stop);
    scroller.removeEventListener("touchstart", stop);
    window.removeEventListener("keydown", stop);
  };

  const correct = () => {
    if (Math.abs(scroller.scrollTop - keep) > 0.5) scroller.scrollTop = keep;
  };

  const tick = () => {
    if (stopped) return;
    correct();
    if (performance.now() < deadline) raf = requestAnimationFrame(tick);
    else stop();
  };

  scroller.addEventListener("wheel", stop, { passive: true });
  scroller.addEventListener("touchstart", stop, { passive: true });
  window.addEventListener("keydown", stop);
  raf = requestAnimationFrame(tick);

  return (tailMs = 0) => {
    if (tailMs > 0) {
      // 延长一点，等浏览器这一轮自动滚动落地后再放手
      deadline = performance.now() + tailMs;
      return;
    }
    stop();
  };
}
