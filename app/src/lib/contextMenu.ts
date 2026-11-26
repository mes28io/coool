// Right-click menus: native macOS menus (AppKit draws them, so they sit above the browser panel's child webview too)
// built from plain item lists. A surface opts in with `onContext(() => items)` on its `onContextMenu`; everywhere else
// the webview's own menu (Reload, Back, Inspect Element) is suppressed by `installContextMenus`, and text fields and
// selected text get the standard Cut / Copy / Paste / Select All.
import type React from "react";
import { isTauri } from "./backend";

export type MenuEntry =
  | { label: string; action: () => void | Promise<void>; enabled?: boolean; checked?: boolean; accelerator?: string }
  | { label: string; items: MenuEntry[]; enabled?: boolean }
  | "-"
  | null
  | false
  | undefined;

/** The last menu shown (selftests read and run its items: native popups aren't in the DOM). */
type Shown = { labels: string[]; run: (label: string) => Promise<boolean> };
declare global {
  interface Window {
    __cooolMenu?: Shown;
  }
}

const clean = (items: MenuEntry[]) => {
  const out: Exclude<MenuEntry, null | false | undefined>[] = [];
  for (const i of items) {
    if (!i) continue;
    if (i === "-" && (!out.length || out[out.length - 1] === "-")) continue;
    out.push(i);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
};

const flat = (items: MenuEntry[], prefix = ""): [string, () => void | Promise<void>][] =>
  clean(items).flatMap((i) => {
    if (i === "-") return [];
    if ("items" in i) return flat(i.items, `${prefix}${i.label} › `);
    return i.enabled === false ? [] : [[`${prefix}${i.label}`, i.action] as [string, () => void | Promise<void>]];
  });

/** Shows `items` as a native menu at the pointer. Errors in an action are logged, never thrown into the page. */
export async function showMenu(items: MenuEntry[]): Promise<void> {
  const list = clean(items);
  if (!list.length) return;
  const actions = flat(list);
  window.__cooolMenu = {
    labels: actions.map(([l]) => l),
    run: async (label) => {
      const a = actions.find(([l]) => l === label);
      if (!a) return false;
      await a[1]();
      return true;
    },
  };
  if (!isTauri) return;
  const { Menu, MenuItem, Submenu, CheckMenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const safe = (f: () => void | Promise<void>) => () => {
    void Promise.resolve()
      .then(f)
      .catch((e) => console.error("menu action", e));
  };
  type Built = Awaited<ReturnType<typeof MenuItem.new>> | Awaited<ReturnType<typeof Submenu.new>> | Awaited<ReturnType<typeof CheckMenuItem.new>> | Awaited<ReturnType<typeof PredefinedMenuItem.new>>;
  const build = async (entries: ReturnType<typeof clean>): Promise<Built[]> =>
    Promise.all(
      entries.map(async (i): Promise<Built> => {
        if (i === "-") return PredefinedMenuItem.new({ item: "Separator" });
        if ("items" in i) return Submenu.new({ text: i.label, enabled: i.enabled !== false, items: await build(clean(i.items)) });
        if (i.checked !== undefined) return CheckMenuItem.new({ text: i.label, checked: i.checked, enabled: i.enabled !== false, action: safe(i.action) });
        return MenuItem.new({ text: i.label, enabled: i.enabled !== false, accelerator: i.accelerator, action: safe(i.action) });
      }),
    );
  const menu = await Menu.new({ items: await build(list) });
  await menu.popup();
}

/** `onContextMenu={onContext(() => [...])}`: the surface's menu instead of the webview's. A null/empty list falls
 * through to the surrounding surface (or the text menu). Stops propagation so an outer surface doesn't open too. */
export const onContext =
  <E extends Element>(build: (e: React.MouseEvent<E>) => MenuEntry[] | null | undefined) =>
  (e: React.MouseEvent<E>) => {
    if (e.defaultPrevented) return;
    const items = build(e);
    if (!items || !clean(items).length) return;
    e.preventDefault();
    e.stopPropagation();
    void showMenu(items);
  };

/** Copies text to the clipboard (menu actions' "Copy …"). */
export const copyText = (text: string) => navigator.clipboard.writeText(text);

const editable = (t: EventTarget | null): HTMLElement | null => {
  if (!(t instanceof Element)) return null;
  const el = t.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
  if (!el) return null;
  if (el instanceof HTMLInputElement && !/^(text|search|url|email|password|number|tel)$/.test(el.type)) return null;
  return el as HTMLElement;
};

/** The text menu for a field or selected text: native predefined items, so they act on the webview's own selection. */
async function textMenu(field: boolean) {
  const sel = (window.getSelection()?.toString() ?? "").length > 0;
  window.__cooolMenu = { labels: field ? ["Cut", "Copy", "Paste", "Select All"] : ["Copy", "Select All"], run: async () => false };
  if (!isTauri) return;
  const { Menu, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const items = field
    ? [
        await PredefinedMenuItem.new({ item: "Cut" }),
        await PredefinedMenuItem.new({ item: "Copy" }),
        await PredefinedMenuItem.new({ item: "Paste" }),
        await PredefinedMenuItem.new({ item: "Separator" }),
        await PredefinedMenuItem.new({ item: "SelectAll" }),
      ]
    : [await PredefinedMenuItem.new({ item: "Copy" }), await PredefinedMenuItem.new({ item: "SelectAll" })];
  if (!field && !sel) return;
  await (await Menu.new({ items })).popup();
}

let installed = false;
/** Once, at startup: no webview menu anywhere; fields and selections get the text menu. Surfaces that handled the
 * event (preventDefault in `onContext`) are left alone. */
export function installContextMenus() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const field = editable(e.target);
    if (field) return void textMenu(true);
    if ((window.getSelection()?.toString() ?? "").length > 0) return void textMenu(false);
  });
}
