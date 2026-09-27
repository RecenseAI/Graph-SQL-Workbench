import { useState } from 'react';
import { useWorkbench, activeTab } from '../../store/workbench.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { GraphqlRunner } from './GraphqlRunner.tsx';
import { Badge, Button, IconButton, Input, Toggle, cx } from '../../ui/primitives.tsx';
import {
  IconClose,
  IconGraph,
  IconPlay,
  IconPlayLine,
  IconPlus,
  IconSpinner,
  IconStop,
  IconTerminal,
} from '../../app/Icons.tsx';

/** The editor half of the workbench: tab strip, toolbar, and the editor itself. */
export function EditorPane() {
  const tabs = useWorkbench((s) => s.tabs);
  const activeTabId = useWorkbench((s) => s.activeTabId);
  const tab = useWorkbench(activeTab);
  const selectTab = useWorkbench((s) => s.selectTab);
  const closeTab = useWorkbench((s) => s.closeTab);
  const addTab = useWorkbench((s) => s.addTab);
  const renameTab = useWorkbench((s) => s.renameTab);
  const run = useWorkbench((s) => s.run);
  const stop = useWorkbench((s) => s.stop);
  const pushdown = useWorkbench((s) => s.pushdown);
  const setPushdown = useWorkbench((s) => s.setPushdown);
  const cache = useWorkbench((s) => s.cache);
  const setCache = useWorkbench((s) => s.setCache);
  const rowLimit = useWorkbench((s) => s.rowLimit);
  const setRowLimit = useWorkbench((s) => s.setRowLimit);
  const connectionCount = useWorkbench((s) => s.connections.length);

  const [renaming, setRenaming] = useState<string | null>(null);

  if (!tab) return null;
  const isSql = tab.kind === 'sql';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-0">
      {/* Tab strip */}
      <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-bg-1">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((item) => (
            <div
              key={item.id}
              className={cx(
                'group flex shrink-0 items-center gap-1.5 border-r border-line px-2.5',
                item.id === activeTabId ? 'bg-bg-0 text-ink-0' : 'text-ink-2 hover:bg-bg-2',
              )}
            >
              <button
                type="button"
                onClick={() => selectTab(item.id)}
                onDoubleClick={() => setRenaming(item.id)}
                className="flex items-center gap-1.5 text-[11px]"
              >
                <span className={item.kind === 'sql' ? 'text-sql' : 'text-gql'}>
                  {item.kind === 'sql' ? <IconTerminal size={12} /> : <IconGraph size={12} />}
                </span>
                {renaming === item.id ? (
                  <input
                    autoFocus
                    defaultValue={item.title}
                    onBlur={(e) => {
                      renameTab(item.id, e.target.value.trim() || item.title);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    className="w-24 rounded border border-sql bg-bg-0 px-1 text-[11px] outline-none"
                  />
                ) : (
                  <span className="max-w-[10rem] truncate">{item.title}</span>
                )}
                {item.running ? (
                  <span className="text-sql">
                    <IconSpinner size={11} />
                  </span>
                ) : null}
              </button>
              {tabs.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Close ${item.title}`}
                  onClick={() => closeTab(item.id)}
                  className="text-ink-3 opacity-0 transition-opacity hover:text-ink-0 group-hover:opacity-100"
                >
                  <IconClose size={11} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <IconButton label="New SQL tab" size={32} onClick={() => addTab('sql')}>
          <IconPlus size={14} />
        </IconButton>
        <IconButton label="New GraphQL tab" size={32} onClick={() => addTab('graphql')} className="text-gql">
          <IconGraph size={14} />
        </IconButton>
      </div>

      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg-1 px-2">
        {tab.running ? (
          <Button tone="danger" size="sm" icon={<IconStop size={11} />} onClick={() => void stop(tab.id)}>
            Stop
          </Button>
        ) : (
          <Button
            tone="primary"
            size="sm"
            icon={<IconPlay size={11} />}
            onClick={() => void run(tab.id)}
            disabled={connectionCount === 0}
            title="Run the whole script (Ctrl+Enter)"
          >
            Run
          </Button>
        )}
        {isSql ? (
          <>
            <IconButton
              label="Run the statement under the cursor (Ctrl+Shift+Enter)"
              onClick={() => void run(tab.id, { statementOnly: true })}
              disabled={tab.running || connectionCount === 0}
            >
              <IconPlayLine size={14} />
            </IconButton>
            <Button
              size="sm"
              onClick={() => void run(tab.id, { explain: true })}
              disabled={tab.running || connectionCount === 0}
              title="Run and include the DuckDB query plan"
            >
              Explain
            </Button>
            <div className="mx-1 h-4 w-px bg-line" />
            <Toggle checked={pushdown} onChange={setPushdown} label="pushdown" />
            <Toggle checked={cache} onChange={setCache} label="cache" />
            <div className="mx-1 h-4 w-px bg-line" />
            <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
              rows
              <Input
                type="number"
                min={1}
                value={rowLimit ?? ''}
                placeholder="default"
                onChange={(e) => setRowLimit(e.target.value ? Number(e.target.value) : null)}
                className="h-6 w-20"
                title="Row budget per table for this run. Blank uses the connection default."
              />
            </label>
          </>
        ) : (
          <Badge tone="gql" title="This tab sends documents to the endpoint as written. Mutations are refused.">
            read-only GraphQL
          </Badge>
        )}
        <div className="flex-1" />
        {tab.lastRunMs !== null && !tab.running ? (
          <span className="tnum text-[11px] text-ink-3">{tab.lastRunMs.toLocaleString()} ms</span>
        ) : null}
        {tab.progress.length > 0 && tab.running ? (
          <span className="tnum text-[11px] text-sql">
            {tab.progress.map((p) => `${p.table} ${p.rows.toLocaleString()} rows`).join('  |  ')}
          </span>
        ) : null}
      </div>

      {/* Editor */}
      <div className="min-h-0 flex-1">
        {isSql ? (
          <CodeEditor
            tab={tab}
            onRun={() => void run(tab.id)}
            onRunStatement={() => void run(tab.id, { statementOnly: true })}
            onStop={() => void stop(tab.id)}
          />
        ) : (
          <GraphqlRunner tab={tab} />
        )}
      </div>
    </div>
  );
}
