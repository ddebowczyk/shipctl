import { X } from "lucide-react";
import { useNoticeStore } from "@shep/core/shared";

export default function NoticeCenter() {
  const notices = useNoticeStore((s) => s.notices);
  const removeNotice = useNoticeStore((s) => s.removeNotice);

  if (notices.length === 0) {
    return null;
  }

  return (
    <div className="notice-center" aria-live="polite" aria-atomic="true">
      {notices.map((notice) => (
        <div key={notice.id} className={`notice-card notice-card--${notice.tone}`}>
          <div className="notice-card__copy">
            <strong>{notice.title}</strong>
            {notice.message ? <span>{notice.message}</span> : null}
            {notice.actions?.length ? (
              <div className="notice-card__actions">
                {notice.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className={`notice-card__action notice-card__action--${action.variant ?? "primary"}`}
                    onClick={() => {
                      removeNotice(notice.id);
                      void action.onClick();
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-btn notice-card__close"
            aria-label="Dismiss notice"
            onClick={() => removeNotice(notice.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
