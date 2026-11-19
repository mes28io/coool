// Whether the window is in macOS full screen. There the traffic lights are gone (macOS shows them with the menu bar
// when the pointer reaches the top edge), so the title bar gives their space back to its own controls.

import { useEffect, useState } from "react";
import { isTauri } from "./backend";

export function useFullscreen(): boolean {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let gone = false;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      const read = () =>
        void w
          .isFullscreen()
          .then((f) => !gone && setFull(f))
          .catch(() => {});
      read();
      // Entering and leaving full screen resizes the window (the animation ends with one more resize).
      void w
        .onResized(read)
        .then((un) => (gone ? un() : (off = un)))
        .catch(() => {});
    });
    return () => {
      gone = true;
      off?.();
    };
  }, []);
  return full;
}
