// Settings > Remote (docs/REMOTE.md): control coool from a paired iPhone. Off by default. Turn on, Pair an iPhone
// (a QR code that works once and expires in two minutes, then a 6-digit code to compare before the Pair click), the
// paired devices with Remove, and the recent remote actions. Everything a phone may do is checked on the Mac
// (crates/remote), not here.

import qrcode from "qrcode-generator";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useClock } from "../../lib/clock";
import { remoteApi, seenWords, type RemoteStatus } from "../../lib/remote";
import { Button } from "../primitives";
import { ConfirmButton, ErrorLine, errText, Group, Note, Row, Switch, Tag } from "./ui";

function useRemote(): [RemoteStatus | null, (s: RemoteStatus) => void, () => void] {
  const [s, setS] = useState<RemoteStatus | null>(null);
  const reload = useCallback(() => {
    remoteApi()
      .then((r) => r.status())
      .then(setS)
      .catch(() => {});
  }, []);
  useEffect(() => {
    reload();
    let off = () => {};
    remoteApi().then((r) => (off = r.onChange(reload)));
    // Last-seen times and the code's countdown move on their own.
    const t = setInterval(reload, 5000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [reload]);
  return [s, setS, reload];
}

/** The pairing payload as a QR code: black on white, whatever the theme (phone cameras read that best). */
function Qr({ text }: { text: string }) {
  const { n, path } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text, "Byte");
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { n, path: d };
  }, [text]);
  return (
    <div className="rounded-[10px] bg-white p-3" data-remote-qr title="Scan with the coool app on your iPhone">
      <svg viewBox={`0 0 ${n} ${n}`} width={196} height={196} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
        <path d={path} fill="black" />
      </svg>
    </div>
  );
}

function Countdown({ until }: { until: number }) {
  const left = useClock((now) => Math.max(0, Math.ceil((until - now) / 1000)));
  return <span className="font-mono tabular-nums">{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired"}</span>;
}

function Pairing({ s, reload }: { s: RemoteStatus; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = s.pairing;
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    f()
      .catch((e) => setErr(errText(e)))
      .finally(() => {
        setBusy(false);
        reload();
      });
  };
  const start = () => run(async () => (await remoteApi()).pairStart());
  const cancel = () => run(async () => (await remoteApi()).pairCancel());
  const confirm = () => run(async () => (await remoteApi()).pairConfirm());

  if (!p)
    return (
      <Row
        label="Pair an iPhone"
        desc="Shows a QR code to scan with the coool app. It works once and for two minutes."
        attr="remote-pair"
        control={
          <Button variant="outline" disabled={busy || !s.connected} onClick={start} data-remote-pair-start title={s.connected ? "Show a pairing code" : "Waiting for the relay"}>
            Pair an iPhone
          </Button>
        }
      >
        <ErrorLine>{err}</ErrorLine>
      </Row>
    );
  if (p.claim) {
    const code = `${p.claim.code.slice(0, 3)} ${p.claim.code.slice(3)}`;
    return (
      <Row label={`Pair ${p.claim.name}?`} desc="Check that the iPhone shows the same code. Pair only if it does." attr="remote-pair">
        <div className="flex items-center gap-4 pb-1" data-remote-confirm>
          <span className="font-mono text-[28px] leading-none tracking-[0.08em] text-fg" data-remote-code={p.claim.code}>
            {code}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" disabled={busy} onClick={cancel} data-remote-pair-cancel>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={confirm} data-remote-pair-confirm title="Let this iPhone see your sessions and answer for you">
              Pair
            </Button>
          </div>
        </div>
        <ErrorLine>{err}</ErrorLine>
      </Row>
    );
  }
  return (
    <Row label="Scan with your iPhone" desc="Open the coool app on your iPhone and scan this code." attr="remote-pair">
      <div className="flex items-end gap-4 pb-1">
        <Qr text={p.url} />
        <div className="flex flex-col gap-2 text-small text-dim">
          <span>
            Expires in <Countdown until={p.expires_at} />
          </span>
          <span>Anyone who scans it before you could ask to pair, so you'll confirm a code next.</span>
          <div>
            <Button variant="ghost" disabled={busy} onClick={cancel} data-remote-pair-cancel>
              Cancel
            </Button>
          </div>
        </div>
      </div>
      <ErrorLine>{err}</ErrorLine>
    </Row>
  );
}

export function RemoteSettings() {
  const [s, setS, reload] = useRemote();
  const [err, setErr] = useState<string | null>(null);
  const now = useClock((n) => Math.floor(n / 30_000) * 30_000);
  if (!s) return null;
  const toggle = (on: boolean) => {
    setErr(null);
    remoteApi()
      .then((r) => r.setEnabled(on))
      .then(setS)
      .catch((e) => setErr(errText(e)));
  };
  const remove = async (id: string) => {
    try {
      setS(await (await remoteApi()).removeDevice(id));
    } catch (e) {
      setErr(errText(e));
    }
  };
  const state = !s.enabled ? null : s.connected ? <Tag tone="ok">Connected</Tag> : s.error ? <Tag tone="err">Offline</Tag> : <Tag>Connecting</Tag>;
  return (
    <>
      <Group label="iPhone">
        <Row
          label="Control coool from your iPhone"
          desc="See your sessions, answer what agents ask, send messages and start chats from a paired iPhone, from anywhere."
          k="remote phone iphone pair relay"
          attr="remote-enabled"
          control={
            <>
              {state}
              <Switch on={s.enabled} onChange={toggle} label="Remote" />
            </>
          }
        >
          {s.enabled && s.error && <Note tone="warn">{s.error}</Note>}
          <ErrorLine>{err}</ErrorLine>
        </Row>
        {s.enabled && <Pairing s={s} reload={reload} />}
      </Group>
      {s.devices.length > 0 && (
        <Group label="Paired devices" footer="Removing a device deletes its keys here and at the relay: anything it sends afterwards is refused.">
          {s.devices.map((d) => (
            <Row
              key={d.id}
              label={d.name}
              desc={`Added ${new Date(d.added).toLocaleDateString()} · ${seenWords(d.last_seen, now)}`}
              attr={`remote-device-${d.id}`}
              k="device paired remove"
              control={<ConfirmButton label="Remove" confirm={`Remove ${d.name}`} onConfirm={() => remove(d.id)} attr={`remote-remove-${d.id}`} />}
            />
          ))}
        </Group>
      )}
      {s.actions.length > 0 && (
        <Group label="Recent remote actions">
          {s.actions.slice(0, 8).map((a, i) => (
            <Row key={`${a.at}-${i}`} dense label={`${a.ok ? "" : a.kind === "refused" ? "Refused: " : "Failed: "}${a.detail}`} desc={`From ${a.device} · ${new Date(a.at).toLocaleTimeString()}`} attr="remote-action" k="remote action log" />
          ))}
        </Group>
      )}
      <Group label="Privacy" footer="The relay is coool's own Convex project. It never sees your sessions: it only knows which Mac talks to which phone, when, and how much.">
        <Row label="End-to-end encrypted" desc="Titles, prompts, commands and answers are encrypted on this Mac and on the phone." k="encryption privacy" />
        <Row label="Allow once or deny" desc="A phone can never choose “always allow”, change a permission mode, or start a chat in Bypass or full access." k="always allow bypass" />
      </Group>
    </>
  );
}
