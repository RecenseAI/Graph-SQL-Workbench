import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { IconSpinner } from '../app/Icons.tsx';

/**
 * The small set of controls the whole workbench is built from. Keeping them here means density,
 * focus rings and disabled states stay identical everywhere, which is what makes a tool with this
 * many affordances still feel like one thing.
 */

const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

type ButtonTone = 'default' | 'primary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: ReactNode;
}

const TONE: Record<ButtonTone, string> = {
  default: 'bg-bg-3 text-ink-0 hover:bg-bg-4 border border-line',
  primary: 'bg-sql text-bg-0 hover:brightness-110 border border-transparent font-medium',
  danger: 'bg-transparent text-err hover:bg-err/10 border border-err/40',
  ghost: 'bg-transparent text-ink-1 hover:bg-bg-3 hover:text-ink-0 border border-transparent',
};

export function Button({ tone = 'default', size = 'md', busy, icon, children, className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded whitespace-nowrap transition-colors',
        size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
        TONE[tone],
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...rest}
    >
      {busy ? <IconSpinner size={13} /> : icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: number;
}

export function IconButton({ label, active, size = 26, children, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      style={{ width: size, height: size }}
      className={cx(
        'grid shrink-0 place-items-center rounded transition-colors',
        active ? 'bg-bg-4 text-sql' : 'text-ink-1 hover:bg-bg-3 hover:text-ink-0',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-7 w-full rounded border border-line bg-bg-0 px-2 text-xs text-ink-0 placeholder:text-ink-3',
        'focus:border-sql focus:outline-none',
        className,
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'h-7 w-full rounded border border-line bg-bg-0 px-1.5 text-xs text-ink-0',
        'focus:border-sql focus:outline-none',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-ink-1">{label}</span>
      {children}
      {hint ? <span className="text-[10px] leading-snug text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-1.5 text-xs text-ink-1 hover:text-ink-0"
    >
      <span
        className={cx(
          'relative h-3.5 w-6 rounded-full transition-colors',
          checked ? 'bg-sql' : 'bg-bg-4',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 size-2.5 rounded-full bg-bg-0 transition-all',
            checked ? 'left-3' : 'left-0.5',
          )}
        />
      </span>
      {label}
    </button>
  );
}

type BadgeTone = 'neutral' | 'sql' | 'gql' | 'ok' | 'warn' | 'err';

const BADGE: Record<BadgeTone, string> = {
  neutral: 'bg-bg-3 text-ink-1',
  sql: 'bg-sql/15 text-sql',
  gql: 'bg-gql/15 text-gql',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  err: 'bg-err/15 text-err',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium', BADGE[tone])}
    >
      {children}
    </span>
  );
}

export function SectionHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
      {children}
      <div className="flex-1" />
      {right}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-sm">
        {icon ? <div className="mb-2 flex justify-center text-ink-3">{icon}</div> : null}
        <p className="text-xs font-medium text-ink-1">{title}</p>
        {children ? <div className="mt-1.5 text-[11px] leading-relaxed text-ink-3">{children}</div> : null}
      </div>
    </div>
  );
}

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  badge?: ReactNode;
  icon?: ReactNode;
}

export function TabStrip<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabSpec<T>[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div role="tablist" className="flex items-stretch gap-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          onClick={() => onSelect(tab.id)}
          className={cx(
            'inline-flex items-center gap-1.5 border-b-2 px-2.5 text-[11px] transition-colors',
            tab.id === active
              ? 'border-sql text-ink-0'
              : 'border-transparent text-ink-2 hover:border-line-strong hover:text-ink-1',
          )}
        >
          {tab.icon}
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}

/** A bar showing what share of a column is null, used in grid headers. */
export function NullBar({ nullCount, total }: { nullCount: number; total: number }) {
  if (total === 0) return null;
  const share = Math.min(1, nullCount / total);
  if (share === 0) return null;
  return (
    <span
      className="inline-block h-1 w-6 overflow-hidden rounded-full bg-bg-4 align-middle"
      title={`${nullCount.toLocaleString()} of ${total.toLocaleString()} rows are NULL (${Math.round(share * 100)}%)`}
    >
      <span className="block h-full bg-nullish" style={{ width: `${Math.max(4, share * 100)}%` }} />
    </span>
  );
}

export { cx };
