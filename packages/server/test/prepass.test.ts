import { describe, expect, it } from 'vitest';
import { prepass } from '../src/sql/prepass.ts';
import { splitStatements, tokenize } from '../src/sql/lexer.ts';
import { analyzeStatement } from '../src/sql/analyze.ts';

const TABLES = ['users', 'orders', 'products', 'orders__items', 'me', 'search'];
const run = (sql: string) => prepass(sql, TABLES);

describe('lexer', () => {
  it('keeps string contents out of the token stream', () => {
    const tokens = tokenize("SELECT 'FROM users' AS x");
    expect(tokens.filter((t) => t.type === 'string').map((t) => t.value)).toEqual(['FROM users']);
    expect(tokens.filter((t) => t.type === 'word').map((t) => t.value)).toEqual(['SELECT', 'AS', 'x']);
  });

  it('handles doubled quotes inside strings and identifiers', () => {
    expect(tokenize("SELECT 'it''s'").find((t) => t.type === 'string')?.value).toBe("it's");
    expect(tokenize('SELECT "od""d"').find((t) => t.type === 'quoted-ident')?.value).toBe('od"d');
  });

  it('skips line and nested block comments', () => {
    const sql = 'SELECT 1 -- FROM users\n/* outer /* inner FROM orders */ still */ , 2';
    const words = tokenize(sql).filter((t) => t.type === 'word').map((t) => t.value);
    expect(words).toEqual(['SELECT']);
  });

  it('reads dollar-quoted strings', () => {
    const tokens = tokenize("SELECT $tag$ FROM users $tag$ AS x");
    expect(tokens.find((t) => t.type === 'string')?.value).toBe(' FROM users ');
  });

  it('splits statements on top-level semicolons only', () => {
    const script = "SELECT 1; SELECT ';' AS x; SELECT (SELECT 2);";
    expect(splitStatements(script).map((s) => s.sql)).toEqual(["SELECT 1", "SELECT ';' AS x", 'SELECT (SELECT 2)']);
  });

  it('reports the source span of each statement', () => {
    const script = 'SELECT 1;\nSELECT 2';
    const statements = splitStatements(script);
    expect(script.slice(statements[1]!.start, statements[1]!.end).trim()).toBe('SELECT 2');
  });
});

describe('argument extraction', () => {
  it('strips an argument list and records the arguments', () => {
    const result = run('SELECT * FROM users(first: 100, country: "DE") u');
    expect(result.sql).toBe('SELECT * FROM users u');
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({
      relation: 'users',
      table: 'users',
      args: { first: 100, country: 'DE' },
      explicit: true,
      references: 1,
    });
  });

  it('accepts every GraphQL literal form', () => {
    const result = run(
      'SELECT * FROM products(where: {category: {_in: ["Audio", "Cameras"]}, price: {_gt: 10.5}}, flag: true, nothing: null, sort: ENUM_VALUE)',
    );
    expect(result.bindings[0]?.args).toEqual({
      where: { category: { _in: ['Audio', 'Cameras'] }, price: { _gt: 10.5 } },
      flag: true,
      nothing: null,
      sort: 'ENUM_VALUE',
    });
  });

  it('reads engine options and keeps them out of the GraphQL arguments', () => {
    const result = run('SELECT * FROM users(country: "GB", @maxRows: 25000, @pageSize: 250, @cache: false)');
    expect(result.bindings[0]?.args).toEqual({ country: 'GB' });
    expect(result.bindings[0]?.options).toEqual({ maxRows: 25000, pageSize: 250, cache: false });
    expect(result.options).toMatchObject({ maxRows: 25000 });
  });

  it('warns about an unknown option instead of failing the query', () => {
    const result = run('SELECT * FROM users(@nonsense: 1)');
    expect(result.warnings.join(' ')).toMatch(/Unknown option @nonsense/);
    expect(result.bindings[0]?.args).toEqual({});
  });

  it('rejects a non-numeric row budget clearly', () => {
    expect(run('SELECT * FROM users(@maxRows: "lots")').warnings.join(' ')).toMatch(/needs a positive number/);
  });

  it('explains a malformed argument list rather than letting DuckDB complain', () => {
    expect(() => run('SELECT * FROM users(first 100)')).toThrow(/Could not read the arguments for users/);
  });

  it('reports an unclosed argument list', () => {
    expect(() => run('SELECT * FROM users(first: 100')).toThrow(/closing parenthesis/);
  });

  it('handles an empty argument list', () => {
    const result = run('SELECT * FROM users()');
    expect(result.sql).toBe('SELECT * FROM users');
    expect(result.bindings[0]?.args).toEqual({});
  });
});

describe('table reference detection', () => {
  it('finds tables after FROM and every kind of JOIN', () => {
    const result = run(`
      SELECT * FROM users u
      LEFT JOIN orders o ON o.userId = u.id
      INNER JOIN products p ON p.id = o.id
      CROSS JOIN me`);
    expect(result.bindings.map((b) => b.table).sort()).toEqual(['me', 'orders', 'products', 'users']);
  });

  it('finds comma-separated tables in a FROM list', () => {
    const result = run('SELECT * FROM users, orders WHERE users.id = orders.userId');
    expect(result.bindings.map((b) => b.table)).toEqual(['users', 'orders']);
  });

  it('ignores a table name that only appears in a string or comment', () => {
    const result = run("SELECT 'users' AS a, 'from orders' AS b -- FROM products\nFROM me");
    expect(result.bindings.map((b) => b.table)).toEqual(['me']);
  });

  it('ignores identifiers in the select list and in WHERE', () => {
    const result = run('SELECT users FROM me WHERE orders > 1');
    expect(result.bindings.map((b) => b.table)).toEqual(['me']);
  });

  it('does not mistake a function call for a table', () => {
    const result = run("SELECT count(*), date_trunc('day', x) FROM me");
    expect(result.bindings.map((b) => b.table)).toEqual(['me']);
  });

  it('treats a CTE as shadowing a catalog table of the same name', () => {
    const result = run('WITH users AS (SELECT 1 AS id) SELECT * FROM users');
    expect(result.cteNames).toEqual(['users']);
    expect(result.bindings).toHaveLength(0);
  });

  it('still resolves real tables alongside a CTE', () => {
    const result = run('WITH recent AS (SELECT 1 AS id) SELECT * FROM recent r JOIN orders o ON o.id = r.id');
    expect(result.bindings.map((b) => b.table)).toEqual(['orders']);
  });

  it('finds tables inside a subquery', () => {
    const result = run('SELECT * FROM (SELECT id FROM users) x JOIN orders o ON o.userId = x.id');
    expect(result.bindings.map((b) => b.table).sort()).toEqual(['orders', 'users']);
  });

  it('reports an unknown table that was given arguments', () => {
    expect(() => run('SELECT * FROM custommers(first: 10)')).toThrow(/no table called "custommers"/);
  });

  it('leaves an unknown bare table alone, so DuckDB can resolve snapshots and CTEs', () => {
    const result = run('SELECT * FROM my_snapshot');
    expect(result.bindings).toHaveLength(0);
    expect(result.sql).toBe('SELECT * FROM my_snapshot');
  });
});

describe('bindings for repeated tables', () => {
  it('shares one fetch when the arguments match', () => {
    const result = run('SELECT * FROM users a JOIN users b ON a.id = b.id');
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.references).toBe(2);
    expect(result.sql).toBe('SELECT * FROM users a JOIN users b ON a.id = b.id');
  });

  it('shares one fetch when identical arguments are written twice', () => {
    const result = run('SELECT * FROM users(country: "DE") a JOIN users(country: "DE") b ON a.id = b.id');
    expect(result.bindings).toHaveLength(1);
    expect(result.sql).toBe('SELECT * FROM users a JOIN users b ON a.id = b.id');
  });

  it('treats argument order as irrelevant', () => {
    const result = run('SELECT * FROM users(country: "DE", active: true) a JOIN users(active: true, country: "DE") b ON a.id = b.id');
    expect(result.bindings).toHaveLength(1);
  });

  it('creates separate relations when the arguments differ', () => {
    const result = run('SELECT * FROM users(country: "DE") de JOIN users(country: "GB") gb ON de.id = gb.id');
    expect(result.bindings.map((b) => b.relation)).toEqual(['users', 'users__wb2']);
    expect(result.sql).toBe('SELECT * FROM users de JOIN users__wb2 gb ON de.id = gb.id');
    expect(result.bindings[0]?.args).toEqual({ country: 'DE' });
    expect(result.bindings[1]?.args).toEqual({ country: 'GB' });
  });

  it('treats no arguments as its own binding', () => {
    const result = run('SELECT * FROM users(country: "DE") a JOIN users b ON a.id = b.id');
    expect(result.bindings.map((b) => b.relation)).toEqual(['users', 'users__wb2']);
    expect(result.bindings[1]?.args).toEqual({});
    expect(result.sql).toBe('SELECT * FROM users a JOIN users__wb2 b ON a.id = b.id');
  });

  it('rewrites spans without corrupting surrounding text', () => {
    const result = run(
      'SELECT u.id, o.total FROM users(first: 5) u JOIN orders(status: "PAID") o ON o.userId = u.id WHERE o.total > 10 ORDER BY o.total DESC LIMIT 3',
    );
    expect(result.sql).toBe(
      'SELECT u.id, o.total FROM users u JOIN orders o ON o.userId = u.id WHERE o.total > 10 ORDER BY o.total DESC LIMIT 3',
    );
  });
});

describe('statement analysis', () => {
  const analyse = (sql: string) => {
    const pre = run(sql);
    return { pre, analysis: analyzeStatement(pre.sql, pre.bindings.map((b) => b.relation)) };
  };

  it('collects the columns each relation needs', () => {
    const { analysis } = analyse('SELECT u.id, u.country, o.total FROM users u JOIN orders o ON o.userId = u.id');
    expect([...(analysis.columns.get('users') as Set<string>)].sort()).toEqual(['country', 'id']);
    expect([...(analysis.columns.get('orders') as Set<string>)].sort()).toEqual(['total', 'userId']);
  });

  it('marks a relation as needing every column for SELECT *', () => {
    const { analysis } = analyse('SELECT * FROM users');
    expect(analysis.columns.get('users')).toBe('*');
  });

  it('marks only the starred relation for alias.*', () => {
    const { analysis } = analyse('SELECT u.*, o.total FROM users u JOIN orders o ON o.userId = u.id');
    expect(analysis.columns.get('users')).toBe('*');
    expect(analysis.columns.get('orders')).not.toBe('*');
  });

  it('extracts AND-ed predicates on a single table', () => {
    const { analysis } = analyse("SELECT * FROM orders WHERE status = 'PAID' AND total > 100 AND channel != 'web'");
    const predicates = analysis.predicates.get('orders') ?? [];
    expect(predicates).toEqual([
      { column: 'status', op: 'eq', value: 'PAID' },
      { column: 'total', op: 'gt', value: 100 },
      { column: 'channel', op: 'ne', value: 'web' },
    ]);
  });

  it('ignores predicates under OR, which cannot be pushed safely', () => {
    const { analysis } = analyse("SELECT * FROM orders WHERE status = 'PAID' OR total > 100");
    expect(analysis.predicates.get('orders') ?? []).toEqual([]);
  });

  it('normalises a reversed comparison', () => {
    const { analysis } = analyse('SELECT * FROM orders WHERE 100 < total');
    expect(analysis.predicates.get('orders')).toEqual([{ column: 'total', op: 'gt', value: 100 }]);
  });

  it('extracts IN and IS NULL', () => {
    const { analysis } = analyse("SELECT * FROM orders WHERE status IN ('PAID', 'SHIPPED') AND channel IS NULL");
    expect(analysis.predicates.get('orders')).toEqual([
      { column: 'status', op: 'in', value: ['PAID', 'SHIPPED'] },
      { column: 'channel', op: 'isNull', value: true },
    ]);
  });

  it('refuses to push a predicate on the nullable side of a LEFT JOIN', () => {
    const { analysis } = analyse("SELECT * FROM users u LEFT JOIN orders o ON o.userId = u.id WHERE o.status = 'PAID'");
    expect(analysis.outerNullable.has('orders')).toBe(true);
    expect(analysis.predicates.get('orders') ?? []).toEqual([]);
  });

  it('detects aggregation, which blocks LIMIT pushdown', () => {
    const { analysis } = analyse('SELECT country, sum(lifetimeValue) FROM users GROUP BY country LIMIT 5');
    expect(analysis.aggregates).toBe(true);
    expect(analysis.pushableLimit).toBeNull();
  });

  it('pushes a LIMIT for a plain single-table scan', () => {
    const { analysis } = analyse('SELECT id FROM users LIMIT 25');
    expect(analysis.pushableLimit).toEqual({ relation: 'users', rows: 25 });
  });

  it('accounts for OFFSET when pushing a LIMIT', () => {
    const { analysis } = analyse('SELECT id FROM users LIMIT 10 OFFSET 40');
    expect(analysis.pushableLimit?.rows).toBe(50);
  });

  it('never pushes a LIMIT across a join', () => {
    const { analysis } = analyse('SELECT u.id FROM users u JOIN orders o ON o.userId = u.id LIMIT 5');
    expect(analysis.pushableLimit).toBeNull();
  });

  it('degrades gracefully when the dialect is beyond the parser', () => {
    const pre = run('SELECT country, sum(lifetimeValue) AS v FROM users GROUP BY ALL QUALIFY v > 0');
    const analysis = analyzeStatement(pre.sql, pre.bindings.map((b) => b.relation));
    // Whether or not this parses, the fallback must ask for everything rather than guess.
    if (!analysis.parsed) {
      expect(analysis.columns.get('users')).toBe('*');
      expect(analysis.predicates.size).toBe(0);
    }
    expect(pre.bindings.map((b) => b.table)).toEqual(['users']);
  });
});
