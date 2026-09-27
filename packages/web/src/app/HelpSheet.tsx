import { useEffect } from 'react';
import { useWorkbench } from '../store/workbench.ts';
import { Badge, IconButton } from '../ui/primitives.tsx';
import { IconClose } from './Icons.tsx';

/**
 * The cheat sheet.
 *
 * Everything the workbench adds to ordinary SQL is here, because none of it is guessable: GraphQL
 * arguments in a FROM clause, the engine options, the nested-table join key, the snapshot
 * statements. A user should never have to leave the app to find out how to pass `first:`.
 */

interface Entry {
  code: string;
  title: string;
  body: string;
}

const SYNTAX: Entry[] = [
  {
    code: 'FROM users(first: 500, role: ADMIN)',
    title: 'GraphQL arguments in the FROM clause',
    body: 'Written exactly as the endpoint documents them. Strings are quoted, enums are bare, input objects are braces. A row-count argument like first: or limit: also caps how many rows are fetched.',
  },
  {
    code: 'JOIN orders o ON o.userId = u.id',
    title: 'Join anything to anything',
    body: 'The relationship does not need to exist in the schema. This is the join GraphQL cannot make for you, and the reason the tool exists.',
  },
  {
    code: 'JOIN orders__items i ON i._parent_rowid = o._rowid',
    title: 'Nested lists are their own tables',
    body: 'A list of objects inside a row becomes a child table, fetched with its parent and joined on _parent_rowid. The parent also gets an items_count column.',
  },
  {
    code: 'FROM users(country: "DE", @maxRows: 50000)',
    title: 'Engine options',
    body: '@maxRows caps rows for this table, @pageSize sets rows per request, @allPages ignores the budget, @cache opts in or out of the fetch cache, @depth changes column flattening.',
  },
  {
    code: 'SELECT _raw FROM users',
    title: 'The escape hatch',
    body: 'Every table has _raw, the row exactly as the endpoint returned it, and _rowid, a stable identity. Reach into _raw with json_extract_string(_raw, \'$.field\').',
  },
  {
    code: 'FROM users(country: "DE") a JOIN users b ON a.id = b.id',
    title: 'Different arguments are different fetches',
    body: 'Two references with the same arguments share one fetch. Different arguments become separate relations, which the Plan panel names.',
  },
];

const STATEMENTS: Entry[] = [
  { code: 'SHOW TABLES', title: 'Every table this endpoint exposes', body: 'With its pagination style, column count and primary key.' },
  { code: 'DESCRIBE users', title: 'Columns in both dialects', body: 'The DuckDB type, the GraphQL type, the nested path it came from, and whether the workbench added it.' },
  { code: 'SHOW SETTINGS', title: 'What the next statement will do', body: 'Pushdown, cache, row budget, page size and depth for this connection.' },
  { code: 'SET pushdown = off', title: 'Stop delegating filters', body: 'Everything is fetched and filtered locally. Useful to compare: row counts in the Plan panel should change while the result does not.' },
  { code: 'SET max_rows = 50000', title: 'Raise the row budget', body: 'Also page_size and depth. These last for the session.' },
  {
    code: 'MATERIALIZE users(first: 5000) AS users_snapshot',
    title: 'Pin a fetch as a real table',
    body: 'A snapshot queries without touching the endpoint, so analysis survives a rate limit, an outage, or a flight.',
  },
  { code: 'SHOW SNAPSHOTS', title: 'What has been pinned', body: 'Plus REFRESH <name> to re-fetch and DROP SNAPSHOT <name> to remove.' },
];

const SHORTCUTS: [string, string][] = [
  ['Ctrl Enter', 'Run the script'],
  ['Ctrl Shift Enter', 'Run the statement under the cursor'],
  ['Ctrl Shift F', 'Format'],
  ['Ctrl K', 'Command palette'],
  ['Ctrl T', 'New tab'],
  ['Ctrl C', 'Copy the selected cells as TSV'],
  ['Double-click a cell', 'Open it in the inspector'],
  ['Double-click a column header', 'Pin the column'],
];

export function HelpSheet() {
  const open = useWorkbench((s) => s.helpOpen);
  const setOpen = useWorkbench((s) => s.setHelpOpen);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      if (event.key === 'F1') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[88vh] w-[min(820px,100%)] flex-col overflow-hidden rounded-lg border border-line bg-bg-1 shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="text-sm font-semibold">SQL over GraphQL</span>
          <Badge tone="sql">cheat sheet</Badge>
          <div className="flex-1" />
          <IconButton label="Close" size={24} onClick={() => setOpen(false)}>
            <IconClose size={15} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
          <section>
            <p className="text-[11px] leading-relaxed text-ink-1">
              The dialect is DuckDB SQL, which is PostgreSQL-flavoured: window functions, CTEs, QUALIFY, PIVOT and
              GROUP BY ALL all work, and common MySQL functions are provided as macros. Everything below is what the
              workbench adds on top.
            </p>
          </section>

          <Section title="Syntax">
            {SYNTAX.map((entry) => (
              <EntryRow key={entry.code} entry={entry} />
            ))}
          </Section>

          <Section title="Statements the workbench answers itself">
            {STATEMENTS.map((entry) => (
              <EntryRow key={entry.code} entry={entry} />
            ))}
          </Section>

          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">Keyboard</h3>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="flex items-baseline justify-between gap-2 border-b border-line/50 py-0.5">
                  <dt className="text-[11px] text-ink-1">{what}</dt>
                  <dd>
                    <kbd className="rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-ink-2">{keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="rounded border border-line bg-bg-2 p-3">
            <h3 className="mb-1 text-[11px] font-semibold text-ink-0">What it cannot do</h3>
            <ul className="space-y-1 text-[11px] leading-relaxed text-ink-2">
              <li>
                Analysis is bounded by the row budget, because the rows have to be fetched before they can be
                computed over. This is a client-side engine, not a federated warehouse.
              </li>
              <li>
                Filters are only delegated when the endpoint exposes a matching argument. When it does not, everything
                is fetched and filtered locally -- the Plan panel says which, and why.
              </li>
              <li>
                Fields of a concrete type under an interface or union are reachable only through _raw.
              </li>
              <li>Mutations are refused. The workbench is read-only by design.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function EntryRow({ entry }: { entry: Entry }) {
  const insert = useWorkbench((s) => s.insertIntoTab);
  const setOpen = useWorkbench((s) => s.setHelpOpen);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-3">
      <button
        type="button"
        onClick={() => {
          insert(entry.code);
          setOpen(false);
        }}
        title="Insert at the cursor"
        className="rounded border border-line bg-bg-0 px-2 py-1.5 text-left font-mono text-[11px] leading-relaxed text-sql hover:border-sql"
      >
        {entry.code}
      </button>
      <div>
        <p className="text-[11px] font-medium text-ink-0">{entry.title}</p>
        <p className="text-[11px] leading-relaxed text-ink-2">{entry.body}</p>
      </div>
    </div>
  );
}
