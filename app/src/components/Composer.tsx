import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/backend";
import { fitTextarea } from "../lib/fitTextarea";
import { useStore } from "../store";
import { IArrowUp } from "./icons";
import { cx, Kbd } from "./primitives";
import { useVoiceField } from "./voice/VoiceHost";

export function Composer({ pty, provider, disabled, compact }: { pty: number; provider: string; disabled?: boolean; compact?: boolean }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const toast = useStore((s) => s.toast);
  useVoiceField(ta);

  useLayoutEffect(() => {
    if (ta.current) fitTextarea(ta.current, 180);
  }, [text]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending || disabled) return;
    setSending(true);
    try {
      await api().sendPrompt(pty, t);
      setText("");
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };

  const can = !!text.trim() && !disabled;
  return (
    <div className={cx("shrink-0 pb-3 pt-1", compact ? "px-3" : "px-6")}>
      <div
        className={cx(
          "mx-auto flex max-w-[700px] items-end gap-2 rounded-[20px] border bg-raised py-2 pl-3.5 pr-2 shadow-card transition-[border-color,box-shadow] duration-200",
          "border-line focus-within:border-[color-mix(in_oklab,var(--dim)_45%,var(--border))]",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? "Session has exited" : `Message ${provider}…`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className="selectable max-h-[180px] min-h-[22px] flex-1 resize-none bg-transparent py-[3px] text-prose outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-2 pb-[1px]">
          {!compact && (
            <span className="hidden items-center gap-1 text-small text-faint sm:flex">
              <Kbd>⇧</Kbd>
              <Kbd>↵</Kbd>
              <span>newline</span>
            </span>
          )}
          <motion.button
            type="button"
            onClick={send}
            disabled={!can}
            whileTap={can ? { scale: 0.92 } : undefined}
            className={cx(
              "flex size-[32px] items-center justify-center rounded-[9px] transition-[background-color,color] duration-150",
              can ? "bg-fg text-bg" : "bg-[color-mix(in_oklab,var(--dim)_14%,transparent)] text-faint",
            )}
            title="Send (Enter)"
          >
            <IArrowUp size={17} strokeWidth={1.9} />
          </motion.button>
        </div>
      </div>
    </div>
  );
}
