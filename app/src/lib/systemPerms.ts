// The two macOS permissions coool asks for, as Settings (General, Notifications) and the onboarding both show them:
// the notification permission (`notify.rs`) and the login item (`login.rs`). Each hook reads the state once (and the
// notification one again when the window regains focus, e.g. back from System Settings); nothing is requested from
// macOS until `ask()` / `set()` is called.

import { useCallback, useEffect, useState } from "react";
import { api } from "./backend";
import type { LoginStatus, NotifyPermission } from "./settingsTypes";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const NOTIFY_TEXT: Record<NotifyPermission["status"], string> = {
  authorized: "Allowed. macOS shows coool’s notifications.",
  provisional: "Delivered quietly to Notification Center.",
  denied: "Turned off for coool in System Settings.",
  not_determined: "macOS hasn’t asked yet. Allow once and coool can notify you.",
  asking: "macOS is asking: choose Allow in its notification at the top right of the screen (or in Notification Center).",
  unavailable: "Not available.",
};

/** The line that says where the notification permission stands. */
export const notifyText = (p: NotifyPermission) => (p.status === "unavailable" ? (p.reason ?? NOTIFY_TEXT.unavailable) : NOTIFY_TEXT[p.status]);
export const notifyAllowed = (p: NotifyPermission | null) => p?.status === "authorized" || p?.status === "provisional";

export function useNotifyPermission() {
  const [perm, setPerm] = useState<NotifyPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      api()
        .notifyPermission()
        .then((p) => live && setPerm(p))
        .catch(() => live && setPerm({ status: "unavailable", reason: "Not in this build of coool." }));
    read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  // While macOS's prompt waits for the person, follow it (it can be answered from Notification Center at any time).
  const asking = perm?.status === "asking";
  useEffect(() => {
    if (!asking) return;
    const t = setInterval(() => {
      api()
        .notifyPermission()
        .then(setPerm)
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [asking]);
  /** The system's one-time prompt (only while macOS hasn't asked). */
  const ask = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await api().notifyRequest();
      setPerm(p);
      // macOS refused to show its prompt: say why (the status stays the real one, and the button stays).
      if (p.reason && p.status !== "unavailable") setErr(`macOS didn’t ask: ${p.reason}.`);
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  }, []);
  return { perm, busy, err, setErr, ask, allowed: notifyAllowed(perm) };
}

/** The switch is on for these (requires approval: registered, waiting for the person in System Settings). */
export const loginOn = (l: LoginStatus | null) => l?.status === "enabled" || l?.status === "requires_approval";
/** The switch can't do anything for these. */
export const loginBlocked = (l: LoginStatus | null) => !l || l.status === "unavailable" || l.status === "not_found";

/** The line that says where the login item stands (`idle`: what it does, for the states with nothing to report). */
export function loginText(l: LoginStatus | null, idle = "Starts coool when you log in to this Mac. Listed in System Settings > General > Login Items.") {
  if (l?.status === "requires_approval") return "macOS is waiting for you to allow it in System Settings > General > Login Items.";
  if (l?.status === "unavailable") return l.reason ?? "Not available in this build.";
  if (l?.status === "not_found") return "macOS doesn't know this build as an app (a development build has no app bundle), so it can't open it at login.";
  return idle;
}

export function useLoginItem() {
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api()
      .loginStatus()
      .then((l) => live && setLogin(l))
      .catch(() => live && setLogin({ status: "unavailable", reason: "Not in this build of coool." }));
    return () => {
      live = false;
    };
  }, []);
  /** Registers or unregisters coool as a login item (`SMAppService`). */
  const set = useCallback(async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      setLogin(await api().loginSet(on));
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  }, []);
  return { login, busy, err, set, on: loginOn(login), blocked: loginBlocked(login) };
}
