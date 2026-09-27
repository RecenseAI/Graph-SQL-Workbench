import { z } from 'zod';

/** Operators the pushdown layer knows how to translate. */
export const PUSHDOWN_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'like', 'ilike', 'isNull'] as const;
export type PushdownOp = (typeof PUSHDOWN_OPS)[number];

/** An http(s) URL. Written as a refinement so it behaves identically across zod minors. */
export const httpUrl = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL');

/**
 * Describes how an endpoint expresses filters, so SQL predicates can be mapped onto
 * GraphQL arguments. `shape` decides where the operator lives:
 *  - `bare`    : `users(status: "PAID")`            -- equality only, arg named after the column
 *  - `flat`    : `users(status_eq: "PAID")`         -- operator suffixed onto the arg name
 *  - `nested`  : `users(where: {status: {_eq: ...}})` -- Hasura/PostGraphile style
 *  - `filter`  : `users(filter: {status: "PAID"})`  -- single filter object, equality only
 */
export const pushdownProfileSchema = z.object({
  shape: z.enum(['bare', 'flat', 'nested', 'filter']),
  /** Argument holding the filter object, for `nested`/`filter` shapes. */
  filterArg: z.string().optional(),
  /** Operator spelling per op. Keys are `PushdownOp` values; unlisted ops are not pushed. */
  operators: z.record(z.string(), z.string()),
  /** Joiner for `flat` shape between column and operator. */
  separator: z.string().default('_'),
  /** Argument used to order rows, when supported. */
  orderByArg: z.string().optional(),
});
export type PushdownProfile = z.infer<typeof pushdownProfileSchema>;

export const authSchema = z.object({
  kind: z.enum(['none', 'bearer', 'basic', 'header']).default('none'),
  token: z.string().optional(),
  user: z.string().optional(),
  pass: z.string().optional(),
  headerName: z.string().optional(),
});
export type AuthConfig = z.infer<typeof authSchema>;

export const connectionSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  endpoint: httpUrl,
  /** Extra headers. Values may interpolate `${env:VAR}`. */
  headers: z.array(z.object({ name: z.string(), value: z.string(), enabled: z.boolean().default(true) })).default([]),
  auth: authSchema.default({ kind: 'none' }),
  /** `auto` pushes only exact argument-name matches; named profiles add operator mapping. */
  pushdownProfile: z.enum(['auto', 'hasura', 'strapi', 'flat', 'none', 'custom']).default('auto'),
  customProfile: pushdownProfileSchema.optional(),
  /** How deep to flatten nested objects into columns. */
  maxDepth: z.number().int().min(1).max(8).default(3),
  /** Rows requested per GraphQL page. */
  pageSize: z.number().int().min(1).max(1000).default(200),
  /** Row budget per table per statement. Exceeding it warns rather than silently truncating. */
  maxRows: z.number().int().min(1).max(5_000_000).default(10_000),
  concurrency: z.number().int().min(1).max(16).default(4),
  requestsPerSecond: z.number().min(0).max(200).default(0),
  timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
  cacheTtlSeconds: z.number().int().min(0).max(86_400).default(300),
  /** Overrides for custom scalars, e.g. `{ "Money": "DECIMAL(38,9)" }`. */
  scalarTypeMap: z.record(z.string(), z.string()).default({}),
  /** Used when the endpoint has introspection disabled. */
  sdl: z.string().optional(),
  color: z.string().default('#38bdf8'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConnectionConfig = z.infer<typeof connectionSchema>;

export const connectionInputSchema = connectionSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial()
  .extend({ name: z.string().min(1), endpoint: httpUrl });
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/** Built-in profiles. `auto` and `none` are handled without a profile object. */
export const BUILTIN_PROFILES: Record<'hasura' | 'strapi' | 'flat', PushdownProfile> = {
  hasura: {
    shape: 'nested',
    filterArg: 'where',
    separator: '_',
    orderByArg: 'order_by',
    operators: { eq: '_eq', ne: '_neq', gt: '_gt', gte: '_gte', lt: '_lt', lte: '_lte', in: '_in', nin: '_nin', like: '_like', ilike: '_ilike', isNull: '_is_null' },
  },
  strapi: {
    shape: 'nested',
    filterArg: 'filters',
    separator: '_',
    orderByArg: 'sort',
    operators: { eq: 'eq', ne: 'ne', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', in: 'in', nin: 'notIn', like: 'contains', ilike: 'containsi', isNull: 'null' },
  },
  flat: {
    shape: 'flat',
    separator: '_',
    operators: { eq: 'eq', ne: 'ne', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', in: 'in', nin: 'nin', like: 'like', ilike: 'ilike', isNull: 'is_null' },
  },
};
