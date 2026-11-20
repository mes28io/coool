// Step 1: the folder to start in (the native picker, or a project coool already knows), and whether the two CLIs
// are on PATH (the backend's `environment`: a PATH lookup, nothing about the person's account is read).

import { api } from "../../lib/backend";
import { folderName, homeShort } from "../../lib/format";
import type { Provider } from "../../lib/types";
import { useStore } from "../../store";
import { ICheck, IFolder } from "../icons";
import { Button, cx, ProviderMark } from "../primitives";
import type { StepProps } from "./types";

const NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

export function FolderStep({ ctx }: StepProps) {
  const toast = useStore((s) => s.toast);
  const { cwd } = ctx.draft;
  const pick = async () => {
    try {
      const p = await api().pickFolder();
      if (p) ctx.setDraft({ cwd: p });
    } catch (e) {
      toast(String(e), "error");
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 rounded-[12px] border border-line bg-panel p-1.5 pl-3" data-onb-folder={cwd ?? ""}>
        <IFolder size={15} className={cx("shrink-0", cwd ? "text-fg" : "text-faint")} />
        <span className={cx("min-w-0 flex-1 truncate", cwd ? "font-mono text-mono-small text-fg" : "text-base text-faint")} title={cwd ? homeShort(cwd) : undefined}>
          {cwd ? homeShort(cwd) : "No folder chosen"}
        </span>
        <Button variant="outline" className="h-[30px] px-2.5 text-small" onClick={() => void pick()} data-onb-choose>
          Choose…
        </Button>
      </div>

      {ctx.projects.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-small text-faint">Or one coool already knows</span>
          <div className="flex flex-wrap gap-1.5" data-onb-projects>
            {ctx.projects.map((p) => {
              const on = p === cwd;
              return (
                <button
                  key={p}
                  type="button"
                  title={homeShort(p)}
                  aria-pressed={on}
                  onClick={() => ctx.setDraft({ cwd: on ? null : p })}
                  className={cx(
                    "h-[28px] max-w-[200px] truncate rounded-[8px] border px-2.5 text-small transition-colors duration-150",
                    on ? "border-[color-mix(in_oklab,var(--text)_38%,var(--border))] bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.10)] text-fg" : "border-line text-dim hover:bg-hover hover:text-fg",
                  )}
                >
                  {folderName(p)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5 pt-1" data-onb-clis>
        {(["claude", "codex"] as Provider[]).map((p) => {
          const found = ctx.env ? !!ctx.env[p] : null;
          return (
            <div key={p} className="flex items-center gap-2 text-small" data-onb-cli={p} data-found={found === null ? "" : String(found)}>
              <ProviderMark provider={p} size={13} className={found === false ? "opacity-50" : undefined} />
              {found === null ? (
                <span className="text-faint">Looking for {NAME[p]}…</span>
              ) : found ? (
                <>
                  <span className="text-dim">{NAME[p]} found</span>
                  <ICheck size={13} className="text-accent-text" />
                </>
              ) : (
                <span className="text-faint">{NAME[p]} not found, install it to use it</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
