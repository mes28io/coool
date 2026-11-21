//! Line diffs, hunks, and putting hunks back (forward or in reverse) on a text that may have moved on.
//!
//! Lines keep their terminators (`"\n"`, `"\r\n"`, or none for a last line without a newline), so a diff and its
//! reversal give back the exact bytes: CRLF files stay CRLF, a missing final newline stays missing. What is shown
//! (`Line::t`) has the terminator taken off, with `eol` saying whether there was one.
//!
//! Applying a hunk never guesses: the lines it expects (its post-image to undo it, its pre-image to apply it) must
//! be in the text as they are, at the place nearest to where the hunk says. When they aren't, the hunk doesn't apply
//! and [`Conflict`] says where it looked; nothing is written.

use serde::Serialize;

/// Above this many lines on either side a file is not diffed line by line (it is shown as "too large").
pub const MAX_LINES: usize = 20_000;
/// Above this many bytes on either side, the same.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Context lines around each change.
pub const CONTEXT: usize = 3;
/// Myers stops after this many edits and falls back to "all of it changed" for the middle part.
const MAX_EDITS: usize = 2_000;

/// The lines of `s`, each with its terminator.
pub fn split_lines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = s.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if c == b'\n' {
            out.push(&s[start..=i]);
            start = i + 1;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// A line without its terminator.
pub fn strip_eol(l: &str) -> &str {
    l.strip_suffix("\r\n").or_else(|| l.strip_suffix('\n')).unwrap_or(l)
}

/// The terminator most lines of `s` use (`"\r\n"` when most do, else `"\n"`).
pub fn dominant_eol(s: &str) -> &'static str {
    let lf = s.matches('\n').count();
    let crlf = s.matches("\r\n").count();
    if crlf * 2 > lf { "\r\n" } else { "\n" }
}

/// Binary: a NUL byte in the first 8 KB, or not UTF-8 at all.
pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&c| c == 0) || std::str::from_utf8(bytes).is_err()
}

/// Too large to diff line by line.
pub fn too_large(s: &str) -> bool {
    s.len() > MAX_BYTES || s.bytes().filter(|&c| c == b'\n').count() > MAX_LINES
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Eq,
    Del,
    Ins,
}

/// An edit script from `a` to `b`: (op, index in a, index in b). Eq and Del carry a's index, Ins carries b's
/// (the other index is where it sits). Common prefix and suffix are taken off first, then Myers' O(ND) diff;
/// past [`MAX_EDITS`] the middle is one delete plus one insert.
pub fn diff<T: PartialEq>(a: &[T], b: &[T]) -> Vec<(Op, usize, usize)> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let (am, bm) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    let mut out: Vec<(Op, usize, usize)> = (0..pre).map(|i| (Op::Eq, i, i)).collect();
    match myers(am, bm) {
        Some(mid) => out.extend(mid.into_iter().map(|(op, i, j)| (op, i + pre, j + pre))),
        None => {
            out.extend((0..am.len()).map(|i| (Op::Del, i + pre, pre)));
            out.extend((0..bm.len()).map(|j| (Op::Ins, pre + am.len(), j + pre)));
        }
    }
    out.extend((0..suf).map(|k| (Op::Eq, a.len() - suf + k, b.len() - suf + k)));
    out
}

fn myers<T: PartialEq>(a: &[T], b: &[T]) -> Option<Vec<(Op, usize, usize)>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    if n == 0 {
        return Some((0..b.len()).map(|j| (Op::Ins, 0, j)).collect());
    }
    if m == 0 {
        return Some((0..a.len()).map(|i| (Op::Del, i, 0)).collect());
    }
    let max = (n + m) as usize;
    let off = max as isize;
    let mut v = vec![0isize; 2 * max + 2];
    // trace[d]: v as it was before step d, for k in [-(d-1), d-1] only (all the walk back reads): O(D^2) memory.
    let mut trace: Vec<Vec<i32>> = Vec::new();
    let mut found = None;
    'outer: for d in 0..=(max.min(MAX_EDITS) as isize) {
        trace.push(if d == 0 { Vec::new() } else { (-(d - 1)..=(d - 1)).map(|k| v[(k + off) as usize] as i32).collect() });
        let mut k = -d;
        while k <= d {
            let ki = (k + off) as usize;
            let mut x = if k == -d || (k != d && v[ki - 1] < v[ki + 1]) { v[ki + 1] } else { v[ki - 1] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[ki] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'outer;
            }
            k += 2;
        }
    }
    let d_end = found?;
    // Walk back through the trace.
    let mut ops = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (1..=d_end).rev() {
        let t = &trace[d as usize];
        let at = |k: isize| t[(k + d - 1) as usize] as isize;
        let k = x - y;
        let prev_k = if k == -d || (k != d && at(k - 1) < at(k + 1)) { k + 1 } else { k - 1 };
        let prev_x = at(prev_k);
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            ops.push((Op::Eq, x as usize, y as usize));
        }
        if x == prev_x {
            y -= 1;
            ops.push((Op::Ins, x as usize, y as usize));
        } else {
            x -= 1;
            ops.push((Op::Del, x as usize, y as usize));
        }
    }
    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        ops.push((Op::Eq, x as usize, y as usize));
    }
    ops.reverse();
    Some(ops)
}

/// One line of a hunk as shown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Line {
    /// " " context, "-" removed, "+" added.
    pub k: &'static str,
    /// The text without its terminator.
    pub t: String,
    /// Line number on the old side (1-based), for context and removed lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub o: Option<u32>,
    /// Line number on the new side (1-based), for context and added lines.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    /// False for a last line without a newline.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub noeol: bool,
    /// Its terminator is CRLF.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub crlf: bool,
}

/// A run of changes with its context. `old`/`new` hold the raw lines (with terminators) of its pre- and post-image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    /// 0-based start of the pre-image in the old text, and of the post-image in the new one.
    pub old_start: usize,
    pub new_start: usize,
    pub old: Vec<String>,
    pub new: Vec<String>,
    /// Every line in order, with its op.
    pub lines: Vec<(Op, String)>,
}

impl Hunk {
    /// Lines added and removed.
    pub fn counts(&self) -> (usize, usize) {
        let add = self.lines.iter().filter(|(o, _)| *o == Op::Ins).count();
        let del = self.lines.iter().filter(|(o, _)| *o == Op::Del).count();
        (add, del)
    }

    /// A stable name for what it changes (the removed and added lines, not where): "kept" marks survive line shifts.
    pub fn fingerprint(&self) -> String {
        let mut h: u64 = 0xcbf29ce484222325;
        for (op, l) in &self.lines {
            let tag: u8 = match op {
                Op::Eq => continue,
                Op::Del => b'-',
                Op::Ins => b'+',
            };
            for &c in std::iter::once(&tag).chain(strip_eol(l).as_bytes()).chain(b"\n") {
                h ^= c as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
        }
        format!("{h:016x}")
    }

    /// The lines as shown, numbered.
    pub fn view(&self) -> Vec<Line> {
        let (mut o, mut n) = (self.old_start as u32 + 1, self.new_start as u32 + 1);
        self.lines
            .iter()
            .map(|(op, raw)| {
                let t = strip_eol(raw).to_string();
                let noeol = !raw.ends_with('\n');
                let crlf = raw.ends_with("\r\n");
                match op {
                    Op::Eq => {
                        let l = Line { k: " ", t, o: Some(o), n: Some(n), noeol, crlf };
                        o += 1;
                        n += 1;
                        l
                    }
                    Op::Del => {
                        let l = Line { k: "-", t, o: Some(o), n: None, noeol, crlf };
                        o += 1;
                        l
                    }
                    Op::Ins => {
                        let l = Line { k: "+", t, o: None, n: Some(n), noeol, crlf };
                        n += 1;
                        l
                    }
                }
            })
            .collect()
    }

    /// The new side's changed span, 0-based [start, end): where it sits in the new text, context included.
    pub fn new_span(&self) -> (usize, usize) {
        (self.new_start, self.new_start + self.new.len())
    }
}

/// Hunks from `a` to `b` with `ctx` lines of context; hunks whose context would touch are one hunk.
pub fn hunks(a: &str, b: &str, ctx: usize) -> Vec<Hunk> {
    let (al, bl) = (split_lines(a), split_lines(b));
    let script = diff(&al, &bl);
    // Group the script into change runs with context.
    let changed: Vec<usize> = script.iter().enumerate().filter(|(_, (op, _, _))| *op != Op::Eq).map(|(i, _)| i).collect();
    if changed.is_empty() {
        return Vec::new();
    }
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for &i in &changed {
        let s = i.saturating_sub(ctx);
        let e = (i + ctx + 1).min(script.len());
        match groups.last_mut() {
            Some(g) if s <= g.1 => g.1 = g.1.max(e),
            _ => groups.push((s, e)),
        }
    }
    groups
        .into_iter()
        .map(|(s, e)| {
            let part = &script[s..e];
            let (old_start, new_start) = match part[0] {
                (Op::Eq, i, j) => (i, j),
                (Op::Del, i, j) => (i, j),
                (Op::Ins, i, j) => (i, j),
            };
            let mut h = Hunk { old_start, new_start, old: Vec::new(), new: Vec::new(), lines: Vec::new() };
            for &(op, i, j) in part {
                match op {
                    Op::Eq => {
                        h.old.push(al[i].to_string());
                        h.new.push(bl[j].to_string());
                        h.lines.push((Op::Eq, bl[j].to_string()));
                    }
                    Op::Del => {
                        h.old.push(al[i].to_string());
                        h.lines.push((Op::Del, al[i].to_string()));
                    }
                    Op::Ins => {
                        h.new.push(bl[j].to_string());
                        h.lines.push((Op::Ins, bl[j].to_string()));
                    }
                }
            }
            h
        })
        .collect()
}

/// Lines added and removed from `a` to `b`.
pub fn counts(a: &str, b: &str) -> (usize, usize) {
    let (al, bl) = (split_lines(a), split_lines(b));
    let s = diff(&al, &bl);
    (s.iter().filter(|x| x.0 == Op::Ins).count(), s.iter().filter(|x| x.0 == Op::Del).count())
}

/// Why a hunk couldn't be put on a text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict {
    /// 1-based line where the hunk expected its lines.
    pub line: usize,
    pub reason: String,
}

impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.reason)
    }
}

/// Where `want` sits in `have`, nearest to `near`; None when nowhere. `loose`: compare without terminators.
fn locate(have: &[&str], want: &[String], near: usize, loose: bool) -> Option<usize> {
    if want.is_empty() {
        return Some(near.min(have.len()));
    }
    if want.len() > have.len() {
        return None;
    }
    let eq = |a: &str, b: &str| if loose { strip_eol(a) == strip_eol(b) } else { a == b };
    let fits = |p: usize| want.iter().enumerate().all(|(k, w)| eq(have[p + k], w));
    let last = have.len() - want.len();
    let near = near.min(last);
    for d in 0..=last.max(near) {
        if near >= d && fits(near - d) {
            return Some(near - d);
        }
        if d > 0 && near + d <= last && fits(near + d) {
            return Some(near + d);
        }
        if near < d && near + d > last {
            break;
        }
    }
    None
}

/// Puts hunks on `text`: forward (pre-image -> post-image) or in reverse (post-image -> pre-image, to undo them).
/// All of them or none: the first that doesn't fit is the error. Hunks are in file order (as [`hunks`] gives them).
pub fn apply(text: &str, hs: &[Hunk], reverse: bool) -> Result<String, Conflict> {
    let lines = split_lines(text);
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut at = 0usize;
    // How far the text has drifted from where the hunks were made.
    let mut drift: isize = 0;
    for h in hs {
        let (want, put, start) = if reverse { (&h.new, &h.old, h.new_start) } else { (&h.old, &h.new, h.old_start) };
        let near = (start as isize + drift).max(at as isize) as usize;
        let rest = &lines[at..];
        let found = locate(rest, want, near.saturating_sub(at), false).map(|p| (p, false)).or_else(|| locate(rest, want, near.saturating_sub(at), true).map(|p| (p, true)));
        let Some((p, loose)) = found else {
            return Err(Conflict { line: near + 1, reason: "the lines this change expects aren't there any more".into() });
        };
        let p = p + at;
        out.extend(lines[at..p].iter().map(|s| s.to_string()));
        if loose {
            // Same text, other line endings: keep the file's own endings.
            let eol = dominant_eol(text);
            let n = put.len();
            out.extend(put.iter().enumerate().map(|(k, l)| {
                let s = strip_eol(l);
                let last_no_eol = k + 1 == n && !l.ends_with('\n');
                if last_no_eol { s.to_string() } else { format!("{s}{eol}") }
            }));
        } else {
            out.extend(put.iter().cloned());
        }
        drift = p as isize - start as isize;
        at = p + want.len();
    }
    out.extend(lines[at..].iter().map(|s| s.to_string()));
    Ok(out.concat())
}

/// The new-text line indexes (0-based) that `a` -> `b` changed, plus the points where lines were removed (a
/// removal between line i-1 and i of `b` marks i): what someone changed in `b` compared with `a`.
pub fn touched(a: &str, b: &str) -> Vec<usize> {
    let (al, bl) = (split_lines(a), split_lines(b));
    let mut out = Vec::new();
    for (op, _, j) in diff(&al, &bl) {
        match op {
            Op::Eq => {}
            Op::Ins | Op::Del => out.push(j),
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(a: &str, b: &str) {
        let hs = hunks(a, b, CONTEXT);
        assert_eq!(apply(a, &hs, false).unwrap(), b, "forward {a:?} -> {b:?}");
        assert_eq!(apply(b, &hs, true).unwrap(), a, "reverse {b:?} -> {a:?}");
    }

    #[test]
    fn split_keeps_terminators() {
        assert_eq!(split_lines("a\nb\r\nc"), vec!["a\n", "b\r\n", "c"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("\n"), vec!["\n"]);
    }

    #[test]
    fn diffs_and_roundtrips() {
        roundtrip("a\nb\nc\n", "a\nB\nc\n");
        roundtrip("", "new\nfile\n");
        roundtrip("gone\n", "");
        roundtrip("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n", "1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\nELEVEN\n12\n");
        roundtrip("x\ny\n", "y\nx\n");
    }

    #[test]
    fn crlf_is_kept() {
        let a = "one\r\ntwo\r\nthree\r\n";
        let b = "one\r\n2\r\nthree\r\n";
        roundtrip(a, b);
        let hs = hunks(a, b, 1);
        let v = hs[0].view();
        assert!(v.iter().all(|l| l.crlf));
        assert_eq!(v[1].t, "two");
        assert_eq!(dominant_eol(a), "\r\n");
    }

    #[test]
    fn no_trailing_newline() {
        roundtrip("a\nb", "a\nc");
        roundtrip("a\nb", "a\nb\n");
        let hs = hunks("a\nb", "a\nb\n", 3);
        let v = hs[0].view();
        assert!(v.iter().any(|l| l.k == "-" && l.noeol));
        assert!(v.iter().any(|l| l.k == "+" && !l.noeol));
    }

    #[test]
    fn hunks_merge_when_close_and_split_when_far() {
        let a: String = (1..=30).map(|i| format!("l{i}\n")).collect();
        let b = a.replace("l5\n", "five\n").replace("l7\n", "seven\n").replace("l25\n", "twentyfive\n");
        let hs = hunks(&a, &b, 3);
        assert_eq!(hs.len(), 2);
        assert_eq!(hs[0].counts(), (2, 2));
        roundtrip(&a, &b);
    }

    #[test]
    fn one_hunk_reverses_alone_on_a_moved_text() {
        let a: String = (1..=30).map(|i| format!("l{i}\n")).collect();
        let b = a.replace("l5\n", "five\n").replace("l25\n", "twentyfive\n");
        let hs = hunks(&a, &b, 3);
        assert_eq!(hs.len(), 2);
        // Someone added lines at the top since: the second hunk still undoes, further down.
        let moved = format!("new0\nnew1\n{b}");
        let undone = apply(&moved, &hs[1..], true).unwrap();
        assert!(undone.contains("\nl25\n") && undone.contains("five\n") && undone.starts_with("new0\n"));
    }

    #[test]
    fn a_hunk_whose_lines_changed_does_not_apply() {
        let a = "a\nb\nc\n";
        let b = "a\nB\nc\n";
        let hs = hunks(a, b, 1);
        let edited = "a\nB, by hand\nc\n";
        let e = apply(edited, &hs, true).unwrap_err();
        assert!(e.reason.contains("aren't there"));
    }

    #[test]
    fn fingerprints_ignore_position() {
        let hs1 = hunks("a\nb\n", "a\nc\n", 3);
        let hs2 = hunks("x\ny\na\nb\n", "x\ny\na\nc\n", 0);
        assert_eq!(hs1[0].fingerprint(), hs2[0].fingerprint());
    }

    #[test]
    fn binary_and_large() {
        assert!(is_binary(b"\x00\x01"));
        assert!(is_binary(&[0xff, 0xfe, 0x41]));
        assert!(!is_binary("héllo".as_bytes()));
        let big = "x\n".repeat(MAX_LINES + 1);
        assert!(too_large(&big));
        assert!(!too_large("x\n"));
    }

    #[test]
    fn touched_lines() {
        assert_eq!(touched("a\nb\nc\n", "a\nB\nc\n"), vec![1]);
        assert_eq!(touched("a\nb\nc\n", "a\nc\n"), vec![1]);
    }

    #[test]
    fn huge_rewrites_fall_back() {
        let a: String = (0..9000).map(|i| format!("a{i}\n")).collect();
        let b: String = (0..9000).map(|i| format!("b{i}\n")).collect();
        let hs = hunks(&a, &b, 3);
        assert_eq!(apply(&a, &hs, false).unwrap(), b);
    }
}
