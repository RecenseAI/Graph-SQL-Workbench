import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkbench, activeTab } from '../store/workbench.ts';
import { cx } from '../ui/primitives.tsx';
import { IconSearch } from './Icons.tsx';

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

/**
 * One keystroke to everything.
 *
 * The palette is also the discoverability layer for the workbench's own statements -- MATERIALIZE,
 * SHOW TABLES, SET pushdown -- which a user would otherwise have to read the docs to find.
 */
export function CommandPalette() {
  const open = useWorkbench((s) => s.paletteOpen);
  const setOpen = useWorkbench((s) => s.setPaletteOpen);
  const catalog = useWorkbench((s) => s.catalog);
  const tab = useWorkbench(activeTab);
  const addTab = useWorkbench((s) => s.addTab);
  const run = useWorkbench((s) => s.run);
  const stop = useWorkbench((s) => s.stop);
  const setSidebarView = useWorkbench((s) => s.setSidebarView);
  const setDockTab = useWorkbench((s) => s.setDockTab);
  const setTheme = useWorkbench((s) => s.setTheme);
  const theme = useWorkbench((s) => s.theme);
  const refreshCatalog = useWorkbench((s) => s.refreshCatalog);
  const refreshConnectionCache = useWorkbench((s) => s.refreshConnectionCache);
  const setPushdown = useWorkbench((s) => s.setPushdown);
  const setHelpOpen = useWorkbench((s) => s.setHelpOpen);
  const pushdown = useWorkbench((s) => s.pushdown);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: 'run', group: 'Run', label: 'Run the script', hint: 'Ctrl Enter', run: () => tab && void run(tab.id) },
      {
        id: 'run-statement',
        group: 'Run',
        label: 'Run the statement under the cursor',
        hint: 'Ctrl Shift Enter',
        run: () => tab && void run(tab.id, { statementOnly: true }),
      },
      { id: 'explain', group: 'Run', label: 'Run with the DuckDB plan', run: () => tab && void run(tab.id, { explain: true }) },
      { id: 'stop', group: 'Run', label: 'Stop the current run', run: () => tab && void stop(tab.id) },
      {
        id: 'pushdown',
        group: 'Run',
        label: pushdown ? 'Turn filter pushdown off' : 'Turn filter pushdown on',
        hint: 'Compare results with and without',
        run: () => setPushdown(!pushdown),
      },
      {
        id: 'help',
        group: 'Help',
        label: 'SQL over GraphQL cheat sheet',
        hint: 'F1',
        run: () => setHelpOpen(true),
      },
      { id: 'new-sql', group: 'Tabs', label: 'New SQL tab', hint: 'Ctrl T', run: () => addTab('sql') },
      { id: 'new-graphql', group: 'Tabs', label: 'New GraphQL tab', run: () => addTab('graphql') },
      { id: 'view-schema', group: 'View', label: 'Show the schema tree', run: () => setSidebarView('schema') },
      { id: 'view-connections', group: 'View', label: 'Show connections', run: () => setSidebarView('connections') },
      { id: 'view-er', group: 'View', label: 'Show the relationship diagram', run: () => setSidebarView('er') },
      { id: 'view-history', group: 'View', label: 'Show query history', run: () => setSidebarView('history') },
      { id: 'panel-graphql', group: 'View', label: 'Show the generated GraphQL', run: () => tab && setDockTab(tab.id, 'graphql') },
      { id: 'panel-plan', group: 'View', label: 'Show the plan and timings', run: () => tab && setDockTab(tab.id, 'plan') },
      { id: 'panel-chart', group: 'View', label: 'Chart the result', run: () => tab && setDockTab(tab.id, 'chart') },
      {
        id: 'theme',
        group: 'View',
        label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      { id: 'refresh-schema', group: 'Connection', label: 'Re-read the schema', run: () => void refreshCatalog({ refresh: true }) },
      {
        id: 'clear-cache',
        group: 'Connection',
        label: 'Clear cached pages and re-read the schema',
        run: () => void refreshConnectionCache(),
      },
      {
        id: 'show-tables',
        group: 'Statements',
        label: 'SHOW TABLES',
        hint: 'Every table this endpoint exposes',
        run: () => {
          const id = addTab('sql', 'SHOW TABLES;\n');
          void run(id);
        },
      },
      {
        id: 'show-settings',
        group: 'Statements',
        label: 'SHOW SETTINGS',
        hint: 'Pushdown, cache, row budget',
        run: () => {
          const id = addTab('sql', 'SHOW SETTINGS;\n');
          void run(id);
        },
      },
      {
        id: 'show-snapshots',
        group: 'Statements',
        label: 'SHOW SNAPSHOTS',
        hint: 'Materialised fetches that query offline',
        run: () => {
          const id = addTab('sql', 'SHOW SNAPSHOTS;\n');
          void run(id);
        },
      },
      {
        id: 'materialize',
        group: 'Statements',
        label: 'MATERIALIZE a table as a snapshot',
        hint: 'Pin a fetch so it queries without the endpoint',
        run: () => {
          const table = catalog?.tables.find((t) => !t.isChild)?.name ?? 'users';
          addTab('sql', `-- A snapshot is a real table: it keeps working with the endpoint offline.\nMATERIALIZE ${table}(first: 5000) AS ${table}_snapshot;\n\nSELECT count(*) FROM ${table}_snapshot;\n`);
        },
      },
    ];

    for (const table of catalog?.tables.filter((t) => !t.isChild) ?? []) {
      list.push({
        id: `select-${table.name}`,
        group: 'Tables',
        label: `SELECT the first 100 rows of ${table.name}`,
        hint: `${table.columns.filter((c) => !c.synthetic).length} columns`,
        run: () => {
          const id = addTab('sql', `SELECT *\nFROM ${table.name}\nLIMIT 100;\n`);
          void run(id);
        },
      });
      list.push({
        id: `describe-${table.name}`,
        group: 'Tables',
        label: `DESCRIBE ${table.name}`,
        run: () => {
          const id = addTab('sql', `DESCRIBE ${table.name};\n`);
          void run(id);
        },
      });
    }
    return list;
  }, [addTab, catalog, pushdown, refreshCatalog, refreshConnectionCache, run, setDockTab, setHelpOpen, setPushdown, setSidebarView, setTheme, stop, tab, theme]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.slice(0, 40);
    // Subsequence matching, so "shtb" finds "SHOW TABLES".
    return commands
      .map((command) => ({ command, score: score(command.label.toLowerCase(), needle) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((entry) => entry.command);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  const invoke = (command: Command | undefined) => {
    if (!command) return;
    setOpen(false);
    command.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-lg border border-line bg-bg-1 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <span className="text-ink-3">
            <IconSearch size={14} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((current) => Math.min(current + 1, filtered.length - 1));
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((current) => Math.max(current - 1, 0));
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                invoke(filtered[selected]);
              }
            }}
            placeholder="Run a command, open a table, change a setting"
            className="h-10 flex-1 bg-transparent text-sm text-ink-0 outline-none placeholder:text-ink-3"
          />
        </div>
        <ul className="max-h-[52vh] overflow-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-[11px] text-ink-3">Nothing matches.</li>
          ) : (
            filtered.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => invoke(command)}
                  className={cx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                    index === selected ? 'bg-bg-3' : 'hover:bg-bg-2',
                  )}
                >
                  <span className="w-20 shrink-0 text-[10px] uppercase tracking-wider text-ink-3">{command.group}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-0">{command.label}</span>
                  {command.hint ? <span className="shrink-0 text-[10px] text-ink-3">{command.hint}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/** Subsequence score: consecutive and word-start matches rank higher. */
function score(haystack: string, needle: string): number {
  let hay = 0;
  let total = 0;
  let streak = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, hay);
    if (found === -1) return 0;
    const atWordStart = found === 0 || haystack[found - 1] === ' ' || haystack[found - 1] === '_';
    streak = found === hay ? streak + 1 : 0;
    total += 1 + streak + (atWordStart ? 3 : 0);
    hay = found + 1;
  }
  return total;
}
