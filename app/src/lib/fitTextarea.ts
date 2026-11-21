// A textarea that fits its text: collapsed to be measured, then given its content's height (up to `max`).
//
// Its box holds its height while it is collapsed. Otherwise that forced layout makes what sits above it taller for an
// instant: WebKit clamps a scroller's scrollTop to the smaller range, and a timeline pinned to the bottom is left short
// of it once the textarea is back, with no resize for anyone to notice (the chat's message list jumped down and back
// up while typing; self-test `typing-steady`, app/src/selftestTyping.ts).
export function fitTextarea(el: HTMLTextAreaElement, max: number, min = 0) {
  const box = el.parentElement;
  if (box) box.style.minHeight = `${box.offsetHeight}px`;
  el.style.height = "0px";
  el.style.height = Math.min(max, Math.max(min, el.scrollHeight)) + "px";
  if (box) box.style.minHeight = "";
}
