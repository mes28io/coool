// Every tooltip in the app, in the app's own style. Components keep writing `title="…"`: this one layer takes the
// text from the element under the pointer (and takes the attribute away for as long as it is hovered, so the system's
// tooltip never shows), and draws it as a raised card beside the element.
//
//   rests     450 ms before the first one; moving on to a neighbour within 400 ms of one shows at once
//   leaves    on pointer leave, press, key, scroll, wheel, or the window losing focus
//   placed    below the element, else above, right, left: the first side that fits the window and stays off the
//             in-app browser's page (a native view, which draws above everything)
//   text      as written, line breaks kept, at most 320px wide and 8 lines
//
// `data-tip` works like `title` for an element that should never have the system's (it is not removed).

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMotion } from "../lib/motion";
import { placeTip, type Box } from "../lib/tipPlace";

const REST_MS = 450;
const FOLLOW_MS = 400;

type Tip = { text: string; anchor: Box; key: number };

/** The nearest element with a tooltip, from the event's target up. */
function tipHost(t: EventTarget | null): HTMLElement | null {
  if (!(t instanceof Element)) return null;
  const el = t.closest("[title], [data-tip], [data-tip-held]");
  return el instanceof HTMLElement && !el.closest("[data-no-tip]") ? el : null;
}

/** Takes the element's `title` for ourselves (so the system shows none) and returns the tooltip's text. */
function take(el: HTMLElement): string {
  const title = el.getAttribute("title");
  if (title !== null) {
    el.removeAttribute("title");
    if (title.trim()) {
      el.dataset.tipHeld = title;
      // The title was the element's only name for assistive tech when it has no text of its own.
      if (!el.getAttribute("aria-label") && !el.textContent?.trim()) {
        el.setAttribute("aria-label", title);
        el.dataset.tipNamed = "";
      }
    } else delete el.dataset.tipHeld;
  }
  return (el.dataset.tipHeld ?? el.dataset.tip ?? "").trim();
}

/** Gives the `title` back when the pointer leaves (React's own later updates of the prop then land as usual). */
function giveBack(el: HTMLElement) {
  const held = el.dataset.tipHeld;
  if (held !== undefined && !el.hasAttribute("title")) el.setAttribute("title", held);
  delete el.dataset.tipHeld;
  if (el.dataset.tipNamed !== undefined) {
    el.removeAttribute("aria-label");
    delete el.dataset.tipNamed;
  }
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const reduce = useMotion().reduce;

  useEffect(() => {
    let host: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastShown = 0;
    let shown = false;
    let n = 0;
    let watch: MutationObserver | null = null;
    // Elements around the hovered one with a `title` of their own (a row around a chip): theirs is held back too, or
    // the system would show it in place of the one we took.
    let above: HTMLElement[] = [];

    const show = () => {
      if (!host || !host.isConnected) return;
      const text = take(host);
      if (!text) return;
      const r = host.getBoundingClientRect();
      shown = true;
      setTip({ text, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, key: n });
    };
    const drop = () => {
      clearTimeout(timer);
      watch?.disconnect();
      watch = null;
      if (host) giveBack(host);
      for (const el of above) giveBack(el);
      above = [];
      host = null;
      if (shown) lastShown = performance.now();
      shown = false;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.buttons) return;
      const el = tipHost(e.target);
      if (el === host) return;
      const follow = shown || performance.now() - lastShown < FOLLOW_MS;
      drop();
      if (!el) return;
      host = el;
      n++;
      if (!take(el)) {
        host = null;
        return;
      }
      // The text can change under the pointer (a running timer, a row that updates): keep the system's away and ours current.
      watch = new MutationObserver(() => {
        if (host?.hasAttribute("title")) {
          take(host);
          if (shown) show();
        }
      });
      watch.observe(el, { attributes: true, attributeFilter: ["title"] });
      for (let p = el.parentElement?.closest<HTMLElement>("[title]"); p; p = p.parentElement?.closest<HTMLElement>("[title]")) {
        take(p);
        above.push(p);
      }
      timer = setTimeout(show, follow ? 60 : REST_MS);
    };
    const out = (e: PointerEvent) => {
      if (host && !(e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) drop();
    };
    const opts = { capture: true, passive: true } as const;
    document.addEventListener("pointerover", over, opts);
    document.addEventListener("pointerout", out, opts);
    document.addEventListener("pointerdown", drop, opts);
    document.addEventListener("keydown", drop, opts);
    document.addEventListener("wheel", drop, opts);
    document.addEventListener("scroll", drop, opts);
    window.addEventListener("blur", drop);
    return () => {
      drop();
      document.removeEventListener("pointerover", over, opts);
      document.removeEventListener("pointerout", out, opts);
      document.removeEventListener("pointerdown", drop, opts);
      document.removeEventListener("keydown", drop, opts);
      document.removeEventListener("wheel", drop, opts);
      document.removeEventListener("scroll", drop, opts);
      window.removeEventListener("blur", drop);
    };
  }, []);

  return createPortal(<AnimatePresence>{tip && <TipCard key={tip.key} tip={tip} reduce={reduce} />}</AnimatePresence>, document.body);
}

function TipCard({ tip, reduce }: { tip: Tip; reduce: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; side: "below" | "above" | "right" | "left" } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const avoid = [...document.querySelectorAll("[data-browser-native]")].map((n) => n.getBoundingClientRect());
    setAt(placeTip(tip.anchor, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }, avoid));
  }, [tip.anchor, tip.text]);
  const dy = at?.side === "above" ? 3 : at?.side === "below" ? -3 : 0;
  const dx = at?.side === "left" ? 3 : at?.side === "right" ? -3 : 0;
  return (
    <motion.div
      ref={ref}
      role="tooltip"
      data-tooltip={at?.side ?? ""}
      className="pointer-events-none fixed z-[70] max-w-[320px] rounded-[9px] border border-line bg-raised px-2.5 py-1.5 text-small leading-[17px] text-fg shadow-pop"
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden" }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: dx, y: dy, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1, transition: { duration: reduce ? 0 : 0.13, ease: [0.2, 0.8, 0.2, 1] } }}
      exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.08 } }}
    >
      <span className="line-clamp-[8] whitespace-pre-line break-words">{tip.text}</span>
    </motion.div>
  );
}
