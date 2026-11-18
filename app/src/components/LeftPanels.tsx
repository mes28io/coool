// The view the left sidebar panel can show besides Projects: Needs you. It fills the panel (header 44px,
// scrolling body); Sidebar cross-fades between them. Settings and Usage are a full-screen page (SettingsPage.tsx).

import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { answerPermission, answerQuestion } from "../lib/actions";
import { pendingPermission, pendingQuestion, useChats } from "../lib/chat";
import { useNow } from "../lib/clock";
import { ago, displayTitle } from "../lib/format";
import { attention } from "../lib/live";
import { sessionKey } from "../lib/types";
import { permissionWhat } from "../lib/toolNames";
import { useStore } from "../store";
import { IBack } from "./icons";
import { Button, cx, ease, IconButton, ProviderMark } from "./primitives";
import { useProjects } from "./Sidebar";

function Header({ title, aside, onBack }: { title: string; aside?: ReactNode; onBack?: () => void }) {
  return (
    <div data-tauri-drag-region className={cx("flex h-[44px] shrink-0 items-center gap-2 pr-3", onBack ? "pl-2" : "pl-4")}>
      {onBack && (
        <IconButton title="Back to projects" onClick={onBack} className="-mr-0.5">
          <IBack size={15} />
        </IconButton>
      )}
      <span className="text-base font-semibold text-fg">{title}</span>
      {aside && <span className="min-w-0 flex-1 truncate text-small text-dim tnum">{aside}</span>}
    </div>
  );
}

// ---------- Needs you ----------

/** Sessions that are blocked on the person: what the rail badge counts. */
export function useNeedsYou() {
  const { projects, digest } = useProjects();
  return projects.flatMap((p) => p.live.map((s) => ({ s, a: attention(s, digest) })).filter((x) => x.a.needs));
}

type Needed = ReturnType<typeof useNeedsYou>[number];


function NeedsRow({ s, a, order }: Needed & { order: string }) {
  const open = useStore((st) => st.open);
  const now = useNow();
  const chat = useChats((c) => (s.chat != null ? c.chats[s.chat] : undefined));
  const perm = chat?.running ? pendingPermission(chat) : null;
  const ask = chat?.running && !perm ? pendingQuestion(chat) : null;
  const [more, setMore] = useState(false);
  const go = () => open({ kind: "session", key: sessionKey(s) });
  const q = ask && ask.questions.length === 1 && !ask.questions[0].multi_select && !ask.questions[0].secret && ask.questions[0].options.length > 0 ? ask.questions[0] : null;
  const since = perm?.ts ?? ask?.ts ?? null;
  const outside = !perm && !ask;

  const small = "h-[26px] rounded-[7px] px-2.5 text-small";
  return (
    <motion.div
      layout="position"
      // Re-measure for layout animations only when the list changes: the row re-renders every second (its clock) and with
      // every sessions payload, and each measure touches every motion element in the window.
      layoutDependency={order}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.16 } }}
      transition={{ duration: 0.2, ease }}
      className="overflow-hidden"
      data-needs-row={sessionKey(s)}
      data-needs-kind={perm ? "permission" : ask ? "question" : "outside"}
    >
      <div className="rounded-[10px] px-2.5 py-2 transition-colors duration-150 hover:bg-hover">
        <button type="button" onClick={go} className="flex w-full items-start gap-2.5 text-left" title="Open this session">
          <ProviderMark provider={s.provider} size={15} className="mt-[3px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base text-fg">
              {perm ? (
                <>
                  <span className="font-medium" title={perm.tool}>
                    {permissionWhat(perm.tool, perm.input, perm.summary).name}
                  </span>
                  <span className="text-dim"> · {permissionWhat(perm.tool, perm.input, perm.summary).detail}</span>
                </>
              ) : ask ? (
                (ask.questions[0]?.question ?? "A question")
              ) : (
                displayTitle(s)
              )}
            </span>
            <span className="block truncate text-small text-dim">
              {perm || ask ? displayTitle(s) : a.needs}
              {since && <span className="text-faint"> · waiting {ago(since, now).replace(" ago", "")}</span>}
            </span>
          </span>
        </button>
        {perm && chat && (
          <div className="mt-2 pl-[25px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="primary" className={small} data-allow-once onClick={() => answerPermission(chat.id, perm.requestId, "allow")} title="Allow this once">
                Allow
              </Button>
              <Button variant="ghost" className={cx(small, "hover:text-err-text")} data-deny onClick={() => answerPermission(chat.id, perm.requestId, "deny")} title="Deny">
                Deny
              </Button>
              {perm.remember.length > 0 && (
                <Button variant="ghost" className={cx(small, "ml-auto text-dim")} onClick={() => setMore((v) => !v)} aria-expanded={more} title="Allow and remember">
                  Allow always…
                </Button>
              )}
            </div>
            {more && (
              <div className="mt-1.5 flex flex-col gap-1" data-remember-options>
                {perm.remember.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    data-remember={o.id}
                    data-remember-scope={o.scope}
                    title={o.detail}
                    onClick={() => answerPermission(chat.id, perm.requestId, "always", o)}
                    className="rounded-[7px] border border-line px-2 py-1 text-left text-small text-fg transition-colors duration-150 hover:bg-hover"
                  >
                    <span className="block">{o.label}</span>
                    {o.scope !== "chat" && <span className="block text-micro text-faint">{o.scope === "user" ? "Saved, all projects" : "Saved to file"}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {ask && chat && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[25px]">
            {q ? (
              q.options.map((o) => (
                <Button key={o.label} variant="outline" className={small} data-option={o.label} title={o.description || undefined} onClick={() => answerQuestion(chat.id, ask.requestId, [[o.label]])}>
                  {o.label}
                </Button>
              ))
            ) : (
              <Button variant="outline" className={small} onClick={go}>
                Answer
              </Button>
            )}
          </div>
        )}
        {outside && (
          <div className="mt-2 flex items-center gap-2 pl-[25px]">
            <Button variant="outline" className={small} onClick={go}>
              Open
            </Button>
            <span className="text-small text-faint">{a.source === "job" ? "a job is waiting" : s.chat === null ? "in your terminal" : "answer it in the session"}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function NeedsView() {
  const list = useNeedsYou();
  const order = list.map((n) => sessionKey(n.s)).join();
  const setView = useStore((s) => s.setSidebarView);
  return (
    <div className="flex h-full flex-col" data-sidebar-view="needs">
      <Header title="Needs you" aside={list.length ? `${list.length} waiting` : undefined} onBack={() => setView("projects")} />
      <div className="scroll min-h-0 flex-1 px-2 pb-3">
        {list.length === 0 && (
          <div className="mx-1 mt-1 rounded-[10px] border border-dashed border-line px-3 py-4 text-center text-base text-dim" data-needs-empty>
            Nothing needs you
          </div>
        )}
        <AnimatePresence initial={false}>
          {list.map((n) => (
            <NeedsRow key={sessionKey(n.s)} {...n} order={order} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
