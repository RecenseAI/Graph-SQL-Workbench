import { useEffect, useState } from 'react';
import type { ConnectionConfig, ConnectionInput } from '@gqlwb/shared';
import { useWorkbench } from '../../store/workbench.ts';
import { api } from '../../lib/api.ts';
import { Badge, Button, Field, IconButton, Input, Select, SectionHeader } from '../../ui/primitives.tsx';
import { IconClose, IconDatabase, IconPlus, IconRefresh, IconSettings } from '../../app/Icons.tsx';

/**
 * Connections are the only configuration the workbench needs, and every field here changes
 * something observable: the pushdown profile decides which filters can be delegated, depth decides
 * how many columns a table has, and the row budget decides when a result gets truncated. The form
 * says so, rather than leaving the user to guess.
 */

const DEMO_ENDPOINT = 'http://127.0.0.1:5471/graphql';

interface DraftState {
  name: string;
  endpoint: string;
  authKind: 'none' | 'bearer' | 'basic' | 'header';
  token: string;
  user: string;
  pass: string;
  headerName: string;
  headers: { name: string; value: string; enabled: boolean }[];
  pushdownProfile: ConnectionConfig['pushdownProfile'];
  maxDepth: number;
  pageSize: number;
  maxRows: number;
  concurrency: number;
  requestsPerSecond: number;
  timeoutMs: number;
  cacheTtlSeconds: number;
  sdl: string;
  scalarTypeMapText: string;
}

function draftFrom(connection?: ConnectionConfig): DraftState {
  return {
    name: connection?.name ?? 'Demo API',
    endpoint: connection?.endpoint ?? DEMO_ENDPOINT,
    authKind: connection?.auth.kind ?? 'none',
    token: connection?.auth.token === '__stored__' ? '' : (connection?.auth.token ?? ''),
    user: connection?.auth.user ?? '',
    pass: '',
    headerName: connection?.auth.headerName ?? '',
    headers: connection?.headers.map((h) => ({ ...h, enabled: h.enabled !== false })) ?? [],
    pushdownProfile: connection?.pushdownProfile ?? 'auto',
    maxDepth: connection?.maxDepth ?? 3,
    pageSize: connection?.pageSize ?? 200,
    maxRows: connection?.maxRows ?? 10_000,
    concurrency: connection?.concurrency ?? 4,
    requestsPerSecond: connection?.requestsPerSecond ?? 0,
    timeoutMs: connection?.timeoutMs ?? 30_000,
    cacheTtlSeconds: connection?.cacheTtlSeconds ?? 300,
    sdl: connection?.sdl ?? '',
    scalarTypeMapText: connection?.scalarTypeMap ? JSON.stringify(connection.scalarTypeMap, null, 2) : '{}',
  };
}

function toInput(draft: DraftState): ConnectionInput | { error: string } {
  let scalarTypeMap: Record<string, string> = {};
  if (draft.scalarTypeMapText.trim()) {
    try {
      const parsed = JSON.parse(draft.scalarTypeMapText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'Scalar types must be a JSON object, for example {"Money": "DECIMAL(38,9)"}.' };
      }
      scalarTypeMap = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    } catch (err) {
      return { error: `Scalar types is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return {
    name: draft.name.trim() || 'Untitled',
    endpoint: draft.endpoint.trim(),
    auth: {
      kind: draft.authKind,
      ...(draft.token ? { token: draft.token } : {}),
      ...(draft.user ? { user: draft.user } : {}),
      ...(draft.pass ? { pass: draft.pass } : {}),
      ...(draft.headerName ? { headerName: draft.headerName } : {}),
    },
    headers: draft.headers.filter((h) => h.name.trim().length > 0),
    pushdownProfile: draft.pushdownProfile,
    maxDepth: draft.maxDepth,
    pageSize: draft.pageSize,
    maxRows: draft.maxRows,
    concurrency: draft.concurrency,
    requestsPerSecond: draft.requestsPerSecond,
    timeoutMs: draft.timeoutMs,
    cacheTtlSeconds: draft.cacheTtlSeconds,
    scalarTypeMap,
    ...(draft.sdl.trim() ? { sdl: draft.sdl } : {}),
  };
}

const PROFILE_HELP: Record<ConnectionConfig['pushdownProfile'], string> = {
  auto: 'Sends a filter only when an argument has exactly the column\'s name. Safe for any endpoint.',
  hasura: 'where: { column: { _eq: value } }, as Hasura and PostGraphile expose it.',
  strapi: 'filters: { column: { eq: value } }, as Strapi exposes it.',
  flat: 'Arguments named column_eq, column_gt and so on.',
  none: 'Never send filters. Everything is fetched and filtered locally.',
  custom: 'A hand-written operator map, edited in the workspace file.',
};

export function ConnectionPanel() {
  const connections = useWorkbench((s) => s.connections);
  const activeId = useWorkbench((s) => s.activeConnectionId);
  const catalog = useWorkbench((s) => s.catalog);
  const catalogLoading = useWorkbench((s) => s.catalogLoading);
  const catalogError = useWorkbench((s) => s.catalogError);
  const selectConnection = useWorkbench((s) => s.selectConnection);
  const saveConnection = useWorkbench((s) => s.saveConnection);
  const deleteConnection = useWorkbench((s) => s.deleteConnection);
  const refreshConnectionCache = useWorkbench((s) => s.refreshConnectionCache);

  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (connections.length === 0) setCreating(true);
  }, [connections.length]);

  const editingConnection = connections.find((c) => c.id === editing);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        right={
          <IconButton label="Add a connection" onClick={() => setCreating(true)} size={22}>
            <IconPlus size={14} />
          </IconButton>
        }
      >
        <IconDatabase size={13} /> Connections
      </SectionHeader>

      <div className="min-h-0 flex-1 overflow-auto">
        {connections.length === 0 && !creating ? (
          <p className="p-3 text-[11px] leading-relaxed text-ink-3">
            No connections yet. Add a GraphQL endpoint and every field on its Query type becomes a table you can
            join, aggregate and window over.
          </p>
        ) : null}

        <ul className="py-1">
          {connections.map((connection) => {
            const active = connection.id === activeId;
            return (
              <li key={connection.id}>
                <div
                  className={
                    active
                      ? 'flex items-center gap-2 border-l-2 border-sql bg-bg-2 px-2 py-1.5'
                      : 'flex items-center gap-2 border-l-2 border-transparent px-2 py-1.5 hover:bg-bg-2'
                  }
                >
                  <button
                    type="button"
                    onClick={() => void selectConnection(connection.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 shrink-0 rounded-full" style={{ background: connection.color }} />
                      <span className="truncate text-xs font-medium text-ink-0">{connection.name}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-ink-3">{connection.endpoint}</span>
                  </button>
                  <IconButton label="Edit connection" size={20} onClick={() => setEditing(connection.id)}>
                    <IconSettings size={13} />
                  </IconButton>
                </div>
                {active ? (
                  <div className="flex flex-wrap items-center gap-1.5 bg-bg-2 px-3 pb-2">
                    {catalogLoading ? (
                      <Badge tone="neutral">reading schema...</Badge>
                    ) : catalogError ? (
                      <Badge tone="err" title={catalogError}>
                        schema failed
                      </Badge>
                    ) : catalog ? (
                      <>
                        <Badge tone="gql">
                          {catalog.tables.filter((t) => !t.isChild).length} tables
                        </Badge>
                        {catalog.tables.some((t) => t.isChild) ? (
                          <Badge tone="neutral">{catalog.tables.filter((t) => t.isChild).length} nested</Badge>
                        ) : null}
                        <Badge tone={catalog.source === 'sdl' ? 'warn' : 'neutral'} title={`schema ${catalog.schemaHash}`}>
                          {catalog.source === 'sdl' ? 'from SDL' : 'introspected'}
                        </Badge>
                        {catalog.warnings.length > 0 ? (
                          <Badge tone="warn" title={catalog.warnings.join('\n\n')}>
                            {catalog.warnings.length} notes
                          </Badge>
                        ) : null}
                      </>
                    ) : null}
                    <div className="flex-1" />
                    <IconButton label="Re-read schema and clear cached pages" size={20} onClick={() => void refreshConnectionCache()}>
                      <IconRefresh size={13} />
                    </IconButton>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>

        {catalogError && activeId ? (
          <div className="m-2 rounded border border-err/40 bg-err/10 p-2 text-[11px] leading-relaxed text-err">
            {catalogError}
          </div>
        ) : null}
      </div>

      {creating || editingConnection ? (
        <ConnectionDialog
          connection={editingConnection}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (input) => {
            const saved = await saveConnection(input, editingConnection?.id);
            if (saved) {
              setCreating(false);
              setEditing(null);
            }
            return saved !== null;
          }}
          onDelete={
            editingConnection
              ? async () => {
                  await deleteConnection(editingConnection.id);
                  setEditing(null);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

function ConnectionDialog({
  connection,
  onClose,
  onSave,
  onDelete,
}: {
  connection?: ConnectionConfig;
  onClose: () => void;
  onSave: (input: ConnectionInput) => Promise<boolean>;
  onDelete?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<DraftState>(() => draftFrom(connection));
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const patch = <K extends keyof DraftState>(key: K, value: DraftState[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    const input = toInput(draft);
    if ('error' in input) {
      setError(input.error);
      return;
    }
    if (!input.endpoint) {
      setError('An endpoint URL is required.');
      return;
    }
    setSaving(true);
    setError(null);
    const ok = await onSave(input);
    setSaving(false);
    if (!ok) setError('The server rejected these settings. Check the endpoint URL.');
  };

  const test = async () => {
    const input = toInput(draft);
    if ('error' in input) {
      setError(input.error);
      return;
    }
    setTesting(true);
    setTestResult(null);
    // Testing needs a saved connection, so an unsaved draft is saved first.
    const saved = await onSave(input);
    if (!saved) {
      setTesting(false);
      setError('Could not save the connection to test it.');
      return;
    }
    try {
      const list = await api.listConnections();
      const target = list.connections.find((c) => c.endpoint === input.endpoint);
      if (!target) throw new Error('Connection not found after saving.');
      const result = await api.testConnection(target.id);
      setTestResult({ ok: result.ok, message: result.message ?? (result.ok ? 'Reachable.' : 'Failed.') });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[86vh] w-[min(560px,100%)] flex-col overflow-hidden rounded-lg border border-line bg-bg-1 shadow-2xl">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="text-xs font-semibold">{connection ? 'Edit connection' : 'New connection'}</span>
          <div className="flex-1" />
          <IconButton label="Close" size={22} onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => patch('name', e.target.value)} placeholder="Production API" />
            </Field>
            <Field label="GraphQL endpoint">
              <Input
                value={draft.endpoint}
                onChange={(e) => patch('endpoint', e.target.value)}
                placeholder="https://api.example.com/graphql"
                spellCheck={false}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Authentication">
              <Select value={draft.authKind} onChange={(e) => patch('authKind', e.target.value as DraftState['authKind'])}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
                <option value="basic">Basic</option>
              </Select>
            </Field>
            {draft.authKind === 'bearer' ? (
              <Field label="Token" hint="Stored separately from the workspace file. ${env:VAR} works too.">
                <Input
                  type="password"
                  value={draft.token}
                  onChange={(e) => patch('token', e.target.value)}
                  placeholder={connection?.auth.token === '__stored__' ? 'unchanged' : 'ghp_...'}
                />
              </Field>
            ) : null}
            {draft.authKind === 'header' ? (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Header name">
                  <Input value={draft.headerName} onChange={(e) => patch('headerName', e.target.value)} placeholder="X-API-Key" />
                </Field>
                <Field label="Value">
                  <Input type="password" value={draft.token} onChange={(e) => patch('token', e.target.value)} />
                </Field>
              </div>
            ) : null}
            {draft.authKind === 'basic' ? (
              <div className="grid grid-cols-2 gap-2">
                <Field label="User">
                  <Input value={draft.user} onChange={(e) => patch('user', e.target.value)} />
                </Field>
                <Field label="Password">
                  <Input type="password" value={draft.pass} onChange={(e) => patch('pass', e.target.value)} />
                </Field>
              </div>
            ) : null}
          </div>

          <Field label="Filter pushdown" hint={PROFILE_HELP[draft.pushdownProfile]}>
            <Select
              value={draft.pushdownProfile}
              onChange={(e) => patch('pushdownProfile', e.target.value as ConnectionConfig['pushdownProfile'])}
            >
              <option value="auto">Auto (exact argument names)</option>
              <option value="hasura">Hasura / PostGraphile</option>
              <option value="strapi">Strapi</option>
              <option value="flat">Flat suffixes</option>
              <option value="none">None</option>
              <option value="custom">Custom</option>
            </Select>
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Column depth" hint="How deep nested objects flatten into columns.">
              <Input
                type="number"
                min={1}
                max={8}
                value={draft.maxDepth}
                onChange={(e) => patch('maxDepth', Number(e.target.value) || 1)}
              />
            </Field>
            <Field label="Page size" hint="Rows per GraphQL request.">
              <Input
                type="number"
                min={1}
                max={1000}
                value={draft.pageSize}
                onChange={(e) => patch('pageSize', Number(e.target.value) || 1)}
              />
            </Field>
            <Field label="Row budget" hint="Per table, per statement. Exceeding it warns.">
              <Input
                type="number"
                min={1}
                value={draft.maxRows}
                onChange={(e) => patch('maxRows', Number(e.target.value) || 1)}
              />
            </Field>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-[11px] text-sql hover:underline"
          >
            {showAdvanced ? 'Hide' : 'Show'} advanced settings
          </button>

          {showAdvanced ? (
            <div className="space-y-3 rounded border border-line bg-bg-0 p-2.5">
              <div className="grid grid-cols-4 gap-2">
                <Field label="Concurrency">
                  <Input type="number" min={1} max={16} value={draft.concurrency} onChange={(e) => patch('concurrency', Number(e.target.value) || 1)} />
                </Field>
                <Field label="Req/sec" hint="0 = no limit">
                  <Input type="number" min={0} value={draft.requestsPerSecond} onChange={(e) => patch('requestsPerSecond', Number(e.target.value) || 0)} />
                </Field>
                <Field label="Timeout ms">
                  <Input type="number" min={1000} value={draft.timeoutMs} onChange={(e) => patch('timeoutMs', Number(e.target.value) || 1000)} />
                </Field>
                <Field label="Cache secs" hint="0 = off">
                  <Input type="number" min={0} value={draft.cacheTtlSeconds} onChange={(e) => patch('cacheTtlSeconds', Number(e.target.value) || 0)} />
                </Field>
              </div>

              <Field label="Custom scalar types" hint='Map GraphQL scalars to DuckDB types, e.g. {"Money": "DECIMAL(38,9)"}'>
                <textarea
                  value={draft.scalarTypeMapText}
                  onChange={(e) => patch('scalarTypeMapText', e.target.value)}
                  spellCheck={false}
                  rows={3}
                  className="w-full rounded border border-line bg-bg-0 p-2 font-mono text-[11px] text-ink-0 focus:border-sql focus:outline-none"
                />
              </Field>

              <Field
                label="Schema SDL"
                hint="Only needed when the endpoint has introspection disabled. Paste its SDL and the workbench uses that instead."
              >
                <textarea
                  value={draft.sdl}
                  onChange={(e) => patch('sdl', e.target.value)}
                  spellCheck={false}
                  rows={4}
                  placeholder="type Query { ... }"
                  className="w-full rounded border border-line bg-bg-0 p-2 font-mono text-[11px] text-ink-0 focus:border-sql focus:outline-none"
                />
              </Field>
            </div>
          ) : null}

          {error ? <p className="rounded border border-err/40 bg-err/10 p-2 text-[11px] text-err">{error}</p> : null}
          {testResult ? (
            <p
              className={
                testResult.ok
                  ? 'rounded border border-ok/40 bg-ok/10 p-2 text-[11px] text-ok'
                  : 'rounded border border-err/40 bg-err/10 p-2 text-[11px] text-err'
              }
            >
              {testResult.message}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
          {onDelete ? (
            <Button tone="danger" size="sm" onClick={() => void onDelete()}>
              Delete
            </Button>
          ) : null}
          <div className="flex-1" />
          <Button size="sm" busy={testing} onClick={() => void test()}>
            Test
          </Button>
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" tone="primary" busy={saving} onClick={() => void save()}>
            {connection ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}
