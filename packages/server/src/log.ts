const ESC = String.fromCharCode(27);
const c = (code: string, text: string): string => `${ESC}[${code}m${text}${ESC}[0m`;

const COLORS = { debug: '90', info: '36', warn: '33', error: '31' } as const;
type Level = keyof typeof COLORS;

const LEVELS: Level[] = ['debug', 'info', 'warn', 'error'];
const minLevel = LEVELS.indexOf((process.env.GQLWB_LOG_LEVEL as Level) ?? 'info');

function emit(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVELS.indexOf(level) < minLevel) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const head = `${c(COLORS[level], level.padEnd(5))} ${c('90', stamp)} ${c('35', scope)}`;
  if (extra === undefined) console.log(`${head} ${message}`);
  else console.log(`${head} ${message}`, extra);
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
