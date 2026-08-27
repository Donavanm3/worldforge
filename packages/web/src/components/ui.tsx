import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-ink-600 bg-ink-800 p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && (
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-ink-600 bg-ink-800 p-4">
      <div className="text-xs uppercase tracking-widest text-slate-400">{label}</div>
      <div className="mt-1 font-mono text-2xl text-slate-100">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  const styles = {
    primary: 'bg-accent-500 hover:bg-accent-400 text-ink-900 font-semibold',
    secondary: 'bg-ink-700 hover:bg-ink-600 text-slate-100 border border-ink-500',
    danger: 'bg-loss/90 hover:bg-loss text-ink-900 font-semibold',
  }[variant];

  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={`rounded-md px-4 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    >
      {loading ? 'Working…' : children}
    </button>
  );
}

export function Field({
  label,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-slate-400">{label}</span>
      <input
        {...props}
        className="w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-slate-100 outline-none focus:border-accent-500"
      />
      {error && <span className="mt-1 block text-xs text-loss">{error}</span>}
    </label>
  );
}

export function Alert({
  children,
  tone = 'error',
}: {
  children: ReactNode;
  tone?: 'error' | 'info';
}) {
  const styles =
    tone === 'error'
      ? 'border-loss/40 bg-loss/10 text-loss'
      : 'border-accent-500/40 bg-accent-500/10 text-accent-400';
  return <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>{children}</div>;
}

/**
 * Placeholder for features that are specified but not yet built (spec 85):
 * never ship a button that silently does nothing.
 */
export function ComingSoon({ feature }: { feature: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-500 bg-ink-800/50 p-8 text-center">
      <div className="text-xs font-semibold uppercase tracking-widest text-accent-400">
        Coming Soon
      </div>
      <p className="mt-2 text-sm text-slate-400">{feature} is not implemented yet.</p>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="p-8 text-center text-sm text-slate-400">{label}</div>;
}
