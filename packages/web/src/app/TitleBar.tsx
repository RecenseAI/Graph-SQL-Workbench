import { useWorkbench } from '../store/workbench.ts';
import { Badge, IconButton, Select, cx } from '../ui/primitives.tsx';
import { IconBook, IconGraph, IconMoon, IconRefresh, IconSearch, IconSun, IconWarning } from './Icons.tsx';

/** Identity, which connection is live, and the two controls that belong at the top level. */
export function TitleBar() {
  const connections = useWorkbench((s) => s.connections);
  const activeConnectionId = useWorkbench((s) => s.activeConnectionId);
  const selectConnection = useWorkbench((s) => s.selectConnection);
  const catalog = useWorkbench((s) => s.catalog);
  const catalogLoading = useWorkbench((s) => s.catalogLoading);
  const refreshCatalog = useWorkbench((s) => s.refreshCatalog);
  const health = useWorkbench((s) => s.health);
  const healthError = useWorkbench((s) => s.healthError);
  const theme = useWorkbench((s) => s.theme);
  const setTheme = useWorkbench((s) => s.setTheme);
  const setPaletteOpen = useWorkbench((s) => s.setPaletteOpen);
  const setHelpOpen = useWorkbench((s) => s.setHelpOpen);

  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-bg-1 px-2.5">
      <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
        <span className="text-gql">
          <IconGraph size={17} />
        </span>
        <span className="whitespace-nowrap text-[13px] font-semibold tracking-tight">GraphQL Workbench</span>
        <span className="hidden whitespace-nowrap rounded bg-bg-3 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-2 lg:inline">
          SQL over GraphQL
        </span>
      </div>

      <div className="mx-1 h-4 w-px bg-line" />

      {connections.length > 0 ? (
        <>
          <Select
            value={activeConnectionId ?? ''}
            onChange={(e) => void selectConnection(e.target.value)}
            className="h-6 w-48 text-[11px]"
            aria-label="Active connection"
          >
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </Select>
          {catalogLoading ? (
            <Badge tone="neutral">reading schema</Badge>
          ) : catalog ? (
            <Badge tone="gql" title={`Schema fingerprint ${catalog.schemaHash}, built ${new Date(catalog.builtAt).toLocaleTimeString()}`}>
              {catalog.tables.filter((t) => !t.isChild).length} tables
            </Badge>
          ) : null}
          <IconButton label="Re-read the schema" size={22} onClick={() => void refreshCatalog({ refresh: true })}>
            <IconRefresh size={13} />
          </IconButton>
        </>
      ) : (
        <span className="whitespace-nowrap text-[11px] text-ink-3">No connection yet</span>
      )}

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:border-line-strong hover:text-ink-0 lg:flex"
      >
        <IconSearch size={12} />
        Command palette
        <kbd className="rounded bg-bg-3 px-1 text-[9px] text-ink-3">Ctrl K</kbd>
      </button>

      {healthError ? (
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-err" title={healthError}>
          <IconWarning size={13} /> API unreachable
        </span>
      ) : (
        <span className={cx('flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-2')} title={`DuckDB ${health?.engine ?? ''}`}>
          <span className="size-1.5 rounded-full bg-ok" />
          DuckDB {health?.engine ?? '...'}
        </span>
      )}

      <IconButton label="SQL over GraphQL cheat sheet (F1)" size={24} onClick={() => setHelpOpen(true)}>
        <IconBook size={14} />
      </IconButton>

      <IconButton
        label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
        size={24}
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      >
        {theme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}
      </IconButton>
    </header>
  );
}
