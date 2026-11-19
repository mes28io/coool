// Whether the keys that answer a permission request (⌘↵ allow, ⇧⌘↵ allow for this chat, ⌘⌫ deny) must wait: something
// on top hides the request they would answer. The onboarding, the palette or a sheet (New session, a confirm) hide
// both a chat pane and the Needs you page; the Settings and Needs you pages also hide the panes under them.

import { useStore } from "../store";
import { useOnboarding } from "./onboarding";

export function answerKeysCovered(from: "pane" | "needs"): boolean {
  const st = useStore.getState();
  if (useOnboarding.getState().open || st.palette || st.sheet) return true;
  return from === "pane" && (st.settings !== null || st.needsPage);
}
