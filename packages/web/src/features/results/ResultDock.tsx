import { useState } from 'react';
import { useWorkbench, activeTab, type DockTab } from '../../store/workbench.ts';
import { api } from '../../lib/api.ts';
import { ResultGrid, ColumnMenu } from './ResultGrid.tsx';
import { GeneratedGraphqlPanel, MessagesPanel, PlanPanel } from '../insight/InsightPanels.tsx';
import { ChartPanel } from '../chart/ChartPanel.tsx';
import { Badge, Button, EmptyState, IconButton, TabStrip, cx, type TabSpec } from '../../ui/primitives.tsx';
import { IconChart, IconDownload, IconGraph, IconLayers, IconSpinner, IconTable, IconTerminal, IconWarning } from '../../app/Icons.tsx';

/**
 * The bottom dock.
 *
 * A script can contain several statements, so results are tabbed the way Workbench tabs them, and
 * each result carries its own panels. The panel row is not decoration: Generated GraphQL and Plan
 * are how a user checks that the translation did what they meant.
 */
export function ResultDock() {
  const tab = useWorkbench(activeTab);
  const setDockTab = useWorkbench((s) => s.setDockTab);
  const selectResult = useWorkbench((s) => s.selectResult);

  if (!tab) return null;

  const result = tab.results[tab.activeResultIndex];
  const view = result ? tab.views[result.resultId] : undefined;
  const warningCount = tab.messages.filter((m) => m.kind === 'warning').length;
  const errorCount = tab.messages.filter((m) => m.kind === 'error').length;

  const panels: TabSpec<DockTab>[] = [
    { id: 'grid', label: 'Result', icon: <IconTable size={12} /> },
    {
      id: 'graphql',
      label: 'Generated GraphQL',
      icon: <IconGraph size={12} />,
      ...(result && result.plan.length > 0 ? { badge: <Badge tone="gql">{result.plan.length}</Badge> } : {}),
    },
    { id: 'plan', label: 'Plan', icon: <IconLayers size={12} /> },
    { id: 'chart', label: 'Chart', icon: <IconChart size={12} /> },
    {
      id: 'messages',
      label: 'Messages',
      icon: <IconTerminal size={12} />,
      ...(errorCount > 0
        ? { badge: <Badge tone="err">{errorCount}</Badge> }
        : warningCount > 0
          ? { badge: <Badge tone="warn">{warningCount}</Badge> }
          : {}),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-1">
      {/* Panel and result tabs */}
      <div className="flex h-7 shrink-0 items-stretch border-b border-line">
        <TabStrip tabs={panels} active={tab.dockTab} onSelect={(id) => setDockTab(tab.id, id)} />
        <div className="flex-1" />
        {tab.results.length > 1 ? (
          <div className="flex items-stretch gap-0.5 border-l border-line pl-1">
            {tab.results.map((item, index) => (
              <button
                key={index}
                type="button"
                onClick={() => selectResult(tab.id, index)}
                title={item.sql.replace(/\s+/g, ' ').slice(0, 120)}
                className={cx(
                  'px-2 text-[11px]',
                  index === tab.activeResultIndex ? 'bg-bg-3 text-ink-0' : 'text-ink-2 hover:text-ink-0',
                )}
              >
                {index + 1}
              </button>
            ))}
          </div>
        ) : null}
        {result && view && result.kind === 'select' ? (
          <div className="flex items-center gap-1 border-l border-line px-1">
            <ColumnMenu tab={tab} result={result} view={view} />
            <ExportMenu resultId={result.resultId} />
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {tab.running && tab.results.length === 0 ? (
          <RunningState />
        ) : !result && (tab.dockTab === 'messages' || tab.messages.length > 0) ? (
          // A statement that fails before producing a result must still show why.
          <MessagesPanel tab={tab} />
        ) : !result ? (
          <EmptyState title="No results yet" icon={<IconTable size={22} />}>
            Run a statement with Ctrl+Enter. Every field on the endpoint's Query type is a table you can join and
            aggregate.
          </EmptyState>
        ) : tab.dockTab === 'grid' ? (
          result.kind === 'command' || !view ? (
            <EmptyState title={result.message ?? 'Statement completed'}>
              {result.plan.length > 0 ? 'See the Plan panel for what was fetched.' : null}
            </EmptyState>
          ) : (
            <ResultGrid tab={tab} result={result} view={view} />
          )
        ) : tab.dockTab === 'graphql' ? (
          <GeneratedGraphqlPanel result={result} />
        ) : tab.dockTab === 'plan' ? (
          <PlanPanel result={result} />
        ) : tab.dockTab === 'chart' ? (
          view ? (
            <ChartPanel result={result} view={view} />
          ) : (
            <EmptyState title="Nothing to chart" />
          )
        ) : (
          <MessagesPanel tab={tab} />
        )}
      </div>
    </div>
  );
}

function RunningState() {
  const tab = useWorkbench(activeTab);
  const progress = tab?.progress ?? [];
  return (
    <div className="grid h-full place-items-center">
      <div className="w-72">
        <div className="mb-2 flex items-center justify-center gap-2 text-xs text-ink-1">
          <span className="text-sql">
            <IconSpinner size={14} />
          </span>
          {progress.length === 0 ? 'Planning and reading the schema...' : 'Fetching from the endpoint'}
        </div>
        <ul className="space-y-1">
          {progress.map((item) => (
            <li key={item.table} className="flex items-center gap-2 text-[11px]">
              <span className="w-28 shrink-0 truncate font-mono text-ink-1">{item.table}</span>
              <span className="tnum w-20 shrink-0 text-right text-num">{item.rows.toLocaleString()} rows</span>
              <span className="tnum shrink-0 text-ink-3">{item.pages} page{item.pages === 1 ? '' : 's'}</span>
              {item.done ? <span className="text-ok">done</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const FORMATS = [
  { format: 'csv' as const, label: 'CSV', hint: 'Opens in Excel and Sheets' },
  { format: 'json' as const, label: 'JSON', hint: 'An array of objects' },
  { format: 'parquet' as const, label: 'Parquet', hint: 'Typed and compressed, reads back into DuckDB' },
  { format: 'markdown' as const, label: 'Markdown', hint: 'A table to paste into a document' },
  { format: 'sql' as const, label: 'SQL INSERTs', hint: 'Replay the result into another database' },
];

function ExportMenu({ resultId }: { resultId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <IconButton label="Export the whole result" size={22} active={open} onClick={() => setOpen(!open)}>
        <IconDownload size={13} />
      </IconButton>
      {open ? (
        <>
          <button type="button" aria-label="Close" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-40 w-60 rounded border border-line bg-bg-1 p-1 shadow-xl">
            <p className="px-1.5 py-1 text-[10px] uppercase tracking-wider text-ink-3">Export every row</p>
            {FORMATS.map((item) => (
              <a
                key={item.format}
                href={api.exportUrl(resultId, item.format)}
                onClick={() => setOpen(false)}
                className="block rounded px-1.5 py-1 hover:bg-bg-2"
              >
                <span className="text-[11px] text-ink-0">{item.label}</span>
                <span className="block text-[10px] text-ink-3">{item.hint}</span>
              </a>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export { IconWarning, Button };
