import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type FileEntry, insertRef, matchDroppedName, mentionAt, searchEntries } from '../state/fileRefs';

/** What the file explorer calls to put a reference into the field you last used. */
export interface FieldHandle {
  insert(path: string): void;
}

/** Set by the file explorer, so a drag from it carries the exact path. */
export const PATH_DRAG_TYPE = 'application/x-kanban-path';

interface Props {
  readonly name: string;
  readonly label: string;
  readonly multiline: boolean;
  readonly defaultValue: string;
  readonly entries: readonly FileEntry[];
  readonly onActivate: (field: FieldHandle) => void;
  /** Called once with this field, for a form that wants a default target before any field is used. */
  readonly registerDefault?: (field: FieldHandle) => void;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly autoFocus?: boolean;
}

type Popup =
  | { readonly kind: 'mention'; readonly start: number; readonly query: string }
  | { readonly kind: 'choose'; readonly fileName: string; readonly paths: readonly string[] };

/** A text field that suggests repo files after @ and takes files dropped from the explorer or your file manager. */
export function MentionField(props: Props) {
  const { name, label, multiline, defaultValue, entries, onActivate, registerDefault, ...rest } = props;
  const [value, setValue] = useState(defaultValue);
  // The explorer keeps this field's handle across renders, so the handle reads the text through a ref.
  const valueRef = useRef(value);
  valueRef.current = value;
  const [popup, setPopup] = useState<Popup | null>(null);
  const [active, setActive] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const suggestions = useMemo(() => {
    if (popup?.kind === 'mention') return searchEntries(entries, popup.query).map((e) => e.path);
    if (popup?.kind === 'choose') return [...popup.paths];
    return [];
  }, [popup, entries]);

  useEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 5_000);
    return () => clearTimeout(timer);
  }, [note]);

  const insertAt = useCallback((start: number, end: number, path: string) => {
    const next = insertRef(valueRef.current, start, end, path);
    pendingCaret.current = next.caret;
    setValue(next.text);
    setPopup(null);
    ref.current?.focus();
  }, []);

  const handle = useMemo<FieldHandle>(
    () => ({
      insert: (path) => {
        const el = ref.current;
        const end = valueRef.current.length;
        insertAt(el?.selectionStart ?? end, el?.selectionEnd ?? end, path);
      },
    }),
    [insertAt],
  );

  useEffect(() => {
    registerDefault?.(handle);
  }, []);

  const choose = (path: string) => {
    if (popup?.kind === 'mention') insertAt(popup.start, popup.start + popup.query.length + 1, path);
    else handle.insert(path);
  };

  const track = (text: string, caret: number) => {
    const found = mentionAt(text, caret);
    setPopup(found && entries.length > 0 ? { kind: 'mention', ...found } : null);
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!popup || suggestions.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const path = suggestions[active];
      if (path === undefined) return;
      e.preventDefault();
      choose(path);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setPopup(null);
    }
  };

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };

  // Explorer drags carry text, so the browser drops it at the pointer itself; only files from outside land here.
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(PATH_DRAG_TYPE) || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    for (const file of [...e.dataTransfer.files]) {
      const paths = matchDroppedName(entries, file.name);
      if (paths.length === 1 && paths[0] !== undefined) handle.insert(paths[0]);
      else if (paths.length > 1) {
        setPopup({ kind: 'choose', fileName: file.name, paths });
        setActive(0);
        return;
      } else setNote(`${file.name} is not in this project, or git ignores it.`);
    }
  };

  const common = {
    ref,
    name,
    value,
    ...rest,
    autoComplete: 'off',
    'aria-autocomplete': 'list' as const,
    'aria-expanded': popup !== null && suggestions.length > 0,
    onChange: (e: { target: HTMLInputElement | HTMLTextAreaElement }) => {
      setValue(e.target.value);
      track(e.target.value, e.target.selectionStart ?? e.target.value.length);
    },
    onKeyDown,
    onClick: () => ref.current && track(ref.current.value, ref.current.selectionStart ?? 0),
    onFocus: () => onActivate(handle),
    onBlur: () => setPopup(null),
    onDragOver,
    onDrop,
  };

  return (
    <label className="mention">
      {label}
      {multiline ? <textarea {...common} /> : <input {...common} />}
      {popup && suggestions.length > 0 && (
        <ul className="mention__list" role="listbox">
          {popup.kind === 'choose' && <li className="mention__title">Which {popup.fileName}?</li>}
          {suggestions.map((path, i) => {
            const slash = path.replace(/\/$/, '').lastIndexOf('/');
            return (
              <li
                key={path}
                role="option"
                aria-selected={i === active}
                className={`mention__item${i === active ? ' mention__item--active' : ''}`}
                // Keep focus in the field, so its blur does not close the list before the click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(path);
                }}
              >
                <span className="mention__name">{path.slice(slash + 1)}</span>
                {slash > 0 && <span className="mention__dir">{path.slice(0, slash + 1)}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {note && <small className="form-error">{note}</small>}
    </label>
  );
}
