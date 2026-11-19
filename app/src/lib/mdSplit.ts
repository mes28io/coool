// A streaming message is parsed again on every token (and every frame of the typing reveal). Its finished blocks
// don't change, so the Markdown view parses them once (memoised per block) and only re-parses the block being
// written. `splitSettled` finds where it is safe to cut: a blank line outside a code fence, before a line that
// starts a new block on its own. Never between two items of one list (a loose list stays one list) and never before
// an indented line (it may continue a list item). Parsing the pieces one after another gives the same elements as
// parsing the whole text; the finished message is parsed whole all the same.

const FENCE = /^ {0,3}(```|~~~)/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;

/** `text` as [settled blocks..., the open tail]; joining them with "" gives `text` back. */
export function splitSettled(text: string): string[] {
  const out: string[] = [];
  let start = 0; // where the current chunk starts (a character offset)
  let blockFirst: string | null = null; // first line of the current block
  let inFence = false;
  let blank = false; // the previous line was blank (outside a fence)
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(pos, end);
    const isBlank = line.trim() === "";
    if (!inFence && blank && !isBlank && blockFirst !== null) {
      const indented = /^\s/.test(line);
      const sameList = LIST.test(line) && LIST.test(blockFirst);
      if (!indented && !sameList) {
        out.push(text.slice(start, pos));
        start = pos;
        blockFirst = null;
      }
    }
    if (!isBlank && blockFirst === null) blockFirst = line;
    if (FENCE.test(line)) inFence = !inFence;
    blank = !inFence && isBlank;
    if (!isBlank && !inFence && LIST.test(line) && blockFirst !== null && !LIST.test(blockFirst)) blockFirst = line;
    if (nl < 0) break;
    pos = nl + 1;
  }
  out.push(text.slice(start));
  return out;
}
