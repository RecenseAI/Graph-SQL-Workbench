import { useCallback, useEffect, useRef, useState } from 'react';

interface SplitterProps {
  /** `vertical` drags left/right (resizes a column); `horizontal` drags up/down (resizes a row). */
  orientation: 'vertical' | 'horizontal';
  /** Current size in px of the panel being resized. */
  size: number;
  onSize: (size: number) => void;
  min?: number;
  max?: number;
  /** Which side of the splitter the resized panel sits on. */
  side?: 'before' | 'after';
  label?: string;
}

/**
 * A 1px divider with a comfortable 9px grab zone. Dragging is tracked on the window so the
 * pointer can leave the divider without dropping the gesture, and double-click resets nothing
 * on purpose -- the caller owns the stored size.
 */
export function Splitter({ orientation, size, onSize, min = 140, max = 900, side = 'before', label }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pointer: 0, size: 0 });

  const vertical = orientation === 'vertical';

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      start.current = { pointer: vertical ? event.clientX : event.clientY, size };
      setDragging(true);
    },
    [size, vertical],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const pointer = vertical ? event.clientX : event.clientY;
      const delta = pointer - start.current.pointer;
      const next = side === 'before' ? start.current.size + delta : start.current.size - delta;
      onSize(Math.max(min, Math.min(max, next)));
    };
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging, max, min, onSize, side, vertical]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 12;
    const decrease = vertical ? 'ArrowLeft' : 'ArrowUp';
    const increase = vertical ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== decrease && event.key !== increase) return;
    event.preventDefault();
    const direction = event.key === increase ? 1 : -1;
    const signed = side === 'before' ? direction : -direction;
    onSize(Math.max(min, Math.min(max, size + signed * step)));
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label ?? 'Resize panel'}
      aria-valuenow={Math.round(size)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={
        vertical
          ? 'group relative z-10 w-px shrink-0 cursor-col-resize bg-line'
          : 'group relative z-10 h-px shrink-0 cursor-row-resize bg-line'
      }
    >
      <div
        className={
          vertical
            ? 'absolute inset-y-0 -left-1 -right-1 group-hover:bg-sql/40 group-focus-visible:bg-sql/60'
            : 'absolute inset-x-0 -top-1 -bottom-1 group-hover:bg-sql/40 group-focus-visible:bg-sql/60'
        }
        style={dragging ? { background: 'var(--color-sql)' } : undefined}
      />
    </div>
  );
}
