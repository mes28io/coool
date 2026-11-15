// Ask a chat's info panel (the composer's /context, /status, /usage, /changes popover)
// to open from somewhere else, e.g. the Checkpoints card's "N files".
import { create } from "zustand";

export const useInfoRequest = create<{ seq: number; chat: number; tab: "changes"; turn: string | null }>(() => ({ seq: 0, chat: -1, tab: "changes", turn: null }));
export const openChanges = (chat: number, turn: string | null = null) => useInfoRequest.setState((s) => ({ seq: s.seq + 1, chat, tab: "changes", turn }));
