import type { Catalog, CatalogTable } from '@gqlwb/shared';

/**
 * Works out which tables can be joined to which.
 *
 * Two kinds of relationship exist here, and the difference is the whole point of the tool:
 *
 *  - **Nested** relationships are certain. A list of objects inside a row became a child table, and
 *    it joins back to its parent on `_parent_rowid`. The schema told us this.
 *  - **Inferred** relationships are the ones GraphQL does not model. A column called `userId` beside
 *    a table called `users` with an `id` primary key is a join the endpoint will never make for you,
 *    and it is exactly the join a SQL user wants. These are proposals, labelled as such, never
 *    applied automatically.
 */

export type RelationshipKind = 'nested' | 'inferred';

export interface Relationship {
  kind: RelationshipKind;
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  /** Why this relationship was proposed, shown in the UI. */
  reason: string;
  /** Rough confidence, used only for ordering. */
  confidence: number;
}

const singular = (name: string): string => {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, 'y');
  if (/(s|sh|ch|x|z)es$/i.test(name)) return name.replace(/es$/i, '');
  if (/[^s]s$/i.test(name)) return name.replace(/s$/i, '');
  return name;
};

const normalise = (name: string): string => singular(name.toLowerCase().replace(/[^a-z0-9]/g, ''));

/** Splits `userId`, `user_id` and `USERID` into their base name. */
function foreignKeyBase(columnName: string): string | null {
  const match = /^(.*?)[_-]?(id|ids)$/i.exec(columnName);
  if (!match) return null;
  const base = match[1] ?? '';
  if (base.length === 0) return null;
  return base;
}

export function findRelationships(catalog: Catalog): Relationship[] {
  const relationships: Relationship[] = [];
  const byName = new Map(catalog.tables.map((t) => [t.name, t]));

  // Nested: certain, straight from the catalog.
  for (const table of catalog.tables) {
    if (!table.isChild || !table.parent) continue;
    const parent = byName.get(table.parent);
    if (!parent) continue;
    relationships.push({
      kind: 'nested',
      from: table.name,
      fromColumn: table.parentKeyColumn ?? '_parent_rowid',
      to: parent.name,
      toColumn: table.parentRefColumn ?? '_rowid',
      reason: `${table.name} is the ${(table.parentPath ?? []).join('.')} list inside ${parent.name}, fetched with it.`,
      confidence: 1,
    });
  }

  // Inferred: a foreign-key-shaped column beside a table that owns that name.
  const candidates = catalog.tables.filter((t) => t.primaryKey);
  for (const table of catalog.tables) {
    for (const column of table.columns) {
      if (column.synthetic || column.isList) continue;
      if (column.path.length === 0) continue;
      const base = foreignKeyBase(column.name.split('_').slice(-1)[0] ?? column.name) ?? foreignKeyBase(column.name);
      if (!base) continue;
      const normalisedBase = normalise(base);
      if (normalisedBase.length < 2) continue;

      for (const target of candidates) {
        if (target.name === table.name) continue;
        if (normalise(target.name) !== normalisedBase) continue;
        const toColumn = target.primaryKey;
        if (!toColumn) continue;
        // An id column pointing at an id column, with matching names, is as good as this gets.
        relationships.push({
          kind: 'inferred',
          from: table.name,
          fromColumn: column.name,
          to: target.name,
          toColumn,
          reason: `${table.name}.${column.name} looks like a reference to ${target.name}.${toColumn}. The schema does not model this relationship, so GraphQL cannot follow it.`,
          confidence: column.kind === 'id' ? 0.9 : 0.6,
        });
        break;
      }
    }
  }

  return relationships.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'nested' ? -1 : 1;
    return b.confidence - a.confidence || a.from.localeCompare(b.from);
  });
}

/** The JOIN clause for a relationship, ready to paste into a statement. */
export function joinClause(relationship: Relationship, fromAlias?: string, toAlias?: string): string {
  const left = fromAlias ?? relationship.from;
  const right = toAlias ?? relationship.to;
  return `JOIN ${relationship.to}${toAlias ? ` ${toAlias}` : ''} ON ${right}.${relationship.toColumn} = ${left}.${relationship.fromColumn}`;
}

/** A complete runnable statement for a relationship, which is what the button inserts. */
export function joinStatement(relationship: Relationship, table: CatalogTable | undefined): string {
  const leftAlias = 'a';
  const rightAlias = 'b';
  const columns = (table?.columns ?? [])
    .filter((c) => !c.synthetic)
    .slice(0, 4)
    .map((c) => `${leftAlias}.${c.name}`);
  const selection = columns.length > 0 ? columns.join(', ') : `${leftAlias}.*`;
  return [
    `SELECT ${selection},`,
    `       ${rightAlias}.*`,
    `FROM ${relationship.from} ${leftAlias}`,
    `JOIN ${relationship.to} ${rightAlias} ON ${rightAlias}.${relationship.toColumn} = ${leftAlias}.${relationship.fromColumn}`,
    'LIMIT 100;',
    '',
  ].join('\n');
}
