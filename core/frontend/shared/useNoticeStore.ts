import { create } from "zustand";
import { reportNoticeDiagnostic } from "@shipctl/core/platform";
import type { NoticeDiagnostic } from "./runtimeDiagnostics.ts";

export type NoticeTone = "info" | "success" | "error";

export interface NoticeAction {
  label: string;
  variant?: "primary" | "secondary";
  onClick: () => void | Promise<void>;
}

export interface Notice {
  id: number;
  title: string;
  message?: string;
  tone: NoticeTone;
  actions?: NoticeAction[];
}

export type { NoticeDiagnostic } from "./runtimeDiagnostics.ts";

interface NoticeStore {
  notices: Notice[];
  /** Runtime diagnostic records, kept after their visible notices dismiss. */
  noticeHistory: readonly NoticeDiagnostic[];
  pushNotice: (
    notice: Omit<Notice, "id">,
    options?: { durationMs?: number },
  ) => number;
  removeNotice: (id: number) => void;
  clearNoticeHistory: () => void;
}

let noticeCounter = 0;

export const useNoticeStore = create<NoticeStore>((set) => ({
  notices: [],
  noticeHistory: [],

  pushNotice: (notice, options) => {
    const id = ++noticeCounter;
    const nextNotice: Notice = { id, ...notice };
    const diagnostic: NoticeDiagnostic = {
      id,
      occurredAt: new Date().toISOString(),
      tone: notice.tone,
      title: notice.title,
      ...(notice.message === undefined ? {} : { message: notice.message }),
      occurrences: 1,
    };

    set((state) => {
      const previous = state.noticeHistory[state.noticeHistory.length - 1];
      const repeatsPrevious = previous?.tone === diagnostic.tone
        && previous.title === diagnostic.title
        && previous.message === diagnostic.message;
      const noticeHistory = repeatsPrevious
        ? [
          ...state.noticeHistory.slice(0, -1),
          { ...previous, occurredAt: diagnostic.occurredAt, occurrences: previous.occurrences + 1 },
        ]
        : [...state.noticeHistory, diagnostic];
      return { notices: [...state.notices, nextNotice], noticeHistory };
    });
    reportNoticeDiagnostic(diagnostic);

    const durationMs = options?.durationMs ?? 3600;
    if (durationMs > 0) {
      window.setTimeout(() => {
        set((state) => ({
          notices: state.notices.filter((entry) => entry.id !== id),
        }));
      }, durationMs);
    }

    return id;
  },

  removeNotice: (id) => {
    set((state) => ({
      notices: state.notices.filter((notice) => notice.id !== id),
    }));
  },

  clearNoticeHistory: () => set({ noticeHistory: [] }),
}));
