// One quiet line above a chat's message box (APP_SPEC "Settings > General", docs/LID.md "A chat that asks"): "Keep
// working with the lid closed" is on and something would hold a closed Mac, but this chat works in a permission mode
// that stops to ask, so it would pause, and the Mac sleep, at its first prompt. Its button switches the chat to the
// least permissive mode that doesn't ask (`lidModeFix`), or, when only a bypass would, opens the mode menu instead;
// a mode never changes without the click. Dismissed per chat.

import { chatCall } from "../lib/actions";
import { api } from "../lib/backend";
import type { Chat } from "../lib/chat";
import { LID_ASK_TEXT, lidModeFix, lidWouldHold } from "../lib/lid";
import { dismissLidAsk, lidAskKeys, useLidAskDismissed, useLidLive } from "../lib/lidLive";
import { IAlert } from "./icons";

export function LidAskBanner({ chat, modes, onModes }: { chat: Chat; modes: { id: string; label: string }[]; onModes: () => void }) {
  // While a turn runs (working, or already waiting on the person).
  const active = chat.running && chat.state !== "idle";
  const lid = useLidLive(active);
  const keys = lidAskKeys(chat.id, chat.sessionId);
  const dismissed = useLidAskDismissed(keys);
  const fix = lidModeFix(chat.permissionMode, modes);
  if (!active || dismissed || !fix || !lidWouldHold(lid)) return null;
  return (
    <div className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-[12px] bg-[color-mix(in_oklab,var(--busy)_10%,transparent)] px-3 py-2 text-small leading-[18px] text-busy-text" data-lid-ask={chat.id} role="status">
      <IAlert size={13} className="mt-[3px] shrink-0" />
      <span className="min-w-0 flex-1 basis-[220px]">{LID_ASK_TEXT}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="rounded-[7px] px-2 py-0.5 font-medium hover:bg-[color-mix(in_oklab,var(--busy)_16%,transparent)]"
          data-lid-ask-fix={fix.kind === "switch" ? fix.id : "menu"}
          onClick={() => (fix.kind === "switch" ? void chatCall(chat.id, () => api().chatSetPermissionMode(chat.id, fix.id)) : onModes())}
        >
          {fix.kind === "switch" ? `Switch to ${fix.label}` : "Choose a mode…"}
        </button>
        <button type="button" className="rounded-[7px] px-2 py-0.5 text-dim hover:bg-hover hover:text-fg" data-lid-ask-dismiss onClick={() => dismissLidAsk(keys)}>
          Dismiss for this chat
        </button>
      </span>
    </div>
  );
}
