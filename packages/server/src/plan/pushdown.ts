import {
  BUILTIN_PROFILES,
  type CatalogArg,
  type CatalogColumn,
  type CatalogTable,
  type ConnectionConfig,
  type PushdownOp,
  type PushdownProfile,
  type PushedPredicate,
  type SkippedPredicate,
} from '@gqlwb/shared';
import type { ExtractedPredicate } from '../sql/analyze.ts';

/**
 * Maps SQL predicates onto GraphQL arguments.
 *
 * The single invariant that makes this safe: a pushed predicate is *also* left in the SQL. The
 * planner never rewrites the WHERE clause, so a mapping that is wrong about the endpoint's
 * semantics can only cause more rows to be fetched than necessary -- never a wrong answer. That
 * is what lets the workbench push filters at all, which every comparable tool declines to do.
 *
 * Beyond that, a predicate is only pushed when the schema actually has somewhere to put it: the
 * argument (or nested filter field) must exist in the introspected catalog, and its type must be
 * compatible with the literal. Anything unproven stays local, with a reason the user can read.
 */

export interface PushdownInput {
  table: CatalogTable;
  predicates: ExtractedPredicate[];
  connection: Pick<ConnectionConfig, 'pushdownProfile' | 'customProfile'>;
  /** Arguments the user wrote by hand, which are never overwritten. */
  explicitArgs: Record<string, unknown>;
  enabled: boolean;
}

export interface PushdownOutput {
  /** Arguments to merge into the fetch. */
  args: Record<string, unknown>;
  pushed: PushedPredicate[];
  skipped: SkippedPredicate[];
}

function resolveProfile(connection: PushdownInput['connection']): PushdownProfile | null {
  switch (connection.pushdownProfile) {
    case 'hasura':
      return BUILTIN_PROFILES.hasura;
    case 'strapi':
      return BUILTIN_PROFILES.strapi;
    case 'flat':
      return BUILTIN_PROFILES.flat;
    case 'custom':
      return connection.customProfile ?? null;
    default:
      return null;
  }
}

const findColumn = (table: CatalogTable, name: string): CatalogColumn | undefined =>
  table.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());

const findArg = (args: CatalogArg[], name: string): CatalogArg | undefined =>
  args.find((a) => a.name.toLowerCase() === name.toLowerCase());

/** Is a literal acceptable for an argument of this GraphQL type? */
function typesAgree(arg: CatalogArg, column: CatalogColumn, value: unknown): boolean {
  const argType = arg.graphqlTypeName;
  const values = Array.isArray(value) ? value : [value];

  for (const item of values) {
    if (item === null) continue;
    if (arg.kind === 'enum' || (arg.enumValues && arg.enumValues.length > 0)) {
      if (typeof item !== 'string') return false;
      // Pushing an unknown enum value would make the endpoint reject the whole query.
      if (arg.enumValues && !arg.enumValues.includes(item)) return false;
      continue;
    }
    switch (argType) {
      case 'Int':
        if (typeof item !== 'number' || !Number.isInteger(item)) return false;
        break;
      case 'Float':
        if (typeof item !== 'number') return false;
        break;
      case 'Boolean':
        if (typeof item !== 'boolean') return false;
        break;
      case 'String':
      case 'ID':
        if (typeof item !== 'string') return false;
        break;
      default: {
        // A custom scalar: trust the column's own kind rather than guessing from the name.
        if (column.kind === 'int' || column.kind === 'float') {
          if (typeof item !== 'number') return false;
        } else if (column.kind === 'boolean') {
          if (typeof item !== 'boolean') return false;
        } else if (typeof item !== 'string' && typeof item !== 'number') {
          return false;
        }
      }
    }
  }
  return true;
}

function setNested(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (key === undefined) return;
    const existing = current[key];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
    }
  }
  const last = path[path.length - 1];
  if (last !== undefined) current[last] = value;
}

function readNested(source: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function computePushdown(input: PushdownInput): PushdownOutput {
  const args: Record<string, unknown> = {};
  const pushed: PushedPredicate[] = [];
  const skipped: SkippedPredicate[] = [];

  if (!input.enabled) {
    for (const predicate of input.predicates) {
      skipped.push({ column: predicate.column, op: predicate.op, reason: 'Pushdown is switched off for this run.' });
    }
    return { args, pushed, skipped };
  }

  if (input.connection.pushdownProfile === 'none') {
    for (const predicate of input.predicates) {
      skipped.push({ column: predicate.column, op: predicate.op, reason: "This connection's pushdown profile is set to none." });
    }
    return { args, pushed, skipped };
  }

  const profile = resolveProfile(input.connection);
  const table = input.table;

  for (const predicate of input.predicates) {
    const column = findColumn(table, predicate.column);
    if (!column) {
      skipped.push({ column: predicate.column, op: predicate.op, reason: `No column named ${predicate.column} on ${table.name}.` });
      continue;
    }
    if (column.synthetic) {
      skipped.push({ column: column.name, op: predicate.op, reason: `${column.name} is added by the workbench, so the endpoint knows nothing about it.` });
      continue;
    }
    if (column.isList) {
      skipped.push({ column: column.name, op: predicate.op, reason: `${column.name} is a list; filtering it happens locally.` });
      continue;
    }
    if (column.path.length !== 1) {
      skipped.push({
        column: column.name,
        op: predicate.op,
        reason: `${column.name} comes from a nested field (${column.path.join('.')}), which arguments cannot address.`,
      });
      continue;
    }
    if (predicate.op === 'in' && !Array.isArray(predicate.value)) {
      skipped.push({ column: column.name, op: predicate.op, reason: 'IN needs a literal list to be pushed.' });
      continue;
    }

    const fieldName = column.path[0] as string;
    const target = resolveTarget(table, profile, fieldName, predicate.op);
    if (!target) {
      skipped.push({
        column: column.name,
        op: predicate.op,
        reason: profile
          ? `The schema has no ${describeTarget(profile, fieldName, predicate.op)} argument for this filter.`
          : `${table.name} has no argument named ${fieldName}, and ${predicate.op === 'eq' ? 'no filter profile is set' : 'the auto profile only pushes equality'}.`,
      });
      continue;
    }

    if (!typesAgree(target.arg, column, predicate.value)) {
      skipped.push({
        column: column.name,
        op: predicate.op,
        reason: `The literal does not match the type of the ${target.path.join('.')} argument (${target.arg.graphqlType}).`,
      });
      continue;
    }

    // Never override something the user wrote by hand.
    if (readNested(input.explicitArgs, target.path) !== undefined) {
      skipped.push({
        column: column.name,
        op: predicate.op,
        reason: `You already set ${target.path.join('.')} explicitly, so it was left alone.`,
      });
      continue;
    }
    if (readNested(args, target.path) !== undefined) {
      skipped.push({
        column: column.name,
        op: predicate.op,
        reason: `Another predicate already filled ${target.path.join('.')}.`,
      });
      continue;
    }

    const value = predicate.op === 'isNull' ? true : predicate.value;
    setNested(args, target.path, value);
    pushed.push({
      column: column.name,
      op: predicate.op,
      value,
      arg: target.path.join('.'),
      via: profile ? `${input.connection.pushdownProfile} profile` : 'exact argument name',
    });
  }

  return { args, pushed, skipped };
}

interface Target {
  /** Path into the argument object, e.g. ['where', 'status', '_eq'] or ['status']. */
  path: string[];
  /** The leaf argument metadata, used for type checking and enum rendering. */
  arg: CatalogArg;
}

function describeTarget(profile: PushdownProfile, fieldName: string, op: PushdownOp): string {
  const spelling = profile.operators[op];
  switch (profile.shape) {
    case 'nested':
      return `${profile.filterArg ?? 'where'}.${fieldName}.${spelling ?? op}`;
    case 'flat':
      return `${fieldName}${profile.separator}${spelling ?? op}`;
    case 'filter':
      return `${profile.filterArg ?? 'filter'}.${fieldName}`;
    default:
      return fieldName;
  }
}

/**
 * Finds where a predicate belongs in the argument tree, verifying at every step that the catalog
 * really has that argument or input field. Nothing is invented.
 */
function resolveTarget(
  table: CatalogTable,
  profile: PushdownProfile | null,
  fieldName: string,
  op: PushdownOp,
): Target | null {
  // The auto profile: exact argument name, equality only. An argument called `status` almost
  // certainly means status = x; it certainly does not mean status > x.
  if (!profile) {
    if (op !== 'eq' && op !== 'in') return null;
    const arg = findArg(table.args, fieldName);
    if (!arg) return null;
    if (op === 'in' && arg.kind !== 'list') return null;
    if (op === 'eq' && arg.kind === 'input') return null;
    return { path: [arg.name], arg };
  }

  const spelling = profile.operators[op];

  if (profile.shape === 'bare') {
    if (op !== 'eq') return null;
    const arg = findArg(table.args, fieldName);
    return arg ? { path: [arg.name], arg } : null;
  }

  if (profile.shape === 'flat') {
    if (spelling === undefined) return null;
    const candidates = [
      `${fieldName}${profile.separator}${spelling}`,
      spelling === '' ? fieldName : `${fieldName}${spelling}`,
    ];
    for (const candidate of candidates) {
      const arg = findArg(table.args, candidate);
      if (arg) return { path: [arg.name], arg };
    }
    return null;
  }

  // Nested and single-object filter shapes both start from a filter argument.
  const filterArgName = profile.filterArg ?? (profile.shape === 'nested' ? 'where' : 'filter');
  const filterArg = findArg(table.args, filterArgName);
  if (!filterArg?.inputFields) return null;
  const fieldArg = filterArg.inputFields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
  if (!fieldArg) return null;

  if (profile.shape === 'filter') {
    if (op !== 'eq') return null;
    return { path: [filterArg.name, fieldArg.name], arg: fieldArg };
  }

  if (spelling === undefined) return null;
  const operatorArg = fieldArg.inputFields?.find((f) => f.name.toLowerCase() === spelling.toLowerCase());
  if (!operatorArg) return null;
  return { path: [filterArg.name, fieldArg.name, operatorArg.name], arg: operatorArg };
}

/** Deep-merges pushdown arguments into the user's explicit arguments. */
export function mergeArgs(
  explicit: Record<string, unknown>,
  pushedArgs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...explicit };
  for (const [key, value] of Object.entries(pushedArgs)) {
    const existing = out[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = mergeArgs(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else if (existing === undefined) {
      out[key] = value;
    }
  }
  return out;
}
