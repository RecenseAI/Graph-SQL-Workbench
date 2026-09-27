import { useMemo, useState } from 'react';
import type { CatalogColumn, CatalogTable } from '@gqlwb/shared';
import { useWorkbench } from '../../store/workbench.ts';
import { Badge, IconButton, Input, SectionHeader, cx } from '../../ui/primitives.tsx';
import {
  IconChevronDown,
  IconChevronRight,
  IconChildTable,
  IconGraph,
  IconPlayLine,
  IconSearch,
  IconTable,
} from '../../app/Icons.tsx';

/**
 * The schema browser, which is the endpoint's Query type read as a set of tables.
 *
 * Every row does something: clicking a column inserts it at the cursor, and the play button on a
 * table writes the SELECT you were about to type. Types are shown in both dialects -- DuckDB on the
 * left because that is what you write in SQL, GraphQL on hover because that is what the endpoint
 * calls it.
 */

const TYPE_COLOR = (column: CatalogColumn): string => {
  if (column.synthetic) return 'text-ink-3';
  switch (column.kind) {
    case 'int':
    case 'float':
      return 'text-num';
    case 'boolean':
      return 'text-bool';
    case 'enum':
      return 'text-gql';
    case 'id':
      return 'text-sql';
    case 'custom':
      return 'text-temporal';
    default:
      return 'text-str';
  }
};

/** A compact rendering of a DuckDB type, so a wide sidebar is not required. */
const shortType = (duckType: string): string =>
  duckType
    .replace('DECIMAL(38,9)', 'DECIMAL')
    .replace('TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ')
    .replace('VARCHAR', 'TEXT')
    .replace('BIGINT', 'INT8')
    .replace('DOUBLE', 'FLOAT8');

export function SchemaTree() {
  const catalog = useWorkbench((s) => s.catalog);
  const catalogLoading = useWorkbench((s) => s.catalogLoading);
  const filter = useWorkbench((s) => s.schemaFilter);
  const setFilter = useWorkbench((s) => s.setSchemaFilter);
  const insertIntoTab = useWorkbench((s) => s.insertIntoTab);
  const addTab = useWorkbench((s) => s.addTab);
  const run = useWorkbench((s) => s.run);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showTypes, setShowTypes] = useState(false);

  const toggle = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));

  const needle = filter.trim().toLowerCase();

  const rootTables = useMemo(() => {
    if (!catalog) return [];
    const roots = catalog.tables.filter((t) => !t.isChild);
    if (!needle) return roots;
    // A table matches by its own name, or by having a matching column or child.
    return roots.filter((table) => {
      if (table.name.toLowerCase().includes(needle)) return true;
      if (table.columns.some((c) => c.name.toLowerCase().includes(needle))) return true;
      return table.childTables.some((child) => child.toLowerCase().includes(needle));
    });
  }, [catalog, needle]);

  const childrenOf = (table: CatalogTable): CatalogTable[] =>
    (catalog?.tables ?? []).filter((t) => t.parent === table.name);

  const matchingColumns = (table: CatalogTable): CatalogColumn[] => {
    const columns = table.columns;
    if (!needle) return columns;
    if (table.name.toLowerCase().includes(needle)) return columns;
    const hits = columns.filter((c) => c.name.toLowerCase().includes(needle));
    return hits.length > 0 ? hits : columns;
  };

  const selectTop = (table: CatalogTable) => {
    const sql = table.isChild
      ? `SELECT i.*\nFROM ${table.parent} p\nJOIN ${table.name} i ON i._parent_rowid = p._rowid\nLIMIT 100;\n`
      : `SELECT *\nFROM ${table.name}\nLIMIT 100;\n`;
    const tabId = addTab('sql', sql);
    void run(tabId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        right={
          <button
            type="button"
            onClick={() => setShowTypes(!showTypes)}
            className={cx('rounded px-1.5 py-0.5 text-[10px]', showTypes ? 'bg-bg-4 text-sql' : 'text-ink-2 hover:text-ink-0')}
            title="Show column types"
          >
            types
          </button>
        }
      >
        <IconGraph size={13} /> Schema
      </SectionHeader>

      <div className="shrink-0 border-b border-line p-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3">
            <IconSearch size={12} />
          </span>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tables and columns"
            className="pl-6"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-4">
        {!catalog ? (
          <p className="p-3 text-[11px] text-ink-3">{catalogLoading ? 'Reading the schema...' : 'No schema loaded.'}</p>
        ) : rootTables.length === 0 ? (
          <p className="p-3 text-[11px] text-ink-3">Nothing matches "{filter}".</p>
        ) : (
          <ul>
            {rootTables.map((table) => {
              const key = `t:${table.name}`;
              const open = expanded[key] ?? Boolean(needle);
              const children = childrenOf(table);
              return (
                <li key={table.name}>
                  <div className="group flex items-center gap-1 pr-1 hover:bg-bg-2">
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-1 text-left"
                    >
                      <span className="shrink-0 text-ink-3">
                        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                      </span>
                      <span className="shrink-0 text-sql">
                        <IconTable size={13} />
                      </span>
                      <span className="truncate text-xs text-ink-0">{table.name}</span>
                      <PaginationBadge table={table} />
                    </button>
                    <IconButton
                      label={`SELECT the first 100 rows of ${table.name}`}
                      size={20}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => selectTop(table)}
                    >
                      <IconPlayLine size={12} />
                    </IconButton>
                  </div>

                  {open ? (
                    <div className="ml-4 border-l border-line">
                      {table.args.length > 0 ? (
                        <ArgumentList table={table} onInsert={insertIntoTab} />
                      ) : null}

                      <ul>
                        {matchingColumns(table).map((column) => (
                          <ColumnRow
                            key={column.name}
                            column={column}
                            showType={showTypes}
                            onInsert={() => insertIntoTab(column.name)}
                          />
                        ))}
                      </ul>

                      {children.map((child) => {
                        const childKey = `t:${child.name}`;
                        const childOpen = expanded[childKey] ?? false;
                        return (
                          <div key={child.name}>
                            <div className="group flex items-center gap-1 pr-1 hover:bg-bg-2">
                              <button
                                type="button"
                                onClick={() => toggle(childKey)}
                                className="flex min-w-0 flex-1 items-center gap-1 py-1 pl-1 text-left"
                              >
                                <span className="shrink-0 text-ink-3">
                                  {childOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                                </span>
                                <span className="shrink-0 text-gql">
                                  <IconChildTable size={13} />
                                </span>
                                <span className="truncate text-xs text-ink-1">{child.name}</span>
                                <Badge tone="neutral" title="Fetched with its parent and joined on _parent_rowid">
                                  nested
                                </Badge>
                              </button>
                              <IconButton
                                label={`SELECT the first 100 rows of ${child.name}`}
                                size={20}
                                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                onClick={() => selectTop(child)}
                              >
                                <IconPlayLine size={12} />
                              </IconButton>
                            </div>
                            {childOpen ? (
                              <ul className="ml-4 border-l border-line">
                                {matchingColumns(child).map((column) => (
                                  <ColumnRow
                                    key={column.name}
                                    column={column}
                                    showType={showTypes}
                                    onInsert={() => insertIntoTab(column.name)}
                                  />
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {catalog && catalog.mutationNames.length > 0 ? (
          <div className="mt-2 border-t border-line px-2 pt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              Mutations ({catalog.mutationNames.length})
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-ink-3">
              Listed for reference. The workbench is read-only and will not run them.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PaginationBadge({ table }: { table: CatalogTable }) {
  const style = table.pagination.style;
  if (style === 'relay') {
    return (
      <Badge tone="gql" title="Relay cursor connection: paged with first/after">
        relay
      </Badge>
    );
  }
  if (style === 'offset') {
    return (
      <Badge tone="neutral" title="Paged with limit/offset">
        offset
      </Badge>
    );
  }
  if (style === 'page') {
    return (
      <Badge tone="neutral" title="Paged with page/perPage">
        paged
      </Badge>
    );
  }
  return (
    <Badge tone="warn" title="No pagination arguments: only what one call returns is available">
      single call
    </Badge>
  );
}

function ArgumentList({ table, onInsert }: { table: CatalogTable; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const required = table.args.filter((a) => a.required);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 py-1 pl-1 text-left hover:bg-bg-2"
      >
        <span className="shrink-0 text-ink-3">{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
        <span className="text-[11px] text-ink-2">arguments ({table.args.length})</span>
        {required.length > 0 ? (
          <Badge tone="warn" title={`${required.map((a) => a.name).join(', ')} must be supplied`}>
            {required.length} required
          </Badge>
        ) : null}
      </button>
      {open ? (
        <ul className="ml-4 border-l border-line">
          {table.args.map((arg) => (
            <li key={arg.name}>
              <button
                type="button"
                onClick={() => onInsert(`${arg.name}: `)}
                title={[arg.description, arg.enumValues?.length ? `One of: ${arg.enumValues.join(', ')}` : null]
                  .filter(Boolean)
                  .join('\n\n')}
                className="flex w-full items-baseline gap-1.5 py-0.5 pl-2 pr-1 text-left hover:bg-bg-2"
              >
                <span className="truncate font-mono text-[11px] text-ink-1">{arg.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-gql">{arg.graphqlType}</span>
                {arg.required ? <span className="shrink-0 text-[10px] text-warn">required</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ColumnRow({
  column,
  showType,
  onInsert,
}: {
  column: CatalogColumn;
  showType: boolean;
  onInsert: () => void;
}) {
  const title = [
    `${column.name}  ${column.duckType}`,
    `GraphQL: ${column.graphqlType}${column.path.length > 1 ? ` (${column.path.join('.')})` : ''}`,
    column.nullable ? 'nullable' : 'not null',
    column.enumValues?.length ? `One of: ${column.enumValues.join(', ')}` : null,
    column.deprecationReason ? `Deprecated: ${column.deprecationReason}` : null,
    column.description ?? null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <li>
      <button
        type="button"
        onClick={onInsert}
        title={title}
        className="flex w-full items-baseline gap-1.5 py-0.5 pl-2 pr-1 text-left hover:bg-bg-2"
      >
        <span
          className={cx(
            'truncate font-mono text-[11px]',
            column.synthetic ? 'text-ink-3 italic' : 'text-ink-0',
            column.deprecationReason && 'line-through decoration-ink-3',
          )}
        >
          {column.name}
        </span>
        {column.isList ? <span className="shrink-0 text-[10px] text-ink-3">[]</span> : null}
        {!column.nullable && !column.synthetic ? (
          <span className="shrink-0 text-[10px] text-ink-3" title="not null">
            *
          </span>
        ) : null}
        <span className="flex-1" />
        {showType ? (
          <span className={cx('shrink-0 font-mono text-[10px]', TYPE_COLOR(column))}>{shortType(column.duckType)}</span>
        ) : null}
      </button>
    </li>
  );
}
