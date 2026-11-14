// Imported first by main.tsx. Matches the native window background to the theme as early
// as possible (index.html has already set the theme on <html>), and again on every theme
// change. The window itself is visible from the start: a hidden window never paints a
// frame, so anything that waits for one before calling show() leaves the app invisible.
// No-op in the browser.
import { isTauri } from "./backend";

/** The window colour is the `--panel` tone of each theme. */
export const WINDOW_BG = { dark: "#171717", light: "#f9f9f9" } as const;

let shown = false;

export async function syncWindow(theme: "dark" | "light", show = false) {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.setBackgroundColor(WINDOW_BG[theme]).catch(() => {});
    if (show && !shown) {
      shown = true;
      await w.show();
    }
  } catch {
    // Never leave the window hidden because of a styling call.
    if (show) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().show();
      } catch {}
    }
  }
}

if (isTauri) {
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  void syncWindow(theme, true);
}
