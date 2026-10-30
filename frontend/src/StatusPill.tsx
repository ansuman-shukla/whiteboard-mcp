import { useEffect, useRef, useState } from 'react';
import type { LinkStatus } from './connection';
import { Icon } from './Icon';

interface Props {
  status: LinkStatus;
  viewers: number;
  follow: boolean;
  onToggleFollow(): void;
  /** Returns false when the note could not be sent. */
  onNote(text: string): boolean;
}

const LABELS: Record<LinkStatus, string> = {
  connecting: 'connecting…',
  live: 'live',
  offline: 'reconnecting…',
  stopped: 'server stopped — ask your agent to open the board',
};
const TITLES: Record<LinkStatus, string> = {
  connecting: 'Waiting for the canvas daemon',
  live: 'Connected to the canvas',
  offline: 'Waiting for the canvas daemon',
  stopped: "Whiteboard MCP's background process isn't running (after a restart, or it was stopped). Your agent starts it again; this tab then reconnects by itself.",
};
const TOAST_MS = 2200;

const EYE = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const CROSSHAIR = 'M12 2v4M12 18v4M2 12h4M18 12h4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z';
const NOTE = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';

export function StatusPill({ status, viewers, follow, onToggleFollow, onNote }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const submit = () => {
    const note = text.trim();
    if (!note) return;
    if (!onNote(note)) return setToast('offline — not sent');
    setText('');
    setOpen(false);
    setToast('sent to agent ✓');
  };

  return (
    <div className="xl-pill-wrap" ref={root}>
      <div className="xl-pill" data-testid="status-pill">
        <span className={`xl-status xl-status--${status}`} role="status" title={TITLES[status]}>
          <i className="xl-dot" />
          <span className="xl-label">{toast ?? LABELS[status]}</span>
        </span>
        {viewers > 1 && (
          <span className="xl-viewers" title={`${viewers} viewers on this canvas`}>
            <Icon d={EYE} />
            {viewers}
          </span>
        )}
        <button type="button" className="xl-btn" aria-pressed={follow} onClick={onToggleFollow} title={follow ? 'Following the agent: new drawings scroll into view' : 'Not following the agent'}>
          <Icon d={CROSSHAIR} />
        </button>
        <button type="button" className="xl-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Note to agent">
          <Icon d={NOTE} />
          <span className="xl-btn-label">Note</span>
        </button>
      </div>
      {open && (
        <form
          className="xl-note"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={field}
            value={text}
            maxLength={4000}
            placeholder="Note to agent…"
            aria-label="Note to agent"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="xl-note-row">
            <span className="xl-hint">⌘/Ctrl + Enter</span>
            <button type="submit" className="xl-send" disabled={!text.trim()}>
              Send
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
