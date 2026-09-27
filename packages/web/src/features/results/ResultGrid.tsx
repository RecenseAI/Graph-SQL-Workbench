import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryResult, ResultColumn } from '@gqlwb/shared';
import { useWorkbench, type EditorTab, type GridView } from '../../store/workbench.ts';
import { estimateWidth, formatCell, rawText, shortType } from './format.ts';
import { Badge, IconButton, Input, NullBar, cx } from '../../ui/primitives.tsx';
import { IconFilter, IconSortAsc, IconSortDesc, IconSpinner } from '../../app/Icons.tsx';

/**
 * The result grid.
 *
 * Rows and columns are both virtualised, so a hundred thousand rows and a hundred columns scroll
 * without a jank. Three things are deliberately server-side rather than local: sorting, filtering
 * and paging all run in DuckDB over the whole result, so the answers describe the result rather
 * than the few hundred rows that happen to be loaded -- which is the difference between a grid and
 * a preview.
 */

const ROW_HEIGHT = 24;
const GUTTER_WIDTH = 56;
const LOAD_THRESHOLD = 40;

interface ResultGridProps {
  tab: EditorTab;
  result: QueryResult;
  view: GridView;
}

export function ResultGrid({ tab, result, view }: ResultGridProps) {
  const applyView = useWorkbench((s) => s.applyView);
  const updateView = useWorkbench((s) => s.updateView);
  const loadMoreRows = useWorkbench((s) => s.loadMoreRows);
  const setInspecting = useWorkbench((s) => s.setInspecting);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [filterDraft, setFilterDraft] = useState(view.filter);
  const [selection, setSelection] = useState<{ anchor: [number, number]; focus: [number, number] } | null>(null);
  const [copied, setCopied] = useState(false);

  const visibleColumns = useMemo(
    () => result.columns.filter((column) => !view.hiddenColumns.includes(column.name)),
    [result.columns, view.hiddenColumns],
  );

  // Column order puts pinned columns first, which is how a Workbench user keeps an id in sight.
  const ordered = useMemo(() => {
    const pinned = visibleColumns.filter((c) => view.pinnedColumns.includes(c.name));
    const rest = visibleColumns.filter((c) => !view.pinnedColumns.includes(c.name));
    return [...pinned, ...rest];
  }, [visibleColumns, view.pinnedColumns]);

  const columnIndexInResult = useCallback(
    (column: ResultColumn) => result.columns.findIndex((c) => c.name === column.name),
    [result.columns],
  );

  const widths = useMemo(
    () =>
      ordered.map(
        (column) => view.columnWidths[column.name] ?? estimateWidth(column, view.rows, columnIndexInResult(column)),
      ),
    [ordered, view.columnWidths, view.rows, columnIndexInResult],
  );

  const rowVirtualizer = useVirtualizer({
    count: view.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: ordered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => widths[index] ?? 120,
    overscan: 4,
  });

  // Re-measure when widths change, otherwise a resized column leaves a gap.
  useEffect(() => {
    columnVirtualizer.measure();
  }, [widths, columnVirtualizer]);

  // Endless scroll: fetch the next page as the viewport approaches the end of what is loaded.
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastVisible = virtualRows[virtualRows.length - 1]?.index ?? 0;
  useEffect(() => {
    if (view.rows.length === 0) return;
    if (view.rows.length >= view.rowCount) return;
    if (lastVisible >= view.rows.length - LOAD_THRESHOLD) {
      void loadMoreRows(tab.id, result.resultId);
    }
  }, [lastVisible, view.rows.length, view.rowCount, loadMoreRows, tab.id, result.resultId]);

  const toggleSort = (column: ResultColumn) => {
    const sameColumn = view.orderBy === column.name;
    // Click cycles ascending, descending, then back to the result's natural order.
    if (!sameColumn) {
      void applyView(tab.id, result.resultId, { orderBy: column.name, descending: false });
    } else if (!view.descending) {
      void applyView(tab.id, result.resultId, { orderBy: column.name, descending: true });
    } else {
      void applyView(tab.id, result.resultId, { orderBy: null, descending: false });
    }
  };

  const startResize = (columnName: string, startX: number, startWidth: number) => {
    const move = (event: PointerEvent) => {
      const next = Math.max(60, Math.min(900, startWidth + (event.clientX - startX)));
      updateView(tab.id, result.resultId, { columnWidths: { ...view.columnWidths, [columnName]: next } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
  };

  /** Selected block as TSV, which is what a spreadsheet expects from a paste. */
  const selectionAsTsv = useCallback((): string => {
    if (!selection) return '';
    const [r1, c1] = selection.anchor;
    const [r2, c2] = selection.focus;
    const rowFrom = Math.min(r1, r2);
    const rowTo = Math.max(r1, r2);
    const colFrom = Math.min(c1, c2);
    const colTo = Math.max(c1, c2);
    const lines: string[] = [];
    // A multi-column selection carries its headers, so the paste is self-describing.
    if (colTo > colFrom || rowTo > rowFrom) {
      lines.push(
        ordered
          .slice(colFrom, colTo + 1)
          .map((column) => column.name)
          .join('\t'),
      );
    }
    for (let r = rowFrom; r <= rowTo; r += 1) {
      const row = view.rows[r];
      if (!row) continue;
      const cells: string[] = [];
      for (let c = colFrom; c <= colTo; c += 1) {
        const column = ordered[c];
        if (!column) continue;
        const value = row[columnIndexInResult(column)];
        cells.push(rawText(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' '));
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }, [selection, ordered, view.rows, columnIndexInResult]);

  useEffect(() => {
    const onCopy = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return;
      if (!selection) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      const text = selectionAsTsv();
      if (!text) return;
      event.preventDefault();
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      });
    };
    window.addEventListener('keydown', onCopy);
    return () => window.removeEventListener('keydown', onCopy);
  }, [selection, selectionAsTsv]);

  const inSelection = (rowIndex: number, colIndex: number): boolean => {
    if (!selection) return false;
    const [r1, c1] = selection.anchor;
    const [r2, c2] = selection.focus;
    return (
      rowIndex >= Math.min(r1, r2) &&
      rowIndex <= Math.max(r1, r2) &&
      colIndex >= Math.min(c1, c2) &&
      colIndex <= Math.max(c1, c2)
    );
  };

  const onCellPointerDown = (rowIndex: number, colIndex: number, event: React.PointerEvent) => {
    if (event.shiftKey && selection) {
      setSelection({ anchor: selection.anchor, focus: [rowIndex, colIndex] });
      return;
    }
    setSelection({ anchor: [rowIndex, colIndex], focus: [rowIndex, colIndex] });
  };

  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Grid toolbar */}
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-bg-1 px-2">
        <div className="relative w-52">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3">
            <IconFilter size={11} />
          </span>
          <Input
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void applyView(tab.id, result.resultId, { filter: filterDraft });
              if (e.key === 'Escape') {
                setFilterDraft('');
                void applyView(tab.id, result.resultId, { filter: '' });
              }
            }}
            onBlur={() => {
              if (filterDraft !== view.filter) void applyView(tab.id, result.resultId, { filter: filterDraft });
            }}
            placeholder="Filter all columns"
            className="h-6 pl-6 text-[11px]"
          />
        </div>
        {view.filter ? (
          <Badge tone="sql" title={`Matching "${view.filter}" across every column`}>
            {view.rowCount.toLocaleString()} of {result.rowCount.toLocaleString()}
          </Badge>
        ) : (
          <span className="tnum text-[11px] text-ink-2">{result.rowCount.toLocaleString()} rows</span>
        )}
        {view.orderBy ? (
          <Badge tone="neutral">
            sorted by {view.orderBy} {view.descending ? 'desc' : 'asc'}
          </Badge>
        ) : null}
        {view.loading ? (
          <span className="text-sql">
            <IconSpinner size={12} />
          </span>
        ) : null}
        <div className="flex-1" />
        {copied ? <Badge tone="ok">copied</Badge> : null}
        {selection ? (
          <span className="text-[11px] text-ink-3">
            {Math.abs(selection.focus[0] - selection.anchor[0]) + 1} x{' '}
            {Math.abs(selection.focus[1] - selection.anchor[1]) + 1} selected, Ctrl+C to copy
          </span>
        ) : null}
        <span className="tnum text-[11px] text-ink-3">
          {view.rows.length.toLocaleString()} loaded
        </span>
      </div>

      {/* Scroll area holds both virtualisers, so rows and columns stay in step */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        <div style={{ width: totalWidth + GUTTER_WIDTH, height: rowVirtualizer.getTotalSize() + ROW_HEIGHT }}>
          {/* Header */}
          <div
            className="sticky top-0 z-20 flex h-6 border-b border-line-strong bg-bg-2"
            style={{ width: totalWidth + GUTTER_WIDTH }}
          >
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-line bg-bg-2 pr-1.5 text-[10px] text-ink-3"
              style={{ width: GUTTER_WIDTH }}
            >
              #
            </div>
            <div className="relative" style={{ width: totalWidth }}>
              {columnVirtualizer.getVirtualItems().map((virtualColumn) => {
                const column = ordered[virtualColumn.index];
                if (!column) return null;
                const sorted = view.orderBy === column.name;
                const pinned = view.pinnedColumns.includes(column.name);
                return (
                  <div
                    key={column.name}
                    className="absolute inset-y-0 flex items-center gap-1 border-r border-line px-1.5"
                    style={{ left: virtualColumn.start, width: virtualColumn.size }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      onDoubleClick={() =>
                        updateView(tab.id, result.resultId, {
                          pinnedColumns: pinned
                            ? view.pinnedColumns.filter((n) => n !== column.name)
                            : [...view.pinnedColumns, column.name],
                        })
                      }
                      title={[
                        `${column.name}  ${column.duckType}`,
                        column.nullCount > 0 ? `${column.nullCount.toLocaleString()} NULLs` : 'no NULLs',
                        column.min !== undefined ? `range ${column.min} to ${column.max}` : '',
                        'Click to sort, double-click to pin',
                      ]
                        .filter(Boolean)
                        .join('\n')}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    >
                      {pinned ? <span className="shrink-0 text-sql">|</span> : null}
                      <span className="truncate text-[11px] font-medium text-ink-0">{column.name}</span>
                      <span className="shrink-0 text-[9px] uppercase text-ink-3">{shortType(column.duckType)}</span>
                      <NullBar nullCount={column.nullCount} total={result.rowCount} />
                      {sorted ? (
                        <span className="shrink-0 text-sql">
                          {view.descending ? <IconSortDesc size={11} /> : <IconSortAsc size={11} />}
                        </span>
                      ) : null}
                    </button>
                    <div
                      role="separator"
                      aria-label={`Resize ${column.name}`}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        startResize(column.name, event.clientX, virtualColumn.size);
                      }}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-sql/50"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rows */}
          <div className="relative" style={{ height: rowVirtualizer.getTotalSize() }}>
            {virtualRows.map((virtualRow) => {
              const row = view.rows[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  className="absolute left-0 flex border-b border-line/60 hover:bg-bg-2/60"
                  style={{ top: virtualRow.start, height: virtualRow.size, width: totalWidth + GUTTER_WIDTH }}
                >
                  <div
                    className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-line bg-bg-1 pr-1.5"
                    style={{ width: GUTTER_WIDTH }}
                  >
                    <span className="tnum text-[10px] text-ink-3">{(virtualRow.index + 1).toLocaleString()}</span>
                  </div>
                  <div className="relative" style={{ width: totalWidth }}>
                    {columnVirtualizer.getVirtualItems().map((virtualColumn) => {
                      const column = ordered[virtualColumn.index];
                      if (!column) return null;
                      const value = row?.[columnIndexInResult(column)];
                      const formatted = formatCell(value, column);
                      const selected = inSelection(virtualRow.index, virtualColumn.index);
                      return (
                        <div
                          key={column.name}
                          onPointerDown={(event) => onCellPointerDown(virtualRow.index, virtualColumn.index, event)}
                          onDoubleClick={() =>
                            setInspecting({
                              resultId: result.resultId,
                              row: virtualRow.index,
                              column: columnIndexInResult(column),
                            })
                          }
                          title={formatted.expandable ? 'Double-click to inspect' : undefined}
                          className={cx(
                            'absolute inset-y-0 flex items-center overflow-hidden border-r border-line/40 px-1.5 font-mono text-[11px]',
                            formatted.className,
                            formatted.align === 'right' ? 'justify-end' : 'justify-start',
                            selected && 'bg-sql/20 ring-1 ring-inset ring-sql/50',
                            formatted.expandable && 'cursor-zoom-in',
                          )}
                          style={{ left: virtualColumn.start, width: virtualColumn.size }}
                        >
                          <span className="truncate">{formatted.text}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {view.rows.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center">
            <p className="text-[11px] text-ink-3">
              {view.filter ? `Nothing matches "${view.filter}".` : 'The query returned no rows.'}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Column visibility menu, kept out of the grid so the grid stays about rows. */
export function ColumnMenu({ tab, result, view }: ResultGridProps) {
  const updateView = useWorkbench((s) => s.updateView);
  const [open, setOpen] = useState(false);
  const hiddenCount = view.hiddenColumns.length;

  return (
    <div className="relative">
      <IconButton label="Show or hide columns" size={22} active={open || hiddenCount > 0} onClick={() => setOpen(!open)}>
        <span className="text-[10px] font-semibold">col</span>
      </IconButton>
      {open ? (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-40 max-h-72 w-52 overflow-auto rounded border border-line bg-bg-1 p-1 shadow-xl">
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="text-[10px] uppercase tracking-wider text-ink-3">Columns</span>
              <button
                type="button"
                className="text-[10px] text-sql hover:underline"
                onClick={() => updateView(tab.id, result.resultId, { hiddenColumns: [] })}
              >
                show all
              </button>
            </div>
            {result.columns.map((column) => {
              const hidden = view.hiddenColumns.includes(column.name);
              return (
                <label key={column.name} className="flex items-center gap-2 px-1.5 py-0.5 hover:bg-bg-2">
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() =>
                      updateView(tab.id, result.resultId, {
                        hiddenColumns: hidden
                          ? view.hiddenColumns.filter((n) => n !== column.name)
                          : [...view.hiddenColumns, column.name],
                      })
                    }
                    className="accent-sql"
                  />
                  <span className="truncate font-mono text-[11px] text-ink-1">{column.name}</span>
                </label>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
