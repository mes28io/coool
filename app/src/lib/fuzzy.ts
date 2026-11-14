/** Subsequence match with a bonus for word starts and contiguous runs. */
export function score(q: string, s: string): number {
  if (!q) return 1;
  const t = s.toLowerCase();
  let ti = 0;
  let sc = 0;
  let run = 0;
  for (const ch of q.toLowerCase()) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    run = at === ti ? run + 1 : 0;
    sc += 1 + run * 2 + (at === 0 || /[\s/·_-]/.test(t[at - 1]) ? 3 : 0);
    ti = at + 1;
  }
  return sc - t.length * 0.01;
}
