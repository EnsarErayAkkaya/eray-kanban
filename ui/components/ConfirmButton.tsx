import { useEffect, useState } from 'react';

interface Props {
  readonly label: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly disabled?: boolean;
  readonly small?: boolean;
}

const ARMED_MS = 4_000;

// Two clicks for anything that cannot be undone; the second has to come within a few seconds.
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled = false, small = false }: Props) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={`btn btn--danger${armed ? ' btn--armed' : ''}${small ? ' btn--small' : ''}`}
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
