// One markdown renderer for all assistant prose (react-markdown + remark-gfm, no raw HTML).
// Tolerates incomplete markdown while streaming (see `streamSafe`), memoized per message; while it streams, its
// finished blocks are parsed once each and only the block being written is parsed again (lib/mdSplit.ts).

import { InlineMedia } from "./Media";
import { localMedia } from "../lib/mediaRules";
import { Children, isValidElement, memo, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import parseMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useOpenPage, webUrl } from "../lib/browser";
import { ICheck, IFile } from "./icons";
import { cx } from "./primitives";
import { splitSettled, tableColumns } from "../lib/mdSplit";
import { addTime, countRender } from "../lib/perfCount";

const SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * Make a half-streamed message safe to parse: an open code fence is closed (it stays a code
 * block), a table is shown only once its separator line is complete, and an unterminated
 * `code`, **bold**, ~~strike~~ or *emphasis* at the very end stays plain text until it closes.
 */
export function streamSafe(src: string): string {
  let t = src;
  const fences = t.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0;
  if (fences % 2 === 1) return t + (t.endsWith("\n") ? "" : "\n") + "```";

  // Trailing run of table-looking lines: keep it only when header + separator are complete.
  const lines = t.split("\n");
  let i = lines.length;
  while (i > 0 && /^\s*\|/.test(lines[i - 1])) i--;
  const run = lines.slice(i);
  if (run.length && !(run.length >= 2 && SEP.test(run[1]) && run[1].includes("-"))) {
    t = lines.slice(0, i).join("\n");
    return t.replace(/\n+$/, "\n");
  }

  // The last paragraph (all of it when there is no blank line: `lastIndexOf` is -1 then, not a cut after one character).
  const at = t.lastIndexOf("\n\n");
  const cut = at < 0 ? 0 : at + 2;
  const head = t.slice(0, cut);
  let tail = t.slice(cut);
  // Dangling markers are dropped (not escaped) so raw symbols never flash; once the closer
  // arrives the text turns bold / code / etc. in place.
  const dropLast = (s: string, tok: string) => {
    const at = s.lastIndexOf(tok);
    return at < 0 ? s : s.slice(0, at) + s.slice(at + tok.length);
  };
  const count = (s: string, tok: string) => s.split(tok).length - 1;
  if (count(tail, "`") % 2 === 1 && !/```/.test(tail)) tail = dropLast(tail, "`");
  if (count(tail, "**") % 2 === 1) tail = dropLast(tail, "**");
  if (count(tail, "~~") % 2 === 1) tail = dropLast(tail, "~~");
  const singles = tail.replace(/\*\*/g, "").replace(/^\s*[*]\s/gm, "");
  if (count(singles, "*") % 2 === 1) {
    const at = tail.lastIndexOf("*");
    if (at >= 0 && tail[at - 1] !== "*" && tail[at + 1] !== "*") tail = tail.slice(0, at) + tail.slice(at + 1);
  }
  // A link still being written: [text](http://par  or  [te
  tail = tail.replace(/\[([^\]\n]*)\]\([^)\n]*$/, "$1").replace(/\[([^\]\n]*)$/, "$1");
  return head + tail;
}

const textOf = (n: ReactNode): string => {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isValidElement(n)) return textOf((n.props as { children?: ReactNode }).children);
  return "";
};

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(isValidElement) as React.ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const lang = /language-([\w+#-]+)/.exec(code?.props.className ?? "")?.[1] ?? "";
  const text = textOf(code?.props.children ?? children).replace(/\n$/, "");
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative my-2 rounded-[12px] border border-hairline bg-raised">
      {lang && <span className="pointer-events-none absolute right-3 top-2 font-mono text-micro text-faint transition-opacity duration-150 group-hover/code:opacity-0">{lang}</span>}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
        title="Copy"
        aria-label="Copy code"
        className="absolute right-2 top-1.5 flex h-[24px] items-center gap-1 rounded-[7px] px-1.5 text-small text-dim opacity-0 transition-opacity duration-150 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/code:opacity-100"
      >
        {copied ? <ICheck size={13} /> : <IFile size={13} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="selectable overflow-x-auto px-3.5 py-3 font-mono text-mono-small leading-[18px] text-fg/90">
        <code>{text}</code>
      </pre>
    </div>
  );
}

/** A link (markdown or a bare URL, which remark-gfm links): http(s) opens in the session's browser panel; nothing else opens. */
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const open = useOpenPage();
  const url = webUrl(href);
  return (
    <a
      href={href}
      title={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        // Never navigate the app's own webview.
        e.preventDefault();
        if (url) open({ kind: "web", url });
      }}
      data-chat-link={url ?? undefined}
      className="text-fg underline decoration-faint underline-offset-2 transition-colors hover:decoration-fg"
    >
      {children}
    </a>
  );
}

const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", cls: string) =>
  function H({ node: _n, ...p }: ComponentPropsWithoutRef<"h2"> & { node?: unknown }) {
    return <Tag className={cx("mb-1 mt-4 first:mt-0", cls)} {...p} />;
  };

const components: Components = {
  p: ({ node: _n, ...p }) => <p className="whitespace-pre-wrap [&:not(:first-child)]:mt-2.5" {...p} />,
  strong: ({ node: _n, ...p }) => <strong className="font-semibold text-fg" {...p} />,
  em: ({ node: _n, ...p }) => <em className="italic" {...p} />,
  del: ({ node: _n, ...p }) => <del className="text-dim line-through decoration-faint/60" {...p} />,
  h1: heading("h1", "text-title font-semibold tracking-[-0.01em] text-fg"),
  h2: heading("h2", "text-prose font-semibold text-fg"),
  h3: heading("h3", "text-base font-semibold text-fg"),
  h4: heading("h4", "text-base font-medium text-dim"),
  h5: heading("h5", "text-base font-medium text-dim"),
  h6: heading("h6", "text-base font-medium text-dim"),
  ul: ({ node: _n, className, ...p }) => <ul className={cx("my-1.5 flex flex-col gap-1 pl-5 marker:text-faint [&_ul]:my-1 [&_ol]:my-1", className?.includes("contains-task-list") ? "list-none pl-0.5" : "list-disc")} {...p} />,
  ol: ({ node: _n, ...p }) => <ol className="my-1.5 flex list-decimal flex-col gap-1 pl-5 marker:text-faint [&_ul]:my-1 [&_ol]:my-1" {...p} />,
  li: ({ node: _n, className, ...p }) => <li className={cx("[&>p]:mt-1", className?.includes("task-list-item") && "flex items-start gap-2")} {...p} />,
  input: ({ node: _n, type, checked }) =>
    type === "checkbox" ? (
      <span aria-checked={!!checked} role="checkbox" className={cx("mt-[4px] flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border", checked ? "border-fg bg-fg text-bg" : "border-line")}>
        {checked && <ICheck size={11} />}
      </span>
    ) : null,
  blockquote: ({ node: _n, ...p }) => <blockquote className="my-2 border-l-2 border-line pl-3 text-dim" {...p} />,
  hr: () => <hr className="my-3 border-0 border-t border-hairline" />,
  // A link to a picture, video, sound or PDF of the chat opens it in the media viewer; other links as before.
  a: ({ node: _n, href, children }) => (localMedia(href) ? <InlineMedia path={localMedia(href)!.path} link={children} /> : <Link href={href}>{children}</Link>),
  // Remote images are never loaded: an image is its alt text as a link. A local one the chat references is shown.
  img: ({ node: _n, src, alt }) =>
    typeof src === "string" && localMedia(src) ? (
      <InlineMedia path={localMedia(src)!.path} alt={alt} />
    ) : (
      <a href={src} title={typeof src === "string" ? src : undefined} target="_blank" rel="noreferrer" onClick={(e) => e.preventDefault()} className="text-dim underline decoration-faint underline-offset-2">
        {alt || src}
      </a>
    ),
  pre: ({ node: _n, children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ node: _n, className, children }) => <code className={cx("rounded-[4px] bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] px-[5px] py-[1px] font-mono text-[0.88em] text-fg", className)}>{children}</code>,
  // A table takes the column's width and its cells wrap (long words and paths too), so it fits; one with too many
  // columns to wrap readably (under ~7rem a column) keeps that width and scrolls sideways in its own box. Never wider
  // than the column, never clipped.
  table: ({ node, ...p }) => (
    <div className="scroll my-2 max-w-full overflow-x-auto" data-md-table>
      <table className="w-full border-collapse text-base tnum" style={{ minWidth: `${tableColumns(node) * 7}rem` }} {...p} />
    </div>
  ),
  th: ({ node: _n, ...p }) => <th className="border-b border-line px-[10px] py-[6px] text-left align-bottom font-medium text-fg [overflow-wrap:anywhere]" {...p} />,
  td: ({ node: _n, ...p }) => <td className="border-b border-hairline px-[10px] py-[6px] align-top [overflow-wrap:anywhere]" {...p} />,
};

/** Assistant prose as markdown. `streaming`: the text is still arriving. */
export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  if (streaming) {
    // Each piece renders its elements straight into the same div, so the DOM is what one parse would give.
    const parts = splitSettled(text);
    const tail = parts.pop() ?? "";
    return (
      <div className={cx("md selectable md-live", className)}>
        {parts.map((t, i) => (
          <Piece key={i} text={t} />
        ))}
        <Piece key={parts.length} text={streamSafe(tail)} />
      </div>
    );
  }
  return (
    <div className={cx("md selectable", className)}>
      <Piece text={text} />
    </div>
  );
});

const PLUGINS = [remarkGfm];

const Piece = memo(function Piece({ text }: { text: string }) {
  countRender("Markdown.Piece");
  // react-markdown's component is a plain function (no hooks): called here, so its parse can be timed (perf scenarios).
  return useMemo(() => {
    const t = performance.now();
    const out = parseMarkdown({ remarkPlugins: PLUGINS, components, children: text });
    addTime("markdown", performance.now() - t);
    return out;
  }, [text]);
});
