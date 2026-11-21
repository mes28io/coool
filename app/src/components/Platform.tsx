// Claude Platform (APP_SPEC "Claude Platform"): the chat header's badge for a chat billed to an API key, and the
// account menu of the New session sheet.

import { useEffect } from "react";
import type { Chat } from "../lib/chat";
import { accountLabel, fmtUsd, keyOf, keyTail, loadPlatform, SUBSCRIPTION, usePlatform } from "../lib/platform";
import { ICheck } from "./icons";
import { cx } from "./primitives";

/** "API key · Work · $0.42": shown in a chat's header while it runs on a Claude Platform key. */
export function PlatformBadge({ chat }: { chat: Chat }) {
  const keys = usePlatform((s) => s.keys);
  const loaded = usePlatform((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void loadPlatform();
  }, [loaded]);
  if (!chat.account || chat.provider !== "claude") return null;
  const k = keyOf(chat.account, keys);
  const name = accountLabel(chat.account, keys);
  const tip = [
    `Billed to the Claude Platform API key “${name}”${k?.last4 ? ` (${keyTail(k)})` : ""}, not your Claude subscription.`,
    chat.costUsd > 0 ? `About ${fmtUsd(chat.costUsd)} so far in this chat, by Claude Code's own count of the turns coool saw.` : "Its cost shows here after the first turn.",
    "Plan usage leaves this chat out.",
  ].join("\n");
  return (
    <span
      data-platform-badge={chat.account}
      title={tip}
      className="ml-1 inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--busy-text)_45%,var(--border))] bg-[color-mix(in_oklab,var(--busy-text)_10%,transparent)] px-1.5 text-micro font-medium text-busy-text"
    >
      <span className="font-mono uppercase tracking-[0.04em]">API</span>
      <span className="max-w-[120px] truncate text-fg/85">{name}</span>
      {chat.costUsd > 0 && <span className="tnum text-dim" data-platform-cost={chat.costUsd.toFixed(4)}>{fmtUsd(chat.costUsd)}</span>}
    </span>
  );
}

/** The sheet's account menu: the subscription, then each key; below, make the choice this folder's default. */
export function AccountMenu({
  current,
  folderName,
  folderAccount,
  onPick,
  onMakeDefault,
}: {
  /** The id, or SUBSCRIPTION. */
  current: string;
  folderName: string | null;
  /** The folder's own default (SUBSCRIPTION when it has none). */
  folderAccount: string;
  onPick: (id: string) => void;
  onMakeDefault: (id: string) => void;
}) {
  const keys = usePlatform((s) => s.keys);
  const row = (id: string, label: string, detail: string) => (
    <button key={id} type="button" data-account-option={id} onClick={() => onPick(id)} className="flex h-[40px] w-full items-center gap-2.5 rounded-[11px] px-2.5 text-left hover:bg-hover">
      <span className={cx("size-[7px] shrink-0 rounded-full", id === SUBSCRIPTION ? "bg-accent-text" : "bg-busy-text")} />
      <span className="text-base font-medium text-fg">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-mono-small text-faint">{detail}</span>
      {id === folderAccount && <span className="shrink-0 text-small text-dim">folder default</span>}
      {id === current && <ICheck size={15} className="shrink-0 text-accent-text" />}
    </button>
  );
  return (
    <div className="p-1">
      <div className="px-2.5 pb-1 pt-1.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Billed to</div>
      {row(SUBSCRIPTION, "Subscription", "your Claude Code login")}
      {keys.map((k) => row(k.id, k.name, k.assist ? "Assist" : keyTail(k)))}
      {folderName && current !== folderAccount && (
        <button type="button" data-account-make-default onClick={() => onMakeDefault(current)} className="mt-1 flex w-full items-center rounded-[11px] border-t border-hairline px-2.5 py-2 text-left text-small text-dim hover:bg-hover hover:text-fg">
          Use {current === SUBSCRIPTION ? "the subscription" : `“${accountLabel(current, keys)}”`} for new chats in {folderName}
        </button>
      )}
      <div className="px-2.5 pb-1.5 pt-1 text-small leading-[17px] text-faint">API keys are added in Settings › Claude Platform.</div>
    </div>
  );
}
