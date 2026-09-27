import {
  getNamedType,
  getNullableType,
  isEnumType,
  isInterfaceType,
  isListType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLUnionType,
} from 'graphql';
import type { PaginationSpec } from '@gqlwb/shared';

/**
 * Works out, from the schema alone, how a root field yields rows and how to ask for more of
 * them. There is no standard here beyond Relay's connection spec, so the rules are ordered:
 * canonical names first, then the conventions that real endpoints actually use, then a
 * structural fallback. Everything it cannot determine degrades to a single unpaginated page,
 * which is always correct if sometimes incomplete.
 */

export type RowType = GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType;

export interface RootFieldShape {
  /** The composite type of one row, or null when the field yields only scalars. */
  rowType: RowType | null;
  pagination: PaginationSpec;
  /** True when the field returns at most one row. */
  single: boolean;
  warnings: string[];
}

const CURSOR_FIRST = ['first', 'firstN'];
const CURSOR_AFTER = ['after', 'afterCursor', 'cursor', 'startCursor'];
const CURSOR_LAST = ['last'];
const CURSOR_BEFORE = ['before', 'beforeCursor', 'endCursor'];
const LIMIT_ARGS = ['limit', 'take', 'pageSize', 'size', 'max', 'maxResults', 'count', 'first'];
const OFFSET_ARGS = ['offset', 'skip', 'start', 'startIndex', 'from'];
const PAGE_ARGS = ['page', 'pageNumber', 'pageIndex'];
const PER_PAGE_ARGS = ['perPage', 'pageSize', 'itemsPerPage', 'size', 'limit'];
const NODE_LIST_NAMES = ['nodes', 'items', 'results', 'data', 'records', 'entries', 'elements', 'list', 'rows'];
const TOTAL_FIELDS = ['totalCount', 'total', 'count', 'totalRecords', 'recordCount', 'totalResults', 'totalItems'];

const isIntish = (arg: GraphQLArgument): boolean => {
  const named = getNamedType(arg.type);
  return isScalarType(named) && ['Int', 'Float'].includes(named.name);
};
const isStringish = (arg: GraphQLArgument): boolean => {
  const named = getNamedType(arg.type);
  return isScalarType(named) && ['String', 'ID'].includes(named.name);
};

function findArg(
  args: readonly GraphQLArgument[],
  candidates: string[],
  accept: (arg: GraphQLArgument) => boolean,
): string | undefined {
  const byLower = new Map(args.map((a) => [a.name.toLowerCase(), a]));
  for (const candidate of candidates) {
    const arg = byLower.get(candidate.toLowerCase());
    if (arg && accept(arg)) return arg.name;
  }
  return undefined;
}

/** A composite type that is not a leaf: object, interface or union. */
function asRowType(type: GraphQLNamedType): RowType | null {
  if (isObjectType(type) || isInterfaceType(type) || isUnionType(type)) return type;
  return null;
}

interface ListField {
  name: string;
  rowType: RowType;
}

/** The field on a wrapper object that actually holds the rows. */
function findRowListField(type: GraphQLObjectType): ListField | undefined {
  const fields = type.getFields();

  // Relay: edges is a list of edge objects, each with a node.
  const edges = fields.edges;
  if (edges && isListType(getNullableType(edges.type))) {
    const edgeType = getNamedType(edges.type);
    if (isObjectType(edgeType)) {
      const node = edgeType.getFields().node;
      if (node) {
        const rowType = asRowType(getNamedType(node.type));
        if (rowType) return { name: 'edges', rowType };
      }
    }
  }

  // A conventionally named list of composites.
  for (const name of NODE_LIST_NAMES) {
    const field = fields[name];
    if (!field || !isListType(getNullableType(field.type))) continue;
    const rowType = asRowType(getNamedType(field.type));
    if (rowType) return { name, rowType };
  }

  // Structural fallback: exactly one list-of-composite field, whatever it is called.
  const candidates = Object.values(fields).filter((field) => {
    if (!isListType(getNullableType(field.type))) return false;
    return asRowType(getNamedType(field.type)) !== null;
  });
  const only = candidates[0];
  if (candidates.length === 1 && only) {
    const rowType = asRowType(getNamedType(only.type));
    if (rowType) return { name: only.name, rowType };
  }
  return undefined;
}

interface PageInfoShape {
  path: string[];
  hasNextField: string;
  endCursorField: string;
}

function findPageInfo(type: GraphQLObjectType): PageInfoShape | undefined {
  for (const [name, field] of Object.entries(type.getFields())) {
    if (!/^page_?info$/i.test(name)) continue;
    const infoType = getNamedType(field.type);
    if (!isObjectType(infoType)) continue;
    const infoFields = infoType.getFields();
    const hasNext = Object.keys(infoFields).find((f) => /^has_?next_?page$/i.test(f) || /^has_?more$/i.test(f));
    const endCursor = Object.keys(infoFields).find((f) => /^end_?cursor$/i.test(f) || /^next_?cursor$/i.test(f));
    if (hasNext && endCursor) return { path: [name], hasNextField: hasNext, endCursorField: endCursor };
  }
  return undefined;
}

function findTotalField(type: GraphQLObjectType): string | undefined {
  const fields = type.getFields();
  for (const candidate of TOTAL_FIELDS) {
    const match = Object.keys(fields).find((name) => name.toLowerCase() === candidate.toLowerCase());
    if (!match) continue;
    const named = getNamedType(fields[match]!.type);
    if (isScalarType(named) && ['Int', 'Float'].includes(named.name)) return match;
  }
  return undefined;
}

/**
 * A field that tells the client whether another page exists: `info { next }` (a next page
 * number, null at the end), `pageInfo { hasNextPage }`, or a top-level `hasMore`.
 */
function findNextIndicator(type: GraphQLObjectType): string[] | undefined {
  const NEXT = /^(next|nextPage|hasNextPage|hasNext|hasMore|nextCursor)$/i;
  const fields = type.getFields();
  for (const [name, field] of Object.entries(fields)) {
    if (NEXT.test(name) && isScalarType(getNamedType(field.type))) return [name];
  }
  for (const [name, field] of Object.entries(fields)) {
    const named = getNamedType(field.type);
    if (!isObjectType(named) || isListType(getNullableType(field.type))) continue;
    for (const [inner, innerField] of Object.entries(named.getFields())) {
      if (NEXT.test(inner) && isScalarType(getNamedType(innerField.type))) return [name, inner];
    }
  }
  return undefined;
}

export function analyseRootField(field: GraphQLField<unknown, unknown>, defaultPageSize: number): RootFieldShape {
  const warnings: string[] = [];
  const args = field.args;
  const nullable = getNullableType(field.type);

  const limitArg = findArg(args, LIMIT_ARGS, isIntish);
  const offsetArg = findArg(args, OFFSET_ARGS, isIntish);
  const pageArg = findArg(args, PAGE_ARGS, isIntish);
  const perPageArg = findArg(args, PER_PAGE_ARGS, isIntish);
  const firstArg = findArg(args, CURSOR_FIRST, isIntish);
  const afterArg = findArg(args, CURSOR_AFTER, isStringish);

  // A bare list: the rows are the field value itself.
  if (isListType(nullable)) {
    const rowType = asRowType(getNamedType(field.type));
    const style = pageArg && perPageArg ? 'page' : limitArg && offsetArg ? 'offset' : 'none';
    if (style === 'none' && !limitArg) {
      warnings.push(
        `${field.name} returns a list with no pagination arguments; the workbench can only read whatever one call returns.`,
      );
    }
    return {
      rowType,
      single: false,
      warnings,
      pagination: {
        style,
        nodesPath: [],
        ...(style === 'offset' ? { limitArg, offsetArg } : {}),
        ...(style === 'page' ? { pageArg, perPageArg } : {}),
        ...(style === 'none' && limitArg ? { limitArg } : {}),
        defaultPageSize,
      },
    };
  }

  if (isObjectType(nullable)) {
    const pageInfoProbe = findPageInfo(nullable);
    const totalProbe = findTotalField(nullable);
    const nextProbe = findNextIndicator(nullable);
    const hasPagingArgs = Boolean(limitArg || offsetArg || pageArg || perPageArg || firstArg || afterArg);

    // An object that merely *contains* a list is not a collection. `continent(code: "EU")`
    // returns one continent with a `countries` list inside it; reading that list as the table's
    // rows would be wrong. Only unwrap when something says this object is a page of results:
    // Relay edges, paging arguments, page metadata, a total, or a conventional wrapper name.
    const wrapperName = /(Connection|Page|Paged|PaginatedList|List|Result|Results|Response|Collection)$/i;
    const looksLikeCollection =
      Boolean(nullable.getFields().edges) ||
      hasPagingArgs ||
      Boolean(pageInfoProbe || totalProbe || nextProbe) ||
      wrapperName.test(nullable.name);
    const listField = looksLikeCollection ? findRowListField(nullable) : undefined;

    // No list anywhere: a single object, which is still a perfectly good one-row table.
    if (!listField) {
      return {
        rowType: nullable,
        single: true,
        warnings,
        pagination: { style: 'none', nodesPath: [], defaultPageSize },
      };
    }

    const nodesPath = listField.name === 'edges' ? ['edges', 'node'] : [listField.name];
    const pageInfo = findPageInfo(nullable);
    const totalField = findTotalField(nullable);

    // Relay needs both a cursor to send and a cursor to receive.
    if (pageInfo && firstArg && afterArg) {
      return {
        rowType: listField.rowType,
        single: false,
        warnings,
        pagination: {
          style: 'relay',
          nodesPath,
          firstArg,
          afterArg,
          pageInfoPath: pageInfo.path,
          hasNextField: pageInfo.hasNextField,
          endCursorField: pageInfo.endCursorField,
          totalField,
          defaultPageSize,
        },
      };
    }

    if (pageArg && perPageArg) {
      return {
        rowType: listField.rowType,
        single: false,
        warnings,
        pagination: {
          style: 'page',
          nodesPath,
          pageArg,
          perPageArg,
          totalField,
          ...(nextProbe ? { nextPagePath: nextProbe } : {}),
          defaultPageSize,
        },
      };
    }

    // Page numbers with a server-chosen page size, e.g. `characters(page: 2) { info { next } }`.
    // Without a size argument a short page proves nothing, so the loop follows the server's own
    // "is there a next page" field instead.
    if (pageArg && nextProbe) {
      return {
        rowType: listField.rowType,
        single: false,
        warnings,
        pagination: { style: 'page', nodesPath, pageArg, nextPagePath: nextProbe, totalField, defaultPageSize },
      };
    }

    if (limitArg && offsetArg) {
      return {
        rowType: listField.rowType,
        single: false,
        warnings,
        pagination: { style: 'offset', nodesPath, limitArg, offsetArg, totalField, defaultPageSize },
      };
    }

    if (pageInfo && !afterArg) {
      warnings.push(
        `${field.name} exposes pageInfo but no cursor argument, so only the first page can be fetched.`,
      );
    } else if (!limitArg) {
      warnings.push(
        `${field.name} has no pagination arguments the workbench recognises; it reads whatever one call returns.`,
      );
    }

    return {
      rowType: listField.rowType,
      single: false,
      warnings,
      pagination: { style: 'none', nodesPath, totalField, ...(limitArg ? { limitArg } : {}), defaultPageSize },
    };
  }

  // A scalar or enum root field: one row, one column.
  const named = getNamedType(field.type);
  if (isScalarType(named) || isEnumType(named)) {
    return { rowType: null, single: true, warnings, pagination: { style: 'none', nodesPath: [], defaultPageSize } };
  }

  const rowType = asRowType(named);
  return {
    rowType,
    single: true,
    warnings,
    pagination: { style: 'none', nodesPath: [], defaultPageSize },
  };
}
