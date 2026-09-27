/**
 * A small SQL lexer.
 *
 * The pre-pass has to find table references in a statement before any real parser has seen it,
 * which means it must not be fooled by a table name inside a string literal or a comment. Rather
 * than scan with regular expressions and hope, the text is tokenised once, properly, including
 * DuckDB's dollar-quoted strings.
 */

export type TokenType =
  | 'word'
  | 'number'
  | 'string'
  | 'quoted-ident'
  | 'punct'
  | 'comment'
  | 'whitespace'
  | 'param';

export interface Token {
  type: TokenType;
  /** Raw source text of the token. */
  text: string;
  /** For words and quoted identifiers, the unquoted value. */
  value: string;
  start: number;
  end: number;
}

const isWordStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isWordPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const push = (type: TokenType, start: number, end: number, value?: string): void => {
    tokens.push({ type, text: sql.slice(start, end), value: value ?? sql.slice(start, end), start, end });
  };

  while (i < sql.length) {
    const c = sql[i] as string;

    // Whitespace
    if (/\s/.test(c)) {
      const start = i;
      while (i < sql.length && /\s/.test(sql[i] as string)) i += 1;
      push('whitespace', start, i);
      continue;
    }

    // Line comment
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      push('comment', start, i);
      continue;
    }

    // Block comment, which DuckDB allows to nest
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i += 1;
      }
      push('comment', start, i);
      continue;
    }

    // Single-quoted string, with '' as the escape
    if (c === "'") {
      const start = i;
      i += 1;
      let value = '';
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      push('string', start, i, value);
      continue;
    }

    // Double-quoted identifier, with "" as the escape
    if (c === '"') {
      const start = i;
      i += 1;
      let value = '';
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      push('quoted-ident', start, i, value);
      continue;
    }

    // Dollar-quoted string: $$body$$ or $tag$body$tag$
    if (c === '$') {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const opener = tagMatch[0];
        const start = i;
        const bodyStart = i + opener.length;
        const closeAt = sql.indexOf(opener, bodyStart);
        i = closeAt === -1 ? sql.length : closeAt + opener.length;
        push('string', start, i, sql.slice(bodyStart, closeAt === -1 ? sql.length : closeAt));
        continue;
      }
      // $1 style parameter
      const paramMatch = /^\$\d+/.exec(sql.slice(i));
      if (paramMatch) {
        const start = i;
        i += paramMatch[0].length;
        push('param', start, i);
        continue;
      }
    }

    // Number, including decimals and exponents
    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] ?? ''))) {
      const start = i;
      while (i < sql.length && /[0-9]/.test(sql[i] as string)) i += 1;
      if (sql[i] === '.') {
        i += 1;
        while (i < sql.length && /[0-9]/.test(sql[i] as string)) i += 1;
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        const save = i;
        i += 1;
        if (sql[i] === '+' || sql[i] === '-') i += 1;
        if (isDigit(sql[i] ?? '')) {
          while (i < sql.length && /[0-9]/.test(sql[i] as string)) i += 1;
        } else {
          i = save;
        }
      }
      push('number', start, i);
      continue;
    }

    // Word
    if (isWordStart(c)) {
      const start = i;
      while (i < sql.length && isWordPart(sql[i] as string)) i += 1;
      push('word', start, i);
      continue;
    }

    // Anything else is a single punctuation character
    push('punct', i, i + 1);
    i += 1;
  }

  return tokens;
}

/** Tokens that carry meaning, i.e. everything except whitespace and comments. */
export function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
}

/**
 * Splits a script into statements on top-level semicolons, keeping each statement's source span
 * so the editor can highlight exactly the statement that failed.
 */
export interface Statement {
  sql: string;
  start: number;
  end: number;
}

export function splitStatements(script: string): Statement[] {
  const tokens = tokenize(script);
  const statements: Statement[] = [];
  let depth = 0;
  let startIndex = 0;

  const flush = (endOffset: number): void => {
    const raw = script.slice(startIndex, endOffset);
    if (raw.trim().length > 0) {
      // Trim leading whitespace and comments from the reported span, keeping the real start.
      const leading = raw.length - raw.trimStart().length;
      statements.push({ sql: raw.trim(), start: startIndex + leading, end: endOffset });
    }
    startIndex = endOffset;
  };

  for (const token of tokens) {
    if (token.type !== 'punct') continue;
    if (token.text === '(') depth += 1;
    else if (token.text === ')') depth = Math.max(0, depth - 1);
    else if (token.text === ';' && depth === 0) {
      flush(token.start);
      startIndex = token.end;
    }
  }
  flush(script.length);
  return statements;
}
