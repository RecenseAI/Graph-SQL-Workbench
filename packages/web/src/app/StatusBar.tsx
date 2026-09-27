import { useWorkbench, activeResult, activeTab } from '../store/workbench.ts';
import { cx } from '../ui/primitives.tsx';

/**
 * The status bar carries the numbers a user checks constantly: how many rows came back, how the
 * time split between the endpoint and the local engine, and whether anything was truncated.
 */
export function StatusBar() {
  const tab = useWorkbench(activeTab);
  const result = useWorkbench((s) => activeResult(activeTab(s)));
  const health = useWorkbench((s) => s.health);
  const catalog = useWorkbench((s) => s.catalog);

  const view = result && tab ? tab.views[result.resultId] : undefined;
  const truncated = result?.stats.some((stat) => stat.truncated) ?? false;
  const cacheHit = result?.stats.some((stat) => stat.cache === 'hit') ?? false;
  const fetchedRows = result?.stats.reduce((sum, stat) => sum + stat.rows, 0) ?? 0;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-bg-1 px-2.5 text-[10px] text-ink-2">
      {result ? (
        <>
          <span className="tnum">
            {view && view.filter
              ? `${view.rowCount.toLocaleString()} of ${result.rowCount.toLocaleString()} rows`
              : `${result.rowCount.toLocaleString()} rows`}
          </span>
          <span className="text-line-strong">|</span>
          <span className="tnum" title="Time at the endpoint versus time in DuckDB">
            fetch {result.timings.fetch.toLocaleString()} ms
            <span className="text-ink-3"> + </span>
            local {(result.timings.shred + result.timings.execute).toLocaleString()} ms
          </span>
          {fetchedRows > 0 ? (
            <>
              <span className="text-line-strong">|</span>
              <span className="tnum" title="Rows fetched from the endpoint for this statement">
                {fetchedRows.toLocaleString()} fetched
              </span>
            </>
          ) : null}
          {cacheHit ? <span className="text-ok">cache hit</span> : null}
          {truncated ? (
            <span className="text-warn" title="The row budget stopped a fetch early. See the Plan panel.">
              truncated
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-ink-3">Ready</span>
      )}

      <div className="flex-1" />

      {catalog?.warnings.length ? (
        <span className="text-ink-3" title={catalog.warnings.join('\n\n')}>
          {catalog.warnings.length} schema note{catalog.warnings.length === 1 ? '' : 's'}
        </span>
      ) : null}
      {tab ? (
        <span className={cx('text-ink-3')}>{tab.kind === 'sql' ? 'DuckDB SQL' : 'GraphQL'}</span>
      ) : null}
      {health ? (
        <span className="hidden truncate text-ink-3 lg:inline" title={health.dataDir}>
          {health.dataDir}
        </span>
      ) : null}
    </footer>
  );
}
