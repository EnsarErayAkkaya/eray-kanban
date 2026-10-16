import { type ReactNode, useEffect } from 'react';

interface Props {
  readonly label: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** Forms open over the board, so you keep your place on it. */
export function Sheet({ label, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer" role="dialog" aria-label={label}>
      <div className="drawer__backdrop" onClick={onClose} />
      <aside className="drawer__panel drawer__panel--sheet">{children}</aside>
    </div>
  );
}
