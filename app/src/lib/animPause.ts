// Infinite CSS animations (status pulses, shimmer words, mood glyphs, step bars, skeletons) run only while
// they can be seen. An element scrolled out of its scroller, off screen, in a hidden pane or a folded card gets
// `data-anim-off` (see styles.css), and every animation in the window pauses while the window is hidden.
// One IntersectionObserver for all of them; a MutationObserver picks up animated elements as they appear.
// Without this, off-screen loops keep the renderer recalculating style and producing frames for nothing.

const ANIMATED = ".needs-ring,.needs-badge,.breathe,.shimmer,.sweep,.attn-card,.seg-run,.spin,.work-spin,.think-dots,.caret,.skel,.mg,.md-live,.welcome-sway,.animate-spin,.animate-ping,.ctx-compacting";

function start() {
  if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const off = !e.isIntersecting;
      const el = e.target as HTMLElement;
      if (off !== el.hasAttribute("data-anim-off")) el.toggleAttribute("data-anim-off", off);
    }
  });
  const each = (n: Node, f: (el: Element) => void) => {
    if (!(n instanceof Element)) return;
    if (n.matches(ANIMATED)) f(n);
    for (const el of n.querySelectorAll(ANIMATED)) f(el);
  };
  const watch = (el: Element) => io.observe(el);
  const unwatch = (el: Element) => io.unobserve(el);
  each(document.body, watch);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") {
        const el = r.target as Element;
        if (el.matches(ANIMATED)) watch(el);
        else if (el.hasAttribute("data-anim-off")) {
          unwatch(el);
          el.removeAttribute("data-anim-off");
        }
        continue;
      }
      r.removedNodes.forEach((n) => each(n, unwatch));
      r.addedNodes.forEach((n) => each(n, watch));
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });

  const vis = () => document.documentElement.classList.toggle("page-hidden", document.hidden);
  document.addEventListener("visibilitychange", vis);
  vis();
}

if (typeof document !== "undefined") {
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}
