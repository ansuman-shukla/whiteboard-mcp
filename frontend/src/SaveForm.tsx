import { useEffect, useRef, useState } from 'react';

interface Props {
  initialName: string;
  /** Resolves when saved; the form stays open on failure so the name isn't lost. */
  onSave(name: string): Promise<void>;
  onClose(): void;
}

export const SAVE_ICON = 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8';

/** Names the board and saves it to the library, where any later chat can find it. */
export function SaveForm({ initialName, onSave, onClose }: Props) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.select();
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSave(trimmed);
    } catch {
      setBusy(false);
    }
  };

  return (
    <form
      ref={root}
      className="xl-note xl-save"
      data-testid="save-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        ref={field}
        value={name}
        maxLength={200}
        placeholder="Name this board…"
        aria-label="Board name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') {
            // Handled here, not by form submission: sandboxed frames without allow-forms (MCP Apps hosts) never submit.
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="xl-note-row">
        <span className="xl-hint">Later chats can find it</span>
        <button type="button" className="xl-send" disabled={!name.trim() || busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
