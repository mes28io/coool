// The speech model chooser, in Settings > Voice and in the onboarding step: the sizes up front, the recommended one
// marked, Download / Pause / Resume / Cancel with progress, files already on this Mac (2relay's ~/models included),
// and "Use an existing file…". Nothing downloads until the person presses Download.

import { useEffect, useState } from "react";
import { voiceApi, type FoundModel, type ModelRow, type Models, type Progress } from "../../lib/voice/api";
import { setVoicePrefs, useVoicePrefs } from "../../lib/voice/prefs";
import { homeShort } from "../../lib/format";
import { Button, cx } from "../primitives";

export const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Models with live download progress (the events update rows between refreshes). */
export function useModels() {
  const [models, setModels] = useState<Models | null>(null);
  const [live, setLive] = useState<Record<string, Progress>>({});
  useEffect(() => {
    const v = voiceApi();
    const refresh = () => void v.models().then(setModels).catch(() => {});
    refresh();
    const off = v.onModel((m) => {
      const { id, ...p } = m;
      setLive((l) => ({ ...l, [id]: p as Progress }));
      if (m.state !== "downloading") refresh();
      if (m.state === "done") setVoicePrefs({ model: m.path, modelId: id, enabled: true });
    });
    return off;
  }, []);
  return { models, live, refresh: () => void voiceApi().models().then(setModels) };
}

export function ModelPicker({ models: given, onChanged, compact }: { models?: Models | null; onChanged?: () => void; compact?: boolean }) {
  const own = useModels();
  const models = own.models ?? given ?? null;
  const p = useVoicePrefs();
  const [err, setErr] = useState<string | null>(null);
  const changed = () => {
    own.refresh();
    onChanged?.();
  };
  if (!models) return <div className="text-small text-faint">Loading models…</div>;
  const choose = (path: string, id: string | null) => {
    setVoicePrefs({ model: path, modelId: id, enabled: true });
    void voiceApi().preload(path);
  };
  const act = (f: () => Promise<void>) => {
    setErr(null);
    void f()
      .then(changed)
      .catch((e) => setErr(errText(e)));
  };
  const others = models.found.filter((f) => f.place !== "coool");
  const pick = async () => {
    setErr(null);
    try {
      const path = await voiceApi().pickModelFile();
      if (!path) return;
      const f = await voiceApi().checkModel(path);
      choose(f.path, f.id);
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-voice-models>
      {models.catalog.map((m) => (
        <ModelLine key={m.id} m={m} progress={own.live[m.id] ?? m.download} recommended={m.id === models.recommended} current={!!m.path && p.model === m.path} onUse={() => m.path && choose(m.path, m.id)} act={act} compact={compact} />
      ))}
      {others.length > 0 && <div className="px-1 pt-1.5 font-mono text-micro font-semibold uppercase tracking-[0.06em] text-faint">Already on this Mac</div>}
      {others.map((f) => (
        <FoundLine key={f.path} f={f} current={p.model === f.path} onUse={() => choose(f.path, f.id)} />
      ))}
      {p.model && !models.catalog.some((m) => m.path === p.model) && !others.some((f) => f.path === p.model) && <FoundLine f={{ path: p.model, bytes: 0, id: p.modelId, place: "other" }} current onUse={() => {}} />}
      <div className="flex items-center gap-2 pt-1">
        <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => void pick()} data-voice-model-file>
          Use an existing file…
        </Button>
        {!compact && (
          <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => void voiceApi().reveal("models")}>
            Show folder
          </Button>
        )}
        {models.free !== null && <span className="ml-auto text-micro text-faint">{fmtSize(models.free)} free</span>}
      </div>
      {err && <div className="text-small text-err-text">{err}</div>}
    </div>
  );
}

function ModelLine({ m, progress, recommended, current, onUse, act, compact }: { m: ModelRow; progress: Progress | null; recommended: boolean; current: boolean; onUse: () => void; act: (f: () => Promise<void>) => void; compact?: boolean }) {
  const v = voiceApi();
  const running = progress?.state === "downloading" || progress?.state === "verifying";
  const paused = !running && (progress?.state === "paused" || (!!m.partial && !m.path));
  const got = progress && "bytes" in progress ? progress.bytes : (m.partial ?? 0);
  const pct = Math.min(100, (got / m.bytes) * 100);
  return (
    <div className={cx("rounded-[10px] border px-3 py-2", current ? "border-[color-mix(in_oklab,var(--accent)_55%,var(--border))] bg-accent-soft/40" : "border-line")} data-voice-model={m.id} data-voice-model-state={m.path ? "ready" : running ? "downloading" : paused ? "paused" : "none"}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate whitespace-nowrap text-base font-medium text-fg">{m.label}</span>
        <span className="shrink-0 whitespace-nowrap font-mono text-mono-small text-dim tnum">{fmtSize(m.bytes)}</span>
        {recommended && <span className="shrink-0 whitespace-nowrap rounded-[5px] bg-accent-soft px-1.5 font-mono text-micro text-accent-text">recommended</span>}
        {!m.translates && <span className="shrink-0 whitespace-nowrap rounded-[5px] bg-[color-mix(in_oklab,var(--dim)_12%,transparent)] px-1.5 font-mono text-micro text-dim">no translate</span>}
        <span className="flex-1" />
        {m.path ? (
          current ? (
            <span className="text-small font-medium text-accent-text">In use</span>
          ) : (
            <>
              <Button variant="outline" className="h-[28px] px-2.5 text-small" onClick={onUse}>
                Use
              </Button>
              {!compact && (
                <Button variant="ghost" className="h-[28px] px-2 text-small hover:text-err-text" onClick={() => act(() => v.deleteModel(m.id))}>
                  Delete
                </Button>
              )}
            </>
          )
        ) : running ? (
          <>
            {progress?.state === "downloading" && (
              <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => act(() => v.pause(m.id))}>
                Pause
              </Button>
            )}
            <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => act(() => v.cancelDownload(m.id))}>
              Cancel
            </Button>
          </>
        ) : paused ? (
          <>
            <Button variant="outline" className="h-[28px] px-2.5 text-small" onClick={() => act(() => v.download(m.id))}>
              Resume
            </Button>
            <Button variant="ghost" className="h-[28px] px-2 text-small" onClick={() => act(() => v.cancelDownload(m.id))}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant={recommended ? "primary" : "outline"} className="h-[28px] px-2.5 text-small" onClick={() => act(() => v.download(m.id))} data-voice-download={m.id}>
            Download
          </Button>
        )}
      </div>
      {!compact && <div className="mt-0.5 text-small text-dim">{m.note}</div>}
      {(running || paused) && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-[4px] flex-1 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--dim)_18%,transparent)]">
            <div className="h-full origin-left rounded-full bg-[var(--accent)] transition-transform duration-300" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <span className="shrink-0 font-mono text-micro text-dim tnum">{progress?.state === "verifying" ? "checking…" : `${fmtSize(got)} of ${fmtSize(m.bytes)}${paused ? " · paused" : ""}`}</span>
        </div>
      )}
      {progress?.state === "failed" && <div className="mt-1 text-small text-err-text">{progress.error}</div>}
    </div>
  );
}

function FoundLine({ f, current, onUse }: { f: FoundModel; current: boolean; onUse: () => void }) {
  return (
    <div className={cx("flex items-center gap-2 rounded-[10px] border px-3 py-2", current ? "border-[color-mix(in_oklab,var(--accent)_55%,var(--border))]" : "border-line")} data-voice-found={f.path}>
      <span className="min-w-0 flex-1 truncate font-mono text-mono-small text-fg" title={f.path}>
        {homeShort(f.path)}
      </span>
      {f.bytes > 0 && <span className="font-mono text-mono-small text-dim">{fmtSize(f.bytes)}</span>}
      {current ? (
        <span className="text-small font-medium text-accent-text">In use</span>
      ) : (
        <Button variant="outline" className="h-[28px] px-2.5 text-small" onClick={onUse}>
          Use
        </Button>
      )}
    </div>
  );
}
