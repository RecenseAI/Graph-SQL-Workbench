import { useState } from 'react';
import type { FetchPlanEntry, QueryResult } from '@gqlwb/shared';
import { useWorkbench, type EditorTab, type RunMessage } from '../../store/workbench.ts';
import { Badge, Button, EmptyState, IconButton, cx } from '../../ui/primitives.tsx';
import { IconCheck, IconCopy, IconGraph, IconInfo, IconLayers, IconWarning } from '../../app/Icons.tsx';

/**
 * The panels that explain what the workbench actually did.
 *
 * These exist because the tool makes a claim -- "your SQL became these GraphQL requests" -- and a
 * claim a user cannot check is a claim they should not trust. Generated GraphQL shows exactly what
 * was sent, the plan shows which filters were delegated and which were not and why, and the
 * timings show where the time went.
 */

export function GeneratedGraphqlPanel({ result }: { result: QueryResult }) {
  const addTab = useWorkbench((s) => s.addTab);
  const [copied, setCopied] = useState<string | null>(null);

  if (result.plan.length === 0) {
    return (
      <EmptyState title="No GraphQL was sent" icon={<IconGraph size={22} />}>
        This statement ran entirely in DuckDB, over snapshots or literals.
      </EmptyState>
    );
  }

  const copy = (entry: FetchPlanEntry) => {
    const text = Object.keys(entry.variables).length
      ? `${entry.document}\n\n# variables\n${JSON.stringify(entry.variables, null, 2)}`
      : entry.document;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(entry.alias);
      window.setTimeout(() => setCopied(null), 1200);
    });
  };

  return (
    <div className="h-full overflow-auto">
      {result.plan.map((entry) => (
        <section key={entry.alias} className="border-b border-line">
          <header className="flex flex-wrap items-center gap-1.5 bg-bg-2 px-2 py-1.5">
            <span className="font-mono text-[11px] text-ink-0">{entry.table}</span>
            {entry.alias !== entry.table ? <Badge tone="neutral">as {entry.alias}</Badge> : null}
            <Badge tone="gql">{entry.pagination}</Badge>
            <Badge tone="neutral" title="Row budget for this table">
              max {entry.maxRows.toLocaleString()}
            </Badge>
            <Badge tone="neutral" title="Rows requested per request">
              page {entry.pageSize}
            </Badge>
            {entry.pushed.length > 0 ? (
              <Badge tone="ok" title={entry.pushed.map((p) => `${p.column} ${p.op} -> ${p.arg}`).join('\n')}>
                {entry.pushed.length} filter{entry.pushed.length === 1 ? '' : 's'} delegated
              </Badge>
            ) : null}
            <div className="flex-1" />
            <Button size="sm" icon={<IconCopy size={11} />} onClick={() => copy(entry)}>
              {copied === entry.alias ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" onClick={() => addTab('graphql', entry.document)}>
              Open in GraphQL tab
            </Button>
          </header>

          <pre className="overflow-x-auto p-2 font-mono text-[11px] leading-relaxed text-ink-1">{entry.document}</pre>

          {Object.keys(entry.variables).length > 0 ? (
            <div className="border-t border-line px-2 py-1.5">
              <p className="text-[10px] uppercase tracking-wider text-ink-3">
                Variables (the pagination loop rewrites these between pages)
              </p>
              <pre className="mt-1 font-mono text-[11px] text-ink-2">{JSON.stringify(entry.variables, null, 2)}</pre>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function PlanPanel({ result }: { result: QueryResult }) {
  if (result.plan.length === 0 && !result.explain) {
    return (
      <EmptyState title="Nothing to plan" icon={<IconLayers size={22} />}>
        This statement needed no data from the endpoint.
      </EmptyState>
    );
  }

  const totalBytes = result.stats.reduce((sum, s) => sum + s.bytes, 0);
  const totalRows = result.stats.reduce((sum, s) => sum + s.rows, 0);
  const totalRequests = result.stats.reduce((sum, s) => sum + s.requests, 0);

  return (
    <div className="h-full space-y-3 overflow-auto p-2">
      {/* Where the time went */}
      <section>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">Time</h3>
        <TimingBar timings={result.timings} />
      </section>

      {/* What was fetched */}
      {result.stats.length > 0 ? (
        <section>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            {totalRequests === 0
              ? `${totalRows.toLocaleString()} rows served from cache, without calling the endpoint`
              : `Fetched ${totalRows.toLocaleString()} rows in ${totalRequests} request${totalRequests === 1 ? '' : 's'} (${(totalBytes / 1024).toFixed(1)} kB)`}
          </h3>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-line text-left text-ink-3">
                <th className="py-1 pr-2 font-medium">table</th>
                <th className="py-1 pr-2 text-right font-medium">rows</th>
                <th className="py-1 pr-2 text-right font-medium">pages</th>
                <th className="py-1 pr-2 text-right font-medium">requests</th>
                <th className="py-1 pr-2 text-right font-medium">kB</th>
                <th className="py-1 pr-2 text-right font-medium">ms</th>
                <th className="py-1 font-medium">cache</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {result.stats.map((stat) => (
                <tr key={stat.table} className="border-b border-line/50">
                  <td className="py-1 pr-2 text-ink-0">{stat.table}</td>
                  <td className="tnum py-1 pr-2 text-right text-num">{stat.rows.toLocaleString()}</td>
                  <td className="tnum py-1 pr-2 text-right text-ink-1">{stat.pages}</td>
                  <td className="tnum py-1 pr-2 text-right text-ink-1">
                    {stat.requests}
                    {stat.retries > 0 ? <span className="text-warn"> +{stat.retries} retried</span> : null}
                  </td>
                  <td className="tnum py-1 pr-2 text-right text-ink-1">{(stat.bytes / 1024).toFixed(1)}</td>
                  <td className="tnum py-1 pr-2 text-right text-ink-1">{stat.ms.toLocaleString()}</td>
                  <td className="py-1">
                    {stat.cache === 'hit' ? (
                      <Badge tone="ok">hit</Badge>
                    ) : stat.cache === 'miss' ? (
                      <Badge tone="neutral">miss</Badge>
                    ) : (
                      <Badge tone="neutral">off</Badge>
                    )}
                    {stat.truncated ? (
                      <Badge tone="warn" title="The row budget stopped this fetch early">
                        truncated
                      </Badge>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {/* Filter delegation, both directions */}
      {result.plan.map((entry) => (
        <section key={entry.alias}>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            {entry.table}
            <span className="font-normal normal-case text-ink-3">
              projected {entry.projected.length} field{entry.projected.length === 1 ? '' : 's'}
            </span>
          </h3>

          {entry.pushed.length === 0 && entry.skipped.length === 0 ? (
            <p className="text-[11px] text-ink-3">No filters in this statement applied to {entry.table}.</p>
          ) : null}

          {entry.pushed.length > 0 ? (
            <ul className="mb-1.5 space-y-0.5">
              {entry.pushed.map((pushed, index) => (
                <li key={index} className="flex items-start gap-1.5 text-[11px]">
                  <span className="mt-0.5 shrink-0 text-ok">
                    <IconCheck size={11} />
                  </span>
                  <span className="text-ink-1">
                    <span className="font-mono text-ink-0">
                      {pushed.column} {opSymbol(pushed.op)} {JSON.stringify(pushed.value)}
                    </span>{' '}
                    sent as <span className="font-mono text-gql">{pushed.arg}</span>{' '}
                    <span className="text-ink-3">via {pushed.via}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {entry.skipped.length > 0 ? (
            <ul className="space-y-0.5">
              {entry.skipped.map((skipped, index) => (
                <li key={index} className="flex items-start gap-1.5 text-[11px]">
                  <span className="mt-0.5 shrink-0 text-ink-3">
                    <IconInfo size={11} />
                  </span>
                  <span className="text-ink-2">
                    <span className="font-mono text-ink-1">
                      {skipped.column} {opSymbol(skipped.op)}
                    </span>{' '}
                    filtered locally. {skipped.reason}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}

      <p className="rounded border border-line bg-bg-2 p-2 text-[10px] leading-relaxed text-ink-3">
        A delegated filter is also kept in the SQL, so if the API filters more loosely than SQL, the extra rows are
        removed locally. Filters are only delegated through arguments the schema declares, with unambiguous operators
        -- but if an API's filter means something stricter than it looks, switch pushdown off in the toolbar and
        compare: the row counts here should change while the result does not.
      </p>

      {result.explain ? (
        <section>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-3">DuckDB plan</h3>
          <pre className="overflow-x-auto rounded border border-line bg-bg-0 p-2 font-mono text-[10px] leading-snug text-ink-2">
            {result.explain}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

function opSymbol(op: string): string {
  const symbols: Record<string, string> = {
    eq: '=',
    ne: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    in: 'IN',
    nin: 'NOT IN',
    like: 'LIKE',
    ilike: 'ILIKE',
    isNull: 'IS NULL',
  };
  return symbols[op] ?? op;
}

function TimingBar({ timings }: { timings: QueryResult['timings'] }) {
  const segments = [
    { label: 'plan', ms: timings.plan, color: 'var(--color-ink-3)' },
    { label: 'fetch', ms: timings.fetch, color: 'var(--color-gql)' },
    { label: 'shred', ms: timings.shred, color: 'var(--color-warn)' },
    { label: 'execute', ms: timings.execute, color: 'var(--color-sql)' },
  ];
  const accounted = segments.reduce((sum, segment) => sum + segment.ms, 0);
  const other = Math.max(0, timings.total - accounted);
  const total = Math.max(1, accounted + other);

  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-3">
        {segments.map((segment) =>
          segment.ms > 0 ? (
            <span
              key={segment.label}
              title={`${segment.label}: ${segment.ms} ms`}
              style={{ width: `${(segment.ms / total) * 100}%`, background: segment.color }}
            />
          ) : null,
        )}
        {other > 0 ? (
          <span title={`other: ${other} ms`} style={{ width: `${(other / total) * 100}%`, background: 'var(--color-bg-4)' }} />
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-2">
        {segments.map((segment) => (
          <span key={segment.label} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: segment.color }} />
            {segment.label} <span className="tnum text-ink-1">{segment.ms.toLocaleString()} ms</span>
          </span>
        ))}
        {other > 0 ? (
          <span className="inline-flex items-center gap-1" title="Reading the schema, opening the local database, and other setup">
            <span className="size-2 rounded-sm" style={{ background: 'var(--color-bg-4)' }} />
            setup <span className="tnum text-ink-1">{other.toLocaleString()} ms</span>
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1 font-medium text-ink-1">
          total <span className="tnum">{timings.total.toLocaleString()} ms</span>
        </span>
      </div>
    </div>
  );
}

export function MessagesPanel({ tab }: { tab: EditorTab }) {
  const results = tab.results;
  if (tab.messages.length === 0 && results.length === 0) {
    return <EmptyState title="Nothing to report">Messages, warnings and errors from the last run appear here.</EmptyState>;
  }
  return (
    <div className="h-full overflow-auto p-2">
      <ul className="space-y-1">
        {results
          .filter((result) => result.message)
          .map((result, index) => (
            <li key={`r${index}`} className="flex items-start gap-1.5 text-[11px] leading-relaxed">
              <span className="mt-0.5 shrink-0 text-ok">
                <IconCheck size={12} />
              </span>
              <span className="text-ink-1">{result.message}</span>
            </li>
          ))}
        {tab.messages.map((message, index) => (
          <MessageRow key={index} message={message} />
        ))}
      </ul>
    </div>
  );
}

function MessageRow({ message }: { message: RunMessage }) {
  const [open, setOpen] = useState(false);
  const detail = message.detail as { code?: string; hint?: string; detail?: unknown } | undefined;
  return (
    <li
      className={cx(
        'rounded border px-2 py-1.5 text-[11px] leading-relaxed',
        message.kind === 'error'
          ? 'border-err/40 bg-err/10 text-err'
          : message.kind === 'warning'
            ? 'border-warn/40 bg-warn/10 text-warn'
            : 'border-line bg-bg-2 text-ink-1',
      )}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0">
          {message.kind === 'error' ? (
            <IconWarning size={12} />
          ) : message.kind === 'warning' ? (
            <IconWarning size={12} />
          ) : (
            <IconInfo size={12} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p>{message.text}</p>
          {detail?.hint ? <p className="mt-1 text-ink-1">{detail.hint}</p> : null}
          {detail?.code ? (
            <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[10px] text-ink-2 underline">
              {detail.code}
              {open ? ' (hide details)' : ' (details)'}
            </button>
          ) : null}
          {open && detail?.detail ? (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg-0 p-1.5 font-mono text-[10px] text-ink-2">
              {typeof detail.detail === 'string' ? detail.detail : JSON.stringify(detail.detail, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function HistoryPanel() {
  const history = useWorkbench((s) => s.history);
  const clear = useWorkbench((s) => s.clearHistory);
  const addTab = useWorkbench((s) => s.addTab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
        History
        <div className="flex-1" />
        {history.length > 0 ? (
          <button type="button" onClick={() => void clear()} className="text-[10px] normal-case text-ink-2 hover:text-err">
            clear
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {history.length === 0 ? (
          <p className="p-3 text-[11px] text-ink-3">Statements you run appear here.</p>
        ) : (
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => addTab('sql', entry.sql.endsWith(';') ? entry.sql : `${entry.sql};`)}
                  title={entry.error ?? entry.sql}
                  className="w-full border-b border-line/60 px-2 py-1.5 text-left hover:bg-bg-2"
                >
                  <span className="flex items-center gap-1.5">
                    <span className={cx('size-1.5 shrink-0 rounded-full', entry.ok ? 'bg-ok' : 'bg-err')} />
                    <span className="tnum text-[10px] text-ink-3">{new Date(entry.at).toLocaleTimeString()}</span>
                    <span className="tnum text-[10px] text-ink-3">{entry.ms.toLocaleString()} ms</span>
                    {entry.ok ? <span className="tnum text-[10px] text-ink-3">{entry.rows.toLocaleString()} rows</span> : null}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-1">
                    {entry.sql.replace(/\s+/g, ' ').slice(0, 120)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
