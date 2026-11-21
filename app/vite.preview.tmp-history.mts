import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Temporary (History screenshots): its own cache folder, port 5437, no HMR. Deleted afterwards.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  cacheDir: "/private/tmp/claude-501/-Users-mdapro-Desktop-coool/cc689cef-04de-4252-a106-27aa673fcde6/scratchpad/vite-history-cache",
  clearScreen: false,
  server: { port: 5437, strictPort: true, hmr: false, watch: { ignored: ["**/src-tauri/**"] } },
});
