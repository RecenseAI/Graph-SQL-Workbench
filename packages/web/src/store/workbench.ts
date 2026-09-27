import { create } from 'zustand';
import type {
  Catalog,
  ConnectionConfig,
  ConnectionInput,
  HistoryEntry,
  QueryResult,
  RunEvent,
} from '@gqlwb/shared';
import { api, ApiError, runSql, type HealthInfo } from '../lib/api.ts';
import { applyTheme, readTheme, type ThemeChoice } from '../lib/theme.ts';

/**
 * All workbench state lives here.
 *
 * The shape follows the UI rather than the API: a tab owns its editor text, its run, and the
 * results of every statement in that run, because that is the unit a user thinks in. Run events
 * arrive over SSE and are folded into the tab as they come, so the plan and fetch progress appear
 * long before any rows do.
 */

export type DockTab = 'grid' | 'graphql' | 'plan' | 'chart' | 'messages';
export type SidebarView = 'schema' | 'connections' | 'history' | 'er';

export interface RunMessage {
  kind: 'info' | 'warning' | 'error';
  text: string;
  detail?: unknown;
  at: number;
}

export interface FetchProgress {
  table: string;
  pages: number;
  rows: number;
  done: boolean;
}

/** Grid view state, kept per result so switching result tabs does not lose a sort. */
export interface GridView {
  orderBy: string | null;
  descending: boolean;
  filter: string;
  /** Rows loaded so far, which grows as the grid scrolls. */
  rows: unknown[][];
  /** Rows matching the current filter. */
  rowCount: number;
  loading: boolean;
  hiddenColumns: string[];
  pinnedColumns: string[];
  columnWidths: Record<string, number>;
}

export interface EditorTab {
  id: string;
  title: string
  kind: 'sql' | 'graphql';
  content: string;
  running: boolean;
  runId: string | null;
  results: QueryResult[];
  activeResultIndex: number;
  views: Record<string, GridView>;
  messages: RunMessage[];
  progress: FetchProgress[];
  dockTab: DockTab;
  /** Cursor offset, used by "run current statement". */
  cursorOffset: number;
  lastRunMs: number | null;
}

const PAGE_ROWS = 300;

const newGridView = (): GridView => ({
  orderBy: null,
  descending: false,
  filter: '',
  rows: [],
  rowCount: 0,
  loading: false,
  hiddenColumns: [],
  pinnedColumns: [],
  columnWidths: {},
});

const STARTER_SQL = `-- GraphQL fetches. DuckDB computes.
-- Every field on the endpoint's Query type is a table here.

SELECT u.country,
       COUNT(*)     AS orders,
       SUM(o.total) AS revenue,
       MAX(o.total) AS biggest
FROM users u
JOIN orders(status: "PAID") o ON o.userId = u.id
GROUP BY u.country
ORDER BY revenue DESC;
`;

let tabCounter = 0;

export function createTab(kind: 'sql' | 'graphql' = 'sql', content?: string): EditorTab {
  tabCounter += 1;
  return {
    id: `tab-${Date.now()}-${tabCounter}`,
    title: kind === 'sql' ? `Query ${tabCounter}` : `GraphQL ${tabCounter}`,
    kind,
    content: content ?? (kind === 'sql' ? STARTER_SQL : '{\n  __typename\n}\n'),
    running: false,
    runId: null,
    results: [],
    activeResultIndex: 0,
    views: {},
    messages: [],
    progress: [],
    dockTab: 'grid',
    cursorOffset: 0,
    lastRunMs: null,
  };
}

interface Persisted {
  tabs: { id: string; title: string; kind: 'sql' | 'graphql'; content: string }[];
  activeTabId: string | null;
  sidebarWidth: number;
  dockHeight: number;
  sidebarView: SidebarView;
}

const STORAGE_KEY = 'gqlwb.workspace.v1';

function loadPersisted(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch {
    return {};
  }
}

interface WorkbenchState {
  health: HealthInfo | null;
  healthError: string | null;

  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  catalog: Catalog | null;
  catalogLoading: boolean;
  catalogError: string | null;

  history: HistoryEntry[];

  tabs: EditorTab[];
  activeTabId: string;

  theme: ThemeChoice;
  sidebarWidth: number;
  dockHeight: number;
  sidebarView: SidebarView;
  paletteOpen: boolean;
  helpOpen: boolean;
  schemaFilter: string;
  /** Row inspected in the cell panel, as [resultId, rowIndex, columnIndex]. */
  inspecting: { resultId: string; row: number; column: number } | null;

  /** Per-run settings the toolbar exposes. */
  pushdown: boolean;
  cache: boolean;
  rowLimit: number | null;

  init: () => Promise<void>;
  pollHealth: () => Promise<void>;
  reloadConnections: () => Promise<void>;
  selectConnection: (id: string) => Promise<void>;
  saveConnection: (input: ConnectionInput, id?: string) => Promise<ConnectionConfig | null>;
  deleteConnection: (id: string) => Promise<void>;
  refreshCatalog: (opts?: { refresh?: boolean }) => Promise<void>;
  refreshConnectionCache: () => Promise<void>;
  reloadHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;

  setTheme: (theme: ThemeChoice) => void;
  setSidebarWidth: (width: number) => void;
  setDockHeight: (height: number) => void;
  setSidebarView: (view: SidebarView) => void;
  setPaletteOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setSchemaFilter: (filter: string) => void;
  setInspecting: (target: WorkbenchState['inspecting']) => void;
  setPushdown: (on: boolean) => void;
  setCache: (on: boolean) => void;
  setRowLimit: (limit: number | null) => void;

  addTab: (kind?: 'sql' | 'graphql', content?: string) => string;
  closeTab: (id: string) => void;
  selectTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<EditorTab>) => void;
  renameTab: (id: string, title: string) => void;
  setTabContent: (id: string, content: string) => void;
  insertIntoTab: (text: string) => void;

  run: (tabId: string, options?: { statementOnly?: boolean; explain?: boolean }) => Promise<void>;
  stop: (tabId: string) => Promise<void>;
  selectResult: (tabId: string, index: number) => void;
  setDockTab: (tabId: string, tab: DockTab) => void;
  updateView: (tabId: string, resultId: string, patch: Partial<GridView>) => void;
  applyView: (tabId: string, resultId: string, patch: Partial<GridView>) => Promise<void>;
  loadMoreRows: (tabId: string, resultId: string) => Promise<void>;
}

const persisted = loadPersisted();
const initialTabs =
  persisted.tabs && persisted.tabs.length > 0
    ? persisted.tabs.map((saved) => ({ ...createTab(saved.kind, saved.content), id: saved.id, title: saved.title }))
    : [createTab('sql')];
const firstTab = initialTabs[0];
if (!firstTab) throw new Error('expected at least one tab');

function persist(state: WorkbenchState): void {
  const payload: Persisted = {
    tabs: state.tabs.map((tab) => ({ id: tab.id, title: tab.title, kind: tab.kind, content: tab.content })),
    activeTabId: state.activeTabId,
    sidebarWidth: state.sidebarWidth,
    dockHeight: state.dockHeight,
    sidebarView: state.sidebarView,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* a full quota must not break the editor */
  }
}

const describe = (err: unknown): string => {
  if (err instanceof ApiError) return err.hint ? `${err.message} ${err.hint}` : err.message;
  return err instanceof Error ? err.message : String(err);
};

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  health: null,
  healthError: null,
  connections: [],
  activeConnectionId: null,
  catalog: null,
  catalogLoading: false,
  catalogError: null,
  history: [],
  tabs: initialTabs,
  activeTabId: persisted.activeTabId && initialTabs.some((t) => t.id === persisted.activeTabId) ? persisted.activeTabId : firstTab.id,
  theme: readTheme(),
  sidebarWidth: persisted.sidebarWidth ?? 300,
  dockHeight: persisted.dockHeight ?? 340,
  sidebarView: persisted.sidebarView ?? 'schema',
  paletteOpen: false,
  helpOpen: false,
  schemaFilter: '',
  inspecting: null,
  pushdown: true,
  cache: true,
  rowLimit: null,

  async init() {
    await get().pollHealth();
    await get().reloadConnections();
    await get().reloadHistory();
  },

  async pollHealth() {
    try {
      set({ health: await api.health(), healthError: null });
    } catch (err) {
      set({ healthError: describe(err) });
    }
  },

  async reloadConnections() {
    try {
      const { connections, activeConnectionId } = await api.listConnections();
      const active = activeConnectionId ?? connections[0]?.id ?? null;
      set({ connections, activeConnectionId: active });
      if (active) await get().refreshCatalog();
      else set({ catalog: null });
    } catch (err) {
      set({ healthError: describe(err) });
    }
  },

  async selectConnection(id) {
    set({ activeConnectionId: id, catalog: null, catalogError: null });
    try {
      await api.activateConnection(id);
    } catch {
      /* activating is a convenience; the local selection still stands */
    }
    await get().refreshCatalog();
  },

  async saveConnection(input, id) {
    try {
      const saved = id ? await api.updateConnection(id, input) : await api.createConnection(input);
      const { connections } = await api.listConnections();
      set({ connections });
      if (!id || id === get().activeConnectionId) {
        await get().selectConnection(saved.connection.id);
      }
      return saved.connection;
    } catch (err) {
      set({ catalogError: describe(err) });
      return null;
    }
  },

  async deleteConnection(id) {
    await api.deleteConnection(id);
    const { connections, activeConnectionId } = await api.listConnections();
    set({ connections, activeConnectionId: activeConnectionId ?? connections[0]?.id ?? null, catalog: null });
    if (connections.length > 0) await get().refreshCatalog();
  },

  async refreshCatalog(opts) {
    const id = get().activeConnectionId;
    if (!id) return;
    set({ catalogLoading: true, catalogError: null });
    try {
      const { catalog } = await api.introspect(id, opts);
      set({ catalog, catalogLoading: false });
    } catch (err) {
      set({ catalogLoading: false, catalogError: describe(err), catalog: null });
    }
  },

  async refreshConnectionCache() {
    const id = get().activeConnectionId;
    if (!id) return;
    await api.refreshConnection(id);
    await get().refreshCatalog({ refresh: true });
  },

  async reloadHistory() {
    try {
      const { entries } = await api.history();
      set({ history: entries });
    } catch {
      /* history is not essential */
    }
  },

  async clearHistory() {
    await api.clearHistory();
    set({ history: [] });
  },

  setTheme(theme) {
    applyTheme(theme);
    set({ theme });
  },
  setSidebarWidth(sidebarWidth) {
    set({ sidebarWidth });
    persist(get());
  },
  setDockHeight(dockHeight) {
    set({ dockHeight });
    persist(get());
  },
  setSidebarView(sidebarView) {
    set({ sidebarView });
    persist(get());
  },
  setPaletteOpen(paletteOpen) {
    set({ paletteOpen });
  },
  setHelpOpen(helpOpen) {
    set({ helpOpen });
  },
  setSchemaFilter(schemaFilter) {
    set({ schemaFilter });
  },
  setInspecting(inspecting) {
    set({ inspecting });
  },
  setPushdown(pushdown) {
    set({ pushdown });
  },
  setCache(cache) {
    set({ cache });
  },
  setRowLimit(rowLimit) {
    set({ rowLimit });
  },

  addTab(kind = 'sql', content) {
    const tab = createTab(kind, content);
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    persist(get());
    return tab.id;
  },

  closeTab(id) {
    set((state) => {
      if (state.tabs.length === 1) return state;
      const index = state.tabs.findIndex((t) => t.id === id);
      const tabs = state.tabs.filter((t) => t.id !== id);
      const fallback = tabs[Math.max(0, index - 1)] ?? tabs[0];
      return {
        tabs,
        activeTabId: state.activeTabId === id ? (fallback?.id ?? state.activeTabId) : state.activeTabId,
      };
    });
    persist(get());
  },

  selectTab(activeTabId) {
    set({ activeTabId });
    persist(get());
  },

  updateTab(id, patch) {
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) }));
  },

  renameTab(id, title) {
    get().updateTab(id, { title });
    persist(get());
  },

  setTabContent(id, content) {
    get().updateTab(id, { content });
    persist(get());
  },

  /** Inserts text at the active tab's cursor, used by the schema tree. */
  insertIntoTab(text) {
    const state = get();
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab) return;
    const at = Math.min(tab.cursorOffset, tab.content.length);
    const next = tab.content.slice(0, at) + text + tab.content.slice(at);
    state.updateTab(tab.id, { content: next, cursorOffset: at + text.length });
    persist(get());
  },

  async run(tabId, options) {
    const state = get();
    const connectionId = state.activeConnectionId;
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (!connectionId) {
      state.updateTab(tabId, {
        messages: [{ kind: 'error', text: 'Add a connection first, then run.', at: Date.now() }],
        dockTab: 'messages',
      });
      return;
    }

    const started = Date.now();
    state.updateTab(tabId, {
      running: true,
      results: [],
      views: {},
      messages: [],
      progress: [],
      activeResultIndex: 0,
      dockTab: 'grid',
    });

    // "Run current statement" narrows the script to whichever statement the cursor is in.
    let statementIndex: number | undefined;
    if (options?.statementOnly) {
      statementIndex = statementIndexAt(tab.content, tab.cursorOffset);
    }

    const results: QueryResult[] = [];
    const messages: RunMessage[] = [];
    const progress = new Map<string, FetchProgress>();

    const handle = runSql(
      {
        connectionId,
        sql: tab.content,
        ...(statementIndex !== undefined ? { statementIndex } : {}),
        pushdown: state.pushdown,
        cache: state.cache,
        ...(state.rowLimit ? { maxRows: state.rowLimit } : {}),
        explain: options?.explain === true,
        pageRows: PAGE_ROWS,
      },
      (event: RunEvent) => {
        switch (event.type) {
          case 'started':
            get().updateTab(tabId, { runId: event.runId });
            break;
          case 'fetch':
            progress.set(event.table, { table: event.table, pages: event.pages, rows: event.rows, done: event.done });
            get().updateTab(tabId, { progress: [...progress.values()] });
            break;
          case 'result': {
            results.push(event.result);
            const views: Record<string, GridView> = {};
            for (const result of results) {
              if (!result.resultId) continue;
              views[result.resultId] = {
                ...newGridView(),
                rows: result.rows,
                rowCount: result.rowCount,
              };
            }
            get().updateTab(tabId, {
              results: [...results],
              views,
              activeResultIndex: results.length - 1,
              dockTab: results[results.length - 1]?.kind === 'command' ? 'messages' : 'grid',
            });
            if (event.result.message) {
              messages.push({ kind: 'info', text: event.result.message, at: Date.now() });
              get().updateTab(tabId, { messages: [...messages] });
            }
            break;
          }
          case 'warning':
            messages.push({ kind: 'warning', text: event.message, at: Date.now() });
            get().updateTab(tabId, { messages: [...messages] });
            break;
          case 'error':
            messages.push({ kind: 'error', text: event.message, detail: event.detail, at: Date.now() });
            get().updateTab(tabId, { messages: [...messages], dockTab: 'messages' });
            break;
          default:
            break;
        }
      },
    );

    try {
      await handle.done;
    } catch (err) {
      messages.push({ kind: 'error', text: describe(err), at: Date.now() });
      get().updateTab(tabId, { messages: [...messages], dockTab: 'messages' });
    } finally {
      get().updateTab(tabId, { running: false, runId: null, lastRunMs: Date.now() - started });
      void get().reloadHistory();
    }
  },

  async stop(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.runId) return;
    try {
      await api.cancelRun(tab.runId);
    } catch {
      /* the run may have finished between click and request */
    }
    get().updateTab(tabId, { running: false });
  },

  selectResult(tabId, activeResultIndex) {
    get().updateTab(tabId, { activeResultIndex });
  },

  setDockTab(tabId, dockTab) {
    get().updateTab(tabId, { dockTab });
  },

  updateView(tabId, resultId, patch) {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, views: { ...tab.views, [resultId]: { ...(tab.views[resultId] ?? newGridView()), ...patch } } }
          : tab,
      ),
    }));
  },

  /** Sorting and filtering happen in DuckDB, so they work over the whole result, not the page. */
  async applyView(tabId, resultId, patch) {
    const tab = get().tabs.find((t) => t.id === tabId);
    const current = tab?.views[resultId] ?? newGridView();
    const next = { ...current, ...patch };
    get().updateView(tabId, resultId, { ...patch, loading: true });
    try {
      const page = await api.sortResult(resultId, next.orderBy, next.descending, next.filter, 0, PAGE_ROWS);
      get().updateView(tabId, resultId, { rows: page.rows, rowCount: page.rowCount, loading: false });
    } catch (err) {
      get().updateView(tabId, resultId, { loading: false });
      get().updateTab(tabId, {
        messages: [...(tab?.messages ?? []), { kind: 'error', text: describe(err), at: Date.now() }],
      });
    }
  },

  async loadMoreRows(tabId, resultId) {
    const tab = get().tabs.find((t) => t.id === tabId);
    const view = tab?.views[resultId];
    if (!tab || !view || view.loading || view.rows.length >= view.rowCount) return;
    get().updateView(tabId, resultId, { loading: true });
    try {
      const page = await api.sortResult(resultId, view.orderBy, view.descending, view.filter, view.rows.length, PAGE_ROWS);
      const existing = get().tabs.find((t) => t.id === tabId)?.views[resultId];
      get().updateView(tabId, resultId, {
        rows: [...(existing?.rows ?? []), ...page.rows],
        rowCount: page.rowCount,
        loading: false,
      });
    } catch {
      get().updateView(tabId, resultId, { loading: false });
    }
  },
}));

/**
 * Which statement of a script contains a given offset. Mirrors the server's splitter closely
 * enough for "run current statement", counting only semicolons outside strings and comments.
 */
export function statementIndexAt(script: string, offset: number): number {
  let index = 0;
  let i = 0;
  let depth = 0;
  while (i < script.length && i < offset) {
    const c = script[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      while (i < script.length) {
        if (script[i] === quote) {
          if (script[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '-' && script[i + 1] === '-') {
      while (i < script.length && script[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && script[i + 1] === '*') {
      i += 2;
      while (i < script.length && !(script[i] === '*' && script[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) index += 1;
    i += 1;
  }
  return index;
}

export const activeTab = (state: WorkbenchState): EditorTab | undefined =>
  state.tabs.find((tab) => tab.id === state.activeTabId);

export const activeResult = (tab: EditorTab | undefined): QueryResult | undefined =>
  tab?.results[tab.activeResultIndex];
