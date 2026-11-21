// Settings > Claude Platform (APP_SPEC "Claude Platform"): named Anthropic API keys a Claude Code chat can be billed
// to instead of the subscription, and the folders that use one by default. A key goes in once and is never shown
// again: the page only gets each key's name and last four characters.

import { useEffect, useState } from "react";
import { api } from "../../lib/backend";
import { accountLabel, keyTail, loadPlatform, usePlatform } from "../../lib/platform";
import { IClose } from "../icons";
import { Button, cx } from "../primitives";
import { Group, Mono, Note, Row } from "./ui";

const inputCls =
  "h-[32px] w-full min-w-0 rounded-[8px] border border-line bg-bg px-2.5 text-small outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint focus:border-[color-mix(in_oklab,var(--fg)_30%,var(--border))] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--fg)_6%,transparent)]";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error: /, "");

export function PlatformSettings() {
  const keys = usePlatform((s) => s.keys);
  const folders = usePlatform((s) => s.folders);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => void loadPlatform(), []);

  const run = async (f: () => Promise<unknown>) => {
    setErr(null);
    try {
      await f();
      await loadPlatform();
      return true;
    } catch (e) {
      setErr(errText(e));
      return false;
    }
  };
  const add = async () => {
    const k = key.trim();
    if (!k || !name.trim() || busy) return;
    setBusy(true);
    // The key goes straight to the backend (Keychain) and is dropped from the page at once.
    setKey("");
    const ok = await run(() => api().platformAddKey(name.trim(), k));
    setBusy(false);
    if (ok) setName("");
  };
  const own = keys.filter((k) => !k.assist);
  const assist = keys.find((k) => k.assist);

  return (
    <>
      <Group label="API keys" attr="platform-keys">
        <Row
          attr="platform"
          label="Claude Platform"
          desc="Run a Claude Code chat on an Anthropic API key (Claude Console) instead of your Claude subscription, billed to that key's organization."
          k="api key console anthropic billing subscription"
        >
          <Note>
            Pick the account when you start a chat (the New session sheet), or set a folder's default there. A chat on a key shows an <span className="font-medium text-fg/85">API</span> badge in its header with what it has cost so far; it never counts
            toward your plan usage. Keys are kept in the macOS Keychain; coool shows only their last four characters.
          </Note>
        </Row>
        {own.map((k) => (
          <Row key={k.id} attr={`platform-key-${k.id}`} label={k.name} desc={`API key ${keyTail(k)}`} k="api key">
            {renaming?.id === k.id ? (
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api().platformRenameKey(k.id, renaming.name)).then((ok) => ok && setRenaming(null));
                }}
              >
                <input autoFocus className={cx(inputCls, "min-w-[200px] flex-1")} value={renaming.name} onChange={(e) => setRenaming({ id: k.id, name: e.target.value })} aria-label="Key name" />
                <Button variant="primary" type="submit" className="h-[32px]" disabled={!renaming.name.trim()}>
                  Rename
                </Button>
                <Button variant="ghost" className="h-[32px]" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" className="h-[30px]" onClick={() => setRenaming({ id: k.id, name: k.name })}>
                  Rename
                </Button>
                <Button variant="ghost" className="h-[30px] hover:text-err-text" data-platform-remove={k.id} onClick={() => void run(() => api().platformRemoveKey(k.id))}>
                  Remove
                </Button>
              </div>
            )}
          </Row>
        ))}
        {assist && (
          <Row attr="platform-key-assist" label="Assist key" desc="The key Settings › Assist uses, offered as a choice too. Replace or remove it there." k="api key assist" />
        )}
        <Row attr="platform-add" label="Add an API key" desc="A name to pick it by (Work, Client X), then the key from console.anthropic.com." k="api key add new">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input className={cx(inputCls, "max-w-[160px] flex-none")} placeholder="Name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Key name" data-platform-name />
            <input type="password" autoComplete="off" spellCheck={false} className={cx(inputCls, "min-w-[220px] flex-1 font-mono text-mono-small")} placeholder="sk-ant-api03-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" data-platform-key />
            <Button variant="primary" type="submit" className="h-[32px]" disabled={!key.trim() || !name.trim() || busy} data-platform-add>
              {busy ? "Saving…" : "Save key"}
            </Button>
          </form>
          {err && <div className="text-small text-err-text">{err}</div>}
        </Row>
      </Group>
      {Object.keys(folders).length > 0 && (
        <Group label="Folder defaults" attr="platform-folders" footer="A folder's default covers its subfolders. Change one from the New session sheet's account menu.">
          {Object.entries(folders).map(([f, a]) => (
            <Row
              key={f}
              dense
              attr={`platform-folder-${f}`}
              label={<Mono>{f}</Mono>}
              desc={`New chats here run on “${accountLabel(a, keys)}”`}
              k={`${f} folder default`}
              control={
                <button type="button" title="Use the subscription here again" className="grid size-[26px] place-items-center rounded-[7px] text-faint hover:bg-hover hover:text-fg" onClick={() => void run(() => api().platformSetFolder(f, null))}>
                  <IClose size={13} />
                </button>
              }
            />
          ))}
        </Group>
      )}
    </>
  );
}
