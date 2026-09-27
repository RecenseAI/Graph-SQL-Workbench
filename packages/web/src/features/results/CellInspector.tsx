import { useEffect, useState } from 'react';
import { useWorkbench, activeTab } from '../../store/workbench.ts';
import { rawText } from './format.ts';
import { Badge, Button, IconButton } from '../../ui/primitives.tsx';
import { IconClose, IconCopy } from '../../app/Icons.tsx';

/**
 * A panel for one cell.
 *
 * Nested values are where a GraphQL-derived grid differs most from a SQL one: a `_raw` column holds
 * the whole row as the endpoint sent it, and list columns hold real arrays. A cell wide enough to
 * show those would ruin the grid, so the full value lives here instead.
 */
export function CellInspector() {
  const inspecting = useWorkbench((s) => s.inspecting);
  const setInspecting = useWorkbench((s) => s.setInspecting);
  const tab = useWorkbench(activeTab);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInspecting(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setInspecting]);

  if (!inspecting || !tab) return null;
  const result = tab.results.find((r) => r.resultId === inspecting.resultId);
  const view = tab.views[inspecting.resultId];
  if (!result || !view) return null;

  const column = result.columns[inspecting.column];
  const value = view.rows[inspecting.row]?.[inspecting.column];
  const text = rawText(value);
  const isNested = value !== null && typeof value === 'object';

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-bg-1">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="truncate font-mono text-[11px] text-ink-0">{column?.name ?? 'cell'}</span>
        <Badge tone="neutral">{column?.duckType ?? 'unknown'}</Badge>
        <div className="flex-1" />
        <IconButton label="Close inspector" size={20} onClick={() => setInspecting(null)}>
          <IconClose size={13} />
        </IconButton>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <span className="tnum text-[10px] text-ink-3">
          row {(inspecting.row + 1).toLocaleString()}
        </span>
        <div className="flex-1" />
        <Button size="sm" icon={<IconCopy size={11} />} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {value === null || value === undefined ? (
          <p className="p-3 text-[11px] italic text-nullish">NULL</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words p-2 font-mono text-[11px] leading-relaxed text-ink-1">
            {text}
          </pre>
        )}
      </div>

      {isNested ? (
        <p className="shrink-0 border-t border-line px-2 py-1.5 text-[10px] leading-relaxed text-ink-3">
          {column?.name === '_raw'
            ? 'This is the row exactly as the endpoint returned it, limited to the fields the statement asked for.'
            : 'Query inside this value with DuckDB: UNNEST for lists, dot access for structs, json_extract for JSON.'}
        </p>
      ) : null}
    </aside>
  );
}
